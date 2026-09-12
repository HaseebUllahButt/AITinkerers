import { NextRequest, NextResponse } from "next/server";
import { getLearnedSources, promoteLearnedSource, rejectLearnedSource } from "@/lib/learn";

export async function GET() {
  const sources = await getLearnedSources();
  return NextResponse.json(sources);
}

export async function POST(req: NextRequest) {
  const { id, action } = await req.json();
  if (!id || !action) return NextResponse.json({ error: "id and action required" }, { status: 400 });

  if (action === "promote") await promoteLearnedSource(id);
  else if (action === "reject") await rejectLearnedSource(id);
  else return NextResponse.json({ error: "unknown action" }, { status: 400 });

  return NextResponse.json({ ok: true });
}
