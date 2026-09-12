// The site's URL inventory: parse sitemap.xml, cache it, and serve it to everything that needs to
// know "what pages do we actually have".
//
// Three consumers, which is why this is a shared store rather than a one-off parse:
//   - the writer's internal-link database (previously 36 hand-curated links, so it could not link to
//     any of the 747 real blog posts),
//   - the URL pickers (canonical, backlink targets, internal-link targets),
//   - the audit, which wants the full inventory rather than the money-page subset.
//
// The live-parse path in src/lib/indexing/discover.ts stays as it is: `discover()` needs a fresh read
// during a crawl run, and it deliberately samples. This is the cached, complete, queryable copy.
import { XMLParser } from "fast-xml-parser";
import { supabaseAdmin } from "@/lib/db/supabase";
import { isMoneyPage, toPath } from "@/lib/indexing/template";

export interface SiteUrlRow {
  url: string;
  path: string;
  section: string;
  lastmod: string | null;
  changefreq: string | null;
  priority: number | null;
  is_money: boolean;
  source: string;
  first_seen: string;
  last_seen: string;
}

export interface ParsedUrl {
  url: string;
  path: string;
  section: string;
  lastmod: string | null;
  changefreq: string | null;
  priority: number | null;
}

/** First path segment, which is how the site is actually organised: blogs, features, apps, compare. */
export function sectionOf(path: string): string {
  return path.replace(/^\/+/, "").split("/")[0] ?? "";
}

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * Parse a sitemap document. Pure and synchronous, so the selfcheck can assert it.
 *
 * Returns either the URLs (a `<urlset>`) or the child sitemap locations (a `<sitemapindex>`) — the
 * caller decides whether to follow them, because recursion needs network access and a budget.
 */
