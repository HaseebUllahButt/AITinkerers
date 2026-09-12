// Every URL Google knows about that no longer answers 200 — and what it was earning before it died.
//
// ── Why this exists alongside the link audit ────────────────────────────────────────────────────
//
// SearchOps's link audit crawls our own pages and checks what they point at, which answers "which LINKS
// are broken". It cannot answer "which PAGES are broken", because a page nothing links to is invisible
// to a link crawl no matter how thoroughly it runs.
//
// That blind spot turned out to be the biggest thing on this site. Measured: 16,686 URLs under a single
// namespace `/read/9zqf5s/`, every one matching `/read/9zqf5s/{slug}-{epoch}`, every sampled one serving
// 410, carrying 176,663 impressions and 1,148 clicks over 480 days. Subjects with no relationship to an
// AI creative suite — lawn tractors, police news, cyclone safety. Nothing on the site links to any of
// them, so the daily link audit had reported the site clean of them every day for months. Search
// Console had all 16,686.
//
// ── Why results are grouped by path pattern ─────────────────────────────────────────────────────
//
// A list of 16,686 rows is not a finding, it is a haystack. Those URLs are ONE fact and the surface has
// to be able to say it in one line, which is what `pattern` — the first two path segments — is for.
// Ordered by the impressions behind each group rather than the row count, because 16,686 pages worth
// 176k impressions matters less than one page worth 12M, and a count-ordered list says the opposite.
import * as cheerio from "cheerio";

import { searchAnalytics, daysAgo, isGscConfigured } from "@/lib/indexing/gsc";
import { supabaseAdmin } from "@/lib/db/supabase";

const UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/125.0.0.0 Safari/537.36";

export type DeadVerdict = "404" | "410" | "soft" | "redirect" | "server-error" | "unreach";

export interface DeadUrl {
  url: string;
  path: string;
  pattern: string;
  httpStatus: number | null;
  verdict: DeadVerdict;
  redirectTo: string | null;
  clicks: number;
  impressions: number;
  position: number | null;
  sources: string[];
  suggestion: string | null;
}

/** `/read/9zqf5s/foo-123` → `/read/9zqf5s`. One segment for shallow paths. */
export function patternOf(path: string): string {
  const seg = path.replace(/^\/|\/$/g, "").split("/");
  if (!seg[0]) return "/";
  return seg.length >= 2 ? `/${seg[0]}/${seg[1]}` : `/${seg[0]}`;
}

/** Not-found wording inside a 200. Same heuristic the link audit uses, so the two agree. */
const SOFT_404 = /\b(404|not found|page (?:not|doesn'?t) exist|no longer (?:available|exists)|couldn'?t find|does not exist)\b/i;

const STOP = new Set(["the", "a", "an", "of", "for", "to", "in", "and", "your", "best", "top", "free", "online", "ai", "with"]);
function tokens(s: string): string[] {
  return s.toLowerCase().split("?")[0].split(/[/\s\-_.]+/)
    .filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t) && !/^20\d\d$/.test(t));
}

/**
 * The live page a dead URL most plausibly meant, or null.
 *
 * Null is the common and correct answer here: most of these are not mis-slugged versions of a real
 * page, they are pages that should never have existed. Offering the least-bad match for one of those
 * would invite a redirect that consolidates spam into a page we care about.
 */
function suggest(path: string, sitemap: string[]): string | null {
  const want = new Set(tokens(path));
  if (want.size < 2) return null;
  let best: { p: string; score: number } | null = null;
  for (const p of sitemap) {
    const have = new Set(tokens(p));
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    const score = shared / (want.size + have.size - shared || 1);
    if (!best || score > best.score) best = { p, score };
  }
  return best && best.score >= 0.5 ? best.p : null;
}

