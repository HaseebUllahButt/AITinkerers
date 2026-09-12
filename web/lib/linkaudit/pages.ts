// The sitemap page sweep: check every URL the sitemap lists — the PAGE itself, not the links
// on it. The classic crawl (run.ts) answers "which links are broken"; since PR #168 it also
// notices a sitemap page that answers 404/410/5xx while fetching it. What it cannot see is a
// page that is broken while returning 200: a soft-404 body, or a silent redirect to the
// homepage — those pages look healthy to the crawl, which happily checks their links and
// moves on. This sweep runs the full verdict engine ON each sitemap URL, so every way a page
// can be dead is one findings row.
//
// It is also fast where the crawl is slow: first-party fetches only, no third-party link
// round-trips — the whole sitemap (~1,500 URLs) in minutes at concurrency 12. That makes
// "is every page alive right now?" answerable on demand after a deploy.
//
// Long-job shape mirrors run.ts: chunked with a time budget, state in Redis (its own keys, so
// a page sweep and a link crawl can run side by side), auto-continued via QStash, results in
// the SAME two tables — a link_audit_runs row with kind='pages', findings with
// page_url = link_url and the real verdict reason. Sharing the vocabulary is what makes
// re-verify, resolved_at closure and the Slack digest work on sweeps with no new code.
import PQueue from "p-queue";
import { supabaseAdmin } from "@/lib/db/supabase";
import { redis } from "@/lib/redis";
import { qstashPublish, isServerless } from "@/lib/qstash";
import { syncSitemap } from "@/lib/sitemap/store";
import {
  checkLink, diffRunLinks, discoverRobotsSitemaps, fetchRaw, HARD_BROKEN_REASONS, VERDICT_REASON,
  type FingerprintMap, type LinkVerdict,
} from "@/lib/linkaudit/run";
import { patternOf } from "@/lib/renderlab/deadUrls";
import { isGscConfigured, searchAnalytics, daysAgo } from "@/lib/indexing/gsc";

// Every sitemap URL gets checked — the cap is a runaway guard (sitemap holds ~1,500 today),
// not a sample size. If the site ever exceeds it, the run log says so out loud.
const MAX_SWEEP_PAGES = 5000;
const SITEMAP_CHILDREN = 50; // nested sitemaps to follow during the pre-sweep sync
const CHUNK_BUDGET_MS = isServerless() ? 210_000 : Infinity;
const PAGE_CONCURRENCY = 12; // our own site only — modest enough not to hammer it

const STATE_KEY = "pagesweep:state";
const FP_KEY = "pagesweep:fp";
const STOP_KEY = "pagesweep:stop";

export interface PageSweepState {
  runId: string;
  pages: string[];
  index: number;
  broken: number;
  unreachable: number;
  log: string[];
  startedAt: number;
  updatedAt: number;
}

const MAX_LOG_LINES = 120;
function pushLog(state: PageSweepState, line: string) {
  state.log ??= [];
  state.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES);
}

// ─── Verdict → finding reason ──────────────────────────────────────────────────────────────
//
// One extra mapping beyond VERDICT_REASON: every swept URL comes from OUR sitemap, so a 5xx
// is our outage even when the hostname fails checkLink's first-party test (a preview deploy,
// the E2E fixture). checkLink files those as "unreach"; here the provenance upgrades them.
export function pageReason(v: LinkVerdict): string | null {
  const mapped = VERDICT_REASON[v.verdict];
  if (mapped) return mapped;
  if (v.verdict === "unreach" && (v.status ?? 0) >= 500) return "http-5xx";
  return null;
}

const REASON_HINT: Record<string, string> = {
  "http-404": "listed in the sitemap but the page returns 404",
  "http-410": "listed in the sitemap but the page returns 410 (gone)",
  "soft-404": "returns 200 but renders a not-found page — invisible to status checks",
  "homepage-redirect": "silently redirects to the homepage — the content is gone",
  "http-5xx": "server error on our own page",
};

// ─── Stop flag ─────────────────────────────────────────────────────────────────────────────

