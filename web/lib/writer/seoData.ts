// Real SEO data, from sources this app can actually reach at runtime.
//
// The rule this file exists to serve: every SEO fact the writer states must come from a tool call,
// never from the model's memory. Search volumes, keyword difficulty, "X% of marketers…" and
// "the average cost is Y" are exactly the claims an LLM will produce fluently and wrongly, and they
// are the ones a reader (or a competitor) is most likely to check.
//
// What is genuinely available here, and what is not:
//   ✅ Google Search Console  — our own impressions, clicks, position, CTR. First-party, exact.
//   ✅ Serper (live Google)   — who actually ranks, People Also Ask, related searches, AI Overview.
//   ✅ Our own page crawls    — real on-page structure of a competing page.
//   ✅ Ahrefs (paid, Advanced) — search volume, keyword difficulty, and per-result DR + organic
//                               traffic. See ./ahrefs.ts. This used to be unavailable and the writer
//                               was told never to state a volume; that rule is now scoped to
//                               "never state one Ahrefs did not return" rather than "never at all".
//
// Serper and Ahrefs are complementary, not alternatives. Ahrefs has no People Also Ask, and PAA is the
// only legitimate source of FAQ headings here (the validator flags invented questions against it).
// Serper has no volume or difficulty. Dropping either would lose real capability.
//
// GSC impressions remain the strongest demand signal for OUR site specifically: they are first-party
// and exact, where volume is a third-party estimate of the whole market.
//
// ⚠️ Ahrefs bills per ROW returned and the workspace runs close to its monthly cap. Every call in
// ./ahrefs.ts is capped and cached; raising a limit there is a cost decision, not a tuning knob.
import { searchAnalytics, daysAgo, isGscConfigured, gscProperty } from "@/lib/indexing/gsc";
import { fetchRaw } from "@/lib/indexing/fetchRendered";
import { extractOnPage } from "@/lib/indexing/onpage";
import { fetchDomainRating } from "@/lib/enrich/domainRating";
import { ahrefsEnabled, keywordOverview, matchingTerms } from "./ahrefs";
import { meteredProviderEnabled, meteredKey } from "@/lib/providers/policy";

export interface SerpResult {
  position: number;
  title: string;
  link: string;
  snippet: string;
  domain: string;
  /** Ahrefs Domain Rating for the result's domain. */
  dr?: number | null;
}

export interface SerpAnalysis {
  keyword: string;
  organic: SerpResult[];
  /** REAL questions Google shows for this query. The only legitimate source of FAQ headings. */
  people_also_ask: string[];
  /** REAL related queries. The only legitimate source of secondary keywords beyond GSC. */
  related_searches: string[];
  /** Whether Google currently shows an AI Overview. Intermittent per query, so treat as a snapshot. */
  has_ai_overview: boolean;
  ai_overview_snippet?: string;
  /** Position of the first result on one of our own domains, if we appear at all. */
  our_position: number | null;
  /** Our own Domain Rating, for comparison against the ranking set. */
  our_dr: number | null;
  /** Ahrefs demand data. Null when AHREFS_API_KEY is unset or the call failed/ran out of units —
   *  which must stay distinguishable from "volume is zero", because the writer is allowed to state a
   *  measured number and forbidden from inventing one. */
  volume: number | null;
  difficulty: number | null;
  /** Related terms WITH volume, unlike related_searches which are Google's unquantified suggestions. */
  related_with_volume: Array<{ keyword: string; volume: number | null; difficulty: number | null }>;
  notes: string[];
}

function hostOf(u: string): string {
  try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; }
}

export function serperEnabled(): boolean {
  return meteredProviderEnabled(!!process.env.SERPER_API_KEY);
}

/**
 * Live SERP for a keyword. This is the grounding source for "what does the reader actually get when
 * they search this", which is what search intent means concretely.
 */
