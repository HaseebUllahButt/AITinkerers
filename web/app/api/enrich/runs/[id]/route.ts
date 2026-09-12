import { NextRequest, NextResponse } from "next/server";
import { getEnrichmentRun } from "@/lib/db/queries";

// GET — one past run's full detail (people + steps) to render the same activity UI.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getEnrichmentRun(id);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    running: false,
    total: run.total,
    done: run.done,
    found: run.found,
    bySource: run.by_source ?? {},
    campaignName: run.campaign_name,
    people: run.people ?? [],
  });
}
