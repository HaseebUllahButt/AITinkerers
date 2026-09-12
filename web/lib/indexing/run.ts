// Indexing + CWV report orchestrator (PRD R1–R4, R7–R8). Report-only: crawls a bounded,
// template-stratified sample of the live site, diffs raw-vs-rendered per URL, runs the gate
// battery, classifies + routes issues, and pulls CWV field p75 + diagnosis per template — all
// assembled into a single in-memory IndexingReport. NO database writes, NO external dispatch.
import PQueue from "p-queue";

import { classifyChecks, predictCoverage } from "./classify";
import { analyzeCwv, type CwvResult, type Device } from "./cwv";
import { discover } from "./discover";
import { fetchRawAndRendered, playwrightEnabled } from "./fetchRendered";
import { inspectUrl, isGscConfigured } from "./gsc";
import { evaluateGate, type UrlChecks, type Verdict } from "./gate";
import { extractOnPage, type OnPageSignals } from "./onpage";
import { classifyRenderMode, type RenderMode } from "./renderMode";
import { buildCwvTickets, buildRoutingPreviews, type RoutableUrl } from "./routing";
import { composeSlackPreview } from "./slackPreview";
import { inferTemplate, isMoneyPage, toPath } from "./template";
import type { AnalyzedUrl, IndexingReport, TemplateSummary } from "./types";

export interface RunOptions {
  domain?: string;
  limit?: number;
  template?: string;
  moneyFirst?: boolean;
  device?: Device;
  /** Cap templates that get a (slow) PSI/CWV call. */
  cwvMaxTemplates?: number;
  /** Crawl concurrency (Playwright renders are heavy). */
  concurrency?: number;
  /** Max URLs to enrich with live GSC URL-Inspection (quota ~2,000/day). Default 200. */
  gscInspectLimit?: number;
  abortSignal?: AbortSignal;
}

// ── helpers ──────────────────────────────────────────────────────────────────
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

