// What a non-rendering crawler sees on one page, versus what a browser sees.
//
// Self-contained on purpose: it READS the existing indexing primitives (fetchRendered, onpage,
// renderMode, gsc) and modifies none of them, so the live indexing report and the link audit are
// untouched by anything here.
//
// ── Why this exists, and what the measurements actually said ────────────────────────────────────
//
// The brief was "Google flagged us for bot rendering issues as spam". Two candidate mechanisms, and
// they need completely different responses, so both are tested:
//
//   CLOAKING     — serving different content to a crawler than to a person. This is a spam policy
//                  violation. Tested by fetching the same URL as Googlebot, GPTBot, Chrome and curl
//                  and comparing.
//   JS-GATING    — content that only exists after client-side JavaScript. NOT a spam violation; it is
//                  an indexing failure. Google's first pass and every major AI crawler run no JS.
//
// Measured on live pages before this was written:
//
//   cloaking:  NONE. /features/nano-banana returns byte-identical HTML (1,531,378 bytes) to Googlebot,
//              GPTBot, Chrome and curl. Same for the blogs sampled. Whatever was flagged, it is not
//              user-agent-differential serving.
//   blogs:     server-rendered. /blogs/ai-dancing-prompts is 5,240 words raw → 5,260 rendered.
//   features:  materially JS-gated. /features/3d-figurines 1,359w → 1,979w (+620, 1.46x);
//              /features/nano-banana 1,465w → 2,101w (+636, 1.43x).
//   payload:   1.5 MB of HTML for ~1,450 words of content — about 1,000 bytes of markup per word.
//   GSC:       /features/nano-banana is "Crawled - currently not indexed" — the exact symptom the
//              render-mode module's own comment predicts for JS-gated content.
//
// ── Why this does not just call classifyRenderMode and stop ─────────────────────────────────────
//
// It does call it, and reports it, but it cannot be the verdict. That classifier needs the rendered
// text to be 2x the raw text before it calls a page js-gated. The features pages sit at 1.43-1.46x, so
// it labels them `ssr` — technically consistent with its own threshold, and wrong about the thing we
// were asked to find. 620 words that a non-rendering crawler cannot see is not "server-rendered".
//
// The thresholds below are set from those numbers: 1.20x with a 150-word floor separates the features
// pattern from the blogs' +20-word noise, with room either side. Raising the existing constant instead
// would change the live indexing report's verdicts, which is not ours to do here.
import * as cheerio from "cheerio";

import { fetchRendered, playwrightEnabled } from "@/lib/indexing/fetchRendered";
import { extractOnPage, type OnPageSignals } from "@/lib/indexing/onpage";
import { classifyRenderMode, type RenderMode } from "@/lib/indexing/renderMode";
import { inspectUrl, isGscConfigured, type GscInspection } from "@/lib/indexing/gsc";

/** Only these two sections. Anything else is out of scope by instruction. */
export const IN_SCOPE = ["/blogs/", "/features/"] as const;

export function inScope(path: string): boolean {
  return IN_SCOPE.some((p) => path.startsWith(p));
}

// ── The crawlers we impersonate ───────────────────────────────────────────────────────────────────
//
// `chrome` is the control — what a person gets. The other three are the populations that matter and
// none of them execute JavaScript: Google's first pass, OpenAI's crawler, and a bare client with no
// browser identity at all. `bare` is included because UA-sniffing middleware usually keys off a
// recognisable browser string, so a client with none is the cheapest way to catch it.
export const AGENTS = {
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  googlebot:
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/125.0.0.0 Safari/537.36",
  gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  bare: "curl/8.4.0",
} as const;

export type AgentName = keyof typeof AGENTS;

export interface AgentFetch {
  agent: AgentName;
  status: number;
  bytes: number;
  words: number;
  hasTitle: boolean;
  hasH1: boolean;
  hasCanonical: boolean;
  hasJsonLd: boolean;
  metaNoindex: boolean;
  xRobotsTag: string | null;
  internalLinks: number;
  error?: string;
}

