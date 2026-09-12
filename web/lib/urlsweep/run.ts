// The retired-URL sweep. Crawl every page on the site and report every place we still reference a
// URL we have retired — the full list at once, so it can be cleaned up in one pass instead of one
// broken link at a time.
//
// ── Why this is not the broken-link audit ───────────────────────────────────────────────────────
//
// The audit already crawls the sitemap and reads every anchor on every page, so the expensive half
// of this is built. But it only stores links that are DEAD, and a retired URL is almost never dead:
// /dashboard/ 308s to /dashboard, trust.northwind.example answers 200. All four of the URLs this was
// asked about are classified "ok" and discarded, and links that ARE in the sitemap are skipped
// before they are even looked at. No run of that audit could ever have answered this.
//
// ── Why it is much faster ───────────────────────────────────────────────────────────────────────
//
// The audit is slow because it fetches every outbound link to decide whether it is alive —
// thousands of third-party round trips. This checks nothing. It reads each page once and matches
// strings, so pages can be fetched CONCURRENTLY rather than one at a time. Minutes, not hours.
//
// ── Two passes, kept apart ──────────────────────────────────────────────────────────────────────
//
// Pass 1 reads real anchors, which gives anchor text and a DOM zone — a footer hit is one template
// edit, not N page edits, and that distinction is most of the value.
// Pass 2 greps the raw HTML, because a CTA whose navigation lives in a click handler or a
// serialised router payload has no <a href> to find. Its hits are stored as kind='raw' and never
// merged into the anchor counts: they need a different fix and they carry real false-positive risk.
import PQueue from "p-queue";

import { supabaseAdmin } from "@/lib/db/supabase";
import { redis } from "@/lib/redis";
import { qstashPublish, isServerless } from "@/lib/qstash";
import {
  fetchSitemapUrls,
  extractLinks,
  describeOccurrences,
  fetchRaw,
} from "@/lib/linkaudit/run";
import { DEFAULT_PATTERNS, matchUrl, rawHits, type SweepPattern } from "./patterns";

const CHUNK_BUDGET_MS = isServerless() ? 210_000 : Infinity;
const PAGE_CONCURRENCY = 10;
/** Pages per checkpoint. Small enough that a killed invocation loses little, large enough that the
 *  Redis write is not the bottleneck. */
const BATCH = 25;

const STATE_KEY = "urlsweep:state";
const STOP_KEY = "urlsweep:stop";

export interface SweepState {
  runId: string;
  patterns: SweepPattern[];
  pages: string[];
  index: number;
  linksSeen: number;
  matches: number;
  log: string[];
  startedAt: number;
  updatedAt: number;
}

const MAX_LOG_LINES = 120;
function pushLog(s: SweepState, line: string) {
  s.log ??= [];
  s.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (s.log.length > MAX_LOG_LINES) s.log.splice(0, s.log.length - MAX_LOG_LINES);
}

// ── State ───────────────────────────────────────────────────────────────────────────────────────

export async function getSweepState(): Promise<SweepState | null> {
  const r = redis();
  if (!r) return null;
  const raw = await r.get<unknown>(STATE_KEY).catch(() => null);
  if (!raw) return null;
  return typeof raw === "string" ? (JSON.parse(raw) as SweepState) : (raw as SweepState);
}
async function saveState(s: SweepState): Promise<void> {
  const r = redis();
  if (!r) return;
  s.updatedAt = Date.now();
  await r.set(STATE_KEY, JSON.stringify(s), { ex: 60 * 60 * 12 }).catch(() => {});
}
async function clearState(): Promise<void> {
  const r = redis();
  if (r) await r.del(STATE_KEY).catch(() => {});
}
export async function requestSweepStop(): Promise<void> {
  const r = redis();
  if (r) await r.set(STOP_KEY, "1", { ex: 3600 }).catch(() => {});
}
async function isStopRequested(): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  return !!(await r.get(STOP_KEY).catch(() => null));
}
async function clearStop(): Promise<void> {
  const r = redis();
  if (r) await r.del(STOP_KEY).catch(() => {});
}

// ── One page ────────────────────────────────────────────────────────────────────────────────────

interface FindingRow {
  run_id: string;
  page_url: string;
  link_url: string;
  link_host: string | null;
  matched: string;
  kind: "anchor" | "raw";
  anchor_text: string | null;
  zone: string | null;
  heading: string | null;
  occurrences: unknown;
  hits: number;
  context: string | null;
}

/** Read one page and return every retired-URL reference on it. Never throws — a page that will not
 *  load is a logged miss, not a failed sweep. */