/**
 * Check a URL twice before believing it is dead.
 *
 * ── Why this is not paranoia ────────────────────────────────────────────────────────────────────
 *
 * The first version checked once, eight at a time, across tens of thousands of URLs. It reported the
 * HOMEPAGE as dead, with 27,470,763 impressions behind it, plus /bg-remover, /features/pixverse-ai
 * (21.6M) and /features/hailuo-ai-video-generator (19.8M). Every one of them returns 200 when asked
 * calmly. The sweep was generating its own evidence: enough concurrent requests to make the site
 * throttle, and a throttled response recorded as a fact about the page.
 *
 * So: one check, and if it looks dead, a second serial check after a pause. Both must agree. An
 * `unreach` is never recorded at all — it means "no answer", which is a statement about the request,
 * not about the page. The 404 Hunter already learned this and this sweep had not.
 */
async function confirm(url: string): Promise<{ status: number | null; verdict: DeadVerdict | "ok"; redirectTo: string | null }> {
  const first = await check(url);
  if (first.verdict === "ok") return first;
  // Inconclusive is not dead. Recording it as dead is how the homepage ends up on a 410 list.
  if (first.verdict === "unreach") return { ...first, verdict: "ok" };
  await new Promise((r) => setTimeout(r, 700));
  const second = await check(url);
  if (second.verdict !== first.verdict) {
    // They disagree, so at least one was load. Trust the healthier reading.
    return second.verdict === "ok" ? second : { ...second, verdict: "ok" };
  }
  return second;
}

/** One live status check, as Googlebot, without following the redirect so we can report the target. */
async function check(url: string): Promise<{ status: number | null; verdict: DeadVerdict | "ok"; redirectTo: string | null }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const s = res.status;
    if (s === 404) { await res.body?.cancel().catch(() => {}); return { status: s, verdict: "404", redirectTo: null }; }
    if (s === 410) { await res.body?.cancel().catch(() => {}); return { status: s, verdict: "410", redirectTo: null }; }
    if (s >= 300 && s < 400) {
      return { status: s, verdict: "redirect", redirectTo: res.headers.get("location") };
    }
    if (s >= 500) { await res.body?.cancel().catch(() => {}); return { status: s, verdict: "server-error", redirectTo: null }; }
    if (s >= 200 && s < 300) {
      const html = await res.text();
      // A 200 that says "not found" is worse than a 404: Google keeps it indexed.
      const $ = cheerio.load(html);
      const lead = `${$("title").first().text()} ${$("h1").first().text()}`.trim();
      if (SOFT_404.test(lead)) return { status: s, verdict: "soft", redirectTo: null };
      return { status: s, verdict: "ok", redirectTo: null };
    }
    return { status: s, verdict: "unreach", redirectTo: null };
  } catch {
    return { status: null, verdict: "unreach", redirectTo: null };
  }
}

/**
 * Every page Search Console has seen, paged past the 25,000-row cap.
 *
 * `pathPrefixes`, when given, pushes a `contains` filter into the GSC query itself instead of fetching
 * everything and filtering here — the cost that matters is Google's own pagination. An unfiltered query
 * over a wide window hits the 25,000-row cap (measured), which is several sequential round trips to
 * Google every single call; a scoped call to /blogs/ or /features/ returns a small enough result that it
 * almost always finishes in one. GSC allows one filter group per request, so "either prefix" means one
 * call per prefix, not one call with an OR — still far cheaper than the unfiltered fetch it replaces.
 */
export async function gscPages(
  days = 480,
  pathPrefixes?: string[],
): Promise<Map<string, { clicks: number; impressions: number; position: number }>> {
  const out = new Map<string, { clicks: number; impressions: number; position: number }>();
  if (!isGscConfigured()) return out;
  const filters = pathPrefixes?.length ? pathPrefixes : [undefined];
  for (const pageContains of filters) {
    for (let startRow = 0; startRow < 200_000; startRow += 25_000) {
      const rows = await searchAnalytics({
        startDate: daysAgo(days), endDate: daysAgo(2), dimensions: ["page"], rowLimit: 25_000, startRow,
        ...(pageContains ? { pageContains } : {}),
      }).catch(() => []);
      for (const r of rows) {
        const u = String(r.keys?.[0] ?? "");
        if (u) out.set(u.replace(/\/+$/, ""), { clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, position: r.position ?? 0 });
      }
      if (rows.length < 25_000) break;
    }
  }
  return out;
}

