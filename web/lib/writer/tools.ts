// The writer agent's tools: research (web_search, fetch_page, keyword_data) and the phase-control
// tools live in control.ts.
//
// Two things this file exists to guarantee:
//
// 1. PROVENANCE. Every URL a research tool returns is recorded into the session's ledger
//    (research.sources / research.internal_links). The validator later checks every citation in
//    the finished article against that ledger — a URL that isn't there is a fabrication, not a
//    typo, and fails the piece outright rather than being "corrected". Recording happens HERE, at
//    the tool boundary, so the ledger reflects what the model was actually shown, not what it
//    later claims to have seen.
//
// 2. CACHE SAFETY. `WRITER_TOOLS` is a single frozen array, always identical regardless of which
//    providers are configured. Tools render at position 0 in the prompt, and any difference there
//    invalidates every cache tier (tools + system + messages) — so an env-dependent tool list would
//    silently fragment the cache per environment. An unconfigured provider fails INSIDE the tool
//    (a normal tool_result with is_error:true), never by omitting the tool from the array.
import type { Anthropic } from "@anthropic-ai/sdk";
import { webSearch, searchEnabled } from "@/lib/search/webSearch";
import { fetchRaw } from "@/lib/indexing/fetchRendered";
import { extractReadability } from "@/lib/extract/readability";
import {
  keywordData, serpAnalysis, competitorPage, serperEnabled,
  formatKeywordData, formatSerpAnalysis, formatCompetitorPage,
} from "./seoData";
import { voiceSitemap, type SitemapLink } from "./voice";
import type { WriterVoice } from "@/lib/db/queries";
import { internalLinkCandidates } from "@/lib/sitemap/store";

export interface ResearchSource {
  url: string;
  title: string;
  snippet: string;
  /** Present once fetch_page has actually read the page; distinguishes "seen in a search result"
   *  from "verified by reading it", which matters for the validator's stricter checks. */
  fetched?: boolean;
}

export interface ResearchLedger {
  /** Every external URL surfaced by a research tool this session, keyed by url. */
  sources: Record<string, ResearchSource>;
  /** MEASURED Search Console rows. The allowlist for any impression/position/click figure the
   *  article states — search volume and keyword difficulty are not available anywhere, so a stated
   *  volume is by definition invented. */
  keyword_rows: Array<{ keyword: string; impressions: number; clicks: number; position: number }>;
  /** Real People Also Ask questions Google returned. The allowlist for question-format H2s. */
  paa: string[];
  /** Real related searches. The allowlist for secondary keywords beyond GSC. */
  related: string[];
  /** Tool-call counter, reset per assistant turn, enforcing the cache-safety fan-out cap. */
  callsThisTurn: number;
  /**
   * How many times a fetch of each URL has FAILED, keyed by url.
   *
   * Exists so the outline gate can tell "has not tried" from "tried and it will never work". A page
   * that 403s a bot will 403 on every retry, and without this the gate cannot distinguish the two —
   * which is how one run spent 19 minutes and 54,540 output tokens failing to satisfy a requirement
   * it had no legal move against.
   */
  fetchFailures?: Record<string, number>;
}

export function newLedger(): ResearchLedger {
  return { sources: {}, keyword_rows: [], paa: [], related: [], callsThisTurn: 0, fetchFailures: {} };
}

/** Record a failed fetch so the outline gate can stop demanding the impossible. */
export function noteFetchFailure(ledger: ResearchLedger, url: string): void {
  ledger.fetchFailures ??= {};
  const k = url.trim().replace(/\/+$/, "").toLowerCase();
  ledger.fetchFailures[k] = (ledger.fetchFailures[k] ?? 0) + 1;
}

/** The internal-link database is the voice's, not the ledger's — a link is "available", not
 *  "seen", so validating against it doesn't require having called a tool. */
export function internalLinksFor(voice: WriterVoice): SitemapLink[] {
  return voiceSitemap(voice);
}

// ── Tool definitions ──────────────────────────────────────────────────────────
// `strict: true` where the schema is simple enough to fully constrain (see shared/tool-use-concepts
// guidance: additionalProperties:false + required). Kept loose (no strict) on web_search/fetch_page
// since their inputs are natural-language strings with no meaningful further constraint.

