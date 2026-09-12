// Which page should own a query, and does this new draft need a canonical.
//
// A canonical tag is not a nice-to-have field to autofill; it is a directive that tells Google "index
// the other page instead of this one". Get it wrong and you have de-indexed the article you just paid
// to write. So the default here is, and stays, EMPTY — an empty canonical means self-canonical, which
// is correct for original content. This module only speaks up when there is real evidence of a
// duplicate, and it says why with numbers.
//
// What actually makes one URL the preferable canonical, in the order that matters:
//
//  1. It already ranks for the query. A page at position 8 with 400 impressions has accumulated
//     signals — links, engagement, history — that a brand-new URL has none of. Canonicalising the new
//     page to it consolidates rather than splits.
//  2. It matches the intent more exactly. A path that IS the keyword ("/apps/ai-headshot-generator"
//     for "ai headshot generator") beats one that merely mentions it.
//  3. Commercial pages outrank informational ones for commercial queries. If the query converts, the
//     product page should own it and the blog post should support it, not compete.
//  4. Shorter path, all else equal. Fewer segments correlates with hierarchy depth and is the
//     conventional tie-break.
//
// The more valuable output is usually NOT the canonical though — it is the cannibalisation warning.
// If we already rank position 8 for the target query, the right move is normally to improve that page
// rather than publish a second one and canonical it away. That gets said out loud.
import { internalLinkCandidates, type LinkCandidate } from "@/lib/sitemap/store";
import { searchAnalytics, daysAgo, isGscConfigured } from "@/lib/indexing/gsc";

export interface Incumbent {
  url: string;
  path: string;
  section: string;
  /** Measured, from Search Console. Null when we have no data for this page + query. */
  position: number | null;
  impressions: number;
  clicks: number;
  /** How much of the query this path literally contains, 0..1. */
  overlap: number;
  is_money: boolean;
  score: number;
  reasons: string[];
}

export type CanonicalVerdict =
  /** Publish it as its own page. The normal, correct outcome. */
  | { kind: "self"; note: string }
  /** The path we are targeting is ITSELF the page that ranks. This is a rebuild, not a new page — a
   *  completely different and much happier situation than cannibalisation, and conflating the two
   *  produced a warning that pointed at an irrelevant weak page while ignoring the real incumbent. */
  | { kind: "rebuild"; incumbent: Incumbent; note: string }
  /** An existing page already owns this query well enough that a second one splits the signal. */
  | { kind: "canonical_to"; incumbent: Incumbent; note: string }
  /** We already rank; improving that page beats publishing a near-duplicate. */
  | { kind: "cannibalisation"; incumbent: Incumbent; note: string };

export interface CanonicalAdvice {
  verdict: CanonicalVerdict;
  /** Everything considered, best first, so a human can disagree with the reasoning. */
  candidates: Incumbent[];
  /** Why the data is thin, when it is. Never silently degrade. */
  notes: string[];
}

/**
 * Words worth matching on, from a query.
 *
 * Two characters, not three. A three-character floor drops "ai", and for this site that is the single
 * most load-bearing word in almost every query: "/blogs/video-generator-tips" and
 * "/blogs/ai-video-generator-tips" are different pages targeting different intent, and a scorer that
 * cannot tell them apart is not scoring the thing that matters. "3d" and "hd" have the same problem.
 * The short function words are listed out instead.
 */
const OVERLAP_STOP = new Set(["of", "to", "in", "on", "at", "by", "or", "an", "is", "it", "as", "be", "do", "my", "we", "us", "vs"]);

export function overlapWords(keyword: string): string[] {
  return keyword.toLowerCase().split(/[^a-z0-9]+/i)
    .filter((w) => w.length >= 2 && !OVERLAP_STOP.has(w));
}

/** Fraction of the query's significant words that appear in the path. */
export function pathOverlap(path: string, keyword: string): number {
  const words = overlapWords(keyword);
  if (!words.length) return 0;
  const slug = path.toLowerCase();
  return words.filter((w) => slug.includes(w)).length / words.length;
}

