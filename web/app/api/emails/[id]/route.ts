import { NextRequest, NextResponse } from "next/server";
import { getOutreachEmail, updateOutreachEmail } from "@/lib/db/queries";
import { auth } from "@auth";
import { resolveManualSender } from "@/lib/email/manualSender";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const email = await getOutreachEmail(id);
  if (!email) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(email);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const session = await auth().catch(() => null);
    const callerEmail = session?.user?.email as string | undefined;
    if (!callerEmail) return NextResponse.json({ error: "not signed in" }, { status: 401 });

    const body = await req.json();

    // WORDING edits get the same two protections the backlinks pitch route has always had, because
    // /emails and /sending both save through here: a sent email's text is the record of a live
    // conversation (409, not a silent no-op), and a change of wording records who made it — the
    // funnel's "Reviewed" state depends on edited_by being written.
    if (typeof body.subject === "string" || typeof body.body === "string") {
      const email = await getOutreachEmail(id);
      if (!email) return NextResponse.json({ error: "not found" }, { status: 404 });
      if ((email as any).sent_at || email.status === "sent") {
        return NextResponse.json(
          { error: "This email has already been sent and its wording cannot be changed. Reply on the thread from the Inbox instead." },
          { status: 409 },
        );
      }
      body.edited_at = new Date().toISOString();
      body.edited_by = callerEmail;
    }

    // SCHEDULING a cron-drafted pitch: it has no sender_email, so a scheduled row would later be
    // delivered by the cron from the server's SMTP identity (never the person's Gmail — the
    // reported "unable to schedule / didn't land in Sent" bug). Stamp the acting user's own Gmail
    // now, requiring their app password, exactly as the batch-send route and Send-now do. Any
    // other PATCH (unschedule, edit, mark-win) is untouched.
    if (body?.status === "scheduled") {
      const email = await getOutreachEmail(id);
      if (!email) return NextResponse.json({ error: "not found" }, { status: 404 });
      if (!(email as any).sender_email) {
        const resolved = await resolveManualSender({
          callerEmail,
          existingSender: null,
          requestedSender: typeof body.sender_email === "string" ? body.sender_email : null,
        });
        if (!resolved.ok) {
          return resolved.needsAppPassword
            ? NextResponse.json({ ok: false, needsAppPassword: true, sender: resolved.sender, error: resolved.reason })
            : NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
        }
        body.sender_email = resolved.sender;
        body.sent_by_email = resolved.sentBy;
      }
    }

    await updateOutreachEmail(id, body);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