export async function sweepPage(
  runId: string,
  pageUrl: string,
  patterns: SweepPattern[],
): Promise<{ rows: FindingRow[]; linksSeen: number; ok: boolean; note?: string }> {
  const res = await fetchRaw(pageUrl, 15_000);
  if ("error" in res) return { rows: [], linksSeen: 0, ok: false, note: res.error };
  if (res.status !== 200 || !res.html) {
    return { rows: [], linksSeen: 0, ok: false, note: `HTTP ${res.status}` };
  }

  const rows: FindingRow[] = [];
  const links = extractLinks(res.html, pageUrl);

  // Pass 1 — real anchors.
  for (const link of links) {
    const p = matchUrl(link.url, patterns);
    if (!p) continue;
    let host: string | null = null;
    try { host = new URL(link.url).hostname; } catch { /* keep null */ }
    const primary = link.occurrences[0];
    rows.push({
      run_id: runId,
      page_url: pageUrl,
      link_url: link.url,
      link_host: host,
      matched: p.label,
      kind: "anchor",
      anchor_text: link.anchor || null,
      zone: primary?.zone ?? null,
      heading: primary?.heading ?? null,
      occurrences: link.occurrences,
      // extractLinks records at most four occurrences per URL per page, so this is "at least".
      // The actionable unit is the page and the zone, not an exact within-page tally.
      hits: link.occurrences.length,
      context: describeOccurrences(link.occurrences),
    });
  }

  // Pass 2 — everything that is not an anchor.
  //
  // An <a href="/dashboard"> is also a string in the HTML, so the raw pass sees every anchor the
  // first pass already found. Suppressing a label outright once it has any anchor was the first
  // attempt and it was wrong: measured against the live site, /blogs carries one anchor to a
  // subdomain AND 165 /dashboard references inside a serialised remote-config payload. Whole-label
  // suppression would have hidden all 165. So the anchor hits are SUBTRACTED instead, and what is
  // left over is the genuinely non-anchor surplus.
  const anchoredHits = new Map<string, number>();
  for (const r of rows) anchoredHits.set(r.matched, (anchoredHits.get(r.matched) ?? 0) + r.hits);

  for (const p of patterns) {
    const { count: rawCount, sample } = rawHits(res.html, p);
    const count = rawCount - (anchoredHits.get(p.label) ?? 0);
    if (count <= 0) continue;
    rows.push({
      run_id: runId,
      page_url: pageUrl,
      // No single URL to point at — the reference is a fragment, not a resolved link. The label is
      // the identity, and the sample is what a person actually needs to find it.
      link_url: `raw:${p.label}`,
      link_host: null,
      matched: p.label,
      kind: "raw",
      anchor_text: null,
      zone: null,
      heading: null,
      occurrences: null,
      hits: count,
      context: sample,
    });
  }

  return { rows, linksSeen: links.length, ok: true };
}

// ── Runner ──────────────────────────────────────────────────────────────────────────────────────

export async function startSweep(opts: { patterns?: SweepPattern[]; startedBy?: string } = {}): Promise<{
  runId: string;
  pagesTotal: number;
}> {
  const patterns = opts.patterns?.length ? opts.patterns : DEFAULT_PATTERNS;
  const pages = await fetchSitemapUrls();

  const { data: run, error } = await supabaseAdmin
    .from("url_sweep_runs")
    .insert({
      status: "running",
      patterns,
      pages_total: pages.length,
      started_by: opts.startedBy ?? null,
    })
    .select()
    .single();
  if (error) throw error;

  await clearState();
  const state: SweepState = {
    runId: run.id,
    patterns,
    pages,
    index: 0,
    linksSeen: 0,
    matches: 0,
    log: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  pushLog(state, `Sitemap fetched — ${pages.length} pages queued, looking for ${patterns.length} pattern(s)`);
  await saveState(state);
  await clearStop();
  return { runId: run.id, pagesTotal: pages.length };
}

/** Work from state.index until done or the chunk budget runs out, then hand off to a fresh
 *  invocation. Mirrors the audit's shape so there is one long-job pattern in this codebase, not two. */
export async function processSweepChunk(): Promise<void> {
  const state = await getSweepState();
  if (!state) return;
  const deadline = Date.now() + CHUNK_BUDGET_MS;

  while (state.index < state.pages.length && Date.now() < deadline) {
    if (await isStopRequested()) {
      pushLog(state, `Stopped at page ${state.index}/${state.pages.length}.`);
      await saveState(state);
      await finishRun(state, "stopped");
      await clearState();
      await clearStop();
      return;
    }

    const slice = state.pages.slice(state.index, state.index + BATCH);
    const queue = new PQueue({ concurrency: PAGE_CONCURRENCY });
    const rows: FindingRow[] = [];
    let failed = 0;

    await Promise.all(
      slice.map((pageUrl) =>
        queue.add(async () => {
          const r = await sweepPage(state.runId, pageUrl, state.patterns);
          state.linksSeen += r.linksSeen;
          if (!r.ok) { failed++; return; }
          if (r.rows.length) rows.push(...r.rows);
        }),
      ),
    );
    await queue.onIdle();

    if (rows.length) {
      state.matches += rows.length;
      await supabaseAdmin
        .from("url_sweep_findings")
        .upsert(rows, { onConflict: "run_id,page_url,link_url,kind", ignoreDuplicates: true });
    }

    state.index += slice.length;
    pushLog(
      state,
      `[${state.index}/${state.pages.length}] +${rows.length} reference(s)${failed ? ` · ${failed} page(s) unreadable` : ""}`,
    );
    await saveState(state);
    await supabaseAdmin
      .from("url_sweep_runs")
      .update({ pages_checked: state.index, links_seen: state.linksSeen, matches: state.matches })
      .eq("id", state.runId);
  }

  await saveState(state);

  if (state.index < state.pages.length) {
    pushLog(state, `Time budget reached — continuing (${state.pages.length - state.index} pages left)`);
    await saveState(state);
    await qstashPublish("/api/url-sweep/run", { continue: true, auto: true });
    return;
  }

  await finishRun(state, "completed");
  await clearState();
}

async function finishRun(state: SweepState, status: "completed" | "stopped"): Promise<void> {
  await supabaseAdmin
    .from("url_sweep_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      pages_checked: state.index,
      links_seen: state.linksSeen,
      matches: state.matches,
    })
    .eq("id", state.runId);
}

