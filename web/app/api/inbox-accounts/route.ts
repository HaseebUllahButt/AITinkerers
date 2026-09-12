import { NextResponse } from "next/server";
import { auth } from "@auth";
import { getInboxAccounts } from "@/lib/db/queries";
import { isAdminEmail } from "@/lib/auth/admin";

// GET — every team mailbox with a connected Gmail app password, so an admin can pick any of them
// in the "Send from" picker and send AS that person. Non-admins get an empty list (they can only
// send from their own email), so the picker naturally collapses to "Your own email" for them.
export async function GET() {
  const session = await auth().catch(() => null);
  const email = session?.user?.email as string | undefined;
  if (!email) return NextResponse.json([], { status: 401 });
  if (!isAdminEmail(email)) return NextResponse.json([]);
  return NextResponse.json(await getInboxAccounts());
}
