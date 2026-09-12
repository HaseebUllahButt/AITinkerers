// Sitemap QA / pre-publish gate (PRD R2, "pre-publish gate" half). Turns a caller-supplied
// list of candidate URLs into per-URL gate verdicts — the SAME battery the live monitor runs
// in run.ts (fetch raw+rendered → on-page signals → render-mode diff → evaluateGate →
// classify + predict), but driven by an explicit URL list instead of a sitemap crawl. Use it
// to answer "is this page safe to publish / add to the sitemap?" before it ships.
//
// Kept separate from runIndexingReport (which also does template stratification, CWV, GSC and
// Slack) so a pre-publish check stays fast and side-effect-free. The gate itself (evaluateGate)
// is the shared source of truth, so a URL gets the identical verdict here and in the monitor.
import PQueue from "p-queue";

import { classifyChecks, predictCoverage, type CoveragePrediction, type Issue } from "./classify";
import { loadRobots, type RobotsMatcher } from "./discover";
import { fetchRawAndRendered, playwrightEnabled } from "./fetchRendered";
import { evaluateGate, type UrlChecks, type Verdict } from "./gate";
import { extractOnPage } from "./onpage";
import { classifyRenderMode, type RenderMode } from "./renderMode";
import { inferTemplate, isMoneyPage, toPath } from "./template";

export interface UrlGateResult {
  url: string;
  path: string;
  template: string;
  isMoney: boolean;
  httpStatus: number;
  verdict: Verdict;
  blockFailures: string[];
  flagFailures: string[];
  issues: Issue[];
  predicted: CoveragePrediction;
  renderMode: RenderMode;
  jsGated: boolean;
  contentWords: number;
  uniquenessRatio: number;
  canonical: string | null;
  error?: string;
}

export interface SitemapQaReport {
  total: number;
  counts: Record<Verdict, number>;
  playwrightEnabled: boolean;
  results: UrlGateResult[];
  notes: string[];
  startedAt: string;
  finishedAt: string;
}

export const SITEMAP_QA_MAX_URLS = 100;

// ── local uniqueness helpers (mirror run.ts; a pre-publish set compares to itself) ──
function shingles(text: string, k = 3, maxWords = 400): Set<string> {
  const w = text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, maxWords);
  const s = new Set<string>();
  for (let i = 0; i + k <= w.length; i += 1) s.add(w.slice(i, i + k).join(" "));
  return s;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}
function canonId(u: string): string | null {
  try {
    const x = new URL(u);
    const host = x.host.replace(/^www\./, "");
    let p = x.pathname;
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return `${host}${p}`.toLowerCase();
  } catch {
    return null;
  }
}
const SOFT_404_RE = /\b(404|not found|page (?:not|doesn'?t) exist|no longer (?:available|exists)|page (?:you|you're) looking for|couldn'?t find|does not exist)\b/i;

// Normalize + de-dupe input; keep only absolute http(s) URLs.
export function normalizeUrls(input: string[]): { urls: string[]; skipped: string[] } {
  const urls: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const t = (raw || "").trim();
    if (!t) continue;
    try {
      const u = new URL(t);
      if (u.protocol !== "http:" && u.protocol !== "https:") { skipped.push(t); continue; }
      const key = u.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(key);
    } catch {
      skipped.push(t);
    }
  }
  return { urls, skipped };
}

interface Fetched {
  url: string;
  path: string;
  template: string;
  isMoney: boolean;
  httpStatus: number;
  isRedirect: boolean;
  headerNoindex: boolean;
  rawSig: ReturnType<typeof extractOnPage> | null;
  renderedSig: ReturnType<typeof extractOnPage> | null;
  renderMode: ReturnType<typeof classifyRenderMode>;
  error?: string;
}

