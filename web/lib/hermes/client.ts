/**
 * Hermes client — the seam for the separately-hosted research/discovery agent.
 *
 * Hermes (github.com/Vyro-ai/charon-hermes, "Computer Agent") is a Python agent platform with a real
 * browser stack: Camoufox for anti-detection page loads, CDP control, and a browser supervisor. It
 * cannot run inside this app — Vercel functions have no Python and no browser — so it lives on its
 * own host and we talk to it over HTTP.
 *
 * Two jobs we want from it, in order of value:
 *
 *   1. **Hard scraping for enrichment.** Our cascade's `page-scrape` step uses a plain fetch, which
 *      is why so many prospects end with no address or a constructed guess. A stealth browser can
 *      actually load the author pages and contact pages that block us today. This is the single
 *      change most likely to move the funnel.
 *   2. **Research for blog posts.** Upcoming model launches, topic timing, competitor
 *      moves. Lower value than (1) because the writer already has Tavily/Serper web search with a
 *      provenance ledger — Hermes only wins here where a page needs a real browser to read.
 *
 * Everything degrades cleanly when HERMES_BASE_URL is unset: `hermesEnabled()` is false, callers
 * fall back to the existing path, and nothing throws. That is deliberate — this must be safe to ship
 * before the service exists, exactly like `writerEnabled()` and `falEnabled()` elsewhere.
 */

export interface HermesResearchRequest {
  /** What to find out, in plain language. */
  question: string;
  /** Optional steer on recency, e.g. "last 30 days". */
  window?: string;
  /** Hard ceiling on wall-clock, so a research call can never hang a request. */
  timeoutMs?: number;
}

export interface HermesResearchResult {
  answer: string;
  /** Every URL the agent actually read. Kept separate from the prose so claims stay auditable —
   *  the writer's no-invented-citations rule depends on being able to check this. */
  sources: string[];
  model?: string;
}

export interface HermesScrapeRequest {
  url: string;
  /** What we're looking for on the page — an email address, a byline, a contact form. */
  want: "email" | "byline" | "contact" | "text";
  timeoutMs?: number;
}

export interface HermesScrapeResult {
  ok: boolean;
  /** The extracted value, when `want` was a specific field. */
  value: string | null;
  /** Rendered page text, when `want` was "text". */
  text?: string;
  /** True when the page was only reachable with the stealth browser — useful for measuring whether
   *  Hermes is actually earning its keep versus a plain fetch. */
  neededBrowser?: boolean;
  status?: number;
  error?: string;
}

/** Is a Hermes host configured? Every caller must check this and have a fallback. */
export function hermesEnabled(): boolean {
  return !!process.env.HERMES_BASE_URL?.trim();
}

function baseUrl(): string {
  return (process.env.HERMES_BASE_URL ?? "").trim().replace(/\/$/, "");
}

/** Shared auth + JSON transport. Bearer, because that is what the Computer API server expects. */
async function call<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const token = process.env.HERMES_TOKEN?.trim();
  // AbortController rather than a race, so the socket is actually closed on timeout instead of
  // leaking a pending request per call.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // The error body IS the diagnosis: the service answers 503 with a `detail` naming exactly
      // which env var it is missing. Swallowing it left callers reporting "failed or timed out"
      // for what was actually a half-second refusal.
      let detail = "";
      try {
        const b = (await res.json()) as { detail?: unknown; error?: unknown };
        detail = String(b?.detail ?? b?.error ?? "").slice(0, 300);
      } catch { /* non-JSON error body */ }
      throw new Error(`Hermes ${path} returned ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    // fetch reports our own deadline as a generic AbortError; name the real cause.
    if (ctrl.signal.aborted) throw new Error(`Hermes ${path} timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** A failed call, carrying the reason the service actually gave (auth refusal, missing env var,
 *  real timeout) instead of collapsing every failure into null. */
export interface HermesCallFailure {
  ok: false;
  error: string;
}

/**
 * Ask Hermes a research question.
 *
 * Returns null only when Hermes is not configured (HERMES_BASE_URL unset), so a caller can write
 * `(await hermesResearch(q)) ?? fallback()` for the disabled state. A call that reached the service
 * and failed returns a HermesCallFailure with the service's own reason — a 503 for a missing token
 * and a genuine timeout are different problems, and the caller should be able to say which.
 */
export async function hermesResearch(req: HermesResearchRequest): Promise<HermesResearchResult | HermesCallFailure | null> {
  if (!hermesEnabled()) return null;
  try {
    return await call<HermesResearchResult>("/v1/research", {
      question: req.question,
      window: req.window ?? null,
    }, req.timeoutMs ?? 120_000);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unreachable" };
  }
}

/**
 * Fetch a page through Hermes' stealth browser and pull one thing off it.
 *
 * This is the enrichment path. Intended use is as a LAST resort inside the existing cascade: try the
 * cheap plain fetch first, and only pay for a browser when that fails — otherwise every prospect
 * costs a browser session.
 */
export async function hermesScrape(req: HermesScrapeRequest): Promise<HermesScrapeResult | null> {
  if (!hermesEnabled()) return null;
  try {
    return await call<HermesScrapeResult>("/v1/scrape", {
      url: req.url,
      want: req.want,
    }, req.timeoutMs ?? 60_000);
  } catch (e) {
    return { ok: false, value: null, error: e instanceof Error ? e.message : "unreachable" };
  }
}

/** Liveness, for a settings page to show whether the host is actually up. */
export async function hermesHealth(): Promise<{ configured: boolean; reachable: boolean; detail?: string }> {
  if (!hermesEnabled()) return { configured: false, reachable: false, detail: "HERMES_BASE_URL is not set." };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const token = process.env.HERMES_TOKEN?.trim();
    const res = await fetch(`${baseUrl()}/v1/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: ctrl.signal,
    });
    return { configured: true, reachable: res.ok, detail: res.ok ? undefined : `health returned ${res.status}` };
  } catch (e) {
    return { configured: true, reachable: false, detail: e instanceof Error ? e.message : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
