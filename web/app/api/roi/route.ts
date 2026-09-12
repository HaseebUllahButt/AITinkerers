import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";

import { isMixpanelConfigured, MixpanelError } from "@/lib/mixpanel/client";
import { buildRoiReport, type Scope } from "@/lib/mixpanel/seoRoi";

// GET — the SEO ROI report: signups, purchases, revenue and generations by landing page and channel.
//
// Read-only by construction. There is no POST here and there should not be one: everything this
// surface knows comes out of Mixpanel, and nothing SearchOps does should write back into product
// analytics.
//
// Mixpanel is slow (seconds per segmentation call, seven of them in parallel), so this sits well
// inside the function limit rather than near it.
export const maxDuration = 120;

async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  return !!(await auth().catch(() => null));
}

function scopeOf(v: string | null): Scope {
  return v === "ai" || v === "all" ? v : "organic";
}

export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Unconfigured is a 200, not an error: the page needs to render its "add these credentials" state,
  // and a 500 there would look like Mixpanel is down.
  if (!isMixpanelConfigured()) {
    return NextResponse.json({
      ok: true, configured: false,
      error: "Mixpanel is not configured. Set MIXPANEL_PROJECT_ID, MIXPANEL_SA_USERNAME and MIXPANEL_SA_SECRET.",
    });
  }

  const sp = req.nextUrl.searchParams;
  const days = Math.min(Math.max(Number(sp.get("days") ?? 30) || 30, 1), 365);
  const scope = scopeOf(sp.get("scope"));
  const section = sp.get("section");

  try {
    const report = await buildRoiReport({ days, scope });
    const pages = section ? report.pages.filter((p) => p.section === section) : report.pages;
    // Sections are derived here rather than in the lib so the filter and the chip list can never
    // disagree about what sections exist.
    const sections = [...new Set(report.pages.map((p) => p.section))]
      .map((s) => ({
        section: s,
        pages: report.pages.filter((p) => p.section === s).length,
        revenue: Math.round(report.pages.filter((p) => p.section === s).reduce((n, p) => n + p.revenue, 0) * 100) / 100,
        signups: report.pages.filter((p) => p.section === s).reduce((n, p) => n + p.signups, 0),
      }))
      .sort((a, b) => b.revenue - a.revenue || b.signups - a.signups);

    return NextResponse.json({ ok: true, configured: true, ...report, pages, sections });
  } catch (e: unknown) {
    const msg = e instanceof MixpanelError ? e.message : e instanceof Error ? e.message : "ROI query failed";
    return NextResponse.json({ ok: false, configured: true, error: msg }, { status: 502 });
  }
}