export async function checkUrls(
  input: string[],
  opts: { concurrency?: number; abortSignal?: AbortSignal } = {},
): Promise<SitemapQaReport> {
  const startedAt = new Date();
  const notes: string[] = [];
  const { urls: normalized, skipped } = normalizeUrls(input);
  if (skipped.length) notes.push(`${skipped.length} line${skipped.length === 1 ? "" : "s"} skipped — not a valid absolute URL.`);

  let urls = normalized;
  if (urls.length > SITEMAP_QA_MAX_URLS) {
    notes.push(`Only the first ${SITEMAP_QA_MAX_URLS} of ${urls.length} URLs were checked (cap per run).`);
    urls = urls.slice(0, SITEMAP_QA_MAX_URLS);
  }

  if (!playwrightEnabled()) {
    notes.push("PLAYWRIGHT_ENABLED is not 'true' — render-diff is off, so js-gated content can't be detected (verdicts use raw HTML only).");
  }

  if (urls.length === 0) {
    const finishedAt = new Date();
    return { total: 0, counts: { pass: 0, block: 0, flag: 0 }, playwrightEnabled: playwrightEnabled(), results: [], notes, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() };
  }

  // robots.txt per distinct host (a disallowed URL should never be published/sitemapped).
  const hosts = [...new Set(urls.map((u) => { try { return new URL(u).origin; } catch { return null; } }).filter((h): h is string => !!h))];
  const robotsByHost = new Map<string, RobotsMatcher>();
  await Promise.all(hosts.map(async (origin) => {
    robotsByHost.set(origin, await loadRobots(`${origin}/robots.txt`).catch(() => ({ disallowed: () => false, rules: [] as string[] })));
  }));

  // 1. fetch raw + rendered per URL
  const queue = new PQueue({ concurrency: opts.concurrency ?? 4 });
  const fetched: Fetched[] = [];
  await Promise.all(
    urls.map((url) =>
      queue.add(async () => {
        const path = toPath(url);
        const template = inferTemplate(url);
        const isMoney = isMoneyPage(path);
        try {
          const { raw, rendered } = await fetchRawAndRendered(url, opts.abortSignal);
          const rawSig = raw?.ok ? extractOnPage(raw.html, url) : null;
          const renderedSig = rendered?.ok ? extractOnPage(rendered.html, rendered.finalUrl) : null;
          const headerNoindex = /noindex/i.test(raw?.headers["x-robots-tag"] ?? "");
          fetched.push({
            url, path, template, isMoney,
            httpStatus: raw?.status ?? rendered?.status ?? 0,
            isRedirect: raw?.isRedirect ?? false,
            headerNoindex, rawSig, renderedSig,
            renderMode: classifyRenderMode(rawSig, renderedSig),
            error: !raw && !rendered ? "fetch failed" : undefined,
          });
        } catch (e: any) {
          fetched.push({
            url, path, template, isMoney, httpStatus: 0, isRedirect: false, headerNoindex: false,
            rawSig: null, renderedSig: null, renderMode: classifyRenderMode(null, null), error: e?.message ?? "error",
          });
        }
      }),
    ),
  );

  // 2. within-set uniqueness per template (are the candidates dupes of each other?)
  const byTemplate = new Map<string, Fetched[]>();
  for (const f of fetched) (byTemplate.get(f.template) ?? byTemplate.set(f.template, []).get(f.template)!).push(f);
  const uniqueness = new Map<string, number>();
  for (const [, group] of byTemplate) {
    const sigs = group.map((f) => shingles(f.renderedSig?.text ?? f.rawSig?.text ?? ""));
    group.forEach((f, i) => {
      let maxSim = 0;
      for (let j = 0; j < group.length; j += 1) { if (i === j) continue; maxSim = Math.max(maxSim, jaccard(sigs[i], sigs[j])); }
      uniqueness.set(f.url, group.length > 1 ? 1 - maxSim : 1);
    });
  }

  // 3. gate + classify + predict per URL
  const results: UrlGateResult[] = fetched.map((f) => {
    const sig = f.renderedSig ?? f.rawSig;
    const canonical = sig?.canonical ?? null;
    const isSelfCanonical = canonical ? canonId(canonical) === canonId(f.url) : false;
    const origin = (() => { try { return new URL(f.url).origin; } catch { return null; } })();
    const robots = origin ? robotsByHost.get(origin) : undefined;
    const checks: UrlChecks = {
      url: f.url,
      path: f.path,
      httpStatus: f.httpStatus,
      isRedirect: f.isRedirect,
      robotsDisallowed: robots?.disallowed(f.path) ?? false,
      hasNoindex: (sig?.metaNoindex ?? false) || f.headerNoindex,
      isSelfCanonical,
      canonical,
      hasTitle: sig?.hasTitle ?? false,
      hasMetaDescription: sig?.hasMetaDescription ?? false,
      h1Count: sig?.h1Count ?? 0,
      hasJsonLd: sig?.hasJsonLd ?? false,
      jsGated: f.renderMode.jsGated,
      contentWords: f.renderedSig?.wordCount ?? f.rawSig?.wordCount ?? 0,
      uniquenessRatio: uniqueness.get(f.url) ?? 1,
      looksSoft404: f.httpStatus === 200 && SOFT_404_RE.test(`${sig?.title ?? ""} ${(sig?.text ?? "").slice(0, 300)}`),
    };
    const gate = evaluateGate(checks);
    return {
      url: f.url, path: f.path, template: f.template, isMoney: f.isMoney, httpStatus: f.httpStatus,
      verdict: gate.verdict, blockFailures: gate.blockFailures, flagFailures: gate.flagFailures,
      issues: classifyChecks(gate, f.isMoney), predicted: predictCoverage(checks),
      renderMode: f.renderMode.mode, jsGated: f.renderMode.jsGated,
      contentWords: checks.contentWords, uniquenessRatio: checks.uniquenessRatio, canonical, error: f.error,
    };
  });

  // Block/flag first so the worst is at the top.
  const order: Record<Verdict, number> = { block: 0, flag: 1, pass: 2 };
  results.sort((a, b) => order[a.verdict] - order[b.verdict] || Number(b.isMoney) - Number(a.isMoney));

  const counts: Record<Verdict, number> = { pass: 0, block: 0, flag: 0 };
  for (const r of results) counts[r.verdict] += 1;

  const finishedAt = new Date();
  return {
    total: results.length, counts, playwrightEnabled: playwrightEnabled(), results, notes,
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
  };
}
