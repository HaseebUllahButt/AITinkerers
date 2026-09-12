import type { RawHit } from "@/lib/types";

// DuckDuckGo HTML endpoint — free, no API key, no rate limit enforced
const DDG_URL = "https://html.duckduckgo.com/html/";

export const duckduckgoHarvester = {
  name: "duckduckgo" as const,

  async run(query: string, opts?: { maxResults?: number; signal?: AbortSignal }): Promise<RawHit[]> {
    const now = new Date().toISOString();
    const max = opts?.maxResults ?? 60; // 3 pages × ~20 results
    const seenUrls = new Set<string>();
    const allHits: RawHit[] = [];

    // Fetch multiple pages — DDG paginates via s= offset (0, 30, 60…)
    const pages = Math.ceil(max / 20);
    for (let page = 0; page < pages; page++) {
      if (opts?.signal?.aborted) break;
      if (allHits.length >= max) break;

      try {
        const body = new URLSearchParams({ q: query, kl: "us-en" });
        if (page > 0) body.set("s", String(page * 30));

        const res = await fetch(DDG_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
          },
          body,
          signal: mergeSignal(opts?.signal, 15_000),
        });

        if (!res.ok) break;
        const html = await res.text().catch(() => "");
        if (!html) break;

        const resultPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

        const pageUrls: string[] = [];
        const pageTitles: string[] = [];
        let m: RegExpExecArray | null;

        while ((m = resultPattern.exec(html)) !== null) {
          const rawHref = m[1];
          const title = m[2].replace(/<[^>]+>/g, "").trim();
          let url = rawHref;
          try {
            const u = new URL(rawHref.startsWith("http") ? rawHref : `https://duckduckgo.com${rawHref}`);
            const uddg = u.searchParams.get("uddg");
            if (uddg) url = decodeURIComponent(uddg);
          } catch {}
          if (!url.startsWith("http") || url.includes("duckduckgo.com")) continue;
          if (seenUrls.has(url)) continue;
          seenUrls.add(url);
          pageUrls.push(url);
          pageTitles.push(title);
        }

        const pageSnippets: string[] = [];
        while ((m = snippetPattern.exec(html)) !== null) {
          pageSnippets.push(m[1].replace(/<[^>]+>/g, "").trim());
        }

        for (let i = 0; i < pageUrls.length; i++) {
          allHits.push({
            url: pageUrls[i],
            title: pageTitles[i] ?? "",
            snippet: pageSnippets[i]?.slice(0, 300) ?? "",
            source: "duckduckgo",
            query,
            discoveredAt: now,
          });
        }

        // DDG returns no results on page past the end — stop early
        if (pageUrls.length === 0) break;
      } catch {
        break;
      }
    }

    return allHits;
  },
};

function mergeSignal(abort: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  if (!abort) return t;
  return AbortSignal.any([abort, t]);
}
