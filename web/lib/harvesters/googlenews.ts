import type { RawHit } from "@/lib/types";

// Google News RSS — free, no API key, searches Google's full news index
const BASE = "https://news.google.com/rss/search";

export const googleNewsHarvester = {
  name: "googlenews" as const,

  async run(query: string, opts?: { maxResults?: number; signal?: AbortSignal }): Promise<RawHit[]> {
    const now = new Date().toISOString();
    const max = opts?.maxResults ?? 20;

    try {
      const params = new URLSearchParams({
        q: query,
        hl: "en-US",
        gl: "US",
        ceid: "US:en",
      });

      const res = await fetch(`${BASE}?${params}`, {
        headers: { "User-Agent": "GenAI-Scout/1.0" },
        signal: mergeSignal(opts?.signal, 12_000),
      });

      if (!res.ok) return [];
      const text = await res.text().catch(() => "");
      if (!text) return [];

      const hits: RawHit[] = [];
      const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
      let m: RegExpExecArray | null;

      while ((m = itemPattern.exec(text)) !== null && hits.length < max) {
        const block = m[1];

        // Google News wraps the real URL in a redirect — extract the actual source URL
        const linkMatch = block.match(/<link>(https?:\/\/[^<]+)<\/link>/) ??
          block.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/);
        const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        const descMatch = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);

        const url = linkMatch?.[1]?.trim();
        if (!url?.startsWith("http")) continue;

        hits.push({
          url,
          title: titleMatch?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "",
          snippet: descMatch?.[1]?.replace(/<[^>]+>/g, "").trim().slice(0, 300) ?? "",
          source: "googlenews",
          query,
          discoveredAt: now,
        });
      }

      return hits;
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
