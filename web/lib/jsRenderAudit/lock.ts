// Shared between the run and status routes: one audit process at a time, tracked by a lock file
// rather than in-memory state, because Next's dev server can restart independently of a spawned
// child — an in-memory flag would forget a run that's still going; a lock file survives that.
import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const ROOT = process.cwd();
export const OUT_ROOT = join(ROOT, "scripts", "output", "js-render-audit");
export const LOCK_PATH = join(OUT_ROOT, ".lock.json");

export interface Lock { pid: number; runId: string; outDir: string; startedAt: string }

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function readLock(): Promise<Lock | null> {
  try {
    return JSON.parse(await readFile(LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * A lock is only meaningful proof of an in-progress run if the process is actually alive AND the
 * run hasn't already produced a report.json — a dev-server restart mid-run orphans the lock file
 * (the child keeps running detached, but nothing is left to clear the lock when it finishes), so
 * both sides of "did this actually finish" are checked rather than trusting the file alone.
 */
export async function activeLock(): Promise<Lock | null> {
  const lock = await readLock();
  if (!lock) return null;
  if (existsSync(join(lock.outDir, "report.json")) || !pidAlive(lock.pid)) {
    await unlink(LOCK_PATH).catch(() => {});
    return null;
  }
  return lock;
}
