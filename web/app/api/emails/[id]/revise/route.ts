import { NextRequest, NextResponse } from "next/server";
import { identifyCaller } from "@/lib/auth/service";
import { supabaseAdmin } from "@/lib/db/supabase";
import { revisePitch } from "@/lib/email/pitchRevise";
import { isPitchTone } from "@/lib/email/pitchTones";
import { loadPitchGrounding } from "@/lib/email/pitchGrounding";

export const maxDuration = 60;

// POST /api/emails/:id/revise — AI-rewrite one outreach pitch and return the proposal.
//
// Returns the replacement subject/body and does NOT write them (the blog revise route's
// contract). The client splices the proposal into the open editor, the person reviews it, and the
// save goes through the normal PATCH — which is what stamps who reviewed the wording. The id only
// authorizes and grounds the rewrite; the TEXT rewritten is what the request carries, so unsaved
// on-screen edits are what get rewritten, not the stale stored copy.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const { data: email, error: emailError } = await supabaseAdmin
    .from("outreach_emails")
    .select("id, status, sent_at, author_id, workflow_id")
    .eq("id", id)
    .maybeSingle();
  if (emailError) return NextResponse.json({ ok: false, error: emailError.message }, { status: 503 });
  if (!email) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  const e = email as any;
  if (e.sent_at || e.status === "sent") {
    return NextResponse.json(
      { ok: false, error: "This pitch has already been sent — its wording is a record now. Reply on the thread from the Inbox instead." },
      { status: 409 },
    );
  }

  const body = await req.json().catch(() => null);
  const subject = String(body?.subject ?? "");
  const text = String(body?.body ?? "");
  if (!text.trim()) return NextResponse.json({ ok: false, error: "There is no pitch text to rewrite." }, { status: 400 });
  if (text.length > 20_000) return NextResponse.json({ ok: false, error: "That's too long for a pitch rewrite." }, { status: 400 });
  if (body?.tone != null && !isPitchTone(body.tone)) {
    return NextResponse.json({ ok: false, error: "Unknown tone." }, { status: 400 });
  }

  // Grounding, best-effort (shared with the workflow-wide apply): who the pitch reaches and which
  // article it is about.
  const context = await loadPitchGrounding({ id, author_id: e.author_id, workflow_id: e.workflow_id });

  const result = await revisePitch({
    tone: typeof body?.tone === "string" ? body.tone : undefined,
    instruction: typeof body?.instruction === "string" ? body.instruction : undefined,
    subject,
    body: text,
    context,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