// Not-found wording in a 200 page's title/lead text → soft 404. Mirrors the Link Audit heuristic.
const SOFT_404_RE = /\b(404|not found|page (?:not|doesn'?t) exist|no longer (?:available|exists)|page (?:you|you're) looking for|couldn'?t find|does not exist)\b/i;

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

const DOMINANT = (modes: RenderMode[]): RenderMode => {
  const counts = new Map<RenderMode, number>();
  for (const m of modes) counts.set(m, (counts.get(m) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
};

interface Fetched {
  url: string;
  path: string;
  template: string;
  isMoney: boolean;
  httpStatus: number;
  isRedirect: boolean;
  headerNoindex: boolean;
  rawSig: OnPageSignals | null;
  renderedSig: OnPageSignals | null;
  renderMode: ReturnType<typeof classifyRenderMode>;
  error?: string;
}

export async function runIndexingReport(opts: RunOptions = {}): Promise<IndexingReport> {
  const startedAt = new Date();
  const domain = opts.domain ?? "northwind.example";
  const limit = Math.min(opts.limit ?? 20, 100);
  const device: Device = opts.device ?? "mobile";
  const concurrency = opts.concurrency ?? 4;
  const cwvMaxTemplates = opts.cwvMaxTemplates ?? 8;
  const notes: string[] = [];

  if (!playwrightEnabled()) {
    notes.push(
      "PLAYWRIGHT_ENABLED is not 'true' — render-diff is disabled, so render mode is 'unknown' and js-gated can't be detected. Set PLAYWRIGHT_ENABLED=true.",
    );
  }
  if (!process.env.GOOGLE_API_KEY && !process.env.PAGESPEED_API_KEY) {
    notes.push("No Google API key — Core Web Vitals will be empty. Add a free GOOGLE_API_KEY (Chrome UX Report + PageSpeed APIs). This is public field data — no Search Console ownership needed.");
  }

  // 1. discover ----------------------------------------------------------------
  const { urls, totalDiscovered, robots, notes: discoverNotes } = await discover({
    domain,
    limit,
    template: opts.template,
    moneyFirst: opts.moneyFirst,
  });
  notes.push(...discoverNotes);

  // 2. fetch raw + rendered per URL --------------------------------------------
  const queue = new PQueue({ concurrency });
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
            url,
            path,
            template,
            isMoney,
            httpStatus: raw?.status ?? rendered?.status ?? 0,
            isRedirect: raw?.isRedirect ?? false,
            headerNoindex,
            rawSig,
            renderedSig,
            renderMode: classifyRenderMode(rawSig, renderedSig),
            error: !raw && !rendered ? "fetch failed" : undefined,
          });
        } catch (e: any) {
          fetched.push({
            url,
            path,
            template,
            isMoney,
            httpStatus: 0,
            isRedirect: false,
            headerNoindex: false,
            rawSig: null,
            renderedSig: null,
            renderMode: classifyRenderMode(null, null),
            error: e?.message ?? "error",
          });
        }
      }),
    ),
  );

  // 3. thin/dup uniqueness within each template --------------------------------
  const byTemplate = new Map<string, Fetched[]>();
  for (const f of fetched) (byTemplate.get(f.template) ?? byTemplate.set(f.template, []).get(f.template)!).push(f);
  const uniqueness = new Map<string, number>();
  for (const [, group] of byTemplate) {
    const sigs = group.map((f) => shingles(f.renderedSig?.text ?? ""));
    group.forEach((f, i) => {
      let maxSim = 0;
      for (let j = 0; j < group.length; j += 1) {
        if (i === j) continue;
        maxSim = Math.max(maxSim, jaccard(sigs[i], sigs[j]));
      }
      uniqueness.set(f.url, group.length > 1 ? 1 - maxSim : 1);
    });
  }

  // 4. gate + classify + predict per URL ---------------------------------------
  const analyzed: AnalyzedUrl[] = fetched.map((f) => {
    const sig = f.renderedSig ?? f.rawSig;
    const canonical = sig?.canonical ?? null;
    const isSelfCanonical = canonical ? canonId(canonical) === canonId(f.url) : false;
    const checks: UrlChecks = {
      url: f.url,
      path: f.path,
      httpStatus: f.httpStatus,
      isRedirect: f.isRedirect,
      robotsDisallowed: robots.disallowed(f.path),
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
      url: f.url,
      path: f.path,
      template: f.template,
      isMoney: f.isMoney,
      httpStatus: f.httpStatus,
      isRedirect: f.isRedirect,
      renderMode: f.renderMode.mode,
      jsGated: f.renderMode.jsGated,
      rawWords: f.renderMode.rawWords,
      renderedWords: f.renderMode.renderedWords,
      uniquenessRatio: checks.uniquenessRatio,
      canonical,
      gate,
      issues: classifyChecks(gate, f.isMoney),
      predicted: predictCoverage(checks),
      renderReasons: f.renderMode.reasons,
      error: f.error,
    };
  });

  // 4b. optional live GSC enrichment (R3) — attach the REAL coverage state when a service
  // account is configured. Quota-aware: bounded + low concurrency. No-op without creds.
  const gscConfigured = isGscConfigured();
  if (gscConfigured) {
    // GSC URL-Inspection quota is ~2,000/day; enrich up to 200 URLs/run (money pages first,
    // since analyzed is already money-first-ordered) so a normal scan gets real coverage on
    // everything, not just the first 40.
    const gscCap = opts.gscInspectLimit ?? 200;
    const gscQueue = new PQueue({ concurrency: 3 });
    await Promise.all(
      analyzed.slice(0, gscCap).map((a) =>
        gscQueue.add(async () => {
          const insp = await inspectUrl(a.url);
          if (insp) a.gsc = { coverageState: insp.coverageState, verdict: insp.verdict, lastCrawlTime: insp.lastCrawlTime };
        }),
      ),
    );
  } else {
    notes.push("Live Google Search Console data is off — add a service account (GSC_PROPERTY + GSC_SA_JSON) to compare predictions against real Google coverage.");
  }

  // 5. template summaries ------------------------------------------------------
  const templates: TemplateSummary[] = [];
  const analyzedByTemplate = new Map<string, AnalyzedUrl[]>();
  for (const a of analyzed)
    (analyzedByTemplate.get(a.template) ?? analyzedByTemplate.set(a.template, []).get(a.template)!).push(a);
  for (const [template, group] of analyzedByTemplate) {
    const verdicts: Record<Verdict, number> = { pass: 0, block: 0, flag: 0 };
    for (const a of group) verdicts[a.gate.verdict] += 1;
    templates.push({
      template,
      urlCount: group.length,
      renderMode: DOMINANT(group.map((a) => a.renderMode)),
      jsGatedCount: group.filter((a) => a.jsGated).length,
      moneyPage: group.some((a) => a.isMoney),
      sampleUrl: group[0].url,
      verdicts,
    });
  }
  // Money-page + most-broken templates first.
  templates.sort(
    (a, b) => Number(b.moneyPage) - Number(a.moneyPage) || b.verdicts.block - a.verdicts.block,
  );

  // 6. CWV per template (field p75 + R8 diagnosis), bounded ---------------------
  const cwvTargets = templates.slice(0, cwvMaxTemplates);
  if (templates.length > cwvMaxTemplates)
    notes.push(`CWV limited to the top ${cwvMaxTemplates} of ${templates.length} templates (PSI is slow).`);
  const cwvQueue = new PQueue({ concurrency: 2 });
  const cwv: CwvResult[] = [];
  await Promise.all(
    cwvTargets.map((t) =>
      cwvQueue.add(async () => {
        const result = await analyzeCwv(t.template, t.sampleUrl, device);
        t.cwv = result;
        cwv.push(result);
      }),
    ),
  );

  // 7. routing previews + slack preview ----------------------------------------
  const routable: RoutableUrl[] = analyzed
    .filter((a) => a.issues.length > 0)
    .map((a) => ({ url: a.url, path: a.path, template: a.template, isMoney: a.isMoney, issues: a.issues }));
  // Indexability issues + CWV-failure tickets (R9) share one routing list, priority-sorted.
  const isMoneyByTemplate: Record<string, boolean> = {};
  for (const t of templates) isMoneyByTemplate[t.template] = t.moneyPage;
  const routing = [
    ...buildRoutingPreviews(routable),
    ...buildCwvTickets(cwv, isMoneyByTemplate),
  ].sort((a, b) => ({ p0: 0, p1: 1, p2: 2 }[a.priority] - { p0: 0, p1: 1, p2: 2 }[b.priority]));

  // Pages the crawler couldn't fetch (timeout / bot-block) are surfaced as a note, not routed.
  const unreachable = analyzed.filter((a) => a.gate.failures.includes("unreachable")).length;
  if (unreachable > 0) {
    notes.push(`${unreachable} page${unreachable === 1 ? "" : "s"} couldn't be fetched (timeout or bot protection) — shown as "unreachable", not routed as a fix.`);
  }

  const finishedAt = new Date();
  const verdictCounts: Record<Verdict, number> = { pass: 0, block: 0, flag: 0 };
  for (const a of analyzed) verdictCounts[a.gate.verdict] += 1;

  const report: IndexingReport = {
    target: domain,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    playwrightEnabled: playwrightEnabled(),
    pagespeedKey: !!(process.env.GOOGLE_API_KEY || process.env.PAGESPEED_API_KEY),
    gscConfigured,
    limit,
    discovered: totalDiscovered,
    analyzed: analyzed.length,
    counts: {
      verdicts: verdictCounts,
      jsGated: analyzed.filter((a) => a.jsGated).length,
      templates: templates.length,
      issues: analyzed.reduce((s, a) => s + a.issues.length, 0),
      p0: analyzed.reduce((s, a) => s + a.issues.filter((i) => i.priority === "p0").length, 0),
    },
    templates,
    urls: analyzed,
    cwv,
    routing,
    slackPreview: "",
    notes,
  };
  report.slackPreview = composeSlackPreview(report);
  return report;
}
