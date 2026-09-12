import type { RawHit } from "@/lib/types";

const REDDIT_BASE = "https://www.reddit.com";
const UA = "GenAI-Scout/1.0 (contact: hello@imagine.art)";
const DELAY = 700; // ms between requests — Reddit's soft limit is ~1 req/sec

async function redditFetch(url: string, abort?: AbortSignal): Promise<unknown> {
  await new Promise((r) => setTimeout(r, DELAY));
  if (abort?.aborted) throw new Error("aborted");
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: mergeSignal(abort, 12_000),
  });
  if (!res.ok) throw new Error(`Reddit ${res.status}: ${url}`);
  return res.json();
}

function extractPosts(data: unknown, source: string, query: string, now: string): {
  hits: RawHit[];
  subreddits: Map<string, number>;
} {
  const hits: RawHit[] = [];
  const subreddits = new Map<string, number>();

  const posts = (data as any)?.data?.children ?? [];
  for (const post of posts as any[]) {
    const p = post.data;
    const sub: string = p.subreddit ?? "";
    if (sub) subreddits.set(sub, (subreddits.get(sub) ?? 0) + (p.score ?? 1));

    if (p.url && !p.url.includes("reddit.com") && p.url.startsWith("http")) {
      hits.push({
        url: p.url,
        title: p.title ?? "",
        snippet: `r/${sub} • ${p.score ?? 0} pts`,
        source,
        query,
        discoveredAt: now,
      });
    }
  }
  return { hits, subreddits };
}

export const redditHarvester = {
  name: "reddit" as const,

  async run(
    query: string,
    opts?: {
      subreddits?: string[];
      maxResults?: number;
      depth?: number;
      signal?: AbortSignal;
    }
  ): Promise<RawHit[]> {
    const seedSubs = opts?.subreddits ?? [];
    const maxResults = opts?.maxResults ?? 50;
    const depth = opts?.depth ?? 2;
    const abort = opts?.signal; // 1 = global only, 2 = + discovered subs, 3 = + browse feeds
    const now = new Date().toISOString();

    const allHits = new Map<string, RawHit>(); // dedupe by URL
    const discoveredSubs = new Map<string, number>(); // sub → relevance score

    const addHits = (hits: RawHit[]) => {
      for (const h of hits) {
        if (!allHits.has(h.url)) allHits.set(h.url, h);
      }
    };
    const addSubs = (subs: Map<string, number>) => {
      for (const [sub, score] of subs) {
        discoveredSubs.set(sub, (discoveredSubs.get(sub) ?? 0) + score);
      }
    };

    // ── Layer 0: Global Reddit search ──────────────────────────────────────────
    // Searches ALL of Reddit — not restricted to any subreddit
    try {
      const params = new URLSearchParams({ q: query, sort: "relevance", limit: String(maxResults), t: "year" });
      const data = await redditFetch(`${REDDIT_BASE}/search.json?${params}`, abort);
      const { hits, subreddits } = extractPosts(data, "reddit", query, now);
      addHits(hits);
      addSubs(subreddits);
    } catch { /* continue */ }

    // Also search with "new" sort to catch recent posts
    try {
      const params = new URLSearchParams({ q: query, sort: "new", limit: "50", t: "month" });
      const data = await redditFetch(`${REDDIT_BASE}/search.json?${params}`, abort);
      const { hits, subreddits } = extractPosts(data, "reddit", query, now);
      addHits(hits);
      addSubs(subreddits);
    } catch { /* continue */ }

    if (depth < 2) return [...allHits.values()];

    // ── Layer 1: Dive into discovered + seed subreddits ─────────────────────────
    // Merge discovered subs with configured seed subs
    for (const sub of seedSubs) {
      discoveredSubs.set(sub, (discoveredSubs.get(sub) ?? 0) + 1000); // priority bump for configured subs
    }

    // Take top 12 most relevant subreddits found
    const topSubs = [...discoveredSubs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([sub]) => sub);

    for (const sub of topSubs) {
      try {
        // Search within this subreddit for the query
        const params = new URLSearchParams({ q: query, restrict_sr: "true", sort: "relevance", limit: "50" });
        const data = await redditFetch(`${REDDIT_BASE}/r/${sub}/search.json?${params}`, abort);
        const { hits, subreddits } = extractPosts(data, "reddit", query, now);
        addHits(hits);
        addSubs(subreddits);
      } catch { /* continue */ }
    }

    if (depth < 3) return [...allHits.values()];

    // ── Layer 2: Browse new/hot feeds of top subreddits ─────────────────────────
    // For the 6 most relevant subs, just browse their recent posts regardless of keyword
    // — catches articles posted without the tool name in the title
    const browseTargets = [...discoveredSubs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([sub]) => sub);

    for (const sub of browseTargets) {
      // New posts
      try {
        const data = await redditFetch(`${REDDIT_BASE}/r/${sub}/new.json?limit=50`, abort);
        const { hits } = extractPosts(data, "reddit", `browse:${sub}`, now);
        addHits(hits);
      } catch { /* continue */ }

      // Hot posts
      try {
        const data = await redditFetch(`${REDDIT_BASE}/r/${sub}/hot.json?limit=25`, abort);
        const { hits } = extractPosts(data, "reddit", `browse:${sub}`, now);
        addHits(hits);
      } catch { /* continue */ }
    }

    return [...allHits.values()];
  },
};

function mergeSignal(abort: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  if (!abort) return t;
  return AbortSignal.any([abort, t]);
}
