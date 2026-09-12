import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { removeAuthorWatch } from "@/lib/db/queries";

async function currentEmail(): Promise<string | null> {
  const session = await auth().catch(() => null);
  return (session?.user?.email as string | undefined) ?? null;
}

// DELETE — remove an author from the current user's watch list.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ authorId: string }> }) {
  const email = await currentEmail();
  if (!email) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const { authorId } = await params;
  await removeAuthorWatch(email, authorId);
  return NextResponse.json({ ok: true });
}