export async function serpAnalysis(keyword: string, ourDomains: string[] = ["imagine.art"]): Promise<SerpAnalysis | null> {
  const key = meteredKey(process.env.SERPER_API_KEY);
  if (!key || !keyword.trim()) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      // 20, not 10: page-two results are where the beatable pages usually are, and the DR comparison
      // ("we outrank N of these") is only meaningful across a wide enough set to be worth acting on.
      body: JSON.stringify({ q: keyword, gl: "us", hl: "en", num: 20 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const d: any = await res.json();

    const ours = new Set(ourDomains.map((x) => x.replace(/^www\./, "").toLowerCase()));
    const organic: SerpResult[] = (Array.isArray(d.organic) ? d.organic : [])
      .filter((o: any) => o?.link)
      .map((o: any) => ({
        position: Number(o.position) || 0,
        title: String(o.title ?? ""),
        link: String(o.link),
        snippet: String(o.snippet ?? ""),
        domain: hostOf(o.link),
      }));

    // Domain Rating for the top results and for us, so the agent can tell "outranked by a stronger
    // site" from "outranked by a WEAKER site", which are completely different content problems. The
    // second case is the actionable one: if a DR 64 page beats us at DR 73, the gap is the content.
    // One request per domain against the free endpoint, so cap it and run them together.
    const topDomains = [...new Set(organic.slice(0, 6).map((o) => o.domain))].filter(Boolean);
    const drPairs = await Promise.all(
      [...topDomains, ...ourDomains].map(async (d) => [d, (await fetchDomainRating(d))?.dr ?? null] as const),
    );
    const drByDomain = new Map(drPairs);
    for (const o of organic) {
      const dr = drByDomain.get(o.domain);
      if (dr !== undefined) o.dr = dr;
    }
    const ourDr = ourDomains.map((d) => drByDomain.get(d)).find((v) => typeof v === "number") ?? null;

    const ourHit = organic.find((o) => ours.has(o.domain.toLowerCase()));

    // Serper exposes the AI Overview under a few shapes depending on the query; the GEO checker in
    // this repo already handles the same variance, so mirror its handling rather than assume one.
    const aio = d.aiOverview ?? null;
    const aioText: string | undefined =
      aio?.snippet ?? aio?.text ??
      (Array.isArray(aio?.textBlocks) ? aio.textBlocks.map((b: any) => b?.snippet ?? "").join(" ").trim() : undefined) ??
      d.answerBox?.snippet ?? d.answerBox?.answer;

    const notes: string[] = [];
    const paa: string[] = (Array.isArray(d.peopleAlsoAsk) ? d.peopleAlsoAsk : [])
      .map((q: any) => String(q?.question ?? "").trim()).filter(Boolean);
    let related: string[] = (Array.isArray(d.relatedSearches) ? d.relatedSearches : [])
      .map((r: any) => String(r?.query ?? "").trim()).filter(Boolean);

    // Serper's related-searches box is often absent, and its credits are one-time and non-renewing.
    // Google's own autocomplete answers the same question — what else are people typing around this
    // term — for free and without a quota. Used as a FALLBACK rather than a replacement: Serper
    // reports what Google actually showed on the SERP, which is the stronger claim when we have it.
    if (!related.length) {
      const { expandKeyword } = await import("./autocomplete");
      const expansion = await expandKeyword(keyword, { max: 12 });
      if (expansion.suggestions.length) {
        related = expansion.suggestions.map((s) => s.keyword);
        notes.push(
          "The related terms below come from Google autocomplete, not from a related-searches box: " +
          "they are queries Google offers real users, but they carry NO search volume. Do not state one.",
        );
      }
    }

    if (!paa.length) notes.push("Google showed no People Also Ask box for this query, so there are no real PAA questions to draw FAQ headings from. Use GSC queries instead.");
    if (!aioText) notes.push("No AI Overview is showing for this query right now. AI Overviews are intermittent per query, so this is a snapshot, not a verdict.");

    // The most useful thing DR tells us: which ranking pages we out-authorise and therefore ought to
    // be able to beat on content quality alone.
    const beatable = organic.filter((o) => typeof o.dr === "number" && ourDr !== null && o.dr! < ourDr);
    if (ourDr !== null && beatable.length) {
      notes.push(
        `We have a higher Domain Rating (${ourDr}) than ${beatable.length} of the pages currently ` +
        `ranking: ${beatable.map((b) => `${b.domain} (DR ${b.dr})`).join(", ")}. Those are ranking on ` +
        `content, not authority, so a better article is a realistic way past them.`,
      );
    }

    // Ahrefs enrichment. Two calls, both small and both cached, adding what Google's SERP cannot tell
    // us: how much demand the keyword actually carries, how hard it is, and which related terms have
    // volume behind them. Fired together because they are independent, and awaited with allSettled so
    // exhausted units or a rate limit degrades the answer instead of failing research outright.
    let volume: number | null = null;
    let difficulty: number | null = null;
    let relatedWithVolume: Array<{ keyword: string; volume: number | null; difficulty: number | null }> = [];
    if (ahrefsEnabled()) {
      const [ov, mt] = await Promise.allSettled([
        keywordOverview(keyword),
        matchingTerms(keyword, "us", 10),
      ]);
      if (ov.status === "fulfilled" && ov.value) {
        volume = ov.value.volume;
        difficulty = ov.value.difficulty;
      }
      if (mt.status === "fulfilled") relatedWithVolume = mt.value;
      if (volume === null) {
        notes.push(
          "Ahrefs returned no volume for this keyword. That means the lookup failed or the monthly " +
          "unit budget is exhausted, NOT that demand is zero. Do not state a search volume.",
        );
      }
    }

    return {
      keyword,
      organic,
      people_also_ask: paa,
      related_searches: related,
      has_ai_overview: !!aioText,
      ai_overview_snippet: aioText ? String(aioText).slice(0, 600) : undefined,
      our_position: ourHit?.position ?? null,
      our_dr: ourDr,
      volume,
      difficulty,
      related_with_volume: relatedWithVolume,
      notes,
    };
  } catch {
    return null;
  }
}

export interface KeywordFact {
  keyword: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
}

export interface KeywordData {
  property: string | null;
  /** Exact and containing matches from our own Search Console. */
  matches: KeywordFact[];
  /** Queries we get impressions for but rank poorly on — the real content gaps. */
  striking_distance: KeywordFact[];
  window: string;
  notes: string[];
}

/**
 * Our own Search Console data for a keyword and its variants.
 *
 * This is the honest replacement for third-party "search volume": impressions are how many times
 * WE were actually shown for the query, measured, not modelled. Position and CTR are likewise real.
 */
export async function keywordData(keyword: string): Promise<KeywordData> {
  const notes: string[] = [];
  if (!isGscConfigured()) {
    return { property: null, matches: [], striking_distance: [], window: "", notes: ["Search Console is not connected, so no first-party keyword data is available. Do not state search volumes from memory."] };
  }
  const startDate = daysAgo(90);
  const endDate = daysAgo(1);
  const rows = await searchAnalytics({ startDate, endDate, dimensions: ["query"], rowLimit: 25000 });
  if (!rows.length) {
    return { property: gscProperty(), matches: [], striking_distance: [], window: `${startDate} to ${endDate}`, notes: ["Search Console returned no rows for this window."] };
  }

  const needle = keyword.trim().toLowerCase();
  const toFact = (r: { keys: string[]; impressions: number; clicks: number; ctr: number; position: number }): KeywordFact => ({
    keyword: r.keys[0], impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position,
  });

  const matches = rows
    .filter((r) => (r.keys[0] ?? "").toLowerCase().includes(needle))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20)
    .map(toFact);

  const striking = rows
    .filter((r) => (r.keys[0] ?? "").toLowerCase().includes(needle))
    .filter((r) => r.impressions >= 50 && r.position >= 5 && r.position <= 30)
    .sort((a, b) => b.impressions * (b.position - 3) - a.impressions * (a.position - 3))
    .slice(0, 15)
    .map(toFact);

  if (!matches.length) {
    notes.push(`No Search Console data for anything containing "${keyword}" in the last 90 days. This is a topic we have no measured demand for yet, which is worth saying plainly rather than inventing a volume figure.`);
  }
  return { property: gscProperty(), matches, striking_distance: striking, window: `${startDate} to ${endDate}`, notes };
}

