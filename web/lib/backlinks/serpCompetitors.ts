// Live SERP lookup via Serper (google.serper.dev) — real "who outranks us and why" data for the
// Rank Watcher. Returns the organic results ranking above northwind.example for a query. No key → null
// (the caller then simply omits the competitor line rather than showing a stub).
import { meteredProviderEnabled, meteredKey } from "@/lib/providers/policy";
export interface SerpCompetitor {
  position: number;
  domain: string;
  title: string;
  link: string;
}

export function serperEnabled(): boolean {
  return meteredProviderEnabled(!!process.env.SERPER_API_KEY);
}

/**
 * Top competitors outranking us for `query`. `ourPosition` (from GSC) lets us return only the
 * results ranking ABOVE us; if unknown, returns the top `limit` non-first-party results.
 */
export async function topCompetitors(
  query: string,
  opts: { ourDomain?: string; ourPosition?: number; limit?: number } = {},
): Promise<SerpCompetitor[] | null> {
  const key = meteredKey(process.env.SERPER_API_KEY);
  if (!key || !query) return null;
  const ourDomain = opts.ourDomain ?? "northwind.example";
  const limit = opts.limit ?? 4;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 10 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const d: any = await res.json();
    const organic: any[] = Array.isArray(d.organic) ? d.organic : [];
    const cutoff = opts.ourPosition && opts.ourPosition > 0 ? opts.ourPosition : Infinity;
    const comps: SerpCompetitor[] = [];
    for (const o of organic) {
      const link = o.link || "";
      let domain = "";
      try { domain = new URL(link).hostname.replace(/^www\./, "").toLowerCase(); } catch { continue; }
      if (domain === ourDomain || domain.endsWith(`.${ourDomain}`)) continue; // skip our own result
      const position = typeof o.position === "number" ? o.position : comps.length + 1;
      if (position >= cutoff) continue; // only those ABOVE us
      comps.push({ position, domain, title: o.title || "", link });
      if (comps.length >= limit) break;
    }
    return comps;
  } catch {
    return null;
  }
}
