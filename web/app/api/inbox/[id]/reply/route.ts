import { NextRequest, NextResponse } from "next/server";
import { getInboxTarget, getUserEmailConfig, getUserAppPasswordEnc, markInboxReplied } from "@/lib/db/queries";
import { supabaseAdmin } from "@/lib/db/supabase";
import { decryptSecret } from "@/lib/crypto";
import { sendEmailAs, type MailAttachment } from "@/lib/email/smtp";
import { resolveInboxSender } from "@/lib/email/manualSender";
import { auth } from "@auth";

export const maxDuration = 60;

// POST /api/inbox/[id]/reply — send a reply into the conversation thread, with optional image
// attachments, from the mailbox that owns the thread. Threads via In-Reply-To/References so it
// nests correctly in Gmail.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const text = (body.body ?? "").toString().trim();
  const to = (body.to ?? "").toString().trim();
  let subject = (body.subject ?? "").toString().trim();
  const inReplyTo = body.inReplyTo ? String(body.inReplyTo) : undefined;
  if (!text) return NextResponse.json({ error: "Message body is required." }, { status: 400 });

  const session = await auth().catch(() => null);
  const me = session?.user?.email;
  if (!me) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  // Reading any team inbox is open; SENDING from someone else's is admin-only. Resolved before
  // anything else so a reply that isn't allowed to go out costs no reads and no partial work.
  const resolved = await resolveInboxSender({ actor: me, requestedAs: req.nextUrl.searchParams.get("as") });
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  const account = resolved.account;

  const target = await getInboxTarget(id, account);
  if (!target) return NextResponse.json({ error: "No conversation with this person in this mailbox." }, { status: 404 });

  // Don't let a human reply collide with the AI negotiator. If this author's thread is AI-managed
  // and still actively negotiating, block the manual send (unless the caller explicitly overrides)
  // and point them to the Negotiation page to take it over there.
  if (!body.overrideAiManaged) {
    const { data: anchor, error: anchorError } = await supabaseAdmin.from("outreach_emails")
      .select("ai_managed, negotiation_status").eq("author_id", id).eq("kind", "initial")
      .order("sent_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    // Fail closed: a guard that cannot read must not let a human reply collide with the AI
    // negotiator on the same publisher.
    if (anchorError) {
      return NextResponse.json({ error: `Could not check whether the AI owns this thread (${anchorError.message}). Nothing was sent.` }, { status: 503 });
    }
    if ((anchor as any)?.ai_managed && [null, "negotiating"].includes((anchor as any)?.negotiation_status ?? null)) {
      return NextResponse.json({ error: "This thread is being handled by the AI negotiator. Take it over on the Negotiation page (Hand off) before replying here.", aiManaged: true }, { status: 409 });
    }
  }
  const recipient = to || target.recipient;
  if (!subject) subject = /^re:/i.test(target.lastSubject) ? target.lastSubject : `Re: ${target.lastSubject || "our conversation"}`;

  // Normalize attachments: accept data URLs or raw base64.
  const attachments: MailAttachment[] = Array.isArray(body.attachments)
    ? body.attachments.slice(0, 10).map((a: any) => {
        const raw = String(a.content ?? "");
        const m = raw.match(/^data:([^;]+);base64,(.*)$/);
        return { filename: a.filename || "attachment", content: m ? m[2] : raw.replace(/^data:.*?base64,/, ""), encoding: "base64", contentType: a.contentType || (m ? m[1] : undefined) };
      }).filter((a: MailAttachment) => a.content)
    : [];

  // Send from the mailbox that owns the thread (own by default, or an admin's ?as= account).
  const inReplyToFmt = inReplyTo ? (inReplyTo.startsWith("<") ? inReplyTo : `<${inReplyTo}>`) : undefined;
  // When an admin sends as someone else, CC them: the same rule deliverOutreach applies to a
  // shared-inbox send, and — since a manual reply writes no outreach_emails row — the only durable
  // record that this left their mailbox on someone else's click.
  const cc = resolved.sentBy.toLowerCase() !== account.toLowerCase() ? resolved.sentBy : undefined;

  try {
    // No env-SMTP fallback. This used to reach for process.env.SMTP_PASS whenever the mailbox
    // being replied from was the server identity, which is a real teammate's Gmail — the last
    // path by which outreach could leave a person's mailbox on credentials they never granted
    // (and, with ?as= ungated as it was, on somebody else's click). The app password is the only
    // way in now, exactly as it is for every other outbound path.
    const pass = decryptSecret(await getUserAppPasswordEnc(account));
    if (!pass) return NextResponse.json({ error: `No Gmail app password on file for ${account}. Add it in Settings to reply from this mailbox.` }, { status: 400 });
    const cfg = await getUserEmailConfig(account);
    const res = await sendEmailAs({ user: account, pass, fromName: cfg.from_name, to: recipient, subject, body: text, cc, inReplyTo: inReplyToFmt, references: inReplyToFmt, attachments });
    if (!res.ok) return NextResponse.json({ error: res.error ?? "Send failed" }, { status: 500 });
    // Record our reply so this thread leaves the "Needs your reply" section.
    await markInboxReplied(account, id).catch(() => {});
    return NextResponse.json({ ok: true, messageId: res.messageId, from: account, to: recipient, subject });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Send failed" }, { status: 500 });
  }
}
