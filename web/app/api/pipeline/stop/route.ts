import { NextResponse } from "next/server";
import { requestStop } from "@/lib/pipeline/abort";

// Durable stop: aborts the local controller AND sets a Redis flag the running pipeline polls,
// so Stop works even when the run executes on a different serverless instance.
export async function POST() {
  await requestStop();
  return NextResponse.json({ stopped: true });
}
