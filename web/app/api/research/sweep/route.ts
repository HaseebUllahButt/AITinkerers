import { NextRequest, NextResponse } from "next/server";

import { isAuthorized } from "@/lib/auth/service";
import { runSweep } from "@/lib/research/sweep";

// POST /api/research/sweep — find what happened and write it to the board.
//
// Called by Vercel cron every weekday morning, and by the Refresh button on /research. Both go
// through isAuthorized, which already accepts CRON_SECRET as well as a signed-in person, so the
// scheduler needs no special case here.
//
// 300s is the ceiling and the sweep is bounded to fit inside it: runRadar's own source timeouts plus
// a cap on ledger checks (see runSweep). It does not hand off to QStash, because unlike writing an
// article a sweep is cheap to simply run again tomorrow — a partial board that fills in on the next
// pass is a better failure than a half-finished job re-entering itself.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const days = Number((body as { days?: unknown }).days);

  try {
    const result = await runSweep({ days: Number.isFinite(days) && days > 0 ? Math.min(days, 30) : undefined });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "sweep failed" },
      { status: 500 },
    );
  }
}

// Vercel's scheduler issues GET for cron paths. Same work, same auth.
export async function GET(req: NextRequest) {
  return POST(req);
}
