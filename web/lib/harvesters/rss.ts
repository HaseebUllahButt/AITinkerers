import type { RawHit } from "@/lib/types";

const UA = `GenAI-Scout/1.0 (+${process.env.APP_URL ?? "http://localhost:3000"})`;

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!r?.ok) return "";
  return r.text().catch(() => "");
}

function extractUrls(text: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    matches.push(m[1]);
  }
  return [...new Set(matches)];
}

async function discoverFeeds(domain: string): Promise<string[]> {
  const feeds: string[] = [];
  const base = `https://${domain}`;

  // Try common feed paths
  const candidates = [
    `${base}/feed`,
    `${base}/rss`,
    `${base}/rss.xml`,
    `${base}/feed.xml`,
    `${base}/atom.xml`,
    `${base}/index.xml`,
  ];

  // Also check robots.txt for sitemap
  const robots = await fetchText(`${base}/robots.txt`);
  const sitemapUrls = extractUrls(robots, /Sitemap:\s*(https?:\/\/[^\s]+)/gi);
  if (sitemapUrls.length > 0) {
    feeds.push(...sitemapUrls);
  }

  // Try homepage for feed links
  const homepage = await fetchText(base);
  const feedLinks = extractUrls(
    homepage,
    /href="([^"]*(?:rss|feed|atom)[^"]*)"/gi
  );
  feeds.push(...feedLinks.filter((u) => u.startsWith("http") || u.startsWith("/")));

  // Add candidates
  feeds.push(...candidates);

  return [...new Set(feeds.slice(0, 5))];
}

async function parseFeed(url: string, source: string): Promise<RawHit[]> {
  const text = await fetchText(url);
  if (!text) return [];

  const hits: RawHit[] = [];
  const now = new Date().toISOString();

  // Match both RSS <item> and Atom <entry>
  const itemPattern = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let m: RegExpExecArray | null;

  while ((m = itemPattern.exec(text)) !== null) {
    const block = m[1];

    const linkMatch =
      block.match(/<link[^>]*>([^<]+)<\/link>/) ??
      block.match(/<link[^>]+href="([^"]+)"/) ??
      block.match(/<guid[^>]*>([^<]+)<\/guid>/);

    const titleMatch = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const descMatch = block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
    const dateMatch =
      block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ??
      block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i);

    const link = linkMatch?.[1]?.trim();
    if (!link || !link.startsWith("http")) continue;

    const title = titleMatch?.[1]?.replace(/<[^>]+>/g, "").trim();
    const snippet = descMatch?.[1]?.replace(/<[^>]+>/g, "").trim().slice(0, 300);

    hits.push({
      url: link,
      title,
      snippet,
      source,
      discoveredAt: now,
    });
  }

  return hits;
}

async function parseSitemap(url: string, source: string, query: string): Promise<RawHit[]> {
  const text = await fetchText(url);
  if (!text) return [];

  const hits: RawHit[] = [];
  const now = new Date().toISOString();

  // Handle sitemap index
  if (text.includes("<sitemapindex")) {
    const sitemapUrls = extractUrls(text, /<loc>(https?:\/\/[^<]+)<\/loc>/gi);
    const results = await Promise.all(sitemapUrls.slice(0, 3).map((u) => parseSitemap(u, source, query)));
    return results.flat();
  }

  // Regular sitemap
  const urlPattern = /<url>([\s\S]*?)<\/url>/gi;
  let m: RegExpExecArray | null;
  while ((m = urlPattern.exec(text)) !== null) {
    const block = m[1];
    const locMatch = block.match(/<loc>(https?:\/\/[^<]+)<\/loc>/i);
    const loc = locMatch?.[1]?.trim();
    if (!loc) continue;

    // Filter by keywords
    const lower = loc.toLowerCase();
    if (
      lower.includes(query.toLowerCase()) ||
      lower.includes("/blog/") ||
      lower.includes("/article/") ||
      lower.includes("/post/")
    ) {
      hits.push({ url: loc, source, query, discoveredAt: now });
    }
  }

  return hits.slice(0, 100);
}

async function processDomain(domain: string, query: string): Promise<RawHit[]> {
  const hits: RawHit[] = [];
  const feeds = await discoverFeeds(domain);
  for (const feed of feeds) {
    if (feed.includes("sitemap") || feed.includes(".xml")) {
      hits.push(...await parseSitemap(feed, "rss", query));
    } else {
      hits.push(...await parseFeed(feed, "rss"));
    }
  }
  return hits;
}

export const rssHarvester = {
  name: "rss" as const,
  async run(query: string, opts?: { domains?: string[] }): Promise<RawHit[]> {
    const domains = opts?.domains ?? [];
    const BATCH = 20; // process 20 domains concurrently (I/O-bound; keeps a big list in budget)
    const results: RawHit[] = [];

    for (let i = 0; i < domains.length; i += BATCH) {
      const batch = domains.slice(i, i + BATCH);
      const settled = await Promise.allSettled(batch.map((d) => processDomain(d, query)));
      for (const r of settled) {
        if (r.status === "fulfilled") results.push(...r.value);
      }
    }

    return results;
  },
};
