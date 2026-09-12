// Backlink Targeting Agent (#4). For a specific money page, finds articles that could link TO
// THAT page (not the homepage): derives the page's topic, runs buyer-intent link queries across
// the whole of Google's result page, dedupes to editorial candidates, and scores the best ones
// with the #5 Author/Publisher Scoring agent.
//
// Four things this reads that it used to miss, all of them answers to "why do I only get a
// handful of prospects":
//
//  1. THE AI ANSWERS. The engines that answer buyer questions cite their sources, and a cited page
//     has already been picked as the authority for the question — often while sitting nowhere in
//     the top ten, so no amount of organic searching finds it. ./aiCitations.ts asks Gemini's
//     Google-grounded search, Perplexity and ChatGPT, and each cited site is resolved to a real
//     article on it before it becomes a prospect.
//
//     Google's own AI Overview panel is NOT this path, and the difference is measured rather than
//     assumed: Serper's /search returns no `aiOverview` field on our key at all, and its People
//     Also Ask entries carry only the question text with no source link (verified live
//     2026-09-02). ./serpSurfaces.ts still reads both shapes on every call, so the day a provider
//     starts returning them they are used — but nothing here depends on that happening.
//
//  2. THE WHOLE SERP, not just the organic list. Every surface that names a source is mined: the
//     featured snippet, the question blocks, the AI Overview references when present. It costs no
//     extra credits — one Serper request already returns all of it, and the shared `webSearch`
//     layer was reading `d.organic` and dropping the rest on the floor.
//
//  3. EXTRA SEED KEYWORDS. The page title gave one topic and four queries, so a campaign's whole
//     prospect supply came from four searches. Callers can now pass `keywords` — the campaign's
//     own list, saved in the UI — and each one seeds the same query set. Google's related searches
//     then seed a second hop, filtered for topic drift with the writer's isOnTopic, so "the whole
//     web" means queries we did not think to write and not only ours.
//
//  4. WHAT WE ALREADY HAVE. `excludeDomains` is applied BEFORE the maxProspects slice. This is the
//     bug behind "Find more prospects finds nothing": the ranked list is stable, so the second
//     press re-scored the same top 15 domains, the caller skipped every one as already-saved, and
//     the run reported 0 new prospects with nothing wrong. Excluding first means each press
//     reaches further down a list that is now long enough to have a further-down.
//
// COST, stated because it is spent on a button press: each query is one Serper credit (one-time,
// non-renewing 2,500 pool) when Serper is configured, and free through Tavily/SearXNG/CSE/Brave
// otherwise. QUERY_CAP bounds a single run, and the report says how many ran and what was dropped.
import PQueue from "p-queue";

import { webSearch, searchEnabled, searchProvider } from "../search/webSearch";
import { fetchRendered, fetchRaw } from "@/lib/indexing/fetchRendered";
import { extractOnPage } from "../indexing/onpage";
import { toPath } from "../indexing/template";
import { seedTokens, isOnTopic } from "../writer/autocomplete";
// A leaf utility that turns a domain into a real article on it (one `site:` search). It lives under
// backlinks/ because that is where domain-sourced prospects were first a problem, but it depends on
// nothing but webSearch, so importing it here adds no cycle.
import { findArticleForDomain } from "../backlinks/findArticle";
import { scoreMany, type ProspectScore } from "./authorScoring";
import { aiAnswerCitations } from "./aiCitations";
import { serpSurfaces, serpSurfacesEnabled, SURFACE_LABEL, type Surface } from "./serpSurfaces";

/** How a candidate URL was found: which SERP surfaces named it, and off which queries. */
export interface Provenance {
  surfaces: Surface[];
  queries: string[];
  /** The Google question this page was cited as answering, when it came from a question block. */
  question?: string;
}

export interface BacklinkReport {
  target: string;
  targetPath: string;
  topicLabel: string;
  /** Topic + every extra keyword this run searched on. */
  seeds: string[];
  /** Every query actually run, including the related-search second hop. */
  queries: string[];
  candidatesFound: number;
  /** Candidate domains dropped because the caller already has them. */
  candidatesAlreadyKnown: number;
  /** Candidate domains per surface, counting each domain once for every surface that named it. */
  surfaceCounts: Partial<Record<Surface, number>>;
  /** How many queries Google answered with an AI Overview, out of how many could be checked. */
  aiOverview: { shown: number; checked: number };
  /** The AI-answer pass: which engines answered, which could not be asked, and what they cited. */
  aiAnswers: {
    enginesUsed: string[];
    unavailable: Array<{ engine: string; reason: string }>;
    citedDomains: number;
    resolvedToArticle: number;
    /** Cited sites filed at site level because no matching article was found on them yet. */
    siteLevel: number;
  };
  /** Per-URL provenance for the prospects below, so a caller can say WHERE each one came from. */
  provenance: Record<string, Provenance>;
  prospects: ProspectScore[];
  notes: string[];
  startedAt: string;
  finishedAt: string;
}

