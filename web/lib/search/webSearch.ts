// Provider-agnostic web search. Real search APIs (not HTML scraping) so they don't get
// bot-blocked or return junk like DuckDuckGo/Bing do from a server:
//   SEARXNG_URL           — SELF-HOSTED, unmetered. First when configured (see below).
//   TAVILY_API_KEY        — 1,000/mo, no card, renews
//   GOOGLE_CSE_KEY + _CX  — 100/day, no card, renews (real Google)
//   BRAVE_SEARCH_API_KEY  — 2,000/mo, needs card, renews
//   SERPER_API_KEY        — 2,500 one-time, no card (real Google)
//
// SearXNG goes FIRST because it is the only one with no ceiling: it is our own instance
// aggregating other engines, so a query costs nothing and there is no monthly cliff. The metered
// providers stay behind it as fallbacks precisely because SearXNG's upstreams rate-limit
// unpredictably — which the fall-through below already handles, since it advances on an empty
// result rather than on a missing key. Deploy: hermes/deploy/searxng/.
//
// Worth stating plainly: SearXNG asks other engines for results, which is against some of their
// terms of service. The exposure is a blocked droplet IP, not a banned account, and the paid
// providers behind it are what make that survivable. It is a deliberate trade, not an oversight.
//
// Providers are tried IN ORDER until one returns something usable, not just until one is
// configured. The distinction became load-bearing when Tavily started answering some queries
// with 200 OK and N results whose URLs are relative "/goto?url=…" redirect stubs — links that
// resolve nowhere (404 on every Tavily host, verified live). To a "pick the first configured
// provider" design that reads as a successful search with zero hits, and every caller went
// blind while three working providers sat unused.

import { meteredKey } from "@/lib/providers/policy";

export interface SearchHit { url: string; title: string; snippet: string }

/** Every configured provider, in order of preference. */
export function searchProviders(): string[] {
  const list: string[] = [];
  if (process.env.SEARXNG_URL) list.push("searxng");
  if (process.env.TAVILY_API_KEY) list.push("tavily");
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX) list.push("google");
  if (process.env.BRAVE_SEARCH_API_KEY) list.push("brave");
  // Metered, so free-only mode drops it from the list entirely (providers/policy.ts).
  if (meteredKey(process.env.SERPER_API_KEY)) list.push("serper");
  return list;
}

export function searchProvider(): string | null {
  return searchProviders()[0] ?? null;
}

export function searchEnabled(): boolean {
  return searchProviders().length > 0;
}

/**
 * Search with fall-through, reporting which provider actually answered — callers that label
 * their sources (deep_research's degraded mode) need the real one, not the first configured.
 */
export async function webSearchDetailed(
  query: string,
  count = 8,
  signal?: AbortSignal,
  onError?: (msg: string) => void,
): Promise<{ provider: string | null; hits: SearchHit[] }> {
  const providers = searchProviders();
  if (!providers.length) { onError?.("no search API key configured"); return { provider: null, hits: [] }; }
  for (let i = 0; i < providers.length; i++) {
    const hits = await searchOne(providers[i], query, count, signal, onError);
    if (hits.length) return { provider: providers[i], hits };
    if (i < providers.length - 1) onError?.(`${providers[i]} returned nothing usable — trying ${providers[i + 1]}`);
  }
  return { provider: null, hits: [] };
}

export async function webSearch(query: string, count = 8, signal?: AbortSignal, onError?: (msg: string) => void): Promise<SearchHit[]> {
  return (await webSearchDetailed(query, count, signal, onError)).hits;
}

/** One provider, one attempt. Every failure mode — HTTP error, timeout, thrown fetch, usable-hit
 *  count of zero — comes back as [] so the loop above can move on; nothing here ends the search. */
