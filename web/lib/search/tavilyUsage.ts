import { redis } from "@/lib/redis";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

// Tavily has no usage API, so we count calls ourselves (per calendar month) in Redis and
// flag the last hard error. Powers a site-wide banner that warns when you're near/over the
// monthly quota — so you can swap the key before searches start failing.
const PER_KEY_LIMIT = Number(process.env.TAVILY_MONTHLY_LIMIT || 1000); // free tier = 1000/mo PER KEY
const monthTag = () => new Date().toISOString().slice(0, 7); // "2026-07"
const monthKey = () => `tavily:count:${monthTag()}`;               // global tally (all keys)
const keyCountKey = (id: string) => `tavily:count:${monthTag()}:${id}`; // per-key tally
const ERR_KEY = "tavily:error";
const KEY_OVERRIDE_KEY = "tavily:key_override"; // legacy single-key override (still honored)
const POOL_KEY = "tavily:pool";                 // rotating pool of keys
const ENV_ID = "env";                           // synthetic id for the env-var fallback key

// ─── Rotating key pool ───────────────────────────────────────────────────────────
// A list of Tavily keys you manage in Settings. Every search is sent to the LEAST-USED key
// this month, so load spreads evenly across all keys instead of hammering one until it dies.
// When a key hits its monthly quota (429/402/432/403) it's flagged exhausted for the current
// month and dropped from rotation; exhaustion auto-clears when the month rolls over, so keys
// become usable again on quota renewal. Add as many as you want — you never run out.
// fallback=true → a paid / pay-as-you-go key that is only used once every FREE key is exhausted
// this month (so free quota is spent first). Free keys (fallback falsy) always take priority.
export interface PoolEntry { id: string; enc: string; label?: string; exhaustedMonth?: string; fallback?: boolean }
export interface PoolKeyStatus { id: string; label: string; masked: string; active: boolean; exhaustedThisMonth: boolean; used: number; fallback: boolean }

async function readPool(): Promise<PoolEntry[]> {
  const r = redis();
  if (!r) return [];
  const raw = await r.get<any>(POOL_KEY).catch(() => null);
  if (!raw) return [];
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return []; }
}
async function writePool(pool: PoolEntry[]): Promise<void> {
  const r = redis();
  if (!r) throw new Error("Redis not configured — can't store Tavily keys");
  await r.set(POOL_KEY, JSON.stringify(pool));
}
function maskKey(k: string): string {
  return k.length <= 10 ? "••••" : `${k.slice(0, 6)}…${k.slice(-4)}`;
}
// Per-key monthly call counts (best-effort — a missing Redis just yields zeros).
async function readCounts(ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const r = redis();
  if (!r || ids.length === 0) { ids.forEach((id) => (out[id] = 0)); return out; }
  const vals = await r.mget<(number | string | null)[]>(...ids.map(keyCountKey)).catch(() => []);
  ids.forEach((id, i) => (out[id] = Number(vals?.[i] ?? 0) || 0));
  return out;
}

export async function addTavilyKey(key: string, label?: string, fallback = false): Promise<void> {
  const clean = key.trim();
  if (!clean) throw new Error("empty key");
  const pool = await readPool();
  const existing = pool.find((e) => decryptSecret(e.enc) === clean);
  if (existing) { existing.fallback = fallback; if (label) existing.label = label.trim(); await writePool(pool); return; } // update flag/label on re-add
  pool.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, enc: encryptSecret(clean)!, label: label?.trim() || undefined, fallback });
  await writePool(pool);
}
export async function removeTavilyKey(id: string): Promise<void> {
  await writePool((await readPool()).filter((e) => e.id !== id));
}
export async function markTavilyKeyExhausted(id: string): Promise<void> {
  const pool = await readPool();
  const e = pool.find((x) => x.id === id);
  if (e) { e.exhaustedMonth = monthTag(); await writePool(pool); }
}
// Put an exhausted key back into rotation (manual reactivate; also used to undo a test mark).
export async function clearTavilyKeyExhausted(id: string): Promise<void> {
  const pool = await readPool();
  const e = pool.find((x) => x.id === id);
  if (e && e.exhaustedMonth) { delete e.exhaustedMonth; await writePool(pool); }
}
export async function listTavilyKeys(): Promise<PoolKeyStatus[]> {
  const month = monthTag();
  const pool = await readPool();
  const counts = await readCounts(pool.map((e) => e.id));
  return pool.map((e) => {
    const exhausted = e.exhaustedMonth === month;
    return { id: e.id, label: e.label ?? "", masked: maskKey(decryptSecret(e.enc) ?? ""), active: !exhausted, exhaustedThisMonth: exhausted, used: counts[e.id] ?? 0, fallback: !!e.fallback };
  });
}
// The next key to use: the LEAST-USED non-exhausted pool entry (balances load across all keys
// and naturally backs off a key that's taken more traffic). Falls back to the legacy override,
// then the env key, when the pool is empty.
export async function getActiveTavilyKey(reserve = false): Promise<{ id: string; key: string } | null> {
  const month = monthTag();
  const active = (await readPool()).filter((e) => e.exhaustedMonth !== month);
  // Free-first: only fall to paid (fallback) keys once every free key is exhausted this month.
  const free = active.filter((e) => !e.fallback);
  const tier = free.length > 0 ? free : active.filter((e) => e.fallback);
  let chosen: { id: string; key: string } | null = null;
  if (tier.length > 0) {
    const counts = await readCounts(tier.map((e) => e.id));
    // Within the chosen tier, least-used first; stable tiebreak on pool order = deterministic.
    tier.sort((a, b) => (counts[a.id] ?? 0) - (counts[b.id] ?? 0));
    for (const e of tier) {
      const key = decryptSecret(e.enc);
      if (key) { chosen = { id: e.id, key }; break; }
    }
  }
  if (!chosen) {
    const r = redis();
    if (r) {
      const legacy = decryptSecret(await r.get<string>(KEY_OVERRIDE_KEY).catch(() => null));
      if (legacy) chosen = { id: ENV_ID, key: legacy };
    }
    if (!chosen) { const env = process.env.TAVILY_API_KEY; if (env) chosen = { id: ENV_ID, key: env }; }
  }
  // Reserve: bump this key's per-key counter NOW so concurrent callers see it as more-used and
  // pick a different key (fixes least-used balancing being defeated under concurrency, since the
  // separate usage tally is fire-and-forget). Only search callers reserve; getTavilyKey doesn't.
  if (chosen && reserve) {
    const r = redis();
    if (r) { const pk = keyCountKey(chosen.id); const n = await r.incr(pk).catch(() => 0); if (n === 1) await r.expire(pk, 60 * 60 * 24 * 40).catch(() => {}); }
  }
  return chosen;
}

