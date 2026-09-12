import { NextRequest, NextResponse, after } from "next/server";
import { auth } from "@auth";
import { startAudit, processAuditChunk, getAuditState } from "@/lib/linkaudit/run";
import { acquireLock, releaseLock } from "@/lib/redis";

export const maxDuration = 300;

// Same authorization convention as the other cron-driven routes: Vercel cron / QStash
// (CRON_SECRET Bearer or ?key=) or a signed-in session (the page's "Run now" button).
async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  const session = await auth().catch(() => null);
  return !!session;
}

// POST — start the daily broken-link audit, or continue an in-flight one (QStash chunk
// handoff). Fresh runs refuse to start while another is active.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));

  if (body.continue) {
    const state = await getAuditState();
    if (!state) return NextResponse.json({ continued: false, reason: "nothing to continue" });
    after(async () => { try { await processAuditChunk(); } catch { /* state persists for resume */ } });
    return NextResponse.json({ continued: true, index: state.index, pagesTotal: state.pages.length });
  }

  // A short lock only guards concurrent STARTS — the run itself is tracked by Redis state.
  const lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (!(await acquireLock("lock:linkaudit:start", 60, lockToken))) {
    return NextResponse.json({ started: false, alreadyRunning: true });
  }
  try {
    const existing = await getAuditState();
    // Treat state with a recent heartbeat as an active run; stale state gets replaced.
    if (existing && Date.now() - existing.updatedAt < 10 * 60_000) {
      return NextResponse.json({ started: false, alreadyRunning: true, index: existing.index, pagesTotal: existing.pages.length });
    }
    const { runId, pagesTotal } = await startAudit();
    after(async () => { try { await processAuditChunk(); } catch { /* state persists for resume */ } });
    return NextResponse.json({ started: true, runId, pagesTotal });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  } finally {
    await releaseLock("lock:linkaudit:start", lockToken);
  }
}

// Vercel cron issues GET — support both.
export async function GET(req: NextRequest) {
  return POST(req);
}
