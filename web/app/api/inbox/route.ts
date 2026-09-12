import { NextRequest, NextResponse } from "next/server";
import { getInboxList, getSharedSenders, getInboxAccounts, resolveInboxAccount } from "@/lib/db/queries";
import { auth } from "@auth";

// GET /api/inbox — a team mailbox grouped into Responses / Awaiting / Filtered. Defaults to the
// logged-in user's own mailbox; pass ?as=<account> to view another team inbox (admin switcher).
// Also returns the list of accounts to populate that switcher.
export async function GET(req: NextRequest) {
  const session = await auth().catch(() => null);
  const me = session?.user?.email;
  if (!me) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const as = req.nextUrl.searchParams.get("as");
  try {
  const viewing = await resolveInboxAccount(me, as);
  // Viewing another teammate's inbox is open to everyone; SENDING from it is admin-only (see
  // resolveInboxSender). The page needs to know which it has, so a reply box that would be
  // refused is never offered in the first place.
  const { isAdminEmail } = await import("@/lib/auth/admin");
  const canSend = viewing.toLowerCase() === me.toLowerCase() || isAdminEmail(me);
  // Email only. WhatsApp vendor chats used to ride along in this list and were reported as
  // impossible to find ("bilkul samajh nahi aa raha") — they live on their own page now,
  // /whatsapp, fed by GET /api/whatsapp/vendors.
  const [people, shared, accounts] = await Promise.all([getInboxList(viewing), getSharedSenders(), getInboxAccounts()]);
  const labelByEmail = new Map(shared.map((s) => [s.email, s.label]));
  const enriched = people
    .map((p) => ({ ...p, sender_label: p.sender_email ? labelByEmail.get(p.sender_email) ?? null : null }))
    .sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? ""));
  const active = enriched.filter((p) => !p.dismissed); // dismissed excluded from the main tabs
  const counts = {
    unread: active.filter((p) => p.unread).length,
    needs_reply: active.filter((p) => p.needs_reply).length,
    replied: active.filter((p) => p.category === "replied").length,
    sent: active.filter((p) => p.category === "sent").length,
    filtered: active.filter((p) => p.category === "filtered").length,
    dismissed: enriched.filter((p) => p.dismissed).length,
  };
  return NextResponse.json({ people: enriched, counts, accounts, viewing, me, canSend });
  } catch (e) {
    // getInboxList & co. throw on read errors now — a failed read is not an empty inbox.
    return NextResponse.json({ error: `The database did not answer (${e instanceof Error ? e.message : "read failed"}). Your inbox is not empty.` }, { status: 503 });
  }
}
