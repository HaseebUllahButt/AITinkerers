import { NextRequest, NextResponse, after } from "next/server";
import { identifyCaller } from "@/lib/auth/service";
import { supabaseAdmin } from "@/lib/db/supabase";
import { getWorkflow } from "@/lib/db/queries";
import { revisePitch } from "@/lib/email/pitchRevise";
import { isPitchTone } from "@/lib/email/pitchTones";
import { loadPitchGrounding } from "@/lib/email/pitchGrounding";
import { startGen, bumpGen, finishGen, isGenRunning, noteGenError } from "@/lib/email/genBuffer";

export const maxDuration = 300;

// POST /api/workflows/:id/revise-emails — apply ONE AI rewrite (a tone preset and/or a free-text
// instruction) to EVERY unsent initial pitch in the workflow.
//
// This is the "that worked, now do the rest" step behind the Rewrite popover: a person tunes the
// wording on one prospect, likes what came back, and wants the same treatment across the workflow
// instead of retyping the instruction eighty times. Each pitch is still rewritten against ITS OWN
// grounding (recipient, article, excerpt), so this scales the instruction, not the text — the
// opposite of the hand-bulk-edited identical blasts the pitch-quality gates exist to stop.
//
// Unlike the single-pitch revise (a PROPOSAL the person reviews and saves), this writes directly.
// So it records the opposite review state: edited_at/edited_by are CLEARED on every pitch it
// touches. The review audit distinguishes "a person approved this wording" from "AI wrote this and
// nobody looked" — a batch result is the second thing even when a person picked the instruction,
// because nobody has read the eighty outputs yet. Each pitch goes back to "Review" on /backlinks.
//
// Body: { tone?: PitchToneId, instruction?: string, exclude_email_id?: string }
//   exclude_email_id — the pitch the person is editing right now; skipped so the batch never
//   clobbers the very draft that is open (their editor holds unsaved state).
// Empty tone AND instruction is allowed and means the revise default ("just tighten it"), the same
// contract as the single-pitch route.
//
// Runs on the generate-emails template: mark started in Redis BEFORE responding, do the work in
// after(), report per-item completion, and let the client poll generate-status?channel=revise.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const tone = typeof body?.tone === "string" && body.tone ? body.tone : undefined;
  const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
  const excludeId = typeof body?.exclude_email_id === "string" ? body.exclude_email_id : null;
  if (tone !== undefined && !isPitchTone(tone)) {
    return NextResponse.json({ error: "Unknown tone." }, { status: 400 });
  }
  if (instruction.length > 2_000) {
    return NextResponse.json({ error: "That instruction is too long to apply." }, { status: 400 });
  }

  const workflow = await getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

  const key = `${id}:revise`;
  // The Redis-backed lock and progress counter are conveniences; the rewrite itself is not.
  // Upstash's free tier has a monthly request quota, and once it is spent EVERY redis call
  // throws (measured 2026-08-31: "ERR max requests limit exceeded", 500000/500000) — which
  // used to crash this route as a blank 500 BEFORE any work started, surfaced in the pitch
  // dialogs as a mute "Couldn't apply". A spent metering counter must not block the actual
  // job: run without the lock and the live counter, and SAY so in the response, so the person
  // gets their rewrite plus an honest "no progress bar today" instead of an unreadable error.
  // The cost of lock-less mode is that a double-press can start two overlapping runs — both
  // write the same correct end state, so that trades wasted model calls for a working button.
  let progressAvailable = true;
  try {
    if (await isGenRunning(key)) return NextResponse.json({ started: false, alreadyRunning: true });
    // A generation run in flight would race this one for the same rows — its upserts and these
    // rewrites would land in whichever order the network decides. One writer at a time.
    if (await isGenRunning(id)) {
      return NextResponse.json({ started: false, generationRunning: true, reason: "Email generation is running for this workflow — wait for it to finish, then apply the rewrite." });
    }
  } catch {
    progressAvailable = false;
  }

  // Unsent initial pitches only. kind is initial-or-null: rows from before the kind column exist
  // and are initials. Sent mail is a record of a live conversation; follow-ups are bump notes with
  // their own wording rules — neither is this batch's business.
  const { data: rows, error: rowsError } = await supabaseAdmin
    .from("outreach_emails")
    .select("id, author_id, workflow_id, subject, body")
    .eq("workflow_id", id)
    .or("kind.eq.initial,kind.is.null")
    .is("sent_at", null)
    .neq("status", "sent")
    .order("created_at", { ascending: true })
    .limit(500);
  if (rowsError) {
    return NextResponse.json({ error: `Could not read the workflow's pitches (${rowsError.message}). Nothing was started.` }, { status: 503 });
  }

  const targets = (rows ?? [])
    .map((r) => r as { id: string; author_id: string; workflow_id: string; subject: string | null; body: string | null })
    .filter((r) => r.id !== excludeId && !!r.body?.trim());
  if (targets.length === 0) {
    return NextResponse.json({ started: false, total: 0, reason: "No other unsent pitches in this workflow to apply it to." });
  }

  if (progressAvailable) {
    try { await startGen(key, targets.length); } catch { progressAvailable = false; }
  }
  after(async () => {
    try {
      await runBulkRevise(key, targets, { tone, instruction: instruction || undefined });
    } finally {
      // Progress bookkeeping, not the work — a spent Redis quota must not kill the batch here
      // after every pitch was already rewritten (or mark the run stuck for its whole TTL).
      await finishGen(key).catch(() => {});
    }
  });

  return NextResponse.json({
    started: true,
    total: targets.length,
    // False = the run is real but invisible: no lock protected it and no counter tracks it.
    // Clients skip polling and say "check the pitches in a few minutes" instead of showing a
    // progress bar that would sit at 0/0 forever.
    progress: progressAvailable,
    ...(progressAvailable ? {} : { reason: "The live progress counter is unavailable right now (the Redis request quota is spent), so there is nothing to poll — the rewrite still runs in the background." }),
  });
}

