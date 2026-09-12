import { NextRequest, NextResponse } from "next/server";
import { getScoreStats } from "@/lib/db/queries";

// GET ?campaign_id= — composite-score distribution to guide the min-score filter.
export async function GET(req: NextRequest) {
  const campaignId = req.nextUrl.searchParams.get("campaign_id") ?? undefined;
  return NextResponse.json(await getScoreStats(campaignId));
}
