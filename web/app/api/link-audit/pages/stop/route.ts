import { NextResponse } from "next/server";
import { requestPageSweepStop } from "@/lib/linkaudit/pages";

// POST — durable stop for the page sweep: a Redis flag the running chunk checks every batch,
// on whichever serverless instance (or QStash continuation) is executing it.
export async function POST() {
  await requestPageSweepStop();
  return NextResponse.json({ stopping: true });
}