async function runBulkRevise(
  key: string,
  targets: Array<{ id: string; author_id: string; workflow_id: string; subject: string | null; body: string | null }>,
  ask: { tone?: string; instruction?: string },
) {
  // Stop drafting BEFORE Vercel stops us: a run cut off mid-batch would leave the progress buffer
  // claiming "running" for its whole 1h TTL, which is the review UI lying about a stuck job.
  const deadline = Date.now() + 270_000;
  const CONCURRENCY = 5;

  // Progress writes are bookkeeping. Redis dying mid-run (the Upstash quota can be spent by any
  // request in the month, including one of these) must cost the progress display, never the batch:
  // an unguarded bump used to throw inside the item's own catch handler, killing every pitch
  // after it as an unhandled rejection.
  const bump = (error?: string) => bumpGen(key, error).catch(() => {});

  let done = 0;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    if (Date.now() > deadline) {
      await noteGenError(key, `Out of time: ${targets.length - done} of ${targets.length} pitches were not rewritten. Apply to all again to finish them.`).catch(() => {});
      return;
    }
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (row) => {
      const context = await loadPitchGrounding(row);
      const label = context.recipientName ?? context.domain ?? row.id.slice(0, 8);
      try {
        const result = await revisePitch({
          tone: ask.tone,
          instruction: ask.instruction,
          subject: row.subject ?? "",
          body: row.body ?? "",
          context,
        });
        if (!result.ok || !result.body) {
          await bump(`${label}: ${result.error ?? "the rewrite failed"}`);
          return;
        }
        const { data, error } = await supabaseAdmin
          .from("outreach_emails")
          .update({ subject: result.subject ?? row.subject, body: result.body, edited_at: null, edited_by: null })
          .eq("id", row.id)
          // Re-assert unsent in the WHERE clause, same as the pitch PATCH: a send run racing this
          // batch must never see its wording change after the message is on the wire.
          .is("sent_at", null)
          .neq("status", "sent")
          .select("id")
          .maybeSingle();
        if (error) await bump(`${label}: ${error.message}`);
        else if (!data) await bump(`${label}: sent while the rewrite ran — left untouched`);
        else await bump();
      } catch (e: any) {
        await bump(`${label}: ${e?.message ?? "the rewrite failed"}`);
      } finally {
        done += 1;
      }
    }));
  }
}
