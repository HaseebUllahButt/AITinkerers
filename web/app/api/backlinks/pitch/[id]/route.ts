import { NextRequest, NextResponse } from "next/server";
import { identifyCaller, actorFor } from "@/lib/auth/service";
import { supabaseAdmin } from "@/lib/db/supabase";

export const maxDuration = 20;

/**
 * Read and edit one AI-drafted pitch, by its outreach_emails id.
 *
 * This exists because the drafts were invisible. The nightly cron writes them as `ready`
 * outreach_emails, and a teammate reported "I cannot find the option to see / edit the pitches written
 * by AI" — correctly, because there was no surface for them anywhere. A queue of unreviewed AI drafts
 * that nobody can read is worse than no drafts: it looks like progress while being unauditable.
 *
 * PATCH only accepts `subject` and `body`. Deliberately narrow: status, scheduling, recipient and
 * threading are all decided by the send pipeline's own guards (the email-trust gate, the duplicate-inbox
 * guard, suppression). Letting an editor set `status: "scheduled"` from here would route around every one
 * of them.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const { data, error } = await supabaseAdmin
    .from("outreach_emails")
    .select("id, subject, body, status, sent_at, scheduled_at, edited_at, edited_by, author_id, kind")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

  const m = data as any;
  return NextResponse.json({
    ok: true,
    pitch: { ...m, editable: !m.sent_at && m.status !== "sent" },
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await identifyCaller(req);
  const actor = actorFor(caller);
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const { data: current, error: currentError } = await supabaseAdmin
    .from("outreach_emails")
    .select("id, status, sent_at")
    .eq("id", id)
    .maybeSingle();
  // The GET in this file already did this right; the PATCH answered "not found" on a failed read
  // for a pitch the person had open in the editor.
  if (currentError) return NextResponse.json({ error: `Could not read the pitch (${currentError.message}). Nothing was saved.` }, { status: 503 });
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  // An already-sent pitch is a record of what actually went out. Editing it would make the archive lie
  // about the conversation the recipient is having with us, which matters as soon as they reply.
  const c = current as any;
  if (c.sent_at || c.status === "sent") {
    return NextResponse.json(
      { error: "This pitch has already been sent and cannot be edited. Reply on the thread from the Inbox instead." },
      { status: 409 },
    );
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.subject === "string") {
    const s = body.subject.trim();
    if (!s) return NextResponse.json({ error: "subject cannot be empty" }, { status: 400 });
    if (s.length > 200) return NextResponse.json({ error: "subject is too long (200 max)" }, { status: 400 });
    patch.subject = s;
  }
  if (typeof body.body === "string") {
    const b = body.body.trim();
    if (!b) return NextResponse.json({ error: "body cannot be empty" }, { status: 400 });
    patch.body = b;
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "nothing to update — send subject and/or body" }, { status: 400 });
  }

  // Records that a human has been through it, which is the whole point of the review surface: the funnel
  // can then distinguish "AI wrote this and nobody looked" from "a person approved this wording".
  patch.edited_at = new Date().toISOString();
  patch.edited_by = actor;

  const { data, error } = await supabaseAdmin
    .from("outreach_emails")
    .update(patch)
    .eq("id", id)
    // Re-assert unsent in the WHERE clause, not just the read above: a send run between the check and the
    // write would otherwise let an edit land on a message already on the wire.
    .is("sent_at", null)
    .select("id, subject, body, status, edited_at, edited_by")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) {
    return NextResponse.json({ error: "This pitch was sent while you were editing it." }, { status: 409 });
  }

  return NextResponse.json({ ok: true, pitch: data });
}
