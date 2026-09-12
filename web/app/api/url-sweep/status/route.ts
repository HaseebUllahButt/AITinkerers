import { NextRequest, NextResponse } from "next/server";

import { isAuthorized } from "@/lib/auth/service";
import { getSweepState, sweepReport } from "@/lib/urlsweep/run";

export const maxDuration = 30;

// GET /api/url-sweep/status — the latest sweep's grouped report, plus live progress if one is running.
//
// Progress and report are separate fields rather than one merged object, because a sweep that is
// half done has a real but INCOMPLETE report, and a UI that cannot tell the two apart will show a
// partial list as if it were the answer.
export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const runId = req.nextUrl.searchParams.get("run") ?? undefined;

  try {
    const [state, report] = await Promise.all([getSweepState(), sweepReport(runId)]);
    return NextResponse.json({
      ok: true,
      running: !!state,
      progress: state
        ? {
            runId: state.runId,
            index: state.index,
            pagesTotal: state.pages.length,
            matches: state.matches,
            log: state.log.slice(-40),
          }
        : null,
      ...report,
    });
  } catch (e: unknown) {
    // Never an empty report on a failed read — "nothing found" and "could not look" are different
    // answers and only one of them means the site is clean.
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "could not read the sweep" },
      { status: 503 },
    );
  }
}
