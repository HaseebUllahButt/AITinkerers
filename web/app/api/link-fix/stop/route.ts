import { NextRequest, NextResponse } from "next/server";
import { requestStop } from "@/lib/linkfix/run";
import { authorized } from "@/lib/linkfix/auth";

// POST — ask the in-flight run to stop at its next checkpoint. Work already done is kept.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await requestStop();
  return NextResponse.json({ stopping: true });
}
