import { NextRequest, NextResponse } from "next/server";
import { getFinderCounts } from "@/lib/db/queries";

// How many prospects (campaign, or all) still lack an email (default) or a LinkedIn —
// and the total pool, so the UI can show "N of M total".
export async function GET(req: NextRequest) {
  const campaignId = req.nextUrl.searchParams.get("campaign_id") ?? undefined;
  const mode = req.nextUrl.searchParams.get("mode") === "linkedin" ? "linkedin" : "email";
  const onlyNew = req.nextUrl.searchParams.get("only_new") === "true";
  try {
    const { total, needing } = await getFinderCounts(campaignId, mode, onlyNew);
    return NextResponse.json({ count: needing, total });
  } catch (e) {
    return NextResponse.json({ error: `The database did not answer (${e instanceof Error ? e.message : "read failed"}).` }, { status: 503 });
  }
}
