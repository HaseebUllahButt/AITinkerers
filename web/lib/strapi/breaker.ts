// Stop hammering Strapi while it is already failing.
//
// ── Why retry alone is not enough ───────────────────────────────────────────────────────────────
//
// Retry fixes a blip: one call, three attempts, and a transient 503 becomes a success. During a
// SUSTAINED outage it does the opposite of helping. A single request into this app can make a dozen
// Strapi calls — buildEntryPlan reads the schema, the entry, and every section — so three attempts each
// turns one page load into ~36 requests against a CMS that is already on the floor. Add the weekday
// cron and a person clicking Refresh and the amplification is what keeps it there.
//
// This project has a specific reason to care: `content-type-builder/components` is a 211KB response
// that folds first under load, and the CMS cannot be restarted by us.
//
// ── Where the state lives, and why it is two-tier ───────────────────────────────────────────────
//
// IN-PROCESS is the primary, and that is not a compromise. The largest multiplier is WITHIN one
// invocation — the dozen sequential calls above — and an in-process flag stops all of them for free,
// with no network call on the healthy path.
//
// REDIS shares it, so a second serverless instance does not have to rediscover the outage from
// scratch. It is deliberately cheap: reads are throttled to one per SYNC_MS per instance, writes are
// fire-and-forget. If Redis is missing or slow the breaker still works, just per-instance.
//
// ── It fails OPEN ───────────────────────────────────────────────────────────────────────────────
//
// Every uncertain path — no Redis, a Redis error, an unreadable value — allows the call. A breaker that
// blocks traffic because its own bookkeeping broke is worse than no breaker: it would take the CMS
// offline for the app while the CMS was perfectly healthy.
import { redis } from "@/lib/redis";

/** Consecutive retry-exhausted failures before the circuit opens. */
const THRESHOLD = 3;
/** How long it stays open before a single probe is allowed through. */
const COOLDOWN_MS = 60_000;
/** How often one instance will consult Redis for somebody else's verdict. */
const SYNC_MS = 10_000;
const KEY = "strapi:breaker:open-until";

interface State {
  /** Consecutive failures seen by THIS instance. */
  failures: number;
  /** Epoch ms until which the circuit is open, or 0. */
  openUntil: number;
  /** Last time we asked Redis. */
  syncedAt: number;
  /** A probe is in flight in half-open, so nothing else should be. */
  probing: boolean;
}

const state: State = { failures: 0, openUntil: 0, syncedAt: 0, probing: false };

/** Exposed for tests and for a status read; not for callers to poke. */
export function breakerState(): Readonly<State> {
  return state;
}

export function resetBreaker(): void {
  state.failures = 0;
  state.openUntil = 0;
  state.syncedAt = 0;
  state.probing = false;
}

export class StrapiCircuitOpen extends Error {
  constructor(msForRemaining: number) {
    super(
      `Strapi is failing repeatedly, so this call was not attempted. ` +
      `Trying again in ${Math.ceil(msForRemaining / 1000)}s. ` +
      `Nothing was written or read — retry after that, or check the CMS.`,
    );
    this.name = "StrapiCircuitOpen";
  }
}

/** Pull another instance's verdict, at most once per SYNC_MS. Best-effort. */
async function syncFromRedis(now: number): Promise<void> {
  if (now - state.syncedAt < SYNC_MS) return;
  state.syncedAt = now;
  const r = redis();
  if (!r) return;
  try {
    const until = await r.get<number>(KEY);
    // Only ever ADOPTS a later deadline. A stale local value must not shorten somebody else's
    // cooldown, and a stale Redis value must not extend one we have already recovered from.
    if (typeof until === "number" && until > state.openUntil) state.openUntil = until;
  } catch { /* fails open — see the header */ }
}

/**
 * Decide whether this call may proceed.
 *
 * Returns null to proceed, or the error to throw. Returning rather than throwing keeps the decision
 * and the failure in the caller's control flow, which matters because `req` wants to count the outcome.
 */
export async function guard(now = Date.now()): Promise<StrapiCircuitOpen | null> {
  await syncFromRedis(now);

  if (state.openUntil === 0) return null;

  if (now >= state.openUntil) {
    // Half-open: exactly ONE call gets to find out whether the CMS is back. Letting the whole backlog
    // through at the instant the cooldown ends would re-create the pile-on this exists to prevent.
    if (state.probing) return new StrapiCircuitOpen(1_000);
    state.probing = true;
    return null;
  }
  return new StrapiCircuitOpen(state.openUntil - now);
}

/** A call came back healthy. Closes the circuit — one success is enough, the CMS is either up or not. */
export function recordSuccess(): void {
  state.failures = 0;
  state.probing = false;
  if (state.openUntil !== 0) {
    state.openUntil = 0;
    const r = redis();
    // Clearing is fire-and-forget for the same reason as setting: the local state is already correct,
    // and awaiting a REST call here would put Redis latency on the recovery path.
    if (r) void r.del(KEY).catch(() => {});
  }
}

/**
 * A call failed in a way that suggests the CMS, not the request.
 *
 * ONLY called for retry-exhausted 5xx and transport failures. A 4xx must never reach here: a run of
 * validation errors means our payloads are wrong, and opening the circuit would then block the reads
 * somebody needs in order to see why.
 */
export function recordFailure(now = Date.now()): void {
  state.probing = false;
  state.failures += 1;
  if (state.failures < THRESHOLD) return;
  state.openUntil = now + COOLDOWN_MS;
  const r = redis();
  if (r) {
    void (async () => {
      try {
        await r.set(KEY, state.openUntil, { px: COOLDOWN_MS });
      } catch { /* per-instance breaking is still better than none */ }
    })();
  }
}
