import type { RawHit } from "@/lib/types";

const CDX_API = "http://index.commoncrawl.org/CC-MAIN-2024-51-index";

export const commonCrawlHarvester = {
  name: "commoncrawl" as const,
  async run(query: string, opts?: { maxResults?: number }): Promise<RawHit[]> {
    const max = opts?.maxResults ?? 100;
    const now = new Date().toISOString();
    const hits: RawHit[] = [];

    // Use URL patterns rather than full-text (CDX is URL-indexed)
    const urlPatterns = [
      "*.medium.com/*ai*",
      "*.substack.com/*ai*",
      "*.wordpress.com/*generative-ai*",
      "*.towardsdatascience.com/*",
      "*.venturebeat.com/*ai*",
    ];

    for (const pattern of urlPatterns.slice(0, 2)) {
      try {
        const params = new URLSearchParams({
          url: pattern,
          output: "json",
          fl: "url,title,timestamp",
          limit: String(Math.ceil(max / urlPatterns.length)),
          filter: "=status:200",
        });

        const res = await fetch(`${CDX_API}?${params}`, {
          headers: { "User-Agent": "GenAI-Scout/1.0" },
          signal: AbortSignal.timeout(20_000),
        });

        if (!res.ok) continue;
        const text = await res.text();
        const lines = text.trim().split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.url?.startsWith("http")) {
              hits.push({
                url: obj.url,
                title: obj.title,
                source: "commoncrawl",
                query,
                discoveredAt: now,
              });
            }
          } catch {}
        }
      } catch {
        continue;
      }
    }

    return hits.slice(0, max);
  },
};
