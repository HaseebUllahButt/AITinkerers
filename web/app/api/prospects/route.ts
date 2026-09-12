import { NextRequest, NextResponse } from "next/server";
import { getProspects, getDashboardStats, getToolMentionCounts, getFreshnessTimeline, getSourceProvenance, getTopPublications } from "@/lib/db/queries";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const limit = parseInt(searchParams.get("limit") ?? "24");
  const offset = parseInt(searchParams.get("offset") ?? "0");
  const minScore = searchParams.get("minScore") ? parseFloat(searchParams.get("minScore")!) : undefined;
  const archetype = searchParams.get("archetype") ?? undefined;
  const tool = searchParams.get("tool") ?? undefined;
  const hasContact = searchParams.get("hasContact") === "true" ? true : undefined;
  const emailStatus = (searchParams.get("email_status") as any) ?? undefined;
  const search = searchParams.get("search") ?? undefined;
  const sortBy = (searchParams.get("sortBy") as any) ?? "composite";
  const include = searchParams.get("include") ?? "";
  const campaignId = searchParams.get("campaign_id") ?? undefined;
  const excludeDiscarded = searchParams.get("exclude_discarded") === "true";
  const qualifiedOnly = searchParams.get("qualified_only") === "true";
  const minDr = searchParams.get("min_dr") ? parseFloat(searchParams.get("min_dr")!) : undefined;

  try {
    const [result, stats, toolCounts, timeline, provenance, publications] = await Promise.all([
      getProspects({ limit, offset, minScore, archetype, tool, hasContact, emailStatus, search, sortBy, campaignId, excludeDiscarded, qualifiedOnly, minDr }),
      include.includes("stats") ? getDashboardStats() : null,
      include.includes("charts") ? getToolMentionCounts() : null,
      include.includes("charts") ? getFreshnessTimeline() : null,
      include.includes("charts") ? getSourceProvenance() : null,
      include.includes("charts") ? getTopPublications() : null,
    ]);

    return NextResponse.json({
      ...result,
      stats,
      toolCounts,
      timeline,
      provenance,
      publications,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
