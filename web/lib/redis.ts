import { Redis } from "@upstash/redis";

// Upstash Redis (REST) — durable state that survives across Vercel serverless instances,
// unlike module-level in-memory buffers. Used for: a distributed send-lock (so overlapping
// cron/QStash triggers never double-send), per-config daily-cap counters, and live send
// progress. Gated by env: if unset (e.g. local dev without Upstash), redis() returns null
// and callers fall back to in-memory behavior.
let _redis: Redis | null | undefined;

export function redis(): Redis | null {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  _redis = url && token ? new Redis({ url, token }) : null;
  return _redis;
}

export function redisEnabled(): boolean {
  return redis() !== null;
}

// ─── Distributed lock ─────────────────────────────────────────────────────────
// Acquire a lock with a TTL (auto-expires so a crashed holder never deadlocks). Returns a
// token to pass to releaseLock, or null if someone else holds it.
export async function acquireLock(key: string, ttlSeconds: number, token: string): Promise<boolean> {
  const r = redis();
  if (!r) return true; // no Redis (local dev) → single instance, treat as acquired
  const res = await r.set(key, token, { nx: true, ex: ttlSeconds });
  return res === "OK";
}

export async function releaseLock(key: string, token: string): Promise<void> {
  const r = redis();
  if (!r) return;
  // Only release if we still own it (compare token), to avoid releasing a lock that already
  // expired and was re-acquired by someone else.
  const lua = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
  await r.eval(lua, [key], [token]).catch(() => {});
}

// ─── Global discovery lock (one discovery run at a time, cross-instance/cross-user) ──
// A discovery run spans multiple serverless chunks. The lock is taken by the FRESH start,
// refreshed by the running pipeline's heartbeat (and by each resume chunk), and released only
// when the whole run completes/stops. TTL > one chunk's hard limit + the QStash hand-off gap,
// so it survives between chunks but auto-expires if the process dies (no permanent lock-out).
const DISCOVERY_LOCK = "discovery:lock";
const DISCOVERY_LOCK_TTL = 330; // seconds

export async function acquireDiscoveryLock(holder: string): Promise<boolean> {
  const r = redis();
  if (!r) return true; // local dev = single instance
  return (await r.set(DISCOVERY_LOCK, holder, { nx: true, ex: DISCOVERY_LOCK_TTL })) === "OK";
}
export async function refreshDiscoveryLock(holder: string): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.set(DISCOVERY_LOCK, holder, { ex: DISCOVERY_LOCK_TTL }).catch(() => {});
}
export async function releaseDiscoveryLock(): Promise<void> {
  const r = redis();
  if (!r) return;
  await Promise.all([r.del(DISCOVERY_LOCK), r.del(DISCOVERY_META)]).catch(() => {});
}
export async function isDiscoveryLocked(): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  return !!(await r.get(DISCOVERY_LOCK).catch(() => null));
}

// Whole-discovery timing + baseline, so the UI can show ONE continuous elapsed timer and
// cumulative progress across all serverless chunks (instead of per-chunk counters that reset
// and make it look like it's restarting). Set once at the fresh start; carried across chunks;
// cleared on completion (see releaseDiscoveryLock).
const DISCOVERY_META = "discovery:meta";
export interface DiscoveryMeta { startedAt: number; baseHits: number; baseProcessed: number; baseAuthors: number; campaignId?: string | null; campaignName?: string | null }
export async function startDiscoveryMeta(m: DiscoveryMeta): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.set(DISCOVERY_META, JSON.stringify(m), { ex: 60 * 60 * 24 }).catch(() => {});
}
export async function getDiscoveryMeta(): Promise<DiscoveryMeta | null> {
  const r = redis();
  if (!r) return null;
  const raw = await r.get<any>(DISCOVERY_META).catch(() => null);
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}

// ─── Daily-cap counter (per config, per UTC day) ────────────────────────────────
// Returns the new count after incrementing; the key auto-expires after 48h.
export async function incrDailyCount(configId: string, day: string, by = 1): Promise<number> {
  const r = redis();
  if (!r) return 0; // no Redis → cap enforced only by DB counts (caller handles)
  const key = `sendcount:${configId}:${day}`;
  const n = await r.incrby(key, by);
  await r.expire(key, 60 * 60 * 48);
  return n;
}

export async function getDailyCount(configId: string, day: string): Promise<number> {
  const r = redis();
  if (!r) return 0;
  const n = await r.get<number>(`sendcount:${configId}:${day}`);
  return n ?? 0;
}
