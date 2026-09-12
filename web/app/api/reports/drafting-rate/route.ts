import { NextRequest, NextResponse } from "next/server";

import { isAuthorized } from "@/lib/auth/service";
import { buildDraftingRateReport } from "@/lib/reports/draftingRate";

// GET /api/reports/drafting-rate — the blog drafting rate, before and after Summit.
//
// Reads ~830 CMS entries across nine pages plus the local draft table, so it is not instant. The
// dashboard renders its card in a loading state and fills in, rather than holding the whole page.
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const report = await buildDraftingRateReport();
    return NextResponse.json({ ok: true, ...report });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "the report could not be built" },
      { status: 500 },
    );
  }
}
