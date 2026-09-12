// Tracks in-flight email generation, keyed by workflow id. Backed by Upstash Redis so it
// survives across Vercel serverless instances (the POST that starts generation and the GET
// that polls progress can land on DIFFERENT instances — an in-memory Map is invisible across
// them and shows 0/0). Falls back to an in-memory Map when Redis isn't configured (local dev).

import { redis } from "@/lib/redis";

interface GenState {
  workflowId: string;
  total: number;
  done: number;
  running: boolean;
  errors: string[];
  startedAt: number;
  finishedAt?: number;
}

const mem = new Map<string, GenState>();
const KEY = (id: string) => `gen:${id}`;
const ERR = (id: string) => `gen:${id}:errors`;
const TTL = 60 * 60; // 1h

export async function startGen(workflowId: string, total: number): Promise<void> {
  const r = redis();
  if (r) {
    await r.del(KEY(workflowId), ERR(workflowId));
    await r.hset(KEY(workflowId), { total, done: 0, running: 1, startedAt: Date.now() });
    await r.expire(KEY(workflowId), TTL);
    return;
  }
  mem.set(workflowId, { workflowId, total, done: 0, running: true, errors: [], startedAt: Date.now() });
}

export async function bumpGen(workflowId: string, error?: string): Promise<void> {
  const r = redis();
  if (r) {
    await r.hincrby(KEY(workflowId), "done", 1);
    if (error) { await r.rpush(ERR(workflowId), error); await r.expire(ERR(workflowId), TTL); }
    return;
  }
  const s = mem.get(workflowId);
  if (s) { s.done += 1; if (error) s.errors.push(error); }
}

/** Record an error WITHOUT advancing `done` — for a whole-run problem (out of time, aborted)
 *  rather than one item's failure, so the progress bar never claims work that didn't happen. */
export async function noteGenError(workflowId: string, error: string): Promise<void> {
  const r = redis();
  if (r) { await r.rpush(ERR(workflowId), error); await r.expire(ERR(workflowId), TTL); return; }
  const s = mem.get(workflowId);
  if (s) s.errors.push(error);
}

export async function finishGen(workflowId: string): Promise<void> {
  const r = redis();
  if (r) { await r.hset(KEY(workflowId), { running: 0, finishedAt: Date.now() }); return; }
  const s = mem.get(workflowId);
  if (s) { s.running = false; s.finishedAt = Date.now(); }
}

export async function getGen(workflowId: string): Promise<GenState | null> {
  const r = redis();
  if (r) {
    const h = await r.hgetall<Record<string, string | number>>(KEY(workflowId));
    if (!h || Object.keys(h).length === 0) return null;
    const errors = (await r.lrange(ERR(workflowId), 0, -1)) ?? [];
    return {
      workflowId,
      total: Number(h.total) || 0,
      done: Number(h.done) || 0,
      running: String(h.running) === "1",
      errors: errors as string[],
      startedAt: Number(h.startedAt) || 0,
    };
  }
  return mem.get(workflowId) ?? null;
}

export async function isGenRunning(workflowId: string): Promise<boolean> {
  const g = await getGen(workflowId);
  return g?.running ?? false;
}