async function searchOne(
  provider: string,
  query: string,
  count: number,
  signal: AbortSignal | undefined,
  onError?: (msg: string) => void,
): Promise<SearchHit[]> {
  // A fresh default deadline per provider: sharing one 12s signal across the loop would let a
  // hung first provider abort every later one before it starts. A caller-supplied signal is
  // theirs to budget and is reused as given.
  const sig = signal ?? AbortSignal.timeout(12000);
  const fail = (res: Response) => onError?.(`${provider} HTTP ${res.status}`);
  try {
    if (provider === "searxng") {
      // Our own instance. `format=json` must be enabled in its settings.yml (the deploy config
      // does this); a SearXNG that has not been configured for JSON answers 403, which lands in
      // the normal fall-through rather than breaking the search.
      const base = (process.env.SEARXNG_URL || "").replace(/\/+$/, "");
      const params = new URLSearchParams({ q: query, format: "json", language: "en" });
      const res = await fetch(`${base}/search?${params}`, {
        headers: {
          Accept: "application/json",
          // SearXNG rejects requests it reads as bot traffic on some builds; a plain UA is enough.
          "User-Agent": "Summit/1.0",
          ...(process.env.SEARXNG_TOKEN ? { Authorization: `Bearer ${process.env.SEARXNG_TOKEN}` } : {}),
        },
        signal: sig,
      });
      if (!res.ok) { fail(res); return []; }
      const d = await res.json();
      return ((d.results ?? []) as Array<{ url?: string; title?: string; content?: string }>)
        .slice(0, count)
        .map((r) => ({ url: String(r.url ?? ""), title: String(r.title ?? ""), snippet: String(r.content ?? "").slice(0, 300) }))
        .filter((h: SearchHit) => h.url.startsWith("http"));
    }

    if (provider === "tavily") {
      const { trackTavilyCall, flagTavilyError, getActiveTavilyKey, markTavilyKeyExhausted } = await import("./tavilyUsage");
      // Quota-exhaustion statuses → this key is spent for the month; roll to the next in the pool.
      const QUOTA = new Set([402, 403, 429, 432]);
      // Try successive keys from the pool until one works or we run out (cap attempts so a
      // pool of dead keys can't loop forever).
      for (let attempt = 0; attempt < 8; attempt++) {
        const active = await getActiveTavilyKey(true); // reserve: bumps this key's per-key count atomically
        if (!active) { onError?.("no Tavily key available (pool empty / all exhausted)"); return []; }
        void trackTavilyCall(); // count toward the global monthly-usage tally (per-key done at reserve)
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: active.key, query, max_results: count, search_depth: "basic" }),
          signal: sig,
        });
        if (res.ok) {
          const d = await res.json();
          const raw = (d.results ?? []) as any[];
          const hits = raw.map((r: any) => ({ url: r.url, title: r.title ?? "", snippet: (r.content ?? "").slice(0, 300) })).filter((h: SearchHit) => h.url?.startsWith("http"));
          // The cloaked-URL mode (see header): results that exist but link nowhere. Not a key
          // problem — the same key answers other queries with real URLs — so don't rotate,
          // just report and let the provider loop fall through.
          if (!hits.length && raw.length) onError?.(`tavily returned ${raw.length} results with unusable relative /goto URLs`);
          return hits;
        }
        if (QUOTA.has(res.status) && active.id && active.id !== "env") {
          // Pool key hit its quota — mark it exhausted for the month and try the next one.
          await markTavilyKeyExhausted(active.id);
          onError?.(`Tavily key ${active.id} exhausted (HTTP ${res.status}) — rotating to next`);
          continue;
        }
        // Non-quota error (e.g. 401 bad key with no id, 5xx) → surface and stop.
        if ([401, 402, 403, 429, 432].includes(res.status)) void flagTavilyError(`HTTP ${res.status}`);
        fail(res); return [];
      }
      onError?.("Tavily: all keys exhausted");
      return [];
    }

    if (provider === "google") {
      const params = new URLSearchParams({ key: process.env.GOOGLE_CSE_KEY!, cx: process.env.GOOGLE_CSE_CX!, q: query, num: String(Math.min(count, 10)) });
      const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, { signal: sig });
      if (!res.ok) { fail(res); return []; }
      const d = await res.json();
      return (d.items ?? []).map((r: any) => ({ url: r.link, title: r.title ?? "", snippet: (r.snippet ?? "").slice(0, 300) })).filter((h: SearchHit) => h.url?.startsWith("http"));
    }

    if (provider === "brave") {
      const params = new URLSearchParams({ q: query, count: String(Math.min(count, 20)) });
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY! },
        signal: sig,
      });
      if (!res.ok) { fail(res); return []; }
      const d = await res.json();
      return (d.web?.results ?? []).map((r: any) => ({ url: r.url, title: r.title ?? "", snippet: (r.description ?? "").slice(0, 300) })).filter((h: SearchHit) => h.url?.startsWith("http"));
    }

    if (provider === "serper") {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": meteredKey(process.env.SERPER_API_KEY) ?? "", "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, num: count }),
        signal: sig,
      });
      if (!res.ok) { fail(res); return []; }
      const d = await res.json();
      return (d.organic ?? []).map((r: any) => ({ url: r.link, title: r.title ?? "", snippet: (r.snippet ?? "").slice(0, 300) })).filter((h: SearchHit) => h.url?.startsWith("http"));
    }

    return [];
  } catch (e: any) {
    onError?.(`${provider}: ${e?.name === "TimeoutError" ? "search timed out" : (e?.message ?? "search network error")}`);
    return [];
  }
}