export interface SweepResult {
  considered: number;
  checked: number;
  dead: number;
  seconds: number;
  notes: string[];
}

/**
 * Check a batch of candidate URLs and record the dead ones.
 *
 * Bounded and resumable rather than exhaustive in one pass: there are 25,000+ candidates and each is a
 * live request. Oldest-checked first, so repeated runs walk the whole set instead of re-checking the
 * loudest pages forever.
 *
 * A URL that comes back healthy is DELETED from the table rather than left with an "ok" verdict — the
 * table is the list of what is currently broken, and a fixed page that lingers in it is the thing that
 * teaches people to distrust the list.
 */
export async function sweepDeadUrls(opts: {
  batch?: number; days?: number; budgetMs?: number;
  /** e.g. ["/blogs/", "/features/"] — restricts both the GSC fetch and the sitemap candidates to
   *  these path prefixes, which is what actually makes a scoped sweep fast (see gscPages). Omit for
   *  the whole-site sweep. */
  pathPrefixes?: string[];
} = {}): Promise<SweepResult> {
  const started = Date.now();
  const batch = opts.batch ?? 400;
  const budgetMs = opts.budgetMs ?? 240_000;
  const notes: string[] = [];

  const traffic = await gscPages(opts.days ?? 480, opts.pathPrefixes);
  if (!traffic.size) notes.push("Search Console returned nothing, so only the sitemap was considered.");

  // The sitemap, both as candidates and as the pool that replacement suggestions come from. Scoped the
  // same way as the GSC fetch above, so "checked" numbers describe the same pool on both sides.
  const inScope = (path: string) => !opts.pathPrefixes?.length || opts.pathPrefixes.some((p) => path.startsWith(p));
  const sitemap: string[] = [];
  const sitemapUrls: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("site_urls").select("url, path").range(from, from + 999);
    for (const r of (data ?? []) as Array<{ url: string; path: string }>) {
      if (!inScope(r.path)) continue;
      if (r.path) sitemap.push(r.path);
      if (r.url) sitemapUrls.push(r.url.replace(/\/+$/, ""));
    }
    if ((data ?? []).length < 1000) break;
  }

  const sources = new Map<string, Set<string>>();
  for (const u of traffic.keys()) (sources.get(u) ?? sources.set(u, new Set()).get(u)!).add("gsc");
  for (const u of sitemapUrls) (sources.get(u) ?? sources.set(u, new Set()).get(u)!).add("sitemap");

  // Oldest-checked first among URLs we already know are dead, then anything never checked. Both halves
  // matter: the first re-confirms (so fixed pages leave the table), the second discovers. Scoped too —
  // otherwise a scoped sweep would spend its batch re-confirming out-of-scope rows, which is exactly
  // the wasted work scoping exists to avoid.
  let knownQuery = supabaseAdmin
    .from("dead_urls").select("url, checked_at").order("checked_at", { ascending: true }).limit(batch);
  if (opts.pathPrefixes?.length) {
    knownQuery = knownQuery.or(opts.pathPrefixes.map((p) => `path.like.${p}%`).join(","));
  }
  const { data: known } = await knownQuery;
  const knownUrls = (known ?? []).map((r) => r.url as string);
  const knownSet = new Set(knownUrls);

  const { data: all } = await supabaseAdmin.from("dead_urls").select("url").limit(50_000);
  const everSeen = new Set((all ?? []).map((r) => r.url as string));

  const unchecked = [...sources.keys()].filter((u) => !everSeen.has(u));
  // Loudest first among the unchecked: if the budget runs out, it should run out on the URLs nobody
  // searches for, not on the ones with traffic behind them.
  unchecked.sort((a, b) => (traffic.get(b)?.impressions ?? 0) - (traffic.get(a)?.impressions ?? 0));

  const queue = [...knownUrls, ...unchecked].slice(0, batch);

  let checked = 0, dead = 0, cursor = 0;
  // Three, not eight. Eight filled this table with fiction: the sweep throttled the site and then
  // recorded the throttling as 404s, on pages with twenty million impressions. Slower and true beats
  // faster and wrong, and the confirm() pass above costs a second request per suspect anyway.
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (;;) {
      const url = queue[cursor++];
      if (!url) return;
      if (Date.now() - started > budgetMs) return;
      const r = await confirm(url);
      checked++;

      if (r.verdict === "ok") {
        // It works. If we previously recorded it as dead, that record is now a lie.
        if (knownSet.has(url)) await supabaseAdmin.from("dead_urls").delete().eq("url", url);
        continue;
      }
      // A redirect is only damage when it lands somewhere useless — a 301 to the right page is a fix,
      // not a finding. A redirect to the homepage is Google's definition of a soft 404.
      if (r.verdict === "redirect") {
        const to = (r.redirectTo ?? "").replace(/\/+$/, "");
        const toPath = to.startsWith("http") ? (() => { try { return new URL(to).pathname; } catch { return to; } })() : to;
        if (toPath && toPath !== "/" && toPath !== "") {
          if (knownSet.has(url)) await supabaseAdmin.from("dead_urls").delete().eq("url", url);
          continue;
        }
      }

      let path = url;
      try { path = new URL(url).pathname; } catch { /* keep the raw string */ }
      const t = traffic.get(url);
      dead++;
      await supabaseAdmin.from("dead_urls").upsert({
        url, path, pattern: patternOf(path),
        http_status: r.status, verdict: r.verdict, redirect_to: r.redirectTo,
        clicks: t?.clicks ?? 0, impressions: t?.impressions ?? 0, position: t?.position ?? null,
        sources: [...(sources.get(url) ?? [])],
        suggestion: suggest(path, sitemap),
        checked_at: new Date().toISOString(),
      }, { onConflict: "url" }).then(() => {}, () => {});
    }
  }));

  // ── Who still links to these ──────────────────────────────────────────────────────────────────
  //
  // From the link audit's own findings rather than a fresh crawl: it already ran this morning over
  // 1,595 pages and recorded the page, the anchor and the section for every broken link it saw. Joining
  // is free; re-crawling to learn the same thing would not be.
  //
  // Most rows will come back with nothing, and that is the point being measured — a dead page nothing
  // links to is exactly what a link crawl cannot find.
  await attachInboundLinks();

  return { considered: sources.size, checked, dead, seconds: Math.round((Date.now() - started) / 1000), notes };
}