// Back-compat single-value accessor (used where rotation isn't needed).
export async function getTavilyKey(): Promise<string | null> {
  return (await getActiveTavilyKey())?.key ?? null;
}

export async function setTavilyKeyOverride(key: string): Promise<void> {
  const r = redis();
  if (!r) throw new Error("Redis not configured — can't store a key override");
  await r.set(KEY_OVERRIDE_KEY, encryptSecret(key));
  await resetTavilyUsage(); // a new/different key starts its own quota — don't carry the old count over
}

export async function clearTavilyKeyOverride(): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.del(KEY_OVERRIDE_KEY);
  await resetTavilyUsage();
}

export async function hasTavilyKeyOverride(): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  return !!(await r.get(KEY_OVERRIDE_KEY).catch(() => null));
}

export async function resetTavilyUsage(): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.del(monthKey()).catch(() => {});
  await r.del(ERR_KEY).catch(() => {});
  // Clear per-key tallies too, so a reset zeroes the whole picture.
  const pool = await readPool().catch(() => [] as PoolEntry[]);
  await Promise.all([...pool.map((e) => e.id), ENV_ID].map((id) => r.del(keyCountKey(id)).catch(() => {})));
}

// Count a call toward the GLOBAL monthly-usage tally. The per-key tally is incremented at
// selection time by getActiveTavilyKey(reserve=true) so it stays accurate under concurrency;
// keyId is kept for back-compat but unused here (prevents double-counting per key).
export async function trackTavilyCall(_keyId?: string): Promise<void> {
  const r = redis();
  if (!r) return;
  const k = monthKey();
  const n = await r.incr(k).catch(() => 0);
  if (n === 1) await r.expire(k, 60 * 60 * 24 * 40).catch(() => {}); // ~40d, spans the month
}

// Flag a hard failure (bad key / quota exceeded / rate limited). Auto-expires in 24h.
export async function flagTavilyError(detail: string): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.set(ERR_KEY, JSON.stringify({ detail, at: Date.now() }), { ex: 60 * 60 * 24 }).catch(() => {});
}

export interface TavilyUsage {
  enabled: boolean;
  used: number;        // total calls this month across all keys
  limit: number;       // aggregate capacity = active keys × per-key limit
  perKeyLimit: number; // per-key monthly limit (free tier = 1000)
  near: boolean;       // >= 90% of aggregate capacity
  over: boolean;       // no capacity left
  error: { detail: string; at: number } | null;
  poolTotal: number;   // keys in the rotating pool
  poolActive: number;  // pool keys not exhausted this month
  perKey: { id: string; label: string; masked: string; used: number; limit: number; active: boolean }[];
}

export async function getTavilyUsage(): Promise<TavilyUsage> {
  const r = redis();
  const pool = await listTavilyKeys();
  const poolActive = pool.filter((k) => k.active).length;
  // Enabled if the env key is wired OR we have any pool keys.
  const enabled = !!process.env.TAVILY_API_KEY || pool.length > 0;
  const perKey = pool.map((k) => ({ id: k.id, label: k.label, masked: k.masked, used: k.used, limit: PER_KEY_LIMIT, active: k.active }));
  // Aggregate capacity spreads across every active key (4 keys → 4,000/mo), so the banner
  // reflects true remaining headroom, not a single key's 1,000.
  const limit = (pool.length > 0 ? Math.max(poolActive, 0) : 1) * PER_KEY_LIMIT || PER_KEY_LIMIT;
  if (!r) return { enabled, used: 0, limit, perKeyLimit: PER_KEY_LIMIT, near: false, over: false, error: null, poolTotal: pool.length, poolActive, perKey };
  const used = Number(await r.get(monthKey()).catch(() => 0)) || 0;
  const errRaw = await r.get<any>(ERR_KEY).catch(() => null);
  const error = errRaw ? (typeof errRaw === "string" ? JSON.parse(errRaw) : errRaw) : null;
  // A pool with active keys left means we're NOT actually out, so judge "over" by remaining keys.
  const over = pool.length > 0 ? poolActive === 0 : used >= limit;
  const near = pool.length > 0 ? poolActive <= 1 && !over : used >= limit * 0.9;
  return { enabled, used, limit, perKeyLimit: PER_KEY_LIMIT, near, over, error, poolTotal: pool.length, poolActive, perKey };
}
