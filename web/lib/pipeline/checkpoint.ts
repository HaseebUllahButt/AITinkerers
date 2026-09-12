import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { redis } from "@/lib/redis";

// Discovery resume checkpoint. On Vercel the filesystem is read-only/ephemeral, so we store
// the checkpoint in Redis when available (durable across serverless instances) and fall back
// to the local filesystem for dev. There is only ever one active run, so a single key is enough.
const DIR = join(process.cwd(), ".pipeline-checkpoints");
const KEY = "pipeline:checkpoint";

export interface PipelineCheckpoint {
  runId: string;
  round: number;
  usedQueries: string[];
  rssComplete: boolean;
  // True once the discover round-loop has fully finished (target reached / diminishing
  // returns / no new queries / max rounds) — set only when Stage 2 (profiling) is what ran
  // out of time, so a resume skips straight to processing instead of re-entering the round
  // loop and mistaking leftover profiling backlog for "not enough articles found yet".
  discoveryDone?: boolean;
  campaignId?: string;
  customKeywords?: string[];
  savedAt: string;
}

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export async function saveCheckpoint(c: PipelineCheckpoint): Promise<void> {
  const r = redis();
  if (r) { await r.set(KEY, JSON.stringify(c), { ex: 60 * 60 * 24 }).catch(() => {}); return; }
  try { ensureDir(); writeFileSync(join(DIR, `${c.runId}.json`), JSON.stringify(c), "utf-8"); } catch { /* ignore */ }
}

export async function deleteCheckpoint(runId: string): Promise<void> {
  const r = redis();
  if (r) { await r.del(KEY).catch(() => {}); return; }
  try { unlinkSync(join(DIR, `${runId}.json`)); } catch { /* ignore */ }
}

export async function findLatestCheckpoint(): Promise<PipelineCheckpoint | null> {
  const r = redis();
  if (r) {
    const raw = await r.get<any>(KEY).catch(() => null);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  try {
    ensureDir();
    const checkpoints = readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => { try { return JSON.parse(readFileSync(join(DIR, f), "utf-8")) as PipelineCheckpoint; } catch { return null; } })
      .filter((c): c is PipelineCheckpoint => c !== null);
    if (!checkpoints.length) return null;
    return checkpoints.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())[0];
  } catch {
    return null;
  }
}
