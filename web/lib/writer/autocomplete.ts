// Keyword expansion from Google's own autocomplete. Free, no key, no quota to run out of.
//
// This fills a specific hole. `keywordData()` (seoData.ts) is first-party GSC data, which is the
// honest source for demand but can only show terms we ALREADY appear for — it cannot discover a
// topic we have never ranked on. Discovery came from Serper's `relatedSearches` and Ahrefs'
// related-keywords, one non-renewing and one metered, so when both are dry the writer has no way
// to find new angles at all.
//
// Autocomplete is what Google actually offers real users mid-query, so it is demand signal rather
// than a model's guess — but it carries NO volume number, and none is invented here. Callers must
// present these as suggestions, not as quantified keywords. (Verified live 2026-08-26:
// suggestqueries.google.com answers unauthenticated and returns up to 15 suggestions per probe.)
import PQueue from "p-queue";

const ENDPOINT = "https://suggestqueries.google.com/complete/search";

/** One autocomplete probe. Returns [] on any failure — a dry probe is normal, not an error. */
export async function fetchSuggestions(
  query: string,
  opts: { hl?: string; gl?: string; signal?: AbortSignal } = {},
): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({ client: "chrome", hl: opts.hl ?? "en", gl: opts.gl ?? "us", q });
  try {
    const res = await fetch(`${ENDPOINT}?${params}`, {
      signal: opts.signal ?? AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    // Shape is [query, [suggestions], …]. Served as text/javascript on some edges, so parse the
    // body ourselves rather than trusting res.json().
    const parsed = JSON.parse(await res.text());
    const list = Array.isArray(parsed) && Array.isArray(parsed[1]) ? parsed[1] : [];
    return list.map((s: unknown) => String(s).trim().toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

// Probe shapes, chosen over the usual a-z "alphabet soup" (26 calls per seed) because these carry
// the intent we actually write for — comparisons, alternatives, how-tos — at half the request
// count. Kept small on purpose: this endpoint is a courtesy, not an API we are entitled to hammer.
const PREFIXES = ["how to", "what is", "why", "best"];
const SUFFIXES = ["free", "vs", "alternative", "for", "without", "online", "tool"];

export interface KeywordSuggestion {
  keyword: string;
  /** How many independent probes surfaced it. Higher = closer to the seed's core intent. */
  hits: number;
}

export interface ExpansionResult {
  seed: string;
  suggestions: KeywordSuggestion[];
  probes: number;
  notes: string[];
}

/** Tokens worth requiring a suggestion to share with the seed. Short stopwords are useless as a
 *  relevance test ("for", "to"), so they are dropped. Pure, for the selfcheck. */
export function seedTokens(seed: string): string[] {
  const STOP = new Set(["the", "a", "an", "for", "to", "of", "and", "or", "in", "on", "is", "how", "what", "why", "best", "vs"]);
  return seed.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));
}

/** Does a suggestion still belong to the seed's topic? Autocomplete drifts — probing
 *  "ai image generator vs" returns "ai photo generator or editor" — so anything sharing no
 *  meaningful token with the seed is dropped. Pure, for the selfcheck. */
export function isOnTopic(suggestion: string, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const s = suggestion.toLowerCase();
  return tokens.some((t) => s.includes(t));
}

/**
 * Expand one seed keyword into ranked suggestions.
 *
 * Every returned string is something Google offered a real user, deduped across probes and ranked
 * by how many probes produced it. No volumes, because we have none.
 */
export async function expandKeyword(
  seed: string,
  opts: { hl?: string; gl?: string; max?: number } = {},
): Promise<ExpansionResult> {
  const s = seed.trim();
  const notes: string[] = [];
  if (!s) return { seed: s, suggestions: [], probes: 0, notes: ["no seed keyword given"] };

  const queries = [s, ...PREFIXES.map((p) => `${p} ${s}`), ...SUFFIXES.map((x) => `${s} ${x}`)];
  const counts = new Map<string, number>();
  const queue = new PQueue({ concurrency: 3 });
  const results = await Promise.all(queries.map((q) => queue.add(() => fetchSuggestions(q, opts))));
  let answered = 0;
  for (const list of results) {
    if (!list || !list.length) continue;
    answered++;
    // Count each suggestion ONCE per probe, so a probe repeating itself cannot inflate a rank.
    for (const sug of new Set(list)) counts.set(sug, (counts.get(sug) ?? 0) + 1);
  }

  const tokens = seedTokens(s);
  const suggestions = [...counts.entries()]
    .filter(([k]) => k !== s.toLowerCase() && isOnTopic(k, tokens))
    .map(([keyword, hits]) => ({ keyword, hits }))
    .sort((a, b) => (b.hits - a.hits) || a.keyword.length - b.keyword.length)
    .slice(0, opts.max ?? 40);

  if (!answered) {
    notes.push("Google autocomplete did not answer any probe — this is a source outage, not an absence of demand.");
  } else if (answered < queries.length) {
    notes.push(`${answered} of ${queries.length} autocomplete probes answered.`);
  }
  if (suggestions.length) {
    notes.push("These are autocomplete suggestions: real queries Google offers users, but with NO search volume attached. Do not state volumes for them.");
  }
  return { seed: s, suggestions, probes: queries.length, notes };
}
