import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdir, writeFile, unlink, open } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, OUT_ROOT, LOCK_PATH, activeLock } from "@/lib/jsRenderAudit/lock";

// Starts scripts/js-render-audit.mts as a child process and returns immediately — a full sweep
// takes minutes, far past what a browser tab wants to hold a request open for. The client polls
// /api/js-render-audit/status instead. Local-only by construction: it shells out to Playwright,
// which needs a real Chromium on the machine running this — same as the CLI script, and same
// reason the render-lab feature this replaces keeps ITS render diff to a local script rather than
// a route (no headless browser on Vercel's serverless runtime).
export async function POST(req: NextRequest) {
  // Vercel sets this in every one of its runtimes (production, preview, build) — and there is no
  // Chromium there, so spawning the script would just fail in some confusing way instead of a clear
  // one. Same constraint Render Lab's own render diff has; see analyze.ts's note on skipRender.
  if (process.env.VERCEL) {
    return NextResponse.json({
      ok: false,
      localOnly: true,
      error: "This audit needs a real Chrome browser, which the deployed site doesn't have. Run it from a local machine: npx tsx scripts/js-render-audit.mts — it uploads to Supabase automatically, so the result shows up here too.",
    }, { status: 200 });
  }

  const existing = await activeLock();
  if (existing) {
    return NextResponse.json({ ok: false, error: "A run is already in progress", runId: existing.runId }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const limit = Number(body?.limit) || 0;
  const section = body?.section === "features" || body?.section === "blogs" ? body.section : undefined;

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(OUT_ROOT, runId);
  await mkdir(outDir, { recursive: true });

  const args = ["tsx", "scripts/js-render-audit.mts", "--out", outDir];
  if (limit > 0) args.push("--limit", String(limit));
  if (section) args.push("--section", section);

  const log = await open(join(outDir, "run.log"), "a");
  // detached + unref: this survives the dev server restarting mid-run, which matters because the
  // lock file (not this process) is what status checks trust — see activeLock's staleness check.
  const child = spawn("npx", args, { cwd: ROOT, stdio: ["ignore", log.fd, log.fd], detached: true });
  child.unref();

  await mkdir(OUT_ROOT, { recursive: true });
  await writeFile(LOCK_PATH, JSON.stringify({ pid: child.pid, runId, outDir, startedAt: new Date().toISOString() }));

  child.on("exit", async () => {
    await log.close().catch(() => {});
    unlink(LOCK_PATH).catch(() => {});
  });
  child.on("error", async () => {
    await log.close().catch(() => {});
    unlink(LOCK_PATH).catch(() => {});
  });

  return NextResponse.json({ ok: true, runId, outDir });
}
