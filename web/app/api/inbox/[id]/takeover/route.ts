import { NextRequest, NextResponse } from "next/server";
import { identifyCaller, actorFor } from "@/lib/auth/service";
import { supabaseAdmin } from "@/lib/db/supabase";
import { logNegotiationActivity } from "@/lib/db/queries";

export const maxDuration = 15;

/**
 * Take a thread out of AI management, from the Inbox.
 *
 * The Inbox refuses a manual reply while the AI negotiator owns a thread, and told you to go do the
 * hand-off on the Negotiation page. That is the correct guard — two senders answering the same person
 * is the worst possible outcome — but making it a trip to another page is wrong: the Inbox is where you
 * are when you decide to step in, and the decision is one you have already made by then.
 *
 * Deliberately a real hand-off and NOT the `overrideAiManaged` flag the reply route already accepts.
 * Overriding sends your message while the negotiator still believes it owns the thread, so its next
 * scheduled pass would answer on top of you. This clears `ai_managed`, deletes any unsent AI draft, and
 * records who took it — the same state the Negotiation page produces, reached from where you are.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await identifyCaller(req);
  const me = actorFor(caller);
  if (!me) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const { id: authorId } = await params;

  // The anchor is the most recent INITIAL to this author — the row the negotiator manages and the row
  // every negotiation reply hangs off via parent_id.
  const { data: anchor, error: anchorError } = await supabaseAdmin
    .from("outreach_emails")
    .select("id, ai_managed, negotiation_status")
    .eq("author_id", authorId)
    .eq("kind", "initial")
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  // Taking over a thread the person is LOOKING AT must not answer "no thread exists" on a
  // failed read.
  if (anchorError) {
    return NextResponse.json({ ok: false, error: `Could not read the thread (${anchorError.message}). Nothing changed — try again.` }, { status: 503 });
  }
  if (!anchor) {
    return NextResponse.json({ ok: false, error: "No outreach thread with this person yet." }, { status: 404 });
  }

  const a = anchor as { id: string; ai_managed: boolean | null; negotiation_status: string | null };

  // Already yours — report success rather than erroring, so a double-click is harmless.
  if (!a.ai_managed) {
    return NextResponse.json({ ok: true, alreadyYours: true, anchor_id: a.id });
  }

  // Drop any AI draft that has not been sent. Leaving it would let someone send the negotiator's
  // half-finished reply after the human has taken the conversation somewhere else.
  await supabaseAdmin.from("outreach_emails")
    .delete().eq("parent_id", a.id).eq("kind", "negotiation").eq("status", "draft");

  await supabaseAdmin.from("outreach_emails")
    .update({ negotiation_status: "handoff", ai_managed: false, intervention_at: new Date().toISOString() })
    .eq("id", a.id);

  await logNegotiationActivity(a.id, me, "handoff", "took the thread out of AI management from the Inbox")
    .catch(() => { /* the audit line is useful, not load-bearing */ });

  return NextResponse.json({ ok: true, alreadyYours: false, anchor_id: a.id });
}