async function attachInboundLinks(): Promise<void> {
  const { data: run } = await supabaseAdmin
    .from("link_audit_runs").select("id").eq("status", "completed")
    .order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (!run?.id) return;

  const { data: findings } = await supabaseAdmin
    .from("link_audit_findings")
    .select("page_url, link_url, anchor_text, location_hint")
    .eq("run_id", run.id)
    .limit(20_000);

  const byTarget = new Map<string, Array<{ page: string; anchor: string; where: string | null }>>();
  for (const f of findings ?? []) {
    const key = String(f.link_url ?? "").replace(/\/+$/, "");
    if (!key) continue;
    const list = byTarget.get(key) ?? [];
    if (list.length < 12) list.push({ page: f.page_url, anchor: f.anchor_text ?? "", where: f.location_hint ?? null });
    byTarget.set(key, list);
  }
  if (!byTarget.size) return;

  // ── Only touch rows that exist ────────────────────────────────────────────────────────────────
  //
  // The audit's targets and the dead-page table barely overlap: measured, 473 distinct broken-link
  // targets against 32 dead rows. Updating by url without checking first issued all 473 as sequential
  // round trips, ~441 of them matching nothing — 100 seconds of no-ops on EVERY sweep call, which was
  // 89% of the sweep's total runtime and the whole reason it looked hung. One read to find the overlap
  // is far cheaper than writing into the void.
  const { data: existing } = await supabaseAdmin.from("dead_urls").select("url").limit(50_000);
  const live = new Set((existing ?? []).map((r) => r.url as string));

  for (const [url, links] of byTarget) {
    if (!live.has(url)) continue;
    await supabaseAdmin.from("dead_urls").update({ linked_from: links }).eq("url", url).then(() => {}, () => {});
  }
}