export interface CompetitorPage {
  url: string;
  status: number;
  title: string;
  meta_description: string;
  word_count: number;
  h1: string;
  headings: string[];
  has_json_ld: boolean;
  notes: string[];
}

/**
 * The real structure of a page that currently ranks. Used so an outline can be informed by what is
 * actually winning rather than by a guess about what "should" work.
 *
 * Deliberately returns STRUCTURE and headings, not the full body: the point is to see how a winning
 * page is organised and how long it is, not to give the model prose to paraphrase too closely.
 */
export async function competitorPage(url: string): Promise<CompetitorPage | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const raw = await fetchRaw(url);
  if (!raw) return null;
  if (!raw.ok || !raw.html) {
    return {
      url, status: raw.status, title: "", meta_description: "", word_count: 0, h1: "", headings: [],
      has_json_ld: false,
      notes: [`Could not read the page (HTTP ${raw.status}). Many sites block automated fetches; treat this as unknown rather than as evidence about the page.`],
    };
  }
  const signals = extractOnPage(raw.html, url);
  // Headings are the useful signal for outline shape, and extractOnPage does not expose them, so
  // pull them here with the same cheap regex approach the rest of the indexing code uses.
  const headings = [...raw.html.matchAll(/<h([23])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter((h) => h.length > 2 && h.length < 120)
    .slice(0, 25);

  return {
    url,
    status: raw.status,
    title: signals.title,
    meta_description: signals.hasMetaDescription ? "(present)" : "(missing)",
    word_count: signals.wordCount,
    h1: signals.hasH1 ? signals.title : "",
    headings,
    has_json_ld: signals.hasJsonLd,
    notes: [],
  };
}

/** Format a SERP analysis for a tool result: compact, and explicit about what each number IS. */
export function formatSerpAnalysis(a: SerpAnalysis): string {
  const out: string[] = [`Live Google results for "${a.keyword}" (US, English):`, ""];
  out.push("Who ranks right now (DR = Ahrefs Domain Rating, a 0-100 authority score):");
  // URL and snippet are rendered, not just domain + title.
  //
  // They used to be dropped here, and that single omission was the whole "the writer analyses the SERP
  // badly" problem. The ledger got the URLs, so provenance passed — but the MODEL only ever saw a list of
  // bare domains. It could not cite a ranking page (it had no address for it) and could not reason about
  // what any competitor actually covers (it had no text). Asking it to analyse search results while
  // withholding the results made guessing the only available move.
  for (const o of a.organic.slice(0, 20)) {
    out.push(`  ${o.position}. ${o.domain}${typeof o.dr === "number" ? ` (DR ${o.dr})` : ""} — ${o.title}`);
    out.push(`      ${o.link}`);
    if (o.snippet) out.push(`      ${o.snippet.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  out.push(
    "",
    "These URLs are retrieved sources: you may cite them, and you can read any of them in full with " +
    "the competitor_page tool. Read the top few before outlining rather than inferring their contents " +
    "from the title.",
  );
  if (a.our_position) out.push("", `We currently appear at position ${a.our_position}${a.our_dr !== null ? ` (our DR ${a.our_dr})` : ""}.`);
  else out.push("", `We do not appear in the top 10 for this query${a.our_dr !== null ? ` (our DR is ${a.our_dr})` : ""}.`);

  // Measured demand. Stated explicitly as MEASURED because the prompt otherwise forbids naming a
  // search volume at all — that rule existed only because nothing in this system could measure one,
  // and repeating it here while handing over a real figure would leave the model unsure which to obey.
  if (a.volume !== null || a.difficulty !== null) {
    const bits: string[] = [];
    if (a.volume !== null) bits.push(`${a.volume.toLocaleString()} searches/month (US)`);
    if (a.difficulty !== null) bits.push(`Keyword Difficulty ${a.difficulty}/100`);
    out.push("", `Ahrefs, MEASURED for "${a.keyword}": ${bits.join(", ")}.`);
    out.push(
      "This figure is measured, so you may state it. Any other volume or difficulty number is not " +
      "available to you and must not be stated.",
    );
  }
  if (a.related_with_volume.length) {
    out.push("", "Related terms with real demand behind them (Ahrefs, monthly volume):");
    for (const r of a.related_with_volume) {
      out.push(`  "${r.keyword}" — ${r.volume !== null ? `${r.volume.toLocaleString()}/mo` : "volume unknown"}${r.difficulty !== null ? `, KD ${r.difficulty}` : ""}`);
    }
    out.push("Prefer these over the plain related searches below when choosing secondary keywords: these are ranked by measured demand.");
  }

  if (a.people_also_ask.length) {
    out.push("", "People Also Ask (REAL questions Google shows for this query — use these verbatim or near-verbatim as your question-format H2s):");
    for (const q of a.people_also_ask) out.push(`  - ${q}`);
  }
  if (a.related_searches.length) {
    out.push("", "Related searches (REAL queries — use these as secondary keywords):");
    for (const r of a.related_searches) out.push(`  - ${r}`);
  }
  out.push("", a.has_ai_overview
    ? `An AI Overview IS showing for this query. Excerpt: ${a.ai_overview_snippet}`
    : "No AI Overview is showing for this query right now.");
  for (const n of a.notes) out.push("", `Note: ${n}`);
  return out.join("\n");
}

export function formatKeywordData(d: KeywordData): string {
  const out: string[] = [];
  if (d.property) out.push(`Our own Search Console data for ${d.property}, ${d.window}.`);
  out.push("These are MEASURED impressions and positions for our site, not third-party volume estimates.");
  out.push(
    "Search volume and keyword difficulty come from Ahrefs via serp_analysis, not from this tool. " +
    "State a volume ONLY if serp_analysis reported one; never estimate one yourself.",
  );
  if (d.matches.length) {
    out.push("", "Queries we already get impressions for:");
    for (const m of d.matches.slice(0, 12)) {
      out.push(`  "${m.keyword}" — ${m.impressions.toLocaleString()} impressions, ${m.clicks.toLocaleString()} clicks, avg position ${m.position.toFixed(1)}`);
    }
  }
  if (d.striking_distance.length) {
    out.push("", "Striking distance (real demand, weak position — the strongest angles to cover):");
    for (const m of d.striking_distance.slice(0, 10)) {
      out.push(`  "${m.keyword}" — ${m.impressions.toLocaleString()} impressions at position ${m.position.toFixed(1)}`);
    }
  }
  for (const n of d.notes) out.push("", `Note: ${n}`);
  return out.join("\n");
}

export function formatCompetitorPage(p: CompetitorPage): string {
  if (p.notes.length && !p.word_count) return `${p.url}\n${p.notes.join(" ")}`;
  const out = [
    `${p.url} (HTTP ${p.status})`,
    `Title: ${p.title}`,
    `Length: ${p.word_count} words. Meta description: ${p.meta_description}. Structured data: ${p.has_json_ld ? "yes" : "no"}.`,
  ];
  if (p.headings.length) {
    out.push("", "How this page is structured:");
    for (const h of p.headings) out.push(`  - ${h}`);
  }
  out.push("", "Use this to judge required depth and coverage. Do not reuse its phrasing or heading wording.");
  return out.join("\n");
}
