import type { RawHit } from "@/lib/types";

const WAYBACK_CDX = "http://web.archive.org/cdx/search/cdx";

export const waybackHarvester = {
  name: "wayback" as const,
  async run(query: string, opts?: { maxResults?: number }): Promise<RawHit[]> {
    const max = opts?.maxResults ?? 60;
    const now = new Date().toISOString();

    // Search for blog/article pages mentioning AI tools
    const searchUrls = [
      `*.medium.com/*best*ai*`,
      `*.substack.com/*ai-tools*`,
      `*.wordpress.com/*ai-video*`,
    ];

    const hits: RawHit[] = [];

    for (const pattern of searchUrls.slice(0, 2)) {
      try {
        const params = new URLSearchParams({
          url: pattern,
          output: "json",
          fl: "original,timestamp,statuscode",
          filter: "statuscode:200",
          limit: String(Math.ceil(max / searchUrls.length)),
          collapse: "urlkey",
        });

        const res = await fetch(`${WAYBACK_CDX}?${params}`, {
          headers: { "User-Agent": "GenAI-Scout/1.0" },
          signal: AbortSignal.timeout(20_000),
        });

        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        if (!Array.isArray(data)) continue;

        for (const row of data.slice(1)) {
          const url = row[0];
          if (url?.startsWith("http")) {
            hits.push({ url, source: "wayback", query, discoveredAt: now });
          }
        }
      } catch {
        continue;
      }
    }

    return hits.slice(0, max);
  },
};