const STOP = new Set(["the", "and", "for", "with", "best", "free", "online", "top", "your", "northwind", "imagine", "art", "create", "make"]);
// Social / marketplace / video hosts are not editorial link targets — drop them.
const NON_EDITORIAL = /(^|\.)(youtube|twitter|x|facebook|instagram|pinterest|tiktok|linkedin|amazon|reddit|quora|google|apple|play\.google)\.com$/i;
/** Hard ceiling on queries per run, so a long keyword list cannot quietly spend the credit pool. */
const QUERY_CAP = 24;
/** How many of Google's related searches to follow as a second hop. */
const EXPAND_CAP = 6;
/** Results asked of each query. The organic providers cap out around 10-20; Serper returns 20. */
const PER_QUERY = 10;

/** How much a surface is worth as a link prospect, over and above appearing in several queries.
 *  An AI Overview citation is the strongest signal Google gives us that a page is the authority
 *  for a query; a plain organic listing is the baseline and gets nothing. */
const SURFACE_BONUS: Record<Surface, number> = {
  ai_overview: 3,
  ai_answer: 3,
  answer_box: 2,
  things_to_know: 1.5,
  people_also_ask: 1.5,
  organic: 0,
};
/** Prompts put to the AI answer engines per run, and cited domains resolved to a real article.
 *  Both are bounded because each prompt is a model call and each resolution is a `site:` search. */
const AI_PROMPT_CAP = 6;
const AI_DOMAIN_CAP = 10;

function topicFromTitle(title: string, path: string): string {
  const cleaned = title.split(/[|–—\-]/)[0].trim();
  if (cleaned && cleaned.length >= 3 && cleaned.length <= 60) return cleaned;
  const slug = path.split("/").filter(Boolean).pop() ?? "";
  return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function topicTerms(label: string): string[] {
  return [...new Set(label.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)))];
}
function domainOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, "").toLowerCase(); } catch { return url; }
}
/** Trim, drop blanks, dedupe case-insensitively, cap length — applied to caller-supplied keywords. */
export function normalizeKeywords(input: unknown, max = 12): string[] {
  const list = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\n,]/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const k = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!k || k.length > 80) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

/** The four buyer-intent shapes that surface roundups — the pages that can actually add a link. */
function queriesForSeed(seed: string, year: number): string[] {
  return [`best ${seed}`, `${seed} tools`, `top ${seed} ${year}`, `${seed} alternatives`];
}

export interface BacklinkOptions {
  target: string;
  domain?: string;
  maxProspects?: number;
  score?: boolean;
  /** Extra seed keywords alongside the page's own topic. Each seeds the full query set. */
  keywords?: string[];
  /** Domains the caller already holds. Excluded BEFORE the maxProspects slice — see the header. */
  excludeDomains?: string[];
  /** Follow Google's related searches for a second hop. Default true; needs Serper for the data. */
  expand?: boolean;
  /** Ask the AI answer engines who they cite for these keywords. Default true; needs one of
   *  GEMINI_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY. */
  aiAnswers?: boolean;
  /** Wall-clock for the SEARCH phase only, so scoring still fits inside the caller's function. */
  timeBudgetMs?: number;
}

interface Candidate {
  url: string;
  title: string;
  snippet: string;
  queries: Set<string>;
  surfaces: Set<Surface>;
  question?: string;
  /** An AI-cited SITE with no matching article found on it. Ranked without the AI bonus — see
   *  the scoring block for why that matters. */
  siteLevel?: boolean;
}

