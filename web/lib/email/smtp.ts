import nodemailer, { type Transporter } from "nodemailer";

// Single reusable SMTP transport, built from .env.local credentials.
// Gmail app password auth over implicit TLS (port 465).
let transporter: Transporter | null = null;

export function getTransport(): Transporter | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  if (!transporter) {
    const port = Number(process.env.SMTP_PORT ?? 465);
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 465 = implicit TLS, 587 = STARTTLS
      auth: { user, pass },
    });
  }
  return transporter;
}

export function fromAddress(overrideName?: string, overrideEmail?: string): string {
  const name = overrideName ?? process.env.SMTP_FROM_NAME ?? "";
  const email = overrideEmail ?? process.env.SMTP_FROM_EMAIL ?? process.env.SMTP_USER ?? "";
  return name ? `"${name}" <${email}>` : email;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  body: string;
  fromName?: string;
  fromEmail?: string;
  cc?: string;
  inReplyTo?: string;   // original Message-ID — threads a follow-up into the same thread
  references?: string;
}): Promise<SendResult> {
  const tx = getTransport();
  if (!tx) return { ok: false, error: "SMTP not configured (missing SMTP_HOST/USER/PASS)" };

  try {
    const info = await tx.sendMail({
      from: fromAddress(opts.fromName, opts.fromEmail),
      to: opts.to,
      cc: opts.cc,
      subject: opts.subject,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
      text: opts.body,
      // Simple text→HTML: preserve line breaks
      html: opts.body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>"),
    });
    return { ok: true, messageId: info.messageId };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "send failed" };
  }
}

function htmlify(body: string): string {
  return body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
}

// Send as a SPECIFIC user via their own Gmail app password (per-user sending). Builds a
// throwaway transport for that identity — correct even if the password changed. cc is used
// to loop in whoever actually initiated the send when it's going out through a shared inbox,
// so they see replies and can reply themselves.
export interface MailAttachment { filename: string; content: string; encoding?: string; contentType?: string }

export async function sendEmailAs(opts: {
  user: string; pass: string; fromName?: string; to: string; subject: string; body: string; cc?: string;
  inReplyTo?: string; references?: string; // thread a follow-up into the original thread
  attachments?: MailAttachment[];
}): Promise<SendResult> {
  try {
    const tx = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: opts.user, pass: opts.pass } });
    const from = opts.fromName ? `"${opts.fromName}" <${opts.user}>` : opts.user;
    const info = await tx.sendMail({ from, to: opts.to, cc: opts.cc, subject: opts.subject, inReplyTo: opts.inReplyTo, references: opts.references, text: opts.body, html: htmlify(opts.body), attachments: opts.attachments });
    tx.close();
    return { ok: true, messageId: info.messageId };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "send failed" };
  }
}

// Pooled transport for BURST sending from one Gmail account. Reuses a few authenticated
// connections across many messages (one login per connection, not per email) so a big
// one-shot batch (hundreds/thousands) sends fast without tripping Gmail's per-login limits.
// Caller must close() it when the batch is done.
export function createPooledUserTransport(user: string, pass: string): Transporter {
  return nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user, pass },
    pool: true, maxConnections: 5, maxMessages: 200,
  });
}

// Send one message over an already-built (pooled) transport. Same shaping as sendEmailAs but
// without creating/closing a transport per call.
export async function sendVia(tx: Transporter, opts: {
  user: string; fromName?: string; to: string; subject: string; body: string; cc?: string;
  inReplyTo?: string; references?: string; attachments?: MailAttachment[];
}): Promise<SendResult> {
  try {
    const from = opts.fromName ? `"${opts.fromName}" <${opts.user}>` : opts.user;
    const info = await tx.sendMail({ from, to: opts.to, cc: opts.cc, subject: opts.subject, inReplyTo: opts.inReplyTo, references: opts.references, text: opts.body, html: htmlify(opts.body), attachments: opts.attachments });
    return { ok: true, messageId: info.messageId };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "send failed" };
  }
}

// Verify a user's Gmail app password without sending (Settings "test connection").
export async function verifyGmail(user: string, pass: string): Promise<SendResult> {
  try {
    const tx = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
    await tx.verify();
    tx.close();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "verify failed" };
  }
}

// Verify the SMTP connection/credentials without sending anything.
export async function verifyTransport(): Promise<SendResult> {
  const tx = getTransport();
  if (!tx) return { ok: false, error: "SMTP not configured" };
  try {
    await tx.verify();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "verify failed" };
  }
}
