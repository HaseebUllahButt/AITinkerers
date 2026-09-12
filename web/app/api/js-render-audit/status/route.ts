import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { activeLock } from "@/lib/jsRenderAudit/lock";

/** The last line in the log that looks like a progress tick — "   40/105  5.5s/page  ~6m left". */
function lastProgressLine(log: string): string | null {
  const lines = log.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\d+\/\d+/.test(lines[i])) return lines[i].trim();
  }
  return null;
}

export async function GET() {
  const lock = await activeLock();
  if (!lock) return NextResponse.json({ running: false });

  let progress: string | null = null;
  try {
    progress = lastProgressLine(await readFile(join(lock.outDir, "run.log"), "utf8"));
  } catch { /* log not written yet */ }

  return NextResponse.json({ running: true, runId: lock.runId, startedAt: lock.startedAt, progress });
}
