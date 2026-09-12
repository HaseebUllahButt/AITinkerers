import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { listRuns } from "@/lib/indexing/persist";

export async function GET(req: NextRequest) {
  const session = await auth().catch(() => null);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 20, 100);
  const runs = await listRuns(limit);
  return NextResponse.json({ ok: true, runs });
}
