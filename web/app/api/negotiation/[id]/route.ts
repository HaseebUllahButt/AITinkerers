import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";
import { getConversation, getNegotiationActivity, logNegotiationActivity, markInboxReplied } from "@/lib/db/queries";
import { deliverOutreach } from "@/lib/email/deliver";
import { resolveManualSender } from "@/lib/email/manualSender";
import { auth } from "@auth";

export const maxDuration = 60;

// GET /api/negotiation/[id] — the full conversation for a thread anchor + its current AI draft
// (the latest kind='negotiation' row), so the Negotiation page can show and let you read it.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const [conversation, { data: draftRow }, activity] = await Promise.all([
      getConversation(id),
      supabaseAdmin.from("outreach_emails")
        .select("id, body, status, subject, created_at").eq("parent_id", id).eq("kind", "negotiation")
        .in("status", ["draft", "failed"]) // only an actionable (unsent) draft; a sent reply is history, not a draft
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      getNegotiationActivity(id),
    ]);
    return NextResponse.json({ conversation, draft: draftRow ?? null, activity });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}

// POST /api/negotiation/[id] — act on a thread (anchor id).
//  { action: 'send' | 'discard', body? }  — send/discard the current draft.
//  { action: 'assist', assistInput }      — human supplies a link/fact/availability/redirect email
//                                            (a document is uploaded separately via /asset), then the
//                                            AI drafts a TRUTHFUL reply; leaves the human-intervention bucket.
//  { action: 'handoff' }                   — take the thread out of AI management (a person handles it).
//  { action: 'mark_answered' }             — a person answered this reply straight from Gmail; record it
//                                            so the thread leaves Needs reply (and the SLA view) honestly.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { action, body: editedBody, assistInput: rawAssist } = await req.json().catch(() => ({}));
    const session = await auth().catch(() => null);
    const me = (session?.user?.email as string | undefined) || "unknown";

    // HANDOFF — remove from AI, clear any unsent draft.
    if (action === "handoff") {
      await supabaseAdmin.from("outreach_emails").delete().eq("parent_id", id).eq("kind", "negotiation").eq("status", "draft");
      await supabaseAdmin.from("outreach_emails").update({ negotiation_status: "handoff", ai_managed: false, intervention_at: new Date().toISOString() }).eq("id", id);
      await logNegotiationActivity(id, me, "handoff", "took the thread out of AI management");
      return NextResponse.json({ ok: true, handoff: true });
    }

    // MARK ANSWERED — the reply was answered outside the app (Gmail directly). The only durable
    // record of a manual answer is inbox_state.last_reply_at, which is what the unanswered view
    // reads, so stamping it here is what makes the thread leave Needs reply. Recorded against the
    // thread's sending mailbox so the Inbox for that mailbox agrees.
    if (action === "mark_answered") {
      const { data: anchor, error: anchorError } = await supabaseAdmin.from("outreach_emails")
        .select("author_id, sender_email").eq("id", id).maybeSingle();
      if (anchorError) return NextResponse.json({ error: `Could not read the thread (${anchorError.message}). Nothing was marked.` }, { status: 503 });
      if (!anchor) return NextResponse.json({ error: "thread not found" }, { status: 404 });
      const mailbox = (anchor as any).sender_email || me;
      if (!mailbox || mailbox === "unknown") return NextResponse.json({ error: "This thread has no sending mailbox and you are not signed in, so there is nothing to record the answer against." }, { status: 400 });
      await markInboxReplied(mailbox, (anchor as any).author_id);
      await logNegotiationActivity(id, me, "mark_answered", "marked the reply as answered outside the app");
      return NextResponse.json({ ok: true, answered: true });
    }

    // ASSIST — the human provided what the AI needed; draft a truthful reply for review.
    if (action === "assist") {
      let assistInput = typeof rawAssist === "string" ? rawAssist.trim() : "";
      const { data: anchor, error: anchorError } = await supabaseAdmin.from("outreach_emails")
        .select("intervention_type, intervention_asset_name").eq("id", id).maybeSingle();
      // Fail closed: on a failed read the redirect re-targeting silently skips and the assist
      // proceeds against the wrong intervention state.
      if (anchorError) return NextResponse.json({ error: `Could not read the thread (${anchorError.message}). Nothing was drafted.` }, { status: 503 });
      const itype = (anchor as any)?.intervention_type;
      const hasAsset = !!(anchor as any)?.intervention_asset_name;
      // Redirect: the assist input is the new address — re-target the whole thread to it.
      if (itype === "redirect" && /\S+@\S+\.\S+/.test(assistInput)) {
        await supabaseAdmin.from("outreach_emails").update({ recipient_override: assistInput }).or(`id.eq.${id},parent_id.eq.${id}`);
      }
      if (!assistInput && hasAsset) assistInput = "The requested document is attached to this email.";
      if (!assistInput) return NextResponse.json({ error: "Add a link, note, email, or upload a document so the AI can reply truthfully." }, { status: 400 });
      const { negotiateThread } = await import("@/lib/negotiation/run");
      const r = await negotiateThread(id, { assistInput, forceDraft: true });
      if (r.error) return NextResponse.json({ error: r.error }, { status: 500 });
      await logNegotiationActivity(id, me, "assist", `provided info${hasAsset ? " + document" : ""}, AI drafted a reply`);
      return NextResponse.json({ ok: true, draft: r.body ?? "" });
    }

    const { data: draft, error: draftError } = await supabaseAdmin.from("outreach_emails")
      .select("id, body, subject, sender_email, sent_by_email, author_id, recipient_override")
      .eq("parent_id", id).eq("kind", "negotiation").in("status", ["draft", "failed"])
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    // A DB error is not "no draft" — the draft the person is looking at exists.
    if (draftError) return NextResponse.json({ error: `Could not read the draft (${draftError.message}). Nothing was sent.` }, { status: 503 });
    if (!draft) return NextResponse.json({ error: "No draft to act on" }, { status: 404 });

    if (action === "discard") {
      await supabaseAdmin.from("outreach_emails").delete().eq("id", (draft as any).id);
      await logNegotiationActivity(id, me, "discard", "discarded the AI draft");
      return NextResponse.json({ ok: true, discarded: true });
    }
    if (action !== "send") return NextResponse.json({ error: "bad action" }, { status: 400 });

    const bodyToSend = typeof editedBody === "string" && editedBody.trim() ? editedBody.trim() : (draft as any).body;
    const { data: mc, error: mcError } = await supabaseAdmin.from("contacts").select("value").eq("author_id", (draft as any).author_id).eq("type", "mailto").limit(1).maybeSingle();
    // Fail closed: "no recipient on file" must be a fact about the author, never about the read.
    if (mcError) return NextResponse.json({ error: `Could not read the recipient (${mcError.message}). Nothing was sent.` }, { status: 503 });
    const recipient = ((draft as any).recipient_override && (draft as any).recipient_override.trim())
      || ((mc as any)?.value ?? "").replace(/^mailto:/i, "").trim();
    if (!recipient) return NextResponse.json({ error: "No recipient email on file for this author" }, { status: 400 });
    const { data: parent, error: parentError } = await supabaseAdmin.from("outreach_emails").select("message_id, intervention_asset_name, intervention_asset_mime, intervention_asset_b64").eq("id", id).maybeSingle();
    // Fail closed, hardest of all: on this read failing, the reply used to SEND anyway —
    // un-threaded and with no attachment — while its body promised "the requested document is
    // attached". An outbound email must never lie because a SELECT timed out.
    if (parentError) return NextResponse.json({ error: `Could not read the thread's attachment/threading state (${parentError.message}). Nothing was sent.` }, { status: 503 });
    const parentMsgId = (parent as any)?.message_id ?? undefined;
    // Attach any human-uploaded document (one-pager etc.) parked on the anchor for this reply.
    const attachments = (parent as any)?.intervention_asset_b64
      ? [{ filename: (parent as any).intervention_asset_name || "attachment", content: (parent as any).intervention_asset_b64, encoding: "base64", contentType: (parent as any).intervention_asset_mime || undefined }]
      : undefined;

    // A legacy thread whose initial was never stamped has no mailbox to reply as (deliverOutreach
    // refuses unstamped sends now — no more server-mailbox fallback). This is a person clicking
    // Send, so resolve THEM as the sender — the same contract as Send now — and stamp the draft so
    // the rest of the thread lives in their mailbox too.
    let sender = (draft as any).sender_email as string | null;
    let sentBy = (draft as any).sent_by_email as string | null;
    if (!sender) {
      if (!session?.user?.email) return NextResponse.json({ error: "not signed in" }, { status: 401 });
      const resolved = await resolveManualSender({ callerEmail: me, existingSender: null });
      if (!resolved.ok) {
        return resolved.needsAppPassword
          ? NextResponse.json({ error: resolved.reason }, { status: 400 })
          : NextResponse.json({ error: resolved.error }, { status: resolved.status });
      }
      sender = resolved.sender; sentBy = resolved.sentBy;
      await supabaseAdmin.from("outreach_emails").update({ sender_email: sender, sent_by_email: sentBy }).eq("id", (draft as any).id);
    }
    const res = await deliverOutreach({
      to: recipient, subject: (draft as any).subject ?? "(no subject)", body: bodyToSend,
      sender, sentBy,
      inReplyTo: parentMsgId, references: parentMsgId, attachments,
    });
    if (!res.ok) {
      await supabaseAdmin.from("outreach_emails").update({ status: "failed", error: res.error, body: bodyToSend }).eq("id", (draft as any).id);
      return NextResponse.json({ error: res.error ?? "send failed" }, { status: 500 });
    }
    await supabaseAdmin.from("outreach_emails").update({ status: "sent", sent_at: new Date().toISOString(), message_id: res.messageId ?? null, error: null, body: bodyToSend }).eq("id", (draft as any).id);
    // The attachment has now gone out once — clear it so a later reply doesn't re-attach it.
    if (attachments) await supabaseAdmin.from("outreach_emails").update({ intervention_asset_name: null, intervention_asset_mime: null, intervention_asset_b64: null }).eq("id", id);
    await logNegotiationActivity(id, me, "send", `sent a reply to ${recipient}${attachments ? " (with attachment)" : ""}`);
    return NextResponse.json({ ok: true, sent: true, to: recipient });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "failed" }, { status: 500 });
  }
}
