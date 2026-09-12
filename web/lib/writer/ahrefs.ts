// Ahrefs v3, for the two things the SERP layer could not previously answer: how much demand a keyword
// actually has, and how strong the pages ranking for it really are.
//
// ── Why this sits alongside Serper rather than replacing it ────────────────────────────────────────
//
// They are complementary, and swapping one for the other would lose real capability:
//
//   Ahrefs gives   search volume, keyword difficulty, and per-result domain_rating + organic traffic
//   Serper gives   People Also Ask, related searches, and result snippets
//
// PAA is the only legitimate source of FAQ headings in this system (the validator checks question
// headings against it and flags invented ones), and Ahrefs does not return it. Volume and difficulty
// are what the writer previously had to be told NOT to state, because nothing could measure them.
// Using both means the model finally gets the full picture.
//
// ── Units ──────────────────────────────────────────────────────────────────────────────────────────
//
// Ahrefs bills per ROW returned, not per request, and the workspace was at 845,772 of 1,000,000 units
// when this was written, resetting monthly. Every call here is therefore capped and cached, and the
// row limits below are deliberately small. Raising a `limit` is a real cost decision, not a tuning
// knob: `select` also matters, because unrequested columns are not billed.

import { meteredProviderEnabled, meteredKey } from "@/lib/providers/policy";
const BASE = "https://api.ahrefs.com/v3";

export function ahrefsEnabled(): boolean {
  return meteredProviderEnabled(!!process.env.AHREFS_API_KEY);
}

/**
 * Per-process cache.
 *
 * Deliberately modest: on serverless a cold start loses it, so this is not a substitute for restraint,
 * it just stops one request that looks a keyword up twice from paying twice. The 6h TTL reflects how
 * fast the underlying data actually moves — volume is a monthly average and a SERP does not reshuffle
 * within a working session.
 */
const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 6 * 60 * 60 * 1000;

async function call<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const key = meteredKey(process.env.AHREFS_API_KEY);
  if (!key) return null;
  const qs = new URLSearchParams(params).toString();
  const cacheKey = `${path}?${qs}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;

  try {
    const res = await fetch(`${BASE}/${path}?${qs}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(25_000),
    });
    // Never throw. Ahrefs is an enrichment layer: the writer must keep working on a 402 (units
    // exhausted) or a 429, just with less data, rather than failing the whole research step.
    if (!res.ok) return null;
    const json = (await res.json()) as T;
    cache.set(cacheKey, { at: Date.now(), value: json });
    return json;
  } catch {
    return null;
  }
}

export interface AhrefsKeyword {
  keyword: string;
  /** Monthly search volume. The number the writer was previously forbidden from stating. */
  volume: number | null;
  /** Keyword Difficulty, 0-100. */
  difficulty: number | null;
}

/** Volume and difficulty for one keyword. 1 row. */
export async function keywordOverview(keyword: string, country = "us"): Promise<AhrefsKeyword | null> {
  const d = await call<{ keywords?: Array<{ keyword: string; volume_monthly?: number; difficulty?: number }> }>(
    "keywords-explorer/overview",
    { select: "keyword,volume_monthly,difficulty", country, keywords: keyword },
  );
  const k = d?.keywords?.[0];
  if (!k) return null;
  return { keyword: k.keyword, volume: k.volume_monthly ?? null, difficulty: k.difficulty ?? null };
}

export interface AhrefsSerpRow {
  position: number;
  url: string;
  title: string;
  /** Ahrefs Domain Rating of the ranking page's domain. */
  dr: number | null;
  /** Estimated monthly organic traffic to that specific URL. */
  traffic: number | null;
}

/**
 * Who ranks, with the two signals that make the list actionable.
 *
 * `traffic` is the addition worth understanding: position alone says who is above us, but traffic says
 * which of those positions is worth anything. A page at #3 pulling 200 visits a month and a page at #3
 * pulling 80,000 are completely different competitive situations, and the writer could not previously
 * tell them apart.
 */
export async function serpOverview(keyword: string, country = "us", limit = 10): Promise<AhrefsSerpRow[]> {
  const d = await call<{ positions?: Array<{ position: number; url: string; title?: string; domain_rating?: number; traffic?: number }> }>(
    "serp-overview/serp-overview",
    {
      select: "position,url,title,domain_rating,traffic",
      country,
      keyword,
      date: new Date().toISOString().slice(0, 10),
    },
  );
  return (d?.positions ?? [])
    .slice(0, limit)
    .map((p) => ({
      position: p.position,
      url: p.url,
      title: p.title ?? "",
      dr: typeof p.domain_rating === "number" ? p.domain_rating : null,
      traffic: typeof p.traffic === "number" ? p.traffic : null,
    }));
}

/**
 * Related terms that carry real volume.
 *
 * Distinct from Serper's "related searches", which are Google's suggestions with no volume attached.
 * These are ranked by demand, so they are usable for choosing secondary keywords rather than only for
 * confirming that a phrase is a real query.
 */
