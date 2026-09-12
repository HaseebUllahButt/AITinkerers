import { NextRequest, NextResponse } from "next/server";

import { isAuthorized } from "@/lib/auth/service";
import { runAutopilot, gatherCandidates, autopilotEnabled, slotForHour } from "@/lib/blog/autopilot";

// The scheduled blog pipeline. Fires six times a day at 9am, 11am, 1pm, 3pm, 5pm and 6pm Pakistan
// time (04:00, 06:00, 08:00, 10:00, 12:00 and 13:00 UTC — Pakistan is UTC+5 year-round, no DST).
//
// Nobody triggers this. It reads the research board and the Notion backlog, decides whether anything
// is worth writing, and either starts a draft or records why it did not. A skip is the expected
// outcome on a quiet day — see the module note in lib/blog/autopilot.ts.
//
// 300s because the judgement is a model call over up to ~180 rows plus two DB reads, and there may be
// a SECOND short call after it: when the cannibalization gate says a pick would compete with a page we
// already own, the topic is retargeted and re-checked before anything is written. The ARTICLE is still
// not written here — startBlogRequest hands off to /api/blog/request/run, which has its own budget and
// re-enqueues itself. So this route's ceiling bounds the decision, not the writing, which is the only
// reason six-times-a-day scheduling is safe at all.
export const maxDuration = 300;

/**
 * Which slot fired, so a missing 3pm run is visible in the audit table.
 *
 * The mapping lives in lib/blog/autopilot.ts next to the slot list, because the slot name is not just a
 * label any more: its POSITION decides which page type this run leans towards and whether it still
 * carries the day's news preference. A route inventing its own name would silently reset both.
 */
function slotFor(url: URL): string {
  const explicit = url.searchParams.get("slot");
  if (explicit) return explicit.slice(0, 20);
  const h = new Date().getUTCHours();
  return slotForHour(h) ?? `utc-${String(h).padStart(2, "0")}`;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  // `dry=1` runs the gather and stops before the judge. For checking what the board would offer
  // without spending a model call or claiming a row.
  if (url.searchParams.get("dry") === "1") {
    const { candidates, notes } = await gatherCandidates();
    return NextResponse.json({
      ok: true, dry: true, enabled: autopilotEnabled(), notes,
      candidates: candidates.map((c) => ({
        kind: c.kind, subject: c.subject, source: c.source, date: c.date,
        modality: c.modality, confidence: c.confidence,
      })),
    });
  }

  // `force=1` bypasses the BLOG_AUTOPILOT env gate for a one-off manual run. It does NOT bypass the
  // daily cap or the lock — those exist to stop duplicate posts, which a manual run can cause too.
  const result = await runAutopilot({
    slot: slotFor(url),
    force: url.searchParams.get("force") === "1",
  });

  // 200 on a skip. A skip is a correct outcome, and a non-2xx would make Vercel's cron log show a
  // healthy quiet day as a failure — which is how a scheduler gets muted.
  return NextResponse.json({ ok: result.status !== "failed", ...result });
}

// Vercel's scheduler issues GET for cron paths. Same work, same auth.
export async function GET(req: NextRequest) {
  return POST(req);
}
