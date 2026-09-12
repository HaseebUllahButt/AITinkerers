import { NextResponse } from "next/server";
import { getEnrichmentRuns } from "@/lib/db/queries";

// GET — recent Email Finder runs (for the run-history list).
export async function GET() {
  return NextResponse.json(await getEnrichmentRuns(25));
}
