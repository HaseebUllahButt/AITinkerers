import { NextRequest, NextResponse, after } from "next/server";

import { auth } from "@auth";
import { acquireLock, releaseLock } from "@/lib/redis";
import { startSweep, processSweepChunk, getSweepState, requestSweepStop } from "@/lib/urlsweep/run";
import { DEFAULT_PATTERNS, type SweepPattern } from "@/lib/urlsweep/patterns";

export const maxDuration = 300;

// Same convention as the link audit: CRON_SECRET (Vercel cron / QStash chunk handoff) or a
// signed-in session (the Run button).
async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  return !!(await auth().catch(() => null));
}

/**
 * Patterns from a request body, or the defaults.
 *
 * Accepts the same shape the library uses, plus a bare-string shorthand so a caller can say
 * "old-thing.imagine.art" or "/old-path" without knowing the object form — the sweep is meant to be
 * usable the next time a URL is retired, and that is the moment nobody wants to read a type.
 */
function patternsFrom(input: unknown): SweepPattern[] {
  if (!Array.isArray(input) || !input.length) return DEFAULT_PATTERNS;
  const out: SweepPattern[] = [];
  for (const raw of input.slice(0, 25)) {
    if (typeof raw === "string") {
      const s = raw.trim();
      if (!s) continue;
      if (s.startsWith("/")) out.push({ label: s, pathPrefix: s });
      else out.push({ label: s, host: s.replace(/^https?:\/\//, "").replace(/\/.*$/, "") });
      continue;
    }
    if (raw && typeof raw === "object") {
      const p = raw as Record<string, unknown>;
      const label = String(p.label ?? p.host ?? p.pathPrefix ?? "").trim();
      if (!label) continue;
      out.push({
        label,
        host: typeof p.host === "string" ? p.host : undefined,
        pathPrefix: typeof p.pathPrefix === "string" ? p.pathPrefix : undefined,
        subdomainCatchAll: p.subdomainCatchAll === true,
        note: typeof p.note === "string" ? p.note : undefined,
      });
    }
  }
  return out.length ? out : DEFAULT_PATTERNS;
}

// POST — start a sweep, or continue an in-flight one (QStash chunk handoff).
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (body.stop) {
    await requestSweepStop();
    return NextResponse.json({ ok: true, stopping: true });
  }

  if (body.continue) {
    const state = await getSweepState();
    if (!state) return NextResponse.json({ continued: false, reason: "nothing to continue" });
    after(async () => { try { await processSweepChunk(); } catch { /* state persists for resume */ } });
    return NextResponse.json({ continued: true, index: state.index, pagesTotal: state.pages.length });
  }

  const lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (!(await acquireLock("lock:urlsweep:start", 60, lockToken))) {
    return NextResponse.json({ started: false, alreadyRunning: true });
  }
  try {
    const existing = await getSweepState();
    // A recent heartbeat means a live run; stale state is a crashed one and gets replaced.
    if (existing && Date.now() - existing.updatedAt < 10 * 60_000) {
      return NextResponse.json({
        started: false,
        alreadyRunning: true,
        index: existing.index,
        pagesTotal: existing.pages.length,
      });
    }
    const session = await auth().catch(() => null);
    const { runId, pagesTotal } = await startSweep({
      patterns: patternsFrom(body.patterns),
      startedBy: (session?.user?.email as string | undefined) ?? undefined,
    });
    after(async () => { try { await processSweepChunk(); } catch { /* state persists for resume */ } });
    return NextResponse.json({ started: true, runId, pagesTotal });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "sweep failed to start" }, { status: 500 });
  } finally {
    await releaseLock("lock:urlsweep:start", lockToken);
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
