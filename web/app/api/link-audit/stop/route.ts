import { NextResponse } from "next/server";
import { requestAuditStop } from "@/lib/linkaudit/run";

// POST — durable stop: sets a Redis flag the running chunk checks before every page, on
// whichever serverless instance (or QStash continuation) is executing it.
export async function POST() {
  await requestAuditStop();
  return NextResponse.json({ stopping: true });
}
