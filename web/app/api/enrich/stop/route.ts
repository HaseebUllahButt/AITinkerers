import { NextResponse } from "next/server";
import { requestAbort } from "@/lib/enrich/enrichBuffer";

// Durable abort: sets a Redis flag the run checks each author, so Stop works even when the
// run is executing on a different serverless instance than this request.
export async function POST() {
  await requestAbort();
  return NextResponse.json({ ok: true });
}
