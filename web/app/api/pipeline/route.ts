import { NextResponse } from "next/server";
import { getPipelineRuns } from "@/lib/db/queries";

export async function GET() {
  try {
    return NextResponse.json(await getPipelineRuns(20));
  } catch (e) {
    return NextResponse.json({ error: `The database did not answer (${e instanceof Error ? e.message : "read failed"}).` }, { status: 503 });
  }
}
