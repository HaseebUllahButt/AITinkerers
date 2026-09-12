import { NextRequest, NextResponse } from "next/server";
import { getInboxTarget, getUserAppPasswordEnc, markInboxSeen, markInboxReplied, resolveInboxAccount } from "@/lib/db/queries";
import { decryptSecret } from "@/lib/crypto";
import { fetchConversation } from "@/lib/email/inbox";
import { auth } from "@auth";

export const maxDuration = 60;

// GET /api/inbox/[id] — live IMAP conversation. Defaults to the logged-in user's mailbox;
// ?as=<account> reads another team mailbox (admin switcher).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth().catch(() => null);
  const me = session?.user?.email;
  if (!me) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const account = await resolveInboxAccount(me, _req.nextUrl.searchParams.get("as"));

  const target = await getInboxTarget(id, account);
  if (!target) return NextResponse.json({ error: "No conversation with this person in this mailbox." }, { status: 404 });
  await markInboxSeen(account, id).catch(() => {}); // opening the thread clears unread

  const isEnvOwner = !!process.env.SMTP_USER && account.toLowerCase() === process.env.SMTP_USER.toLowerCase();
  const pass = decryptSecret(await getUserAppPasswordEnc(account)) ?? (isEnvOwner ? (process.env.SMTP_PASS ?? null) : null);
  if (!account || !pass) {
    return NextResponse.json({ error: `No mailbox credentials on file for ${account}. Add a Gmail app password in Settings to read this inbox.`, target, messages: [] }, { status: 200 });
  }

  try {
    const messages = await fetchConversation(account, pass, target.recipient);
    // Self-heal "Needs your reply": if the real last outbound in the thread is ours, record it so a
    // thread we already answered (incl. before reply-tracking existed) stops showing as needing one.
    const lastOut = messages.filter((m: any) => m.direction === "outbound").map((m: any) => m.date).filter(Boolean).sort().pop();
    if (lastOut) await markInboxReplied(account, id, lastOut).catch(() => {});
    return NextResponse.json({ target: { ...target, account }, messages });
  } catch (e: any) {
    return NextResponse.json({ error: `Couldn't read the mailbox: ${e?.message ?? "IMAP error"}`, target: { ...target, account }, messages: [] }, { status: 200 });
  }
}