export type Severity = "critical" | "warn" | "info";

export interface Issue {
  code: string;
  severity: Severity;
  detail: string;
}

export interface PageFinding {
  url: string;
  path: string;
  section: "blogs" | "features";
  checkedAt: string;

  httpStatus: number | null;
  /** Per-crawler fetch. `chrome` is the control; the rest are the no-JS populations. */
  agents: AgentFetch[];
  /** True when any no-JS crawler saw materially different content from Chrome. The spam signal. */
  cloaked: boolean;

  rawWords: number;
  rawBytes: number;
  renderedWords: number | null;
  renderedBytes: number | null;
  /** rendered / raw. Null when no rendered pass was possible. */
  wordRatio: number | null;
  wordDelta: number | null;
  /** The existing classifier's own verdict, reported alongside ours rather than instead of it. */
  existingMode: RenderMode;
  /** Bytes of markup per word of content. ~1,000 on these templates. */
  bytesPerWord: number | null;

  /** SEO-critical tags absent from raw HTML but present after JS. */
  jsGatedTags: string[];
  /** Internal links a non-rendering crawler cannot follow. */
  jsGatedLinks: number | null;

  gsc: GscInspection | null;
  impressions: number | null;
  clicks: number | null;
  position: number | null;

  issues: Issue[];
  /** Highest severity present, for sorting. */
  worst: Severity | null;
  /** Impressions-weighted rank: a broken page nobody sees is not the first thing to fix. */
  priority: number;
}

// ── Thresholds ────────────────────────────────────────────────────────────────────────────────────
//
// Every number here is set against the measurements in the module note. They are named so a future
// change is a decision rather than a tweak.

/** Rendered/raw ratio at which JS is adding a material amount of content. Blogs sit at ~1.004. */
const JS_RATIO = 1.2;
/** …and an absolute floor, so a 60-word page going to 80 is not a finding. */
const JS_DELTA_WORDS = 150;
/** Below this, the page has effectively no pre-JS content at all. From renderMode's own constant. */
const NO_CONTENT_WORDS = 120;
/** A page whose whole body arrives with JS. Independent of the ratio, which cannot express it. */
const SEVERE_RATIO = 2;
/** Payload a crawler has to download and parse. These templates ship 1.5 MB. */
const BLOATED_BYTES = 800_000;
/** Markup-to-content ratio. Measured ~1,000 bytes/word on features; 400 is already poor. */
const BLOATED_BYTES_PER_WORD = 400;
/** Content difference between a no-JS crawler and Chrome that counts as cloaking rather than noise. */
const CLOAK_WORD_TOLERANCE = 0.05;
/**
 * How much bigger a cross-agent word difference must be than the page's OWN run-to-run variance
 * before it is called cloaking.
 *
 * Measured: /features/25th-anniversary-video-maker was flagged because curl saw 1,579 words where
 * Chrome saw 1,492 — 6%, just over the tolerance. But the two responses were 1,497,433 and 1,498,812
 * bytes: 0.09% apart. A page serving genuinely different content to a crawler does not do it in 1.4 KB.
 * What actually varies is the page's own content between two fetches — a rotating testimonial or a
 * randomised section — and it varies whoever asks.
 *
 * So a suspected difference is checked against the page fetched twice under the SAME identity. Only a
 * cross-agent gap clearly larger than the page's self-variance is cloaking. Calling normal dynamic
 * content a spam violation would be the worst kind of finding this tool could produce: alarming,
 * confident, and wrong.
 */
const CLOAK_OVER_SELF_VARIANCE = 2;
/** Cloaking changes the payload. A word gap with near-identical bytes is variance, not serving. */
const CLOAK_MIN_BYTE_DRIFT = 0.01;

function countInternalLinks($: cheerio.CheerioAPI, host: string): number {
  let n = 0;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (href.startsWith("/") && !href.startsWith("//")) { n++; return; }
    try { if (new URL(href).host.replace(/^www\./, "") === host) n++; } catch { /* not a URL */ }
  });
  return n;
}

