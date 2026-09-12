import type { RawHit } from "@/lib/types";

const HN_ALGOLIA = "https://hn.algolia.com/api/v1/search";

export const hnHarvester = {
  name: "hackernews" as const,
  async run(query: string, opts?: { maxResults?: number; signal?: AbortSignal }): Promise<RawHit[]> {
    const max = opts?.maxResults ?? 40;
    const now = new Date().toISOString();

    try {
      const params = new URLSearchParams({
        query,
        tags: "story",
        hitsPerPage: String(max),
        numericFilters: "points>5",
      });

      const res = await fetch(`${HN_ALGOLIA}?${params}`, {
        headers: { "User-Agent": "GenAI-Scout/1.0" },
        signal: mergeSignal(opts?.signal, 10_000),
      });

      if (!res.ok) return [];
      const data = await res.json().catch(() => null);
      if (!data?.hits) return [];

      const hits: RawHit[] = [];

      for (const hit of data.hits as any[]) {
        // External article URL
        if (hit.url) {
          hits.push({
            url: hit.url,
            title: hit.title,
            snippet: `HN: ${hit.points} pts, ${hit.num_comments} comments`,
            source: "hackernews",
            query,
            discoveredAt: now,
          });
        }
        // HN discussion page itself
        hits.push({
          url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          title: hit.title,
          snippet: `HN discussion`,
          source: "hackernews",
          query,
          discoveredAt: now,
        });
      }

      return hits.filter((h) => h.url.startsWith("http"));
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
