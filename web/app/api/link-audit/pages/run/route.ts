import { NextRequest, NextResponse, after } from "next/server";
import { auth } from "@auth";
import { startPageSweep, processPageSweepChunk, getPageSweepState } from "@/lib/linkaudit/pages";
import { acquireLock, releaseLock } from "@/lib/redis";

export const maxDuration = 300;

// Same authorization convention as /api/link-audit/run: cron secret or a signed-in session.
async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  const session = await auth().catch(() => null);
  return !!session;
}

// POST — start the sitemap page sweep (check every sitemap URL itself), or continue an
// in-flight one (QStash chunk handoff). Body: { includeRetired?: true } sweeps the full
// site_urls inventory including URLs dropped from the sitemap.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));

  if (body.continue) {
    const state = await getPageSweepState();
    if (!state) return NextResponse.json({ continued: false, reason: "nothing to continue" });
    after(async () => { try { await processPageSweepChunk(); } catch { /* state persists for resume */ } });
    return NextResponse.json({ continued: true, index: state.index, pagesTotal: state.pages.length });
  }

  const lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (!(await acquireLock("lock:pagesweep:start", 60, lockToken))) {
    return NextResponse.json({ started: false, alreadyRunning: true });
  }
  try {
    const existing = await getPageSweepState();
    if (existing && Date.now() - existing.updatedAt < 10 * 60_000) {
      return NextResponse.json({ started: false, alreadyRunning: true, index: existing.index, pagesTotal: existing.pages.length });
    }
    const { runId, pagesTotal } = await startPageSweep({ includeRetired: body.includeRetired === true });
    after(async () => { try { await processPageSweepChunk(); } catch { /* state persists for resume */ } });
    return NextResponse.json({ started: true, runId, pagesTotal });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "start failed" }, { status: 500 });
  } finally {
    await releaseLock("lock:pagesweep:start", lockToken);
  }
}

// Vercel cron issues GET.
export async function GET(req: NextRequest) {
  return POST(req);
}