// ── Report ──────────────────────────────────────────────────────────────────────────────────────

export interface SweepGroup {
  link_url: string;
  matched: string;
  kind: "anchor" | "raw";
  pages: number;
  /** Which DOM zones it appears in, most common first. */
  zones: string[];
  /** True when the reference is in a shared template rather than page content — one fix, not N.
   *  This is the single most useful thing the report says, so it is computed, not left to the eye. */
  site_wide: boolean;
  sample_anchor: string | null;
  sample_pages: string[];
  all_pages: string[];
}

export interface SweepReport {
  run: {
    id: string;
    status: string;
    pages_total: number;
    pages_checked: number;
    matches: number;
    started_at: string;
    finished_at: string | null;
    patterns: SweepPattern[];
  } | null;
  groups: SweepGroup[];
  total_references: number;
  total_pages_affected: number;
}

/**
 * The latest run, grouped the way somebody cleaning this up would want it.
 *
 * Grouped by target URL rather than listed flat, because a flat list of 1,400 rows for one footer
 * link reads as 1,400 problems when it is one. The grouping is what turns a crawl into a work list.
 */
export async function sweepReport(runId?: string): Promise<SweepReport> {
  const { data: run } = runId
    ? await supabaseAdmin.from("url_sweep_runs").select("*").eq("id", runId).maybeSingle()
    : await supabaseAdmin
        .from("url_sweep_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

  if (!run) return { run: null, groups: [], total_references: 0, total_pages_affected: 0 };

  const { data: findings } = await supabaseAdmin
    .from("url_sweep_findings")
    .select("page_url, link_url, matched, kind, anchor_text, zone, hits, context")
    .eq("run_id", run.id)
    .limit(20_000);

  const byKey = new Map<string, SweepGroup & { zoneCount: Record<string, number> }>();
  const affected = new Set<string>();
  let total = 0;

  for (const f of findings ?? []) {
    const key = `${f.kind}|${f.link_url}`;
    total += f.hits ?? 1;
    affected.add(f.page_url);
    let g = byKey.get(key);
    if (!g) {
      g = {
        link_url: f.link_url,
        matched: f.matched,
        kind: f.kind,
        pages: 0,
        zones: [],
        site_wide: false,
        sample_anchor: f.anchor_text ?? null,
        sample_pages: [],
        all_pages: [],
        zoneCount: {},
      };
      byKey.set(key, g);
    }
    g.pages++;
    g.all_pages.push(f.page_url);
    if (g.sample_pages.length < 5) g.sample_pages.push(f.page_url);
    if (!g.sample_anchor && f.anchor_text) g.sample_anchor = f.anchor_text;
    if (f.zone) g.zoneCount[f.zone] = (g.zoneCount[f.zone] ?? 0) + 1;
  }

  const checked = Math.max(run.pages_checked ?? 0, 1);
  const groups: SweepGroup[] = [...byKey.values()]
    .map(({ zoneCount, ...g }) => {
      const zones = Object.entries(zoneCount).sort((a, b) => b[1] - a[1]).map(([z]) => z);
      return {
        ...g,
        zones,
        // On more than half the crawled pages, or on many pages in shared markup: that is a
        // template, and a template is one edit. The claim is "look in the template first", not a
        // proof, so the thresholds are deliberately loose.
        //
        // The `raw` clause is not symmetry for its own sake. The first full run flagged only the
        // footer link: /dashboard, ideate and shorts each appeared on ~240 of 1,564 pages as raw
        // references, which is 15% — under the majority threshold — and raw findings carry no DOM
        // zone by construction, so neither clause could ever fire. Three plainly template-level
        // items read as ordinary content. A raw reference repeated across dozens of pages IS
        // shared markup or config; there is no other way for it to get there.
        site_wide:
          g.pages / checked > 0.5 ||
          (g.pages > 20 &&
            (g.kind === "raw" || zones.some((z) => z === "nav" || z === "header" || z === "footer"))),
      };
    })
    .sort((a, b) => b.pages - a.pages);

  return {
    run: {
      id: run.id,
      status: run.status,
      pages_total: run.pages_total,
      pages_checked: run.pages_checked,
      matches: run.matches,
      started_at: run.started_at,
      finished_at: run.finished_at,
      patterns: run.patterns ?? [],
    },
    groups,
    total_references: total,
    total_pages_affected: affected.size,
  };
}
