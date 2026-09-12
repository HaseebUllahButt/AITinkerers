import type { RawHit } from "@/lib/types";

const UA = "GenAI-Scout/1.0 (+http://localhost:3000)";

export const ghostHarvester = {
  name: "ghost" as const,
  async run(query: string, opts?: { domains?: string[] }): Promise<RawHit[]> {
    const domains = opts?.domains ?? [];
    const now = new Date().toISOString();
    const hits: RawHit[] = [];

    for (const domain of domains) {
      // Try Ghost Content API first
      try {
        const ghostRes = await fetch(
          `https://${domain}/ghost/api/content/posts/?filter=tag:ai&limit=20&fields=url,title,excerpt,published_at,authors`,
          { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8_000) }
        );
        if (ghostRes.ok) {
          const data = await ghostRes.json().catch(() => null);
          for (const post of data?.posts ?? []) {
            if (post.url?.startsWith("http")) {
              hits.push({
                url: post.url,
                title: post.title,
                snippet: post.excerpt?.slice(0, 300),
                source: "ghost",
                query,
                discoveredAt: now,
              });
            }
          }
          continue;
        }
      } catch {}

      // Fallback: RSS feed
      try {
        const rssRes = await fetch(`https://${domain}/rss/`, {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(8_000),
        });
        if (rssRes.ok) {
          const xml = await rssRes.text();
          const items = xml.match(/<item>([\s\S]*?)<\/item>/gi) ?? [];
          for (const item of items.slice(0, 20)) {
            const link = item.match(/<link>([^<]+)<\/link>/)?.[1]?.trim();
            const title = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim();
            if (link?.startsWith("http")) {
              hits.push({ url: link, title, source: "ghost", query, discoveredAt: now });
            }
          }
        }
      } catch {}
    }

    return hits;
  },
};
