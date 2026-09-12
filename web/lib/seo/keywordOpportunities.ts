// Striking-distance keyword opportunities from Google Search Console.
//
// The keyword selection here is the part that has to be honest. It comes entirely from Search
// Console: queries where we ALREADY get impressions but rank badly. That is measured demand against
// measured weakness, which is a far better reason to write something than a third-party volume
// estimate or an intuition about what people search. There is no search-volume or keyword-difficulty
// source connected to this app, so none is used or reported.
//
// Extracted from the cluster planner when clusters were removed — this half was never about
// clusters, it is demand data, and Summer's keyword_data tool reads it.
import {
  searchAnalytics, daysAgo, isGscConfigured, gscProperty, type SearchAnalyticsRow,
} from "@/lib/indexing/gsc";


export interface KeywordOpportunity {
  keyword: string;
  impressions: number;
  clicks: number;
  position: number;
  /** impressions × how far we are from the top 3. Ranks "big demand, bad position" to the top. */
  opportunity: number;
}

/** Queries we already rank well for don't need a new article, so they are excluded from candidates. */
const ALREADY_WINNING_POSITION = 5;
const MIN_IMPRESSIONS = 50;
const MAX_POSITION = 30;

export function scoreOpportunity(r: SearchAnalyticsRow): number {
  return r.impressions * Math.max(0, r.position - 3);
}

/**
 * Striking-distance queries from Search Console, best opportunity first.
 *
 * `seed` narrows to a topic area (substring match) so a search can be scoped to something the team
 * actually wants to write about, rather than always returning the same site-wide top queries.
 */
export async function keywordOpportunities(
  seed?: string,
  limit = 60,
): Promise<{ opportunities: KeywordOpportunity[]; property: string | null; window: string; notes: string[] }> {
  const notes: string[] = [];
  if (!isGscConfigured()) {
    return { opportunities: [], property: null, window: "", notes: ["Search Console is not connected, so there is no demand data to work from."] };
  }
  const startDate = daysAgo(90);
  const endDate = daysAgo(1);
  const rows = await searchAnalytics({ startDate, endDate, dimensions: ["query"], rowLimit: 25000 });
  if (!rows.length) {
    return { opportunities: [], property: gscProperty(), window: `${startDate} to ${endDate}`, notes: ["Search Console returned no rows for this window."] };
  }

  const needle = seed?.trim().toLowerCase();
  const candidates = rows
    .filter((r) => r.impressions >= MIN_IMPRESSIONS)
    .filter((r) => r.position >= ALREADY_WINNING_POSITION && r.position <= MAX_POSITION)
    .filter((r) => (needle ? (r.keys[0] ?? "").toLowerCase().includes(needle) : true));

  if (needle && candidates.length === 0) {
    notes.push(`No striking-distance queries contain "${seed}". Either we have no measured demand there yet, or we already rank well for it.`);
  }

  const opportunities = candidates
    .map((r) => ({
      keyword: r.keys[0], impressions: r.impressions, clicks: r.clicks, position: r.position,
      opportunity: Math.round(scoreOpportunity(r)),
    }))
    .sort((a, b) => b.opportunity - a.opportunity)
    .slice(0, limit);

  return { opportunities, property: gscProperty(), window: `${startDate} to ${endDate}`, notes };
}
