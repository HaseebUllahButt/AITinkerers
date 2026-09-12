import type { RawHit } from "@/lib/types";
import { webSearch, searchEnabled } from "@/lib/search/webSearch";

// Discovery harvester backed by a real search API (Tavily/Google/Brave/Serper). Unlike
// scraping DuckDuckGo/Bing (blocked / junk from a server), these return real result URLs
// we can ingest as blog-post hits. Gated by whichever search key is configured.
export const webSearchHarvester = {
  name: "websearch" as const,

  async run(query: string, opts?: { maxResults?: number; signal?: AbortSignal }): Promise<RawHit[]> {
    if (!searchEnabled()) return [];
    const now = new Date().toISOString();
    const hits = await webSearch(query, opts?.maxResults ?? 10, opts?.signal).catch(() => []);
    return hits.map((h) => ({
      url: h.url,
      title: h.title,
      snippet: h.snippet,
      source: "websearch",
      query,
      discoveredAt: now,
    }));
  },
};
