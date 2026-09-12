import { NextRequest, NextResponse } from "next/server";
import { setInboxDismissed, resolveInboxAccount } from "@/lib/db/queries";
import { auth } from "@auth";

// POST /api/inbox/[id]/dismiss  { dismissed: boolean } — push a person aside (or restore) in
// the viewed mailbox (own by default, or ?as=<account> for admins).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth().catch(() => null);
  const me = session?.user?.email;
  if (!me) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const account = await resolveInboxAccount(me, req.nextUrl.searchParams.get("as"));
  const { dismissed } = await req.json().catch(() => ({}));
  await setInboxDismissed(account, id, !!dismissed);
  return NextResponse.json({ ok: true });
}
