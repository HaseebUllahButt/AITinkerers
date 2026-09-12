import { NextRequest, NextResponse } from "next/server";
import { getOutreachEmailWithRecipient, updateOutreachEmail, getFollowupParent, addressHasOtherSentInitial } from "@/lib/db/queries";
import { deliverOutreach } from "@/lib/email/deliver";
import { isRoleEmail } from "@/lib/email/roleEmail";
import { acquireLock, releaseLock, incrDailyCount } from "@/lib/redis";
import { auth } from "@auth";
import { resolveManualSender } from "@/lib/email/manualSender";

export const maxDuration = 60;

// POST — send ONE queued email immediately, ignoring its scheduled time (the manual
// "Send now" on a queued row). Sends from the acting user's own Gmail: a pitch drafted by the
// nightly cron has no sender, so without stamping one here it would leave via the server's SMTP
// identity and never reach the person's Sent box (the reported bug).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth().catch(() => null);
  const callerEmail = session?.user?.email as string | undefined;
  if (!callerEmail) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const reqBody = await req.json().catch(() => ({} as Record<string, unknown>));

  // Per-email lock so a "Send now" click can't race the cron processor (or a second click)
  // and double-send the same email to the same person.
  const token = `sn-${id}`;
  if (!(await acquireLock(`lock:send:${id}`, 90, token))) {
    return NextResponse.json({ ok: false, error: "This email is already being sent." });
  }
  try {
    const email = await getOutreachEmailWithRecipient(id);
    if (!email) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (email.status === "sent") return NextResponse.json({ ok: true, already: true });
    if (!email.recipient) {
      await updateOutreachEmail(id, { status: "failed", error: "No recipient email address" });
      return NextResponse.json({ ok: false, error: "No recipient email address" });
    }
    if (isRoleEmail(email.recipient)) {
      await updateOutreachEmail(id, { status: "failed", error: "Skipped: generic/role address (not a person)", followup_skipped: true });
      return NextResponse.json({ ok: false, error: "generic/role address — not sent" });
    }
    const isThreadReply = (email as any).kind === "followup" || (email as any).kind === "negotiation";

    // Same send-time duplicate-inbox guard as the cron loop: never send an INITIAL to an inbox
    // that already got an initial from another thread. Not silent — the caller gets a clear
    // reason. Follow-ups / negotiation replies and admin test-sends (recipient_override) are exempt.
    if (!isThreadReply && !(email as any).recipient_override &&
        await addressHasOtherSentInitial(email.recipient, id)) {
      await updateOutreachEmail(id, { status: "failed", error: "Skipped: recipient inbox already contacted in another campaign", followup_skipped: true });
      return NextResponse.json({ ok: false, error: "This inbox was already contacted in another campaign — not sent." });
    }

    let inReplyTo: string | undefined;
    if (isThreadReply && (email as any).parent_id) {
      const parent = await getFollowupParent((email as any).parent_id).catch(() => null);
      // A nudge follow-up is skipped if they've since replied; a negotiation reply is our answer
      // TO their reply, so it always proceeds.
      if ((email as any).kind === "followup" && (parent?.replied_at || parent?.success_at)) {
        await updateOutreachEmail(id, { status: "draft", scheduled_at: null });
        return NextResponse.json({ ok: false, error: "Recipient already replied — follow-up skipped." });
      }
      inReplyTo = parent?.message_id ?? undefined;
    }

    // Resolve who this goes out as: the row's existing sender if one was stamped, else the
    // clicking user's own Gmail. Requires an app password for the chosen identity, so we never
    // fall back to the server mailbox on a real person's manual send.
    const resolved = await resolveManualSender({
      callerEmail,
      existingSender: (email as any).sender_email,
      requestedSender: typeof reqBody.sender_email === "string" ? reqBody.sender_email : null,
    });
    if (!resolved.ok) {
      return resolved.needsAppPassword
        ? NextResponse.json({ ok: false, needsAppPassword: true, sender: resolved.sender, error: resolved.reason })
        : NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
    }
    // Persist the identity on the row BEFORE sending, so a retry (or the archive) reflects who it
    // actually went out as, and the sent row groups under the real sender instead of "Default".
    // An initial sent by hand inherits the campaign policy's AI-replies switch, the same way the
    // dialog and autopilot stamp it. Without this a Send-now thread was one the negotiator would
    // never auto-answer. Best-effort: an unreadable policy leaves the row as it was (the
    // unanswered-reply sweep still drafts for a person either way).
    let aiManaged: boolean | undefined;
    if (!isThreadReply && (email as any).workflow_id && (email as any).ai_managed !== true) {
      const { getPolicyFor } = await import("@/lib/automation/policy");
      aiManaged = await getPolicyFor((email as any).workflow_id).then((p) => p.ai_replies).catch(() => undefined);
    }
    await updateOutreachEmail(id, { sender_email: resolved.sender, sent_by_email: resolved.sentBy, ...(aiManaged === undefined ? {} : { ai_managed: aiManaged }) });

    const res = await deliverOutreach({
      to: email.recipient,
      subject: email.subject ?? "(no subject)",
      body: email.body ?? "",
      sender: resolved.sender,
      sentBy: resolved.sentBy,
      inReplyTo, references: inReplyTo,
    });

    if (res.ok) {
      await updateOutreachEmail(id, { status: "sent", sent_at: new Date().toISOString(), error: undefined, message_id: res.messageId ?? undefined });
      // Count manual sends toward the sender's daily cap so the cron processor's cap stays honest
      // (manual send is intentional, so we don't hard-block it, but it must still be counted).
      await incrDailyCount(resolved.sender, new Date().toISOString().slice(0, 10)).catch(() => {});
      return NextResponse.json({ ok: true });
    }
    await updateOutreachEmail(id, { status: "failed", error: res.error });
    return NextResponse.json({ ok: false, error: res.error });
  } finally {
    await releaseLock(`lock:send:${id}`, token);
  }
}