export async function requestPageSweepStop(): Promise<void> {
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

// ─── Redis state ───────────────────────────────────────────────────────────────────────────

export async function getPageSweepState(): Promise<PageSweepState | null> {
  const r = redis();
  if (!r) return null;
  const raw = await r.get<unknown>(STATE_KEY).catch(() => null);
  if (!raw) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as PageSweepState;
}
async function saveState(s: PageSweepState): Promise<void> {
  const r = redis();
  if (!r) return;
  s.updatedAt = Date.now();
  await r.set(STATE_KEY, JSON.stringify(s), { ex: 60 * 60 * 24 }).catch(() => {});
}
export async function clearPageSweepState(): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.del(STATE_KEY).catch(() => {});
  await r.del(FP_KEY).catch(() => {});
}
async function loadFp(): Promise<FingerprintMap> {
  const r = redis();
  if (!r) return {};
  const raw = await r.get<unknown>(FP_KEY).catch(() => null);
  return raw ? ((typeof raw === "string" ? JSON.parse(raw) : raw) as FingerprintMap) : {};
}
async function saveFp(m: FingerprintMap): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.set(FP_KEY, JSON.stringify(m), { ex: 60 * 60 * 24 }).catch(() => {});
}

// ─── Enumeration ───────────────────────────────────────────────────────────────────────────
//
// The inventory is site_urls (synced from sitemap.xml, upsert-never-delete), refreshed RIGHT
// BEFORE each sweep so the URL list is today's sitemap, not last month's. The sync going
// stale is a real failure mode we measured: a month without a scheduled sync. When the sync
// fails the sweep still runs over the existing inventory — a stale list beats no sweep — and
// the log says which happened.
// Beyond the default /sitemap.xml: robots.txt-declared sitemaps, and the known first-party
// subdomains' own sitemaps. Each candidate is probed first — syncSitemap logs every attempt
// to site_url_syncs, and three "no such sitemap" failure rows per day is noise, so only a
// URL that actually answers with sitemap XML gets synced.
const EXTRA_SITEMAP_HOSTS = ["app.northwind.example", "shorts.northwind.example", "ideate.northwind.example"];

async function syncExtraSitemaps(): Promise<number> {
  const candidates = new Set<string>();
  try {
    for (const u of await discoverRobotsSitemaps("https://www.northwind.example")) {
      if (u !== "https://www.northwind.example/sitemap.xml") candidates.add(u);
    }
  } catch { /* robots discovery is additive */ }
  for (const h of EXTRA_SITEMAP_HOSTS) candidates.add(`https://${h}/sitemap.xml`);

  let synced = 0;
  for (const url of candidates) {
    const probe = await fetchRaw(url, 8_000);
    if ("error" in probe || probe.status !== 200) continue;
    if (!/<(urlset|sitemapindex)/i.test(probe.html)) continue;
    const r = await syncSitemap({ sourceUrl: url, maxChildren: SITEMAP_CHILDREN }).catch(() => null);
    if (r?.ok) synced++;
  }
  return synced;
}

// Exported: the JS-links detector enumerates the same universe the sweep does.
export async function enumeratePages(includeRetired: boolean): Promise<{ pages: string[]; note: string }> {
  const sync = await syncSitemap({ maxChildren: SITEMAP_CHILDREN }).catch(() => null);
  const synced = !!sync?.ok;
  const extra = await syncExtraSitemaps().catch(() => 0);

  // Seven days rather than "this sync": the crawl persists its spider discoveries into
  // site_urls (source='spider') at finalize, stamped whenever the crawl finishes — a filter
  // pinned to this sync's timestamp would exclude every one of them. A week keeps current
  // sitemap rows + recent discoveries in scope and lets long-dropped URLs age out.
  const freshCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const pages: string[] = [];
  const PAGE = 1000; // PostgREST silently caps un-ranged selects at 1000 — always paginate
  for (let from = 0; pages.length < MAX_SWEEP_PAGES; from += PAGE) {
    let q = supabaseAdmin.from("site_urls").select("url, last_seen").order("url").range(from, from + PAGE - 1);
    if (synced && !includeRetired) q = q.gte("last_seen", freshCutoff);
    const { data, error } = await q;
    if (error) throw new Error(`Could not read site_urls (${error.message})`);
    for (const r of data ?? []) { if (pages.length < MAX_SWEEP_PAGES) pages.push(r.url as string); }
    if (!data || data.length < PAGE) break;
  }
  const note = synced
    ? `Sitemap re-synced (${sync!.url_count} URLs${extra > 0 ? ` + ${extra} extra sitemap${extra === 1 ? "" : "s"}` : ""}) — sweeping ${pages.length}${includeRetired ? " incl. formerly-listed" : ""}.`
    : `Sitemap sync failed — sweeping the existing inventory of ${pages.length} URLs instead.`;
  return { pages, note };
}

// ─── Runner ────────────────────────────────────────────────────────────────────────────────

