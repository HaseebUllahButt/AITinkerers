import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { addAuthorWatch, getUserWatches } from "@/lib/db/queries";

async function currentEmail(): Promise<string | null> {
  const session = await auth().catch(() => null);
  return (session?.user?.email as string | undefined) ?? null;
}

// GET — the current user's watched authors, with last-checked timestamp.
export async function GET() {
  const email = await currentEmail();
  if (!email) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  return NextResponse.json(await getUserWatches(email));
}

// POST — add an author to the current user's watch list.
export async function POST(req: NextRequest) {
  const email = await currentEmail();
  if (!email) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const { author_id } = await req.json().catch(() => ({}));
  if (!author_id) return NextResponse.json({ error: "author_id required" }, { status: 400 });
  await addAuthorWatch(email, author_id);
  return NextResponse.json({ ok: true }, { status: 201 });
}
