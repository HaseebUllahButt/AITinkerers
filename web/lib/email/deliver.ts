import { getUserEmailConfig, getUserAppPasswordEnc } from "@/lib/db/queries";
import { decryptSecret } from "@/lib/crypto";
import { sendEmailAs, type SendResult, type MailAttachment } from "./smtp";

// An outreach email nobody owns must never leave the building. The old env-SMTP fallback
// delivered unstamped rows from the server's shared identity — a real teammate's Gmail — so
// recipients got mail "from" a person who never scheduled anything, and the row's sender_email
// stayed null, so the status page couldn't even say whose mailbox it left. Refusing is the only
// honest option: the row parks as failed with this message, and Send now / Schedule stamp the
// acting person and retry it as them.
export const NO_SENDER_ERROR =
  "No sender assigned — refused to send from the shared server mailbox. Open the email and use Send now or Schedule so it goes out as you.";

// Deliver one outreach email as the stamped per-user sender, from their own Gmail (their app
// password). Shared by the batch processor and the per-email "Send now" action. When sentBy
// differs from sender (a shared-inbox send), sentBy is CC'd so they see replies and can reply too.
export async function deliverOutreach(opts: {
  to: string; subject: string; body: string; sender?: string | null; sentBy?: string | null;
  inReplyTo?: string; references?: string; // set for follow-ups so they thread into the original
  attachments?: MailAttachment[];          // e.g. a human-uploaded one-pager on an assisted negotiation reply
}): Promise<SendResult> {
  if (!opts.sender) return { ok: false, error: NO_SENDER_ERROR };
  const cc = opts.sentBy && opts.sentBy !== opts.sender ? opts.sentBy : undefined;
  const pass = decryptSecret(await getUserAppPasswordEnc(opts.sender));
  if (!pass) return { ok: false, error: `${opts.sender} hasn't set a Gmail app password (Settings → Your sending email)` };
  const cfg = await getUserEmailConfig(opts.sender);
  return sendEmailAs({ user: opts.sender, pass, fromName: cfg.from_name, to: opts.to, subject: opts.subject, body: opts.body, cc, inReplyTo: opts.inReplyTo, references: opts.references, attachments: opts.attachments });
}