function signalsOf(html: string, url: string): { sig: OnPageSignals; links: number } {
  const sig = extractOnPage(html, url);
  let links = 0;
  try {
    const $ = cheerio.load(html);
    links = countInternalLinks($, new URL(url).host.replace(/^www\./, ""));
  } catch { /* leave at 0 */ }
  return { sig, links };
}

/** One plain HTTP GET under a named crawler identity. No JavaScript, which is the point. */
async function fetchAs(url: string, agent: AgentName): Promise<AgentFetch> {
  const base: AgentFetch = {
    agent, status: 0, bytes: 0, words: 0, hasTitle: false, hasH1: false,
    hasCanonical: false, hasJsonLd: false, metaNoindex: false, xRobotsTag: null, internalLinks: 0,
  };
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": AGENTS[agent], Accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const xRobots = res.headers.get("x-robots-tag");
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return { ...base, status: res.status, xRobotsTag: xRobots };
    }
    const html = await res.text();
    const { sig, links } = signalsOf(html, url);
    return {
      agent, status: res.status, bytes: html.length, words: sig.wordCount,
      hasTitle: sig.hasTitle, hasH1: sig.hasH1, hasCanonical: !!sig.canonical,
      hasJsonLd: sig.hasJsonLd, metaNoindex: sig.metaNoindex,
      xRobotsTag: xRobots, internalLinks: links,
    };
  } catch (e: unknown) {
    return { ...base, error: e instanceof Error ? e.message : "fetch failed" };
  }
}

export interface AnalyzeOptions {
  /** Skip the headless render. Set on any host without Chromium — see the note in analyzePage. */
  skipRender?: boolean;
  /** Skip the GSC URL-Inspection call. Quota is ~2,000/day, so a full sweep must bound it. */
  skipGsc?: boolean;
  /** Traffic for this URL, joined by the caller from one bulk Search Analytics query. */
  traffic?: { clicks: number; impressions: number; position: number } | null;
}

/**
 * Analyse one URL.
 *
 * Never throws: a page that cannot be fetched comes back as a finding with a `fetch_failed` issue, so
 * a sweep of 1,124 URLs is not ended by one bad host.
 *
 * ── On `skipRender` ─────────────────────────────────────────────────────────────────────────────
 *
 * The rendered pass needs Playwright and an installed Chromium, which this project has locally
 * (PLAYWRIGHT_ENABLED=true) and does not have on Vercel's serverless runtime. That is why the
 * render-diff half of this tool is driven by a script rather than by the route: rather than pretend,
 * a finding produced without a render says so — `renderedWords` is null and the issues list carries
 * `render_unavailable`. The cloaking, payload and raw-tag checks need no browser and run anywhere,
 * which matters because cloaking is the half that maps to an actual spam policy.
 */