export function parseSitemap(xml: string): { urls: ParsedUrl[]; children: string[] } {
  let doc: any;
  try { doc = parser.parse(xml); } catch { return { urls: [], children: [] }; }

  if (doc?.sitemapindex) {
    const children = asArray<any>(doc.sitemapindex.sitemap)
      .map((s) => (typeof s?.loc === "string" ? s.loc.trim() : ""))
      .filter(Boolean);
    return { urls: [], children };
  }

  const urls: ParsedUrl[] = [];
  const seen = new Set<string>();
  for (const u of asArray<any>(doc?.urlset?.url)) {
    // fast-xml-parser coerces a numeric-looking <loc> — never observed, but String() costs nothing
    // and a non-string here would otherwise throw inside toPath.
    const loc = typeof u?.loc === "string" ? u.loc.trim() : String(u?.loc ?? "").trim();
    if (!loc || !/^https?:\/\//i.test(loc) || seen.has(loc)) continue;
    seen.add(loc);

    const path = toPath(loc);
    // <priority> arrives as a number or a string depending on the value; <lastmod> may carry a full
    // timestamp, and the column is a date.
    const priority = u?.priority === undefined || u?.priority === "" ? null : Number(u.priority);
    const lastmodRaw = u?.lastmod === undefined ? "" : String(u.lastmod).trim();

    urls.push({
      url: loc,
      path,
      section: sectionOf(path),
      lastmod: lastmodRaw ? lastmodRaw.slice(0, 10) : null,
      changefreq: u?.changefreq ? String(u.changefreq).trim() : null,
      priority: Number.isFinite(priority) ? priority : null,
    });
  }
  return { urls, children: [] };
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function fetchText(url: string, timeoutMs = 20_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/xml,text/xml,*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export interface SyncResult {
  ok: boolean;
  error?: string;
  source_url: string;
  url_count: number;
  added: number;
  sections: Record<string, number>;
}

/**
 * Refresh the inventory from a sitemap (following a sitemap index one level, bounded).
 *
 * Upsert, never replace: a URL that disappears from the sitemap keeps its row and simply stops being
 * refreshed. That way a link that was valid yesterday is still recognised today, and a sitemap that
 * breaks and returns 12 URLs cannot wipe the inventory — the sync log records the count so the drop
 * is visible.
 *
 * `xml` lets a caller sync from a file they already have instead of the network.
 */
export async function syncSitemap(opts: { sourceUrl?: string; xml?: string; maxChildren?: number } = {}): Promise<SyncResult> {
  const sourceUrl = opts.sourceUrl ?? "https://www.imagine.art/sitemap.xml";
  const maxChildren = opts.maxChildren ?? 20;

  const log = async (r: SyncResult) => {
    await supabaseAdmin.from("site_url_syncs").insert({
      source_url: r.source_url, url_count: r.url_count, added: r.added, ok: r.ok, error: r.error ?? null,
    });
    return r;
  };

  let xml = opts.xml ?? null;
  if (!xml) xml = await fetchText(sourceUrl);
  if (!xml) {
    return log({ ok: false, error: `Could not fetch ${sourceUrl}`, source_url: sourceUrl, url_count: 0, added: 0, sections: {} });
  }

  const first = parseSitemap(xml);
  let urls = first.urls;

  // A sitemap index: fetch the children (bounded) and flatten.
  if (!urls.length && first.children.length) {
    for (const child of first.children.slice(0, maxChildren)) {
      const childXml = await fetchText(child);
      if (!childXml) continue;
      urls = urls.concat(parseSitemap(childXml).urls);
    }
  }

  if (!urls.length) {
    return log({ ok: false, error: "No <loc> entries found", source_url: sourceUrl, url_count: 0, added: 0, sections: {} });
  }

  // Paginated. PostgREST returns at most 1000 rows per request no matter what you ask for, so a plain
  // select here reported 501 URLs as "new" on a second sync of an identical sitemap — it had only seen
  // 1000 of the 1,501 it already had. This cap has bitten three separate queries in this file; assume
  // any select that could exceed 1000 rows needs .range() pagination.
  const known = new Set<string>();
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data } = await supabaseAdmin
        .from("site_urls").select("url").order("url").range(from, from + PAGE - 1);
      for (const r of data ?? []) known.add(r.url);
      if (!data || data.length < PAGE) break;
    }
  }
  const now = new Date().toISOString();

  const rows = urls.map((u) => ({
    ...u,
    is_money: isMoneyPage(u.path),
    source: "sitemap",
    last_seen: now,
  }));

  // Chunked: a 1,500-row upsert in one request is large enough to hit request limits, and a partial
  // failure mid-way is fine here because the operation is idempotent.
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabaseAdmin
      .from("site_urls")
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "url" });
    if (error) {
      return log({ ok: false, error: error.message, source_url: sourceUrl, url_count: rows.length, added: 0, sections: {} });
    }
  }

  const sections: Record<string, number> = {};
  for (const u of urls) sections[u.section || "(home)"] = (sections[u.section || "(home)"] ?? 0) + 1;

  return log({
    ok: true,
    source_url: sourceUrl,
    url_count: rows.length,
    added: rows.filter((r) => !known.has(r.url)).length,
    sections,
  });
}

/** Query the inventory. `q` matches on path, so "headshot" finds every headshot page. */
export async function listSiteUrls(opts: { section?: string; q?: string; moneyOnly?: boolean; limit?: number } = {}): Promise<SiteUrlRow[]> {
  let query = supabaseAdmin.from("site_urls").select("*").order("path");
  if (opts.section) query = query.eq("section", opts.section);
  if (opts.moneyOnly) query = query.eq("is_money", true);
  if (opts.q?.trim()) query = query.ilike("path", `%${opts.q.trim()}%`);
  // Capped at 1000 by PostgREST regardless of what we ask for. Callers that need everything should
  // page; the pickers filter by section or query first, so a 1000-row ceiling is not reached.
  const { data, error } = await query.limit(Math.min(opts.limit ?? 1000, 1000));
  if (error) throw error;
  return data ?? [];
}

export async function siteUrlCount(): Promise<number> {
  const { count } = await supabaseAdmin.from("site_urls").select("url", { count: "exact", head: true });
  return count ?? 0;
}

/**
 * Every path in the inventory, money pages first. For the "pick a page" dropdowns.
 *
 * Paginated for the same reason internalLinkUniverse is: a single query returns at most 1000 rows
 * whatever limit you pass, which would quietly hide 500 real pages from every picker.
 */
export async function allSiteUrlPaths(): Promise<string[]> {
  const rows: Array<{ path: string; is_money: boolean }> = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("site_urls").select("path, is_money").order("path").range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows
    .sort((a, b) => Number(b.is_money) - Number(a.is_money) || a.path.localeCompare(b.path))
    .map((r) => r.path);
}

