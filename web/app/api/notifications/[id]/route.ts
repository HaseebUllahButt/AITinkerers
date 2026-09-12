import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { markNotificationRead } from "@/lib/db/queries";

async function currentEmail(): Promise<string | null> {
  const session = await auth().catch(() => null);
  return (session?.user?.email as string | undefined) ?? null;
}

// PATCH — mark one notification read (scoped to the current user).
export async function PATCH(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await currentEmail();
  if (!email) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const { id } = await params;
  await markNotificationRead(id, email);
  return NextResponse.json({ ok: true });
}