export const WRITER_TOOLS: Anthropic.Tool[] = [
  {
    name: "web_search",
    description:
      "Search the web for real, currently-indexed pages. Returns titles, URLs and snippets. " +
      "This is the ONLY way to obtain a URL you may cite — never write a URL from memory. " +
      "Use a tight, single-idea query, the way a person would search, not a paragraph of keywords.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A single, specific search query." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch_page",
    description:
      "Fetch and extract the readable text of a page you already have a URL for (from web_search). " +
      "Use this before citing a specific statistic or quote, or when a snippet is too thin to " +
      "represent the source honestly. Do not call this on a URL that did not come from web_search.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "A URL previously returned by web_search." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "keyword_data",
    description:
      "Our own Google Search Console data for a keyword: MEASURED impressions, clicks and average " +
      "position over the last 90 days, plus striking-distance variants. This is real first-party " +
      "demand, not a third-party estimate. For market-wide search volume and keyword difficulty, call " +
      "serp_analysis instead: it returns measured Ahrefs figures. Never state a volume from memory.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "The keyword or phrase to look up." },
      },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "serp_analysis",
    description:
      "Live Google results for a keyword: who actually ranks in the top 10, the real People Also Ask " +
      "questions, the real related searches, and whether an AI Overview is showing. " +
      "Call this for the primary keyword before writing the outline. The People Also Ask questions " +
      "are the ONLY legitimate source for your question-format H2 headings, and related searches are " +
      "the only legitimate source of secondary keywords beyond Search Console.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "The keyword to look up on live Google." },
      },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "competitor_page",
    description:
      "Fetch a page that currently ranks and report its real structure: title, word count, heading " +
      "outline, whether it has structured data. Use it on one or two top results to judge how much " +
      "depth the topic actually requires. Many large sites block automated fetches and will return " +
      "an error; treat that as unknown rather than as evidence.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "A URL from serp_analysis or web_search." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "internal_links",
    description:
      "Search OUR OWN site for real pages to link to. This is the internal-link database: the only " +
      "URLs on our domain you are allowed to link to are the ones this returns (plus any cluster " +
      "siblings you were given). Call it for the main topic and for each major subtopic before you " +
      "propose an outline — a page that exists and is not linked is a wasted link, and a path you " +
      "guessed is a 404 on a published page. There are around 1,500 real pages, so search rather " +
      "than assume.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Topic words, e.g. \"ai headshot generator\" or \"virtual try on\"." },
        section: {
          type: "string",
          description:
            "Optional. Restrict to one part of the site: \"blogs\" for articles, \"features\" for " +
            "feature pages, \"apps\" for tool pages, \"compare\" for comparisons.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

interface ToolContext {
  ledger: ResearchLedger;
  /** A hard cap independent of the model's own judgement — see the plan's cache-lookback finding:
   *  research emits tool_use/tool_result pairs in bulk, and more than ~4 calls in one turn risks
   *  pushing the next cache breakpoint past the 20-block lookback window. */
  maxCallsPerTurn?: number;
}

export interface ToolRunResult {
  content: string;
  is_error?: boolean;
}

/** Dispatch one tool_use block. Never throws — every failure mode becomes a tool_result the model
 *  can read and route around, per the repo's llmChat-style "degrade, don't throw" convention. */
export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolRunResult> {
  // 12, not 4. The model legitimately fans out several searches as PARALLEL tool_use blocks in a
  // single assistant message, and a cap of 4 rejected the 5th mid-batch — producing a confusing
  // error result for a reasonable action. The concern this cap exists for (keeping the next cache
  // breakpoint within the 20-block lookback window) is handled properly by the second breakpoint in
  // applyCacheBreakpoints; this is now just a runaway-loop backstop, bounded further by
  // MAX_INTERNAL_ROUNDS in agent.ts.
  const cap = ctx.maxCallsPerTurn ?? 12;
  if (ctx.ledger.callsThisTurn >= cap) {
    return {
      is_error: true,
      content: `Tool-call budget for this turn reached (${cap}). Use what you have gathered so ` +
        `far; if you genuinely need more research, say so in your next message rather than calling ` +
        `more tools right now.`,
    };
  }
  ctx.ledger.callsThisTurn++;

  try {
    if (name === "internal_links") {
      const query = String(input.query ?? "").trim();
      if (!query) return { is_error: true, content: "query is required" };
      const section = input.section ? String(input.section).trim() : undefined;
      const hits = await internalLinkCandidates(query, { section, limit: 15 });
      if (!hits.length) {
        return {
          content: `No pages on our site match "${query}"${section ? ` in /${section}` : ""}. Do not invent ` +
            `an internal path — either search a broader term or leave that link out.`,
        };
      }
      // Recorded in the ledger so the provenance gate recognises these as real, retrieved URLs
      // rather than fabrications, exactly like an external source.
      for (const h of hits) {
        ctx.ledger.sources[h.url] = {
          url: h.url,
          title: `Our page: ${h.path}`,
          snippet: `Internal ${h.section || "page"}${h.lastmod ? `, updated ${h.lastmod}` : ""}`,
          fetched: ctx.ledger.sources[h.url]?.fetched,
        };
      }
      return {
        content: [
          `${hits.length} of our own pages match "${query}"${section ? ` in /${section}` : ""}:`,
          ...hits.map((h) => `  ${h.path}${h.lastmod ? `   (updated ${h.lastmod})` : ""}`),
          "",
          "Use these paths verbatim in link_plan. Anything not listed here is not linkable.",
        ].join("\n"),
      };
    }

    if (name === "web_search") {
      const query = String(input.query ?? "").trim();
      if (!query) return { is_error: true, content: "query is required" };
      if (!searchEnabled()) {
        return { is_error: true, content: "No web search provider is configured. Proceed using keyword_data and any sources already in your research, and note in the outline that live web research was unavailable." };
      }
      const errors: string[] = [];
      const hits = await webSearch(query, 8, undefined, (m) => errors.push(m));
      if (hits.length === 0) {
        return { is_error: true, content: `No results${errors.length ? `: ${errors.join("; ")}` : " for that query."}` };
      }
      for (const h of hits) {
        ctx.ledger.sources[h.url] = { url: h.url, title: h.title, snippet: h.snippet, fetched: ctx.ledger.sources[h.url]?.fetched };
      }
      return {
        content: hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n\n"),
      };
    }

    if (name === "fetch_page") {
      const url = String(input.url ?? "").trim();
      if (!url) return { is_error: true, content: "url is required" };
      if (!(url in ctx.ledger.sources)) {
        // Counted as a failure too. This branch was half of a genuine deadlock: the outline gate
        // demanded a URL be fetched, and fetch_page refused it because it had never been a search
        // result. The model had no legal move, and nothing recorded that fact.
        noteFetchFailure(ctx.ledger, url);
        return {
          is_error: true,
          content: `That URL was not returned by web_search in this session, so it cannot be fetched ` +
            `or cited. Use competitor_page for an arbitrary URL, or search for it first.`,
        };
      }
      const raw = await fetchRaw(url);
      if (!raw?.ok || !raw.html) {
        noteFetchFailure(ctx.ledger, url);
        return { is_error: true, content: `Could not fetch that page (${raw ? `HTTP ${raw.status}` : "network error"}). Cite the search snippet instead, or drop the claim.` };
      }
      const article = await extractReadability(raw.html, url);
      if (!article?.textContent) {
        noteFetchFailure(ctx.ledger, url);
        return { is_error: true, content: "Fetched the page but could not extract readable text (likely a non-article page). Cite the search snippet instead." };
      }
      ctx.ledger.sources[url] = { ...ctx.ledger.sources[url], url, title: article.title || ctx.ledger.sources[url]?.title || "", snippet: ctx.ledger.sources[url]?.snippet ?? "", fetched: true };
      // Bounded: this is context the model reads once to extract a fact, not the article body.
      return { content: article.textContent.slice(0, 6000) };
    }

    if (name === "keyword_data") {
      const keyword = String(input.keyword ?? "").trim();
      if (!keyword) return { is_error: true, content: "keyword is required" };
      const d = await keywordData(keyword);
      // Record every measured fact so the validator can tell a cited number from an invented one.
      for (const m of [...d.matches, ...d.striking_distance]) {
        ctx.ledger.keyword_rows.push({
          keyword: m.keyword, impressions: m.impressions, clicks: m.clicks, position: m.position,
        });
      }
      return { content: formatKeywordData(d), is_error: !d.property };
    }

    if (name === "serp_analysis") {
      const keyword = String(input.keyword ?? "").trim();
      if (!keyword) return { is_error: true, content: "keyword is required" };
      if (!serperEnabled()) {
        return { is_error: true, content: "Live SERP data is unavailable (no SERPER_API_KEY). Draw FAQ headings from Search Console queries instead, and do not invent questions." };
      }
      const a = await serpAnalysis(keyword);
      if (!a) return { is_error: true, content: "The SERP lookup failed. Retry once, or proceed using Search Console data only." };

      // Competitor URLs become citable, and the real PAA/related queries become the allowlist the
      // validator checks FAQ headings and secondary keywords against.
      for (const o of a.organic) {
        ctx.ledger.sources[o.link] = {
          url: o.link, title: o.title, snippet: o.snippet,
          fetched: ctx.ledger.sources[o.link]?.fetched,
        };
      }
      ctx.ledger.paa.push(...a.people_also_ask);
      ctx.ledger.related.push(...a.related_searches);
      return { content: formatSerpAnalysis(a) };
    }

    if (name === "competitor_page") {
      const url = String(input.url ?? "").trim();
      if (!url) return { is_error: true, content: "url is required" };
      const p = await competitorPage(url);
      if (!p) return { is_error: true, content: "That does not look like a fetchable http(s) URL." };
      // A competitor page read this way is a real retrieved source, so it becomes citable.
      if (p.word_count > 0) {
        ctx.ledger.sources[p.url] = {
          url: p.url, title: p.title, snippet: (p.headings[0] ?? "").slice(0, 200), fetched: true,
        };
      }
      return { content: formatCompetitorPage(p), is_error: p.word_count === 0 };
    }

    return { is_error: true, content: `Unknown tool "${name}".` };
  } catch (e: any) {
    // Never let a tool crash the turn. A degraded result the model can read beats a 500.
    return { is_error: true, content: `Tool failed: ${e?.message ?? "unknown error"}` };
  }
}
