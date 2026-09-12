import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getRunReport } from "@/lib/indexing/persist";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth().catch(() => null);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const report = await getRunReport(id);
  if (!report) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, report });
}