/** The most recent sync, for showing "last refreshed" and catching a shrunken sitemap. */
export async function lastSitemapSync(): Promise<{ created_at: string; url_count: number; ok: boolean; error: string | null } | null> {
  const { data } = await supabaseAdmin
    .from("site_url_syncs").select("created_at, url_count, ok, error")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
}


/* ─────────────────────────────────────────────────────────────────────────────────────────────────
   The writer's internal-link database.

   The voice profile carries ~36 hand-curated links with categories and descriptions. That is a good
   editorial shortlist, and it is nowhere near the site: there are 747 real blog posts and 379 feature
   pages, and `propose_outline` rejected a link to any of them because they were not in the curated
   set. So a cluster article could only ever link to its siblings.

   1,500 URLs cannot go in the prompt — it is a cached prefix and that would be ~50k tokens per call.
   They are exposed as a searchable tool instead, so the model asks for the pages relevant to what it
   is writing and gets back real paths it is then allowed to use.
   ───────────────────────────────────────────────────────────────────────────────────────────────── */

export interface LinkCandidate { url: string; path: string; section: string; lastmod: string | null }

/**
 * Internal pages matching a topic, best-first.
 *
 * Ranking is deliberately simple and explainable: every query word that appears in the path scores a
 * point, an exact-ish path match scores more, and money pages get a small nudge so a commercial page
 * wins a tie against a blog post. No embeddings — path slugs on this site are keyword-shaped, so
 * substring matching is genuinely good, and a wrong-but-confident semantic match would be worse than
 * a miss the model can see.
 */
export async function internalLinkCandidates(
  query: string,
  opts: { section?: string; limit?: number } = {},
): Promise<LinkCandidate[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 15, 50));
  const words = query.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length >= 3);
  if (!words.length) return [];

  // Fetch on the single most distinctive word, then rank in memory. One round trip, and the ranking
  // stays here where it can be read and changed without touching SQL.
  const anchor = [...words].sort((a, b) => b.length - a.length)[0];
  let q = supabaseAdmin.from("site_urls").select("url, path, section, lastmod, is_money").ilike("path", `%${anchor}%`);
  if (opts.section) q = q.eq("section", opts.section);
  const { data, error } = await q.limit(400);
  if (error) throw error;

  const scored = (data ?? []).map((r: any) => {
    const slug = String(r.path).toLowerCase();
    let score = 0;
    for (const w of words) if (slug.includes(w)) score += 1;
    if (words.every((w) => slug.includes(w))) score += 2;
    if (r.is_money) score += 0.5;
    return { r, score };
  });

  // Relevance floor. The anchor word is the longest, not the rarest, so a search for "ai headshot
  // generator" anchors on "generator" and drags in every generator page on the site. Keeping only
  // results within half the best score drops those: handing the model 15 pages of which 1 is relevant
  // invites a plausible-but-wrong link.
  const best = scored.reduce((m, x) => Math.max(m, x.score), 0);
  const floor = Math.max(1, best / 2);

  return scored
    .filter((x) => x.score >= floor)
    .sort((a, b) => b.score - a.score || a.r.path.length - b.r.path.length)
    .slice(0, limit)
    .map(({ r }) => ({ url: r.url, path: r.path, section: r.section, lastmod: r.lastmod }));
}

/**
 * Every internal URL the writer is ALLOWED to link to, as a set for validation.
 *
 * Both forms of each URL are included (with and without the leading host) because the model writes
 * whichever it was shown, and rejecting a real page over a host prefix would be a maddening failure.
 */
export async function internalLinkUniverse(): Promise<Set<string>> {
  const out = new Set<string>();
  // Paginated with .range(), NOT .limit(): PostgREST caps a response at 1000 rows regardless of the
  // limit you ask for, so a plain .limit(5000) silently returned 1000 of 1,501 URLs and the validator
  // rejected links to the 500 it never saw. The set size still looked healthy because each row
  // contributes three entries — which is exactly how this hid.
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("site_urls").select("url, path").order("url").range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data ?? []) {
      out.add(r.url);
      out.add(r.url.replace(/\/$/, ""));
      out.add(r.path);
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}
