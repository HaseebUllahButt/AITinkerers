// Link-intersect: domains that link to TWO OR MORE of our competitors but not to us. The classic
// backlink play this pipeline never had — a domain that has already linked to multiple direct
// competitors is a proven link-placer in exactly our niche, which beats any single-profile signal
// runBacklinkAuthors can produce. Set operations over cached fetches, so a full three-competitor
// intersect re-run costs zero units inside the cache TTL.
import { cachedAllBacklinks } from "./ahrefsCache";
import type { AhrefsBacklink } from "@/lib/writer/ahrefs";

export interface IntersectRow {
  domain: string;
  /** Which competitors this domain links to, sorted. */
  competitors: string[];
  competitor_count: number;
  /** The best (highest-DR) linking page among the competitors' rows — the page to harvest. */
  best: AhrefsBacklink;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

/** Pure set-ops core, exported so the selfcheck can pin it: ≥2 competitors, ours excluded,
 *  ranked by overlap count then DR. */
export function intersectReferringDomains(
  byCompetitor: Record<string, AhrefsBacklink[]>,
  excludeHosts: ReadonlySet<string>,
): IntersectRow[] {
  const map = new Map<string, { comps: Set<string>; best: AhrefsBacklink; bestDr: number }>();
  for (const [comp, rows] of Object.entries(byCompetitor)) {
    for (const b of rows) {
      const d = hostOf(b.url_from);
      if (!d || excludeHosts.has(d)) continue;
      const e = map.get(d) ?? { comps: new Set<string>(), best: b, bestDr: b.domain_rating_source ?? -1 };
      e.comps.add(comp);
      if ((b.domain_rating_source ?? -1) > e.bestDr) { e.best = b; e.bestDr = b.domain_rating_source ?? -1; }
      map.set(d, e);
    }
  }
  return [...map.entries()]
    .filter(([, e]) => e.comps.size >= 2)
    .map(([domain, e]) => ({ domain, competitors: [...e.comps].sort(), competitor_count: e.comps.size, best: e.best }))
    .sort((a, b) => b.competitor_count - a.competitor_count || (b.best.domain_rating_source ?? -1) - (a.best.domain_rating_source ?? -1));
}

export interface IntersectResult {
  rows: IntersectRow[];
  /** Units spent by THIS call, summed across the fetches that missed cache. */
  rows_billed: number;
  /** Targets answered from the cache (free). */
  cached_targets: string[];
  /** How many of our own referring domains the exclusion covered (0 = exclusion unavailable). */
  our_profile_sample: number;
  notes: string[];
}

/**
 * Fetch (through the cache) each competitor's referring domains plus a sample of our own, and
 * intersect. `null`-style failures come back as { error } naming the competitor that failed, so
 * the caller can report the real blocker instead of a generic shrug.
 */
export async function competitorLinkIntersect(
  competitorsInput: string[],
  opts: { minDr?: number; maxDr?: number; perCompetitorLimit?: number; ourLimit?: number } = {},
): Promise<IntersectResult | { error: string }> {
  const competitors = [...new Set(competitorsInput
    .map((c) => c.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase())
    .filter(Boolean))];
  if (competitors.length < 2 || competitors.length > 4) {
    return { error: "Give 2-4 competitor domains — the intersect needs at least two profiles to overlap." };
  }
  const minDr = opts.minDr ?? 30;
  const maxDr = opts.maxDr ?? 85;
  const perLimit = Math.min(Math.max(opts.perCompetitorLimit ?? 100, 10), 200);
  const ourLimit = Math.min(Math.max(opts.ourLimit ?? 500, 100), 500);

  const notes: string[] = [];
  const cachedTargets: string[] = [];
  let billed = 0;

  // Our own profile, for exclusion — a domain already linking to us is a different playbook
  // (nurture, not pitch). Best-effort: if this fetch fails, intersect anyway and say so.
  const ours = await cachedAllBacklinks("imagine.art", { limit: ourLimit, minDr: 0, maxDr: 100 });
  const excludeHosts = new Set<string>((ours?.rows ?? []).map((b) => hostOf(b.url_from)).filter(Boolean));
  if (ours) {
    billed += ours.rows_billed;
    if (ours.cached) cachedTargets.push("imagine.art");
  } else {
    notes.push("Could not fetch our own profile, so domains already linking to imagine.art are NOT excluded this run.");
  }

  const byCompetitor: Record<string, AhrefsBacklink[]> = {};
  for (const comp of competitors) {
    const r = await cachedAllBacklinks(comp, { limit: perLimit, minDr, maxDr });
    if (r === null) {
      return { error: `Ahrefs did not answer for ${comp} (budget, key or network). ${billed} row${billed === 1 ? "" : "s"} were billed before the failure; fetched profiles are cached and a retry will not re-bill them.` };
    }
    byCompetitor[comp] = r.rows;
    billed += r.rows_billed;
    if (r.cached) cachedTargets.push(comp);
  }

  return {
    rows: intersectReferringDomains(byCompetitor, excludeHosts),
    rows_billed: billed,
    cached_targets: cachedTargets,
    our_profile_sample: excludeHosts.size,
    notes,
  };
}
