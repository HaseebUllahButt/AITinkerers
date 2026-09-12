import { NextRequest, NextResponse } from "next/server";
import { sendEmail, verifyTransport } from "@/lib/email/smtp";
import { isAdminCaller } from "@/lib/auth/service";

// POST { to } — sends a test email to verify SMTP is working.
//
// Admin-only. This is the one route that puts mail on the wire FROM the shared env identity — a
// real teammate's Gmail — TO whatever address the caller names, and it carried no check of its
// own. The proxy meant a session was still required, so this was never open to the internet; it
// was open to every signed-in teammate, and (via the header bypasses in src/proxy.ts) to anything
// holding CRON_SECRET or HERMES_TOKEN. Sending as a named person is admin-only everywhere else in
// this app; there is no reason for the diagnostic to be the exception.
export async function POST(req: NextRequest) {
  const gate = await isAdminCaller(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

  const { to } = await req.json().catch(() => ({}));
  if (!to) return NextResponse.json({ error: "recipient 'to' required" }, { status: 400 });

  const result = await sendEmail({
    to,
    subject: "SearchOps — test email",
    body: `Hi,\n\nThis is a test email from SearchOps confirming the outbound SMTP sender is configured and working.\n\nIf you're reading this, emails will send from ${process.env.SMTP_FROM_EMAIL ?? process.env.SMTP_USER}.\n\n— SearchOps`,
  });

  const status = result.ok ? 200 : 500;
  return NextResponse.json(result, { status });
}

// GET — verify the SMTP connection without sending. Nothing goes out, but a bare
// "are these credentials live?" probe on the shared mailbox is not public information either.
export async function GET(req: NextRequest) {
  const gate = await isAdminCaller(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

  const result = await verifyTransport();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