export async function analyzePage(
  url: string,
  path: string,
  opts: AnalyzeOptions = {},
): Promise<PageFinding> {
  const section: "blogs" | "features" = path.startsWith("/features/") ? "features" : "blogs";
  const f: PageFinding = {
    url, path, section, checkedAt: new Date().toISOString(),
    httpStatus: null, agents: [], cloaked: false,
    rawWords: 0, rawBytes: 0, renderedWords: null, renderedBytes: null,
    wordRatio: null, wordDelta: null, existingMode: "unknown", bytesPerWord: null,
    jsGatedTags: [], jsGatedLinks: null,
    gsc: null, impressions: opts.traffic?.impressions ?? null,
    clicks: opts.traffic?.clicks ?? null, position: opts.traffic?.position ?? null,
    issues: [], worst: null, priority: 0,
  };

  // Every crawler identity, concurrently. Four cheap GETs beat one and an assumption.
  const names = Object.keys(AGENTS) as AgentName[];
  f.agents = await Promise.all(names.map((n) => fetchAs(url, n)));
  const chrome = f.agents.find((a) => a.agent === "chrome")!;
  const bots = f.agents.filter((a) => a.agent !== "chrome");
  f.httpStatus = chrome.status || null;
  f.rawWords = chrome.words;
  f.rawBytes = chrome.bytes;

  if (!chrome.status) {
    f.issues.push({ code: "fetch_failed", severity: "warn", detail: `The page could not be fetched${chrome.error ? `: ${chrome.error}` : "."}` });
    return finish(f);
  }
  if (chrome.status >= 300) {
    f.issues.push({
      code: "not_200", severity: "warn",
      detail: `In the sitemap but answers HTTP ${chrome.status}. A sitemap should only list URLs that return 200.`,
    });
    return finish(f);
  }

  // ── Cloaking ──────────────────────────────────────────────────────────────────────────────────
  for (const b of bots) {
    if (!b.status) continue;
    if (b.status !== chrome.status) {
      f.cloaked = true;
      f.issues.push({
        code: "cloaking_status", severity: "critical",
        detail: `Answers HTTP ${b.status} to ${b.agent} but ${chrome.status} to a browser. Serving crawlers a `
          + "different response from people is a spam policy violation, not an optimisation.",
      });
      continue;
    }
    const denom = Math.max(chrome.words, 1);
    const drift = Math.abs(b.words - chrome.words) / denom;
    const byteDrift = Math.abs(b.bytes - chrome.bytes) / Math.max(chrome.bytes, 1);
    if (drift > CLOAK_WORD_TOLERANCE) {
      if (byteDrift < CLOAK_MIN_BYTE_DRIFT) {
        f.issues.push({
          code: "content_varies_between_fetches", severity: "info",
          detail: `${b.agent} counted ${b.words} words against a browser's ${chrome.words} `
            + `(${Math.round(drift * 100)}% apart) but the two responses were only `
            + `${(byteDrift * 100).toFixed(2)}% different in size. Something on the page varies between `
            + "fetches — a rotating or randomised section — rather than varying by who is asking.",
        });
      } else {
        // The payload really does differ. Before calling it cloaking, measure what the page does when
        // the SAME identity asks twice: only a gap clearly wider than its own variance is serving.
        const again = await fetchAs(url, "chrome");
        const selfDrift = Math.abs(again.words - chrome.words) / denom;
        if (drift > Math.max(CLOAK_WORD_TOLERANCE, selfDrift * CLOAK_OVER_SELF_VARIANCE)) {
          // A difference only a bare client sees, with Google's and OpenAI's crawlers byte-identical to
          // a browser, is not a search-visibility risk — and it is the crawlers that matter here.
          const searchCrawler = b.agent === "googlebot" || b.agent === "gptbot";
          if (searchCrawler) f.cloaked = true;
          f.issues.push({
            code: searchCrawler ? "cloaking_content" : "ua_variance_bare_client",
            severity: searchCrawler ? "critical" : "info",
            detail: `${b.agent} sees ${b.words} words and ${b.bytes} bytes where a browser sees `
              + `${chrome.words} words and ${chrome.bytes} bytes (${Math.round(drift * 100)}% apart). `
              + `Fetching twice as a browser varied by only ${Math.round(selfDrift * 100)}%, so this is `
              + (searchCrawler
                  ? "user-agent-differential serving to a search crawler."
                  : "not the page's own variance — but Googlebot and GPTBot both match a browser, so it "
                    + "is a curiosity rather than a search-visibility problem."),
          });
        } else {
          f.issues.push({
            code: "content_varies_between_fetches", severity: "info",
            detail: `${b.agent} differed from a browser by ${Math.round(drift * 100)}%, but fetching `
              + `twice as a browser differed by ${Math.round(selfDrift * 100)}% on its own. The page `
              + "varies between fetches, not by who is asking.",
          });
        }
      }
    }
    if (b.metaNoindex && !chrome.metaNoindex) {
      f.cloaked = true;
      f.issues.push({
        code: "cloaking_noindex", severity: "critical",
        detail: `noindex is served to ${b.agent} but not to a browser.`,
      });
    }
  }

  // ── The rendered pass ─────────────────────────────────────────────────────────────────────────
  const canRender = !opts.skipRender && playwrightEnabled();
  if (!canRender) {
    f.issues.push({
      code: "render_unavailable", severity: "info",
      detail: "No headless browser on this host, so raw was not compared against rendered. The cloaking, "
        + "payload and tag checks above did run. Run the script locally for the render diff.",
    });
  } else {
    const rendered = await fetchRendered(url).catch(() => null);
    if (!rendered?.html) {
      f.issues.push({ code: "render_failed", severity: "info", detail: "The headless render returned nothing, so no diff was possible for this page." });
    } else {
      const { sig, links } = signalsOf(rendered.html, url);
      f.renderedWords = sig.wordCount;
      f.renderedBytes = rendered.html.length;
      f.wordDelta = sig.wordCount - chrome.words;
      f.wordRatio = chrome.words > 0 ? sig.wordCount / chrome.words : null;
      f.jsGatedLinks = Math.max(0, links - chrome.internalLinks);

      const rawSig = { ...extractOnPage("", url), wordCount: chrome.words, hasTitle: chrome.hasTitle, hasH1: chrome.hasH1, canonical: chrome.hasCanonical ? url : null, hasJsonLd: chrome.hasJsonLd };
      f.existingMode = classifyRenderMode(rawSig as OnPageSignals, sig).mode;

      if (!chrome.hasTitle && sig.hasTitle) f.jsGatedTags.push("title");
      if (!chrome.hasH1 && sig.hasH1) f.jsGatedTags.push("h1");
      if (!chrome.hasCanonical && sig.canonical) f.jsGatedTags.push("canonical");
      if (!chrome.hasJsonLd && sig.hasJsonLd) f.jsGatedTags.push("json-ld");

      if (f.jsGatedTags.length) {
        f.issues.push({
          code: "js_gated_tags", severity: "critical",
          detail: `${f.jsGatedTags.join(", ")} exist only after JavaScript. A non-rendering crawler sees the `
            + "page without them, which is the same as them not being there.",
        });
      }
      if (chrome.words < NO_CONTENT_WORDS && sig.wordCount >= NO_CONTENT_WORDS) {
        f.issues.push({
          code: "no_content_pre_js", severity: "critical",
          detail: `A crawler that runs no JavaScript sees ${chrome.words} words here; a browser sees `
            + `${sig.wordCount}. The page's content is entirely client-rendered.`,
        });
      } else if (f.wordRatio && f.wordRatio >= SEVERE_RATIO && (f.wordDelta ?? 0) >= JS_DELTA_WORDS) {
        f.issues.push({
          code: "js_gated_content", severity: "critical",
          detail: `${f.wordDelta} of ${sig.wordCount} words (${Math.round((f.wordRatio - 1) * 100)}% more than raw) `
            + "appear only after JavaScript.",
        });
      } else if (f.wordRatio && f.wordRatio >= JS_RATIO && (f.wordDelta ?? 0) >= JS_DELTA_WORDS) {
        f.issues.push({
          code: "js_gated_content", severity: "warn",
          detail: `${f.wordDelta} words (${Math.round((f.wordRatio - 1) * 100)}% more than raw) appear only after `
            + `JavaScript. Note the existing render classifier calls this "${f.existingMode}" — its threshold is `
            + "2x, and this page is below it while still hiding a section's worth of copy from a first-pass crawler.",
        });
      }
      if ((f.jsGatedLinks ?? 0) >= 10) {
        f.issues.push({
          code: "js_gated_links", severity: "warn",
          detail: `${f.jsGatedLinks} internal links appear only after JavaScript, so a non-rendering crawler `
            + "cannot follow them. Those are crawl paths to the pages they point at.",
        });
      }
    }
  }

  // ── Payload ───────────────────────────────────────────────────────────────────────────────────
  f.bytesPerWord = chrome.words > 0 ? Math.round(chrome.bytes / chrome.words) : null;
  if (chrome.bytes >= BLOATED_BYTES) {
    f.issues.push({
      code: "payload_bloat", severity: "warn",
      detail: `${(chrome.bytes / 1_048_576).toFixed(2)} MB of HTML for ${chrome.words} words`
        + `${f.bytesPerWord ? ` — about ${f.bytesPerWord} bytes of markup per word` : ""}. Every crawler pays `
        + "that download and parse cost on every visit, and rendering budget is finite.",
    });
  } else if (f.bytesPerWord && f.bytesPerWord >= BLOATED_BYTES_PER_WORD) {
    f.issues.push({
      code: "markup_ratio", severity: "info",
      detail: `${f.bytesPerWord} bytes of markup per word of content.`,
    });
  }

  // ── Tags a crawler needs and this page never has, in either pass ───────────────────────────────
  if (!chrome.hasJsonLd && !(f.renderedWords !== null && f.jsGatedTags.includes("json-ld"))) {
    f.issues.push({
      code: "no_structured_data", severity: "warn",
      detail: "No JSON-LD at all, before or after JavaScript. Article and FAQ markup is how this page "
        + "becomes eligible for the rich results and AI citations it is otherwise invisible to.",
    });
  }
  if (!chrome.hasTitle) f.issues.push({ code: "no_title_raw", severity: "critical", detail: "No <title> in the raw HTML." });
  if (!chrome.hasH1) f.issues.push({ code: "no_h1_raw", severity: "warn", detail: "No <h1> in the raw HTML." });
  if (!chrome.hasCanonical) f.issues.push({ code: "no_canonical_raw", severity: "warn", detail: "No canonical link in the raw HTML." });
  if (chrome.metaNoindex) f.issues.push({ code: "noindex", severity: "critical", detail: "This page is in the sitemap and tells crawlers not to index it." });
  if (chrome.xRobotsTag && /noindex/i.test(chrome.xRobotsTag)) {
    f.issues.push({ code: "noindex_header", severity: "critical", detail: `X-Robots-Tag: ${chrome.xRobotsTag}` });
  }

  // ── What Google actually did with it ──────────────────────────────────────────────────────────
  if (!opts.skipGsc && isGscConfigured()) {
    f.gsc = await inspectUrl(url).catch(() => null);
    const state = f.gsc?.coverageState ?? "";
    if (/not indexed/i.test(state)) {
      // The pairing is the finding. "Crawled - currently not indexed" has many causes; on a page we
      // have just measured as JS-gated, the cause is not a mystery.
      const gated = f.issues.some((i) => i.code === "js_gated_content" || i.code === "js_gated_tags" || i.code === "no_content_pre_js");
      f.issues.push({
        code: gated ? "not_indexed_and_js_gated" : "not_indexed",
        severity: gated ? "critical" : "warn",
        detail: gated
          ? `Google says "${state}" AND this page hides content behind JavaScript. Those two facts together `
            + "are the diagnosis, not a coincidence."
          : `Google says "${state}".`,
      });
    }
    if (f.gsc?.googleCanonical && f.gsc.userCanonical && f.gsc.googleCanonical !== f.gsc.userCanonical) {
      f.issues.push({
        code: "canonical_overridden", severity: "warn",
        detail: `We declare ${f.gsc.userCanonical} as canonical; Google chose ${f.gsc.googleCanonical}.`,
      });
    }
  }

  return finish(f);
}

const RANK: Record<Severity, number> = { critical: 3, warn: 2, info: 1 };

function finish(f: PageFinding): PageFinding {
  f.worst = f.issues.reduce<Severity | null>(
    (a, i) => (a === null || RANK[i.severity] > RANK[a] ? i.severity : a),
    null,
  );
  // Impressions-weighted, because a broken page nobody sees is not the first one to fix. log1p so a
  // page with 3.9M impressions does not bury every other finding, and +1 so a zero-impression page
  // with a critical issue still outranks a clean one.
  const weight = Math.log1p(f.impressions ?? 0) + 1;
  f.priority = Math.round((f.worst ? RANK[f.worst] : 0) * weight * 100) / 100;
  return f;
}
