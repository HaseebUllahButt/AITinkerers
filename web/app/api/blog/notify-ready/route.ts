import { NextRequest, NextResponse } from "next/server";

import { isAuthorized } from "@/lib/auth/service";
import { notifyReadyDrafts } from "@/lib/blog/notifyReady";
import { ensureThumbnails } from "@/lib/blog/ensureThumbnails";
import { resumeStalledRuns } from "@/lib/blog/resumeStalled";

export const maxDuration = 120;

// POST/GET /api/blog/notify-ready — announce blog drafts that became ready to publish.
//
// Vercel cron drives this; isAuthorized already accepts CRON_SECRET as well as a signed-in person,
// so the scheduler needs no special case. Vercel issues GET for cron paths, hence both verbs.
//
// ?dry=1 reports what WOULD be posted and stamps nothing — the only safe way to check the first-run
// guard against a real backlog before letting it touch a channel.
async function run(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  // Three passes share the 120s ceiling, and the last of them is the one that must not be interrupted
  // halfway. Image generation gets everything up to this mark and no more — see the note in
  // ensureThumbnails, and the claim-before-post note in notifyReady.
  const startedAt = Date.now();
  const THUMBNAIL_DEADLINE_MS = 80_000;
  try {
    // ── Resume BEFORE patching, because resuming is the better outcome ──────────────────────────
    //
    // A writer run killed between its last section and its image step leaves a finished article with
    // no thumbnail, no cover, no JSON-LD and no announcement — and nothing re-enqueues it, because
    // runBlogRequest only hands off after writeOneArticle returns. Measured on the autopilot's 15:00
    // run: 14/14 sections, 14,807 characters, phase stuck at `writing`, silent.
    //
    // ensureThumbnails below would eventually rescue such a draft by filling the one field that
    // blocks publishing, and that is how the 15:00 draft actually got saved — but it is a patch, not
    // a recovery: the session stays stuck and the cover and schema stay missing. Resuming the run
    // completes the real tail.
    //
    // Drafts that were resumed are then EXCLUDED from both passes this tick. The resumed run does its
    // own images and its own announcement, so touching them here would pay for a duplicate render or
    // announce the draft before its images landed. If a resume does not take, the next hourly tick
    // finds it stalled again and the patch path still catches it.
    const resumed = await resumeStalledRuns({ dryRun }).catch((e) => ({
      stalled: 0, resumed: 0, resumedDraftIds: [] as string[], tooOld: 0,
      failures: [{ session: "-", error: e instanceof Error ? e.message : "resume pass failed" }],
      notes: [] as string[],
    }));

    // Thumbnails, then notify. A machine-written draft whose only blocker was the missing image
    // becomes publishable in the same run that announces it — announcing "ready" and then fixing the
    // thing that made it unready would put the two in the wrong order.
    const thumbs = await ensureThumbnails({
      dryRun, skipDraftIds: resumed.resumedDraftIds,
      deadlineAt: startedAt + THUMBNAIL_DEADLINE_MS,
    }).catch((e) => ({
      considered: 0, fromVideo: 0, generated: 0, skipped: 0,
      failures: [{ draft: "-", error: e instanceof Error ? e.message : "thumbnail pass failed" }],
      notes: [] as string[],
    }));
    const result = await notifyReadyDrafts({ dryRun, skipDraftIds: resumed.resumedDraftIds });
    return NextResponse.json({ ok: true, dryRun, resumed, thumbnails: thumbs, ...result });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "notify failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) { return run(req); }
export async function GET(req: NextRequest) { return run(req); }