export async function runBacklinkTargets(opts: BacklinkOptions): Promise<BacklinkReport> {
  const startedAt = new Date();
  const domain = opts.domain ?? "northwind.example";
  const maxProspects = opts.maxProspects ?? 10;
  // The budget covers BOTH discovery phases and is split between them, so a slow SERP provider
  // cannot starve the AI-answer pass (the phase that finds the prospects nothing else finds) and a
  // hung answer engine cannot eat the caller's whole function. Whatever the search phase leaves
  // early rolls into the AI phase, since the AI deadline is absolute rather than a second timer.
  const budgetMs = opts.timeBudgetMs ?? 150_000;
  const searchDeadline = Date.now() + Math.round(budgetMs * 0.6);
  const aiDeadline = Date.now() + budgetMs;
  const notes: string[] = [];
  const targetPath = toPath(opts.target.startsWith("http") ? opts.target : `https://${domain}${opts.target}`);
  const targetUrl = `https://${domain}${targetPath}`;
  const ourDomain = domain.replace(/^www\./, "");
  const excluded = new Set((opts.excludeDomains ?? []).map((d) => d.replace(/^www\./, "").toLowerCase()));

  const empty = (topicLabel: string, seeds: string[], queries: string[]): BacklinkReport => ({
    target: targetUrl, targetPath, topicLabel, seeds, queries,
    candidatesFound: 0, candidatesAlreadyKnown: 0, surfaceCounts: {},
    aiOverview: { shown: 0, checked: 0 },
    aiAnswers: { enginesUsed: [], unavailable: [], citedDomains: 0, resolvedToArticle: 0, siteLevel: 0 },
    provenance: {}, prospects: [], notes,
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
  });

  const surfacesOn = serpSurfacesEnabled();
  if (!searchEnabled() && !surfacesOn) {
    notes.push("No web-search key configured (set TAVILY_API_KEY, or SERPER_API_KEY for the AI Overview surfaces). Can't find backlink prospects without one.");
    return empty("", [], []);
  }

  // Derive the target page's topic (our site is JS-gated → render, fall back to raw).
  const rendered = await fetchRendered(targetUrl);
  const html = rendered?.ok ? rendered.html : (await fetchRaw(targetUrl))?.html;
  const title = html ? extractOnPage(html, targetUrl).title : "";
  const topicLabel = topicFromTitle(title, targetPath);
  const keywords = normalizeKeywords(opts.keywords);
  const seeds = [topicLabel, ...keywords].filter(Boolean);
  const terms = [...new Set([...topicTerms(topicLabel), ...keywords.flatMap((k) => topicTerms(k))])];
  const year = new Date().getFullYear();

  // ── Round one: the seeds' own queries ─────────────────────────────────────────
  const planned = seeds.flatMap((s) => queriesForSeed(s, year));
  const queries = [...new Set(planned)].slice(0, QUERY_CAP);
  if (planned.length > queries.length) {
    notes.push(`${planned.length - queries.length} planned quer${planned.length - queries.length === 1 ? "y was" : "ies were"} dropped at this run's cap of ${QUERY_CAP} — press again or trim the keyword list to cover them.`);
  }
  if (!surfacesOn) {
    notes.push(
      `Searching organic results only (via ${searchProvider() ?? "the configured provider"}). ` +
      "Google's AI Overview, featured snippet and question blocks need SERPER_API_KEY — " +
      "unset, or withheld by free-only mode.",
    );
  }

  const candidates = new Map<string, Candidate>();
  const related = new Map<string, number>();
  // The questions Google itself asks around these keywords (People Also Ask / "Things to know").
  // Kept because they are the best prompts to put to the AI answer engines below: real user
  // phrasing, on this exact topic, chosen by Google rather than invented by us.
  const googleQuestions: string[] = [];
  let aioShown = 0, aioChecked = 0;
  let searchErrors = 0;

  const record = (
    url: string, title: string, snippet: string, surface: Surface, query: string,
    opts: { question?: string; siteLevel?: boolean } = {},
  ) => {
    const d = domainOf(url);
    if (!d || d === ourDomain || NON_EDITORIAL.test(d)) return;
    const existing = candidates.get(url);
    if (existing) {
      existing.queries.add(query);
      existing.surfaces.add(surface);
      if (!existing.title && title) existing.title = title;
      if (!existing.question && opts.question) existing.question = opts.question;
      // A URL that also turned up as a real search result is not site-level any more.
      if (existing.siteLevel && !opts.siteLevel) existing.siteLevel = false;
      return;
    }
    candidates.set(url, {
      url, title, snippet,
      queries: new Set([query]), surfaces: new Set([surface]),
      ...(opts.question ? { question: opts.question } : {}),
      ...(opts.siteLevel ? { siteLevel: true } : {}),
    });
  };

  /** One query, through the richest source available. Reports its own failure; never throws. */
  const runQuery = async (q: string): Promise<void> => {
    if (Date.now() > searchDeadline) return;
    if (surfacesOn) {
      const res = await serpSurfaces(q).catch(() => null);
      if (res) {
        aioChecked++;
        if (res.aiOverviewShown) aioShown++;
        for (const h of res.hits) record(h.url, h.title, h.snippet, h.surface, q, { question: h.question });
        for (const r of res.relatedQueries) related.set(r, (related.get(r) ?? 0) + 1);
        googleQuestions.push(...res.questions);
        for (const n of res.notes) notes.push(n);
        // Serper answered, but with nothing usable — fall through to the free providers rather
        // than let one dry SERP shrink the candidate pool.
        if (res.hits.length) return;
      } else {
        searchErrors++;
        notes.push(`"${q}": the Serper request failed, so this query's AI Overview and question blocks were not read.`);
      }
    }
    if (!searchEnabled()) return;
    const hits = await webSearch(q, PER_QUERY, undefined, (m) => { searchErrors++; notes.push(`search: ${m}`); });
    for (const h of hits) record(h.url, h.title, h.snippet, "organic", q);
  };

  // Concurrency 4: the old loop was sequential, which is why widening the query set at all needed
  // this — 24 queries at up to 20s each would not fit any serverless function.
  const queue = new PQueue({ concurrency: 4 });
  await Promise.all(queries.map((q) => queue.add(() => runQuery(q))));

  // ── Round two: Google's own related searches ──────────────────────────────────
  // Queries we did not think to write, ranked by how many of our seeds surfaced them, and filtered
  // for drift against the seed vocabulary (the same isOnTopic the writer uses on autocomplete).
  const expandedQueries: string[] = [];
  if ((opts.expand ?? true) && related.size && Date.now() < searchDeadline) {
    const tokens = seedTokens(seeds.join(" "));
    const already = new Set(queries.map((q) => q.toLowerCase()));
    const budget = Math.max(0, Math.min(EXPAND_CAP, QUERY_CAP - queries.length));
    const picked = [...related.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([q]) => q)
      .filter((q) => !already.has(q.toLowerCase()) && isOnTopic(q, tokens))
      .slice(0, budget);
    if (picked.length) {
      expandedQueries.push(...picked);
      await Promise.all(picked.map((q) => queue.add(() => runQuery(q))));
      notes.push(`Followed ${picked.length} of Google's related searches as a second hop: ${picked.join(", ")}.`);
    }
    const dropped = related.size - picked.length;
    if (budget === 0 && related.size) notes.push(`${related.size} related searches were not followed — this run had no query budget left.`);
    else if (dropped > 0) notes.push(`${dropped} other related search${dropped === 1 ? " was" : "es were"} not followed (off-topic, already run, or past the cap).`);
  }
  const queriesRun = [...queries, ...expandedQueries];

  if (Date.now() > searchDeadline) {
    notes.push("The search phase hit its time budget, so some queries did not run — press again to cover them.");
  }

  // ── AI answers: who do the answer engines cite for these keywords ─────────────
  //
  // The prospects worth the most and the hardest to find any other way. A page an AI answer cites
  // has already been picked as the authority for the question a buyer asked, and unlike a ranking
  // page it is often not in the top ten at all.
  //
  // Google's own AI Overview panel is attempted on every SERP call above and yields nothing with
  // our providers (./serpSurfaces.ts says why, at length). These engines do answer, so this is the
  // path that actually delivers AI-answer prospects today.
  //
  // Prompts: the questions GOOGLE asks around these keywords first, because they are real user
  // phrasing chosen by Google, then our own buyer-intent shapes to fill the budget.
  const aiSummary = { enginesUsed: [] as string[], unavailable: [] as Array<{ engine: string; reason: string }>, citedDomains: 0, resolvedToArticle: 0, siteLevel: 0 };
  if ((opts.aiAnswers ?? true) && Date.now() >= aiDeadline) {
    notes.push("The AI answer engines were not asked: the search phase used this run's whole time budget. Press again — the searches already done are cheap to repeat and the engines will get their turn.");
  } else if (opts.aiAnswers ?? true) {
    const prompts = [
      ...new Set([
        ...googleQuestions,
        ...seeds.flatMap((s) => [`What is the best ${s}?`, `Best free ${s} online`]),
      ]),
    ].slice(0, AI_PROMPT_CAP);
    const cited = await aiAnswerCitations(prompts, {
      brandAliases: [domain, ourDomain.replace(/\..*$/, "")],
      exclude: (d) => d === ourDomain || NON_EDITORIAL.test(d),
      // Leave room for the site→article lookups that follow, which are what make these prospects
      // pitchable rather than just present.
      deadline: aiDeadline - 20_000,
    });
    notes.push(...cited.notes);
    aiSummary.enginesUsed = cited.enginesUsed;
    aiSummary.unavailable = cited.unavailable;

    // One entry per cited DOMAIN — an engine citing the same site for three prompts is one
    // prospect, and the strongest prompt is the one worth keeping as the pitch hook.
    const byCitedDomain = new Map<string, { url: string; prompt: string; engines: Set<string> }>();
    for (const c of cited.citations) {
      const cur = byCitedDomain.get(c.domain);
      if (cur) { cur.engines.add(c.engine); continue; }
      byCitedDomain.set(c.domain, { url: c.url, prompt: c.prompt, engines: new Set([c.engine]) });
    }
    aiSummary.citedDomains = byCitedDomain.size;

    // Drop what we already have, then resolve each remaining site to a REAL article on it.
    //
    // This matters more here than anywhere else in discovery: Gemini's grounding returns the
    // source's DOMAIN (its uri is a Google redirect), and a prospect whose URL is a homepage is
    // exactly what the relevance gate refuses to pitch — the "43 of 46 prospects were homepages"
    // failure findArticleForDomain was written for. Resolving it now means these arrive pitchable
    // instead of arriving as work for a later button.
    const foundDomains = new Set([...candidates.keys()].map(domainOf));
    const toResolve = [...byCitedDomain.entries()]
      .filter(([d]) => !excluded.has(d) && !foundDomains.has(d))
      .slice(0, AI_DOMAIN_CAP);
    if (byCitedDomain.size > toResolve.length) {
      const dropped = byCitedDomain.size - toResolve.length;
      notes.push(`${dropped} AI-cited site${dropped === 1 ? " was" : "s were"} not looked up this run (already found by a search, already yours, or past the ${AI_DOMAIN_CAP}-site cap).`);
    }
    const resolveQueue = new PQueue({ concurrency: 3 });
    await Promise.all(toResolve.map(([d, info]) => resolveQueue.add(async () => {
      const found = await findArticleForDomain({ domain: d, topic: topicLabel }).catch(() => null);
      const engines = [...info.engines].join(" + ");
      if (found?.best?.url) {
        aiSummary.resolvedToArticle++;
        record(found.best.url, found.best.title || d, `Cited by ${engines} answering "${info.prompt}".`, "ai_answer", info.prompt, { question: info.prompt });
      } else {
        // Keep the site anyway — an AI-cited publisher is worth having even when we cannot find
        // the right piece on it yet — but say so, because it lands as a site-level prospect that
        // "Find article URLs" has to finish.
        aiSummary.siteLevel++;
        record(`https://${d}`, d, `Cited by ${engines} answering "${info.prompt}". No article found on the site for this topic yet.`, "ai_answer", info.prompt, { question: info.prompt, siteLevel: true });
      }
    })));
    if (aiSummary.citedDomains) {
      notes.push(
        `${cited.enginesUsed.join(", ") || "The answer engines"} cited ${aiSummary.citedDomains} linkable site${aiSummary.citedDomains === 1 ? "" : "s"} across ${prompts.length} prompt${prompts.length === 1 ? "" : "s"}; ` +
        `${toResolve.length} of them were looked up this run` +
        `${aiSummary.resolvedToArticle ? `, ${aiSummary.resolvedToArticle} of which resolved to a specific article` : ""}` +
        `${aiSummary.siteLevel ? `, ${aiSummary.siteLevel} with no matching article yet (filed at site level — "Find article URLs" finishes those)` : ""}.`,
      );
    }
  } else {
    notes.push("AI answer engines were not asked this run (turned off by the caller).");
  }

  // ── Rank: one URL per domain, best surface and most query hits win ────────────
  const byDomain = new Map<string, { url: string; title: string; hits: number; score: number; surfaces: Surface[]; queries: string[]; question?: string }>();
  const surfaceCounts: Partial<Record<Surface, number>> = {};
  let alreadyKnown = 0;
  for (const c of candidates.values()) {
    const d = domainOf(c.url);
    if (excluded.has(d)) { alreadyKnown++; continue; }
    // Strongest surface first, so every consumer can read [0] as "how this page was found" and a
    // provenance label reads in order of what actually matters.
    const surfaces = [...c.surfaces].sort((a, b) => SURFACE_BONUS[b] - SURFACE_BONUS[a]);
    for (const s of surfaces) surfaceCounts[s] = (surfaceCounts[s] ?? 0) + 1;
    const listicle = /(best|top|tools|vs|alternative|review|roundup|compare)/i.test(`${c.title} ${c.url}`);
    // An AI-cited SITE with no matching article gets no AI bonus. findArticleForDomain requires a
    // topic word in the article's TITLE, so a page that resolved is topically vetted — an
    // unresolved site is not, and the engines do cite tangential sources (an AI answer about video
    // pricing cited aap.org). Letting those inherit a +3 would push them past relevant roundups.
    const bonus = c.siteLevel ? 0.5 : Math.max(...surfaces.map((s) => SURFACE_BONUS[s]));
    const score = c.queries.size + bonus + (listicle ? 1.5 : 0);
    const cur = byDomain.get(d);
    if (!cur || score > cur.score) {
      byDomain.set(d, {
        url: c.url, title: c.title, hits: c.queries.size, score,
        surfaces, queries: [...c.queries], ...(c.question ? { question: c.question } : {}),
      });
    }
  }
  const ranked = [...byDomain.values()].sort((a, b) => b.score - a.score);
  const candidatesFound = ranked.length;

  if (alreadyKnown) {
    notes.push(`${alreadyKnown} candidate page${alreadyKnown === 1 ? "" : "s"} sat on a domain you already have, and were skipped before ranking rather than after — which is what lets a repeat run reach new sites.`);
  }
  if (candidatesFound === 0) {
    notes.push(
      searchErrors > 0
        ? "No editorial candidates found, and some searches failed this run — that is a search outage, not proof there are no prospects. Try again before changing the target."
        : `No editorial candidates found across ${queriesRun.length} quer${queriesRun.length === 1 ? "y" : "ies"} — add keywords with a wider audience, or try a different target page.`,
    );
    return {
      ...empty(topicLabel, seeds, queriesRun), candidatesAlreadyKnown: alreadyKnown,
      aiOverview: { shown: aioShown, checked: aioChecked }, aiAnswers: aiSummary,
    };
  }

  const chosen = ranked.slice(0, maxProspects);
  if (candidatesFound > chosen.length) {
    notes.push(`${candidatesFound - chosen.length} more candidate domain${candidatesFound - chosen.length === 1 ? "" : "s"} were found than this run scores (${maxProspects}) — press again to work down the list.`);
  }

  const provenance: Record<string, Provenance> = {};
  for (const r of chosen) {
    provenance[r.url] = { surfaces: r.surfaces, queries: r.queries, ...(r.question ? { question: r.question } : {}) };
  }

  // Score the chosen candidates (unless disabled).
  const prospects = opts.score === false
    ? chosen.map((r) => ({
        url: r.url, domain: domainOf(r.url), title: r.title, relevance: 0, freshnessYear: null,
        freshness: "unknown" as const, outboundQuality: 0, spamRisk: "medium" as const,
        domainAuthority: null, replyLikelihood: "medium" as const, isListicle: true, angle: "", composite: 0,
      }))
    : await scoreMany(chosen.map((r) => r.url), terms, topicLabel);

  if (aioChecked > 0) {
    notes.push(
      aioShown > 0
        ? `Google showed an AI Overview on ${aioShown} of ${aioChecked} queries; ${surfaceCounts.ai_overview ?? 0} candidate page${(surfaceCounts.ai_overview ?? 0) === 1 ? " was" : "s were"} cited in one.`
        : `Google showed no AI Overview on any of the ${aioChecked} queries checked this run. It is intermittent per query and phrasing, so this is a snapshot, not an absence.`,
    );
  }

  return {
    target: targetUrl, targetPath, topicLabel, seeds, queries: queriesRun,
    candidatesFound, candidatesAlreadyKnown: alreadyKnown, surfaceCounts,
    aiOverview: { shown: aioShown, checked: aioChecked }, aiAnswers: aiSummary,
    provenance, prospects, notes,
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
  };
}

/** "cited in Google's AI Overview; ranks organically" — how a prospect was found, in words. */
export function provenanceLabel(surfaces: Surface[] | undefined): string | null {
  if (!surfaces?.length) return null;
  // Every member of Surface must appear here: a surface missing from this list renders as an empty
  // label, which is how "cited by an AI answer engine" silently became a blank WHY THEM cell.
  const ordered = (["ai_overview", "ai_answer", "answer_box", "things_to_know", "people_also_ask", "organic"] as Surface[])
    .filter((s) => surfaces.includes(s));
  return ordered.map((s) => SURFACE_LABEL[s]).join("; ");
}
