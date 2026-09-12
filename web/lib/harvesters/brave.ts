import type { RawHit } from "@/lib/types";

export const braveHarvester = {
  name: "brave" as const,
  async run(query: string, opts?: { maxResults?: number; signal?: AbortSignal }): Promise<RawHit[]> {
    const key = process.env.BRAVE_SEARCH_API_KEY;
    if (!key) return []; // gracefully disabled when no key

    const max = opts?.maxResults ?? 30;
    const now = new Date().toISOString();

    try {
      const params = new URLSearchParams({
        q: query,
        count: String(Math.min(max, 20)),
        freshness: "pm",
      });

      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: {
          "User-Agent": "GenAI-Scout/1.0",
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": key,
        },
        signal: mergeSignal(opts?.signal, 10_000),
      });

      if (!res.ok) return [];
      const data = await res.json().catch(() => null);

      return (data?.web?.results ?? []).map((r: any) => ({
        url: r.url,
        title: r.title,
        snippet: r.description?.slice(0, 300),
        source: "brave",
        query,
        discoveredAt: now,
      }));
    } catch {
      return [];
    }
  },
};

function mergeSignal(abort: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  if (!abort) return t;
  return AbortSignal.any([abort, t]);
}
