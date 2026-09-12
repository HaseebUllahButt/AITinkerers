import { NextResponse } from "next/server";
import { auth } from "@auth";
import { getUserNotifications } from "@/lib/db/queries";

async function currentEmail(): Promise<string | null> {
  const session = await auth().catch(() => null);
  return (session?.user?.email as string | undefined) ?? null;
}

// GET — the current user's notification feed, newest first.
export async function GET() {
  const email = await currentEmail();
  if (!email) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  return NextResponse.json(await getUserNotifications(email));
}