export async function matchingTerms(keyword: string, country = "us", limit = 10): Promise<AhrefsKeyword[]> {
  const d = await call<{ keywords?: Array<{ keyword: string; volume_monthly?: number; difficulty?: number }> }>(
    "keywords-explorer/matching-terms",
    { select: "keyword,volume_monthly,difficulty", country, keywords: keyword, limit: String(limit) },
  );
  return (d?.keywords ?? []).map((k) => ({
    keyword: k.keyword,
    volume: k.volume_monthly ?? null,
    difficulty: k.difficulty ?? null,
  }));
}

export interface AhrefsBacklink {
  /** The page carrying the link. This is what gets fetched for a byline. */
  url_from: string;
  title: string;
  /** Domain Rating of the LINKING domain, which is what decides whether the link is worth chasing. */
  domain_rating_source: number | null;
  /** Estimated monthly organic traffic to the linking domain. */
  traffic_domain: number | null;
  anchor: string;
  /** ISO date the link was first seen. A 2019 link often means a writer who has since moved on. */
  first_seen: string | null;
  is_dofollow: boolean | null;
}

/**
 * Who links to a domain, one row per referring domain, strongest first.
 *
 * The single most expensive call in this file, and the only one where a careless parameter can cost
 * real money: `all-backlinks` is billed per row and a real domain has millions. Three guards, all
 * deliberate:
 *
 *   aggregation=1_per_domain  collapses a site's 50 links into 1. Also the right outreach unit, since
 *                             50 links from one publisher is one relationship.
 *   order_by DR desc          spends the budget on domains worth a link rather than the long tail.
 *   limit                     capped by the caller and never defaulted to "everything".
 *
 * `select` matters as much: unrequested columns are not billed, so this asks for exactly the seven
 * fields the author pipeline reads and nothing else.
 */
export async function allBacklinks(
  target: string,
  opts: { limit?: number; minDr?: number; maxDr?: number } = {},
): Promise<AhrefsBacklink[] | null> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
  const params: Record<string, string> = {
    target,
    // subdomains, so blog.competitor.com counts as the same target a human would mean.
    mode: "subdomains",
    select: "url_from,title,domain_rating_source,traffic_domain,anchor,first_seen,is_dofollow",
    order_by: "domain_rating_source:desc",
    aggregation: "1_per_domain",
    limit: String(limit),
  };
  // Filtering server-side keeps weak domains out of the ROW COUNT, so it saves units rather than
  // just tidying the result.
  //
  // The grammar is exact and fails closed: `is` takes a FLAT ["gte", n]. Nesting it as [["gte", n]]
  // returns HTTP 400 "invalid filter expression", which call() turns into null — so a wrong filter
  // here reads downstream as "Ahrefs is down", not as a bad query. Verified against the live API.
  const clauses: unknown[] = [];
  if (opts.minDr != null) clauses.push({ field: "domain_rating_source", is: ["gte", opts.minDr] });
  // A ceiling matters more than it sounds. Ordering by DR descending surfaces the mega-platforms
  // first, and measured against a real profile those are exactly the rows with nobody to pitch:
  // Telegram channels, an App Store listing, learn.microsoft.com, a Spotify creator page. Capping
  // DR spends the row budget on the band that actually answers email.
  if (opts.maxDr != null) clauses.push({ field: "domain_rating_source", is: ["lte", opts.maxDr] });
  if (clauses.length === 1) params.where = JSON.stringify(clauses[0]);
  else if (clauses.length > 1) params.where = JSON.stringify({ and: clauses });
  const d = await call<{ backlinks?: AhrefsBacklink[] }>("site-explorer/all-backlinks", params);
  if (!d) return null;
  return (d.backlinks ?? []).map((b) => ({
    url_from: b.url_from,
    title: b.title ?? "",
    domain_rating_source: typeof b.domain_rating_source === "number" ? b.domain_rating_source : null,
    traffic_domain: typeof b.traffic_domain === "number" ? b.traffic_domain : null,
    anchor: b.anchor ?? "",
    first_seen: b.first_seen ?? null,
    is_dofollow: typeof b.is_dofollow === "boolean" ? b.is_dofollow : null,
  }));
}

/** Remaining monthly units, so the UI can warn before a research run quietly degrades. */
export async function unitsRemaining(): Promise<{ used: number; limit: number; resets: string | null } | null> {
  const d = await call<{ limits_and_usage?: { units_limit_workspace?: number; units_usage_workspace?: number; usage_reset_date?: string } }>(
    "subscription-info/limits-and-usage", {},
  );
  const l = d?.limits_and_usage;
  if (!l) return null;
  return {
    used: l.units_usage_workspace ?? 0,
    limit: l.units_limit_workspace ?? 0,
    resets: l.usage_reset_date ?? null,
  };
}
