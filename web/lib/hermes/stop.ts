// Durable-ish stop flag for a running Hermes turn. Redis when configured (works across serverless
// instances, same as pipeline/abort.ts), in-memory fallback for single-instance dev. Checked by the
// agent loop between model rounds — a stop lands at the next round boundary, never mid-stream.
import { redis } from "@/lib/redis";

const local = new Set<string>();
const KEY = (sessionId: string) => `hermes:stop:${sessionId}`;

export async function requestHermesStop(sessionId: string): Promise<void> {
  const r = redis();
  if (r) await r.set(KEY(sessionId), "1", { ex: 600 });
  else local.add(sessionId);
}

export async function isHermesStopRequested(sessionId: string): Promise<boolean> {
  const r = redis();
  if (r) return (await r.get(KEY(sessionId))) != null;
  return local.has(sessionId);
}

export async function clearHermesStop(sessionId: string): Promise<void> {
  const r = redis();
  if (r) await r.del(KEY(sessionId));
  else local.delete(sessionId);
}