/**
 * Rank a page's claim to a query. Pure, so the selfcheck can pin the weighting.
 *
 * Ranking position dominates deliberately: it is the only input here that is *measured evidence of
 * Google's own judgement*, where everything else is our inference. A page at position 5 has already
 * been told it is relevant.
 */
export function scoreIncumbent(input: {
  position: number | null;
  impressions: number;
  overlap: number;
  is_money: boolean;
  path: string;
  commercialQuery: boolean;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (input.position !== null) {
    // Position 1 → 30, position 30 → ~1. Steep, because the gap between page one and page three is
    // not linear in value.
    const fromRanking = Math.max(0, 31 - input.position);
    score += fromRanking;
    reasons.push(`already ranks position ${input.position.toFixed(1)}`);
    if (input.impressions >= 100) {
      score += 5;
      reasons.push(`${input.impressions.toLocaleString()} impressions`);
    }
  }

  score += input.overlap * 12;
  if (input.overlap === 1) reasons.push("path contains the whole query");
  else if (input.overlap >= 0.5) reasons.push("path partly matches the query");

  if (input.is_money && input.commercialQuery) {
    score += 6;
    reasons.push("commercial page for a commercial query");
  }

  // Shorter paths win ties. Small weight: it is a tie-break, not a signal.
  const depth = input.path.split("/").filter(Boolean).length;
  score += Math.max(0, 3 - depth);

  return { score: Math.round(score * 10) / 10, reasons };
}

/** Queries with buying intent, where a product page should own the term rather than a blog post. */
const COMMERCIAL_MARKERS = [
  "best", "top", "buy", "price", "pricing", "cost", "cheap", "free", "vs", "alternative",
  "alternatives", "review", "reviews", "software", "tool", "tools", "app", "apps", "generator",
];

export function isCommercialQuery(keyword: string): boolean {
  const words = keyword.toLowerCase().split(/[^a-z0-9]+/i);
  return words.some((w) => COMMERCIAL_MARKERS.includes(w));
}

/**
 * Should this draft carry a canonical, and to where?
 *
 * `excludePath` is the draft's own intended path, so a page does not find itself and recommend
 * canonicalising to itself — which would be both wrong and very confusing.
 */
export async function adviseCanonical(input: {
  keyword: string;
  excludePath?: string;
}): Promise<CanonicalAdvice> {
  const notes: string[] = [];
  const keyword = input.keyword.trim();
  if (!keyword) {
    return { verdict: { kind: "self", note: "No primary keyword, so there is nothing to compare against." }, candidates: [], notes };
  }

  // Topical shortlist from our own inventory.
  let pages: LinkCandidate[] = [];
  try {
    pages = await internalLinkCandidates(keyword, { limit: 12 });
  } catch {
    notes.push("Could not read the site inventory, so no duplicate check was possible.");
  }
  const own = input.excludePath?.replace(/^\/?/, "/");
  // Keep our own path aside rather than discarding it: if it is the page that already ranks, that is
  // the single most important fact about this brief and it must not be filtered into silence.
  const ownPage = own ? pages.find((p) => p.path === own) ?? null : null;
  pages = pages.filter((p) => p.path !== own);

  // Real ranking data for this exact query, per page. This is the evidence that decides it.
  const byPath = new Map<string, { position: number; impressions: number; clicks: number }>();
  if (isGscConfigured()) {
    try {
      const rows = await searchAnalytics({
        startDate: daysAgo(90), endDate: daysAgo(1),
        dimensions: ["query", "page"], rowLimit: 25000,
      });
      const needle = keyword.toLowerCase();
      for (const r of rows) {
        if ((r.keys[0] ?? "").toLowerCase() !== needle) continue;
        const path = (() => { try { return new URL(r.keys[1]).pathname.replace(/\/$/, "") || "/"; } catch { return r.keys[1]; } })();
        const prev = byPath.get(path);
        // Same page can appear once; keep the best-performing row if it somehow repeats.
        if (!prev || r.impressions > prev.impressions) {
          byPath.set(path, { position: r.position, impressions: r.impressions, clicks: r.clicks });
        }
      }
      if (byPath.size === 0) {
        notes.push(`No page currently gets impressions for "${keyword}", so there is no incumbent to defer to.`);
      }
    } catch {
      notes.push("Search Console lookup failed, so ranking evidence is missing and only path matching was used.");
    }
  } else {
    notes.push("Search Console is not connected, so there is no ranking evidence — path matching only.");
  }

  const commercial = isCommercialQuery(keyword);
  const candidates: Incumbent[] = pages.map((p) => {
    const gsc = byPath.get(p.path) ?? null;
    const overlap = pathOverlap(p.path, keyword);
    const is_money = /^\/(apps|features)\//.test(p.path) || /^\/ai-[a-z-]+$/.test(p.path);
    const { score, reasons } = scoreIncumbent({
      position: gsc?.position ?? null,
      impressions: gsc?.impressions ?? 0,
      overlap, is_money, path: p.path, commercialQuery: commercial,
    });
    return {
      url: p.url, path: p.path, section: p.section,
      position: gsc?.position ?? null,
      impressions: gsc?.impressions ?? 0,
      clicks: gsc?.clicks ?? 0,
      overlap, is_money, score, reasons,
    };
  }).sort((a, b) => b.score - a.score);

  // Are we rebuilding a page that already ranks? Check before anything else, because every other
  // verdict below would be answering the wrong question.
  if (own) {
    const selfGsc = byPath.get(own);
    if (selfGsc && selfGsc.position <= 20 && selfGsc.impressions >= 50) {
      const overlap = pathOverlap(own, keyword);
      const is_money = /^\/(apps|features)\//.test(own) || /^\/ai-[a-z-]+$/.test(own);
      const { score, reasons } = scoreIncumbent({
        position: selfGsc.position, impressions: selfGsc.impressions,
        overlap, is_money, path: own, commercialQuery: commercial,
      });
      const incumbent: Incumbent = {
        url: ownPage?.url ?? own, path: own, section: ownPage?.section ?? "",
        position: selfGsc.position, impressions: selfGsc.impressions, clicks: selfGsc.clicks,
        overlap, is_money, score, reasons,
      };
      return {
        verdict: {
          kind: "rebuild",
          incumbent,
          note: `You already own ${own}: it ranks position ${selfGsc.position.toFixed(1)} for "${keyword}" ` +
            `with ${selfGsc.impressions.toLocaleString()} impressions. This is a REBUILD of a page that ` +
            `already works, not a new page. Keep the same URL, do not set a canonical, and do not let the ` +
            `rebuild drop content the current page ranks on.`,
        },
        candidates, notes,
      };
    }
  }

  const top = candidates[0];

  // No candidate, or nothing that looks like the same page: publish it as itself.
  if (!top || top.overlap < 0.6) {
    return {
      verdict: { kind: "self", note: "Nothing on the site covers this closely enough to be a duplicate. Leave the canonical empty." },
      candidates, notes,
    };
  }

  // We already rank respectably for this exact query. Publishing a second page on it splits the
  // signal, and the honest advice is to improve the page that already works.
  if (top.position !== null && top.position <= 15 && top.impressions >= 50) {
    return {
      verdict: {
        kind: "cannibalisation",
        incumbent: top,
        note: `${top.path} already ranks position ${top.position.toFixed(1)} for "${keyword}" with ` +
          `${top.impressions.toLocaleString()} impressions. A second page on the same query usually ` +
          `splits those signals rather than adding to them. Consider expanding that page instead — or ` +
          `if this draft is genuinely a different angle, retarget it to a narrower query.`,
      },
      candidates, notes,
    };
  }

  // The path is effectively the same page, but it is not ranking. A canonical consolidates the two.
  if (top.overlap === 1 && (top.position === null || top.position > 15)) {
    return {
      verdict: {
        kind: "canonical_to",
        incumbent: top,
        note: `${top.path} targets the same query and is not ranking well` +
          `${top.position !== null ? ` (position ${top.position.toFixed(1)})` : " (no impressions)"}. ` +
          `If this draft replaces it, canonical this one to it so the two do not compete — or pick one ` +
          `to keep and redirect the other.`,
      },
      candidates, notes,
    };
  }

  return {
    verdict: { kind: "self", note: "The closest existing page is not close enough to canonical to. Leave it empty." },
    candidates, notes,
  };
}