export async function startPageSweep(opts: { includeRetired?: boolean } = {}): Promise<{ runId: string; pagesTotal: number }> {
  const { pages, note } = await enumeratePages(opts.includeRetired === true);
  if (pages.length === 0) throw new Error("No sitemap URLs to sweep — is site_urls empty and the sitemap unreachable?");
  const { data: run, error } = await supabaseAdmin
    .from("link_audit_runs")
    .insert({ status: "running", pages_total: pages.length, kind: "pages" })
    .select()
    .single();
  if (error) throw error;
  await clearPageSweepState();
  const state: PageSweepState = {
    runId: run.id, pages, index: 0, broken: 0, unreachable: 0, log: [],
    startedAt: Date.now(), updatedAt: Date.now(),
  };
  pushLog(state, note);
  if (pages.length >= MAX_SWEEP_PAGES) pushLog(state, `CAP HIT: sitemap exceeds ${MAX_SWEEP_PAGES} URLs — raise MAX_SWEEP_PAGES to keep full coverage.`);
  await saveState(state);
  await clearStop();
  return { runId: run.id, pagesTotal: pages.length };
}

export async function processPageSweepChunk(): Promise<void> {
  const state = await getPageSweepState();
  if (!state) return;
  const deadline = Date.now() + CHUNK_BUDGET_MS;
  const fpCache = await loadFp();
  const queue = new PQueue({ concurrency: PAGE_CONCURRENCY });

  while (state.index < state.pages.length && Date.now() < deadline) {
    if (await isStopRequested()) {
      pushLog(state, `Stopped by user at ${state.index}/${state.pages.length} pages.`);
      await saveState(state);
      await supabaseAdmin.from("link_audit_runs").update({
        status: "stopped", finished_at: new Date().toISOString(),
        pages_checked: state.index, broken_found: state.broken, unreachable: state.unreachable,
      }).eq("id", state.runId);
      await clearPageSweepState();
      await clearStop();
      return;
    }

    // A batch per loop turn keeps the stop-flag check and state saves regular without
    // paying a Redis round-trip per page.
    const batch = state.pages.slice(state.index, state.index + 50);
    const rows: Array<Record<string, unknown>> = [];
    await Promise.all(batch.map((url) => queue.add(async () => {
      const v = await checkLink(url, fpCache);
      const reason = pageReason(v);
      const path = (() => { try { return new URL(url).pathname || "/"; } catch { return url; } })();
      if (reason) {
        state.broken++;
        rows.push({
          run_id: state.runId, page_url: url, page_author: null,
          link_url: url, anchor_text: null, context_text: null,
          occurrences: [], location_hint: REASON_HINT[reason] ?? "the page itself is broken",
          reason, http_status: v.status ?? null,
        });
        pushLog(state, `${path} — BROKEN PAGE (${reason}${v.status ? `, HTTP ${v.status}` : ""})`);
      } else if (v.verdict === "unreach") {
        state.unreachable++;
        rows.push({
          run_id: state.runId, page_url: url, page_author: null,
          link_url: url, anchor_text: null, context_text: null,
          occurrences: [], location_hint: "our own page didn't answer — timeout or connection error, worth a manual look",
          reason: "unreachable", http_status: v.status ?? null,
        });
        pushLog(state, `${path} — page didn't answer (${v.status ? `HTTP ${v.status}` : "timeout"})`);
      }
    })));
    await queue.onIdle();

    if (rows.length > 0) {
      await supabaseAdmin.from("link_audit_findings").upsert(rows, {
        onConflict: "run_id,page_url,link_url", ignoreDuplicates: true,
      });
    }

    state.index += batch.length;
    pushLog(state, `[${state.index}/${state.pages.length}] swept — ${state.broken} broken, ${state.unreachable} unreachable so far`);
    await saveState(state);
    await saveFp(fpCache);
    await supabaseAdmin.from("link_audit_runs").update({
      pages_checked: state.index, broken_found: state.broken, unreachable: state.unreachable,
    }).eq("id", state.runId);
  }

  if (state.index < state.pages.length) {
    pushLog(state, `Time budget reached — continuing in a fresh run (${state.pages.length - state.index} pages left)`);
    await saveState(state);
    await qstashPublish("/api/link-audit/pages/run", { continue: true, auto: true });
    return;
  }
  pushLog(state, "Sweep complete — comparing to the last sweep and posting the digest…");
  await saveState(state);

  // ── Finalize ─────────────────────────────────────────────────────────────────────────────
  const { data: curRows } = await supabaseAdmin
    .from("link_audit_findings").select("link_url, reason, http_status").eq("run_id", state.runId);
  const brokenRows = (curRows ?? []).filter((r) => HARD_BROKEN_REASONS.has(r.reason));

  // GSC traffic behind each dead page (best-effort): lets the digest and the disposition
  // queue lead with "this dead page had 1,200 clicks", which is what decides gone-vs-redirect.
  const traffic = new Map<string, { clicks: number; impressions: number }>();
  try {
    if (isGscConfigured() && brokenRows.length > 0) {
      const rows = await searchAnalytics({ startDate: daysAgo(28), endDate: daysAgo(1), dimensions: ["page"], rowLimit: 5000 });
      for (const r of rows) traffic.set(r.keys[0], { clicks: r.clicks, impressions: r.impressions });
      for (const f of brokenRows.slice(0, 200)) {
        const t = traffic.get(f.link_url);
        if (t && t.clicks > 0) {
          await supabaseAdmin.from("link_audit_findings")
            .update({ location_hint: `${REASON_HINT[f.reason] ?? "broken page"} · ~${t.clicks.toLocaleString()} clicks/28d behind it` })
            .eq("run_id", state.runId).eq("link_url", f.link_url);
        }
      }
    }
  } catch { /* traffic is decoration — the findings stand without it */ }

  // Feed the disposition queue: a dead PAGE's fix is an edge decision (410 / redirect /
  // leave), which is Render Lab's dead_urls machinery. Insert-only (ignoreDuplicates) so a
  // row the GSC sweep already owns — with real click history and maybe a decided
  // disposition — is never clobbered by us writing zeros over it.
  try {
    const DEAD_VERDICT: Record<string, string> = {
      "http-404": "404", "http-410": "410", "soft-404": "soft", "homepage-redirect": "redirect", "http-5xx": "server-error",
    };
    const deadRows = brokenRows.map((f) => {
      const path = (() => { try { return new URL(f.link_url).pathname; } catch { return f.link_url; } })();
      const t = traffic.get(f.link_url);
      return {
        url: f.link_url, path, pattern: patternOf(path),
        http_status: f.http_status, verdict: DEAD_VERDICT[f.reason] ?? "404", redirect_to: null,
        clicks: t?.clicks ?? 0, impressions: t?.impressions ?? 0, position: null,
        sources: ["sitemap-sweep"], suggestion: null, checked_at: new Date().toISOString(),
      };
    });
    for (let i = 0; i < deadRows.length; i += 100) {
      await supabaseAdmin.from("dead_urls").upsert(deadRows.slice(i, i + 100), { onConflict: "url", ignoreDuplicates: true });
    }
  } catch { /* the bridge is a convenience — findings are the record */ }

  // Run-over-run closure, sweeps compared only to sweeps.
  try {
    const { data: prevRun } = await supabaseAdmin
      .from("link_audit_runs").select("id").eq("status", "completed").eq("kind", "pages")
      .neq("id", state.runId).order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (prevRun) {
      const { data: prevRows } = await supabaseAdmin
        .from("link_audit_findings").select("link_url, reason").eq("run_id", prevRun.id);
      const hard = (rows: Array<{ link_url: string; reason: string }> | null) =>
        [...new Set((rows ?? []).filter((r) => HARD_BROKEN_REASONS.has(r.reason)).map((r) => r.link_url))];
      const { fixed } = diffRunLinks(hard(prevRows), [...new Set(brokenRows.map((r) => r.link_url))]);
      const now = new Date().toISOString();
      for (let i = 0; i < fixed.length; i += 100) {
        await supabaseAdmin.from("link_audit_findings")
          .update({ resolved_at: now, last_checked_at: now })
          .in("link_url", fixed.slice(i, i + 100)).is("resolved_at", null);
      }
      if (fixed.length > 0) pushLog(state, `${fixed.length} page(s) dead last sweep now answer — marked fixed.`);
    }
  } catch { /* reporting, not correctness */ }

  await supabaseAdmin.from("link_audit_runs").update({
    status: "completed", finished_at: new Date().toISOString(),
    pages_checked: state.index, broken_found: state.broken, unreachable: state.unreachable,
  }).eq("id", state.runId);

  try {
    const { postAuditDigest } = await import("./slack");
    await postAuditDigest(state.runId);
  } catch { /* digest failure shouldn't fail the sweep */ }

  await clearPageSweepState();
}
