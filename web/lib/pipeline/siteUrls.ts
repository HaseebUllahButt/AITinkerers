import { rssHarvester } from "@/lib/harvesters/rss";
import { fetchPage } from "@/lib/extract/fetch";

// ── Seed-site article discovery ───────────────────────────────────────────────
// Given a campaign "site" (a bare domain OR a specific URL), find as many of that
// site's real article URLs as possible so Stage 2 can profile each one and pull out
// its author. This is the robust harvest behind the Discovery channel's "Sites to
// outreach" box: paste a site, and we mine its writers.
//
// Angles, unioned (each is blind to what the others surface):
//   1. WordPress REST  — /wp-json/wp/v2/posts gives clean post URLs on any WP site
//   2. RSS + sitemaps  — via the existing rssHarvester (feeds + shallow sitemap)
//   3. Sitemap index   — robots.txt Sitemap: entries + common names, recursing ONE level
//                        into a sitemap index (e.g. Shopify's non-standard sitemaps_list.xml)
//   4. Hub expansion   — author/topic/category "hub" pages (from sitemaps or crawl) list a
//                        writer's posts; fetch them and pull the post links. This is what
//                        cracks big SPA marketing sites whose posts aren't in one flat feed.
//   5. Section crawl   — rendered fetch of the homepage + blog/section roots + the seed URL
//   6. The seed URL itself — always included when a specific article URL was given
//
// No relevance gate (that's the point of a site campaign — take the site's writers as-is),
// so it's deliberately generous but bounded by hard caps at every fan-out to avoid runaway
// on giant multi-locale sites.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Hard caps — every fan-out is bounded so a giant site (Shopify has ~50 locales × many
// sitemaps) can't blow up the harvest.
const MAX_TOP_SITEMAPS = 6;
const MAX_CHILD_SITEMAPS = 24;
const MAX_HUBS = 90;
const POSTS_PER_AUTHOR_HUB = 2;   // few per author hub → maximize DISTINCT authors covered
const POSTS_PER_OTHER_HUB = 4;
const HUB_CONCURRENCY = 8;

function toHost(seed: string): string {
  const s = seed.trim();
  try {
    return new URL(s.startsWith("http") ? s : `https://${s}`).hostname.replace(/^www\./, "");
  } catch {
    return s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  }
}

async function fetchText(url: string, signal?: AbortSignal, ms = 12_000): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml,*/*" },
      signal: signal ?? AbortSignal.timeout(ms),
      redirect: "follow",
    });
    if (!res.ok) return "";
    return await res.text();
  } catch { return ""; }
}

// A URL is "article-ish" if it lives on the target host and its path looks like a content
// permalink rather than a nav/taxonomy/asset/hub page. Loose on purpose (a site campaign
// wants breadth); the person-name filter downstream is the real gate.
const NON_ARTICLE_SEGMENTS = new Set([
  "tag", "tags", "category", "categories", "topic", "topics", "author", "authors",
  "page", "search", "feed", "rss", "amp", "wp-content", "wp-admin", "wp-json", "sitemap",
  "about", "contact", "privacy", "terms", "login", "signup", "register", "cart",
  "product", "products", "pricing", "shop", "account", "cdn-cgi", "assets", "static",
]);
// Two-letter or aa-bb locale codes ("fr", "es-es", "hk-en") — first-segment noise on
// multi-locale marketing sites; a single locale token is never an article slug.
const LOCALE_SEG = /^[a-z]{2}(-[a-z]{2})?$/;

function isArticleishPath(pathname: string): boolean {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length === 0) return false;                 // homepage
  if (segs.some((s) => NON_ARTICLE_SEGMENTS.has(s.toLowerCase()))) return false;
  const last = segs[segs.length - 1].toLowerCase();
  if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|css|js|xml|ico|mp4|mp3)$/.test(last)) return false;
  if (LOCALE_SEG.test(last)) return false;             // ".../es-es" locale root, not an article
  // A permalink slug almost always has a dash or is reasonably long; a single short token
  // ("/blog") is a section root. Also require the slug not be a bare locale.
  const looksLikeSlug = (last.includes("-") || last.length >= 12 || segs.length >= 2) && !LOCALE_SEG.test(last);
  return looksLikeSlug;
}

// Author/topic/category "hub" pages that LIST a writer's posts. Matched so we can expand them.
const HUB_RE = /\/(authors?|contributors?|topics?|tags?|category|categories)\/[a-z0-9][a-z0-9-]{1,60}\/?$/i;
const AUTHOR_HUB_RE = /\/(authors?|contributors?)\//i;
// An editorial path — used to gate SITEMAP and HUB-expansion URLs, whose sources also list
// heaps of non-article marketing pages (a site's top sitemap has /accessibility, /affiliates,
// /pricing…). WP/RSS/section-crawl are already blog-scoped, so they don't need this gate.
const EDITORIAL_RE = /\/(blog|news|article|articles|post|posts|story|stories|insight|insights|guide|guides|resource|resources|learn|academy|magazine|read)\//i;

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim()).filter(Boolean);
}

function sameHost(u: string, host: string): boolean {
  try { return new URL(u).hostname.replace(/^www\./, "") === host; } catch { return false; }
}

function extractArticleLinks(html: string, host: string): { articles: string[]; hubs: string[] } {
  const articles = new Set<string>();
  const hubs = new Set<string>();
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let href = m[1].trim();
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
    try {
      const u = new URL(href, `https://${host}`);
      if (u.hostname.replace(/^www\./, "") !== host) continue;
      u.hash = ""; u.search = "";
      const s = u.toString();
      if (HUB_RE.test(u.pathname)) hubs.add(s);
      else if (isArticleishPath(u.pathname)) articles.add(s);
    } catch { /* skip malformed */ }
  }
  return { articles: [...articles], hubs: [...hubs] };
}

async function wpPostUrls(host: string, signal?: AbortSignal): Promise<string[]> {
  const urls: string[] = [];
  for (let page = 1; page <= 2; page++) {
    try {
      const res = await fetch(
        `https://${host}/wp-json/wp/v2/posts?per_page=100&page=${page}&_fields=link&orderby=date&order=desc`,
        { headers: { "User-Agent": UA, Accept: "application/json" }, signal: signal ?? AbortSignal.timeout(12_000) }
      );
      if (!res.ok) break;
      const data = (await res.json().catch(() => [])) as Array<{ link?: string }>;
      if (!Array.isArray(data) || data.length === 0) break;
      for (const p of data) if (p?.link) urls.push(p.link);
      if (data.length < 100) break;
    } catch { break; }
  }
  return urls;
}

// robots.txt "Sitemap:" lines + the usual well-known names.
async function sitemapRoots(host: string, signal?: AbortSignal): Promise<string[]> {
  const roots = new Set<string>();
  const robots = await fetchText(`https://${host}/robots.txt`, signal, 8_000);
  for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
    const u = m[1].trim();
    if (sameHost(u, host)) roots.add(u);
  }
  for (const name of ["sitemap.xml", "sitemap_index.xml", "sitemaps_list.xml", "sitemap-index.xml"]) {
    roots.add(`https://${host}/${name}`);
  }
  return [...roots].slice(0, MAX_TOP_SITEMAPS);
}

// Keep only default-locale child sitemaps that look editorial (blog/news/author/post) and
// aren't locale-prefixed — so a 50-locale site contributes its English blog, not 50 copies.
function keepChildSitemap(url: string): boolean {
  let path = "";
  try { path = new URL(url).pathname.toLowerCase(); } catch { return false; }
  if (!path.endsWith(".xml")) return false;
  const first = path.split("/").filter(Boolean)[0] ?? "";
  if (LOCALE_SEG.test(first)) return false;                 // /fr/..., /es-es/... → skip locale copies
  return /blog|news|article|post|author|insight|resource|learn|guide/.test(path);
}

export interface SiteHarvestResult {
  urls: string[];
  breakdown: { wp: number; rss: number; sitemap: number; hub: number; crawl: number; seedUrl: number };
}

// Discover article URLs for one seed (a bare domain or a specific article/section URL).
export async function discoverSiteArticleUrls(
  seed: string,
  cap = 200,
  signal?: AbortSignal,
): Promise<SiteHarvestResult> {
  const host = toHost(seed);
  const isFullUrl = /^https?:\/\//.test(seed.trim());
  // Per-source buckets, composed by priority at the end (rather than racing every source into
  // one running-capped set — that let a giant marketing sitemap starve the high-value hub
  // expansion). Hub-expanded author posts map to DISTINCT writers, so they rank first.
  const seedUrls: string[] = [];
  const wpUrls: string[] = [];
  const rssUrls: string[] = [];
  const sitemapUrls: string[] = [];
  const crawlUrls: string[] = [];
  const hubUrls: string[] = [];
  const hubs = new Set<string>();
  const MAX_SITEMAP_ARTICLES = 1500; // bound on how many sitemap locs we retain as articles

  if (isFullUrl) {
    try { const u = new URL(seed.trim()); u.hash = ""; seedUrls.push(u.toString()); } catch {}
  }

  // Angles 1 + 2 (WP REST, RSS/shallow-sitemap) run concurrently.
  const [wp, rss] = await Promise.all([
    wpPostUrls(host, signal).catch(() => [] as string[]),
    rssHarvester.run("", { domains: [host] }).then((h) => h.map((x) => x.url)).catch(() => [] as string[]),
  ]);
  for (const u of wp) if (sameHost(u, host)) wpUrls.push(u);
  for (const u of rss) if (sameHost(u, host)) rssUrls.push(u);

  const classify = (loc: string) => {
    if (!sameHost(loc, host)) return;
    let p = ""; try { p = new URL(loc).pathname; } catch { return; }
    if (HUB_RE.test(p)) hubs.add(loc);
    else if (EDITORIAL_RE.test(loc) && isArticleishPath(p) && sitemapUrls.length < MAX_SITEMAP_ARTICLES) sitemapUrls.push(loc);
  };

  // Angle 3 — sitemap index traversal (one level deep).
  const roots = await sitemapRoots(host, signal).catch(() => [] as string[]);
  const childSitemaps: string[] = [];
  for (const root of roots) {
    if (signal?.aborted) break;
    const xml = await fetchText(root, signal);
    if (!xml) continue;
    const locs = extractLocs(xml);
    const isIndex = /<sitemapindex/i.test(xml) || (locs.length > 0 && locs.every((l) => l.toLowerCase().endsWith(".xml")));
    if (isIndex) { for (const child of locs) if (keepChildSitemap(child)) childSitemaps.push(child); }
    else for (const loc of locs) classify(loc);
  }
  for (const child of [...new Set(childSitemaps)].slice(0, MAX_CHILD_SITEMAPS)) {
    if (signal?.aborted) break;
    const xml = await fetchText(child, signal);
    if (!xml) continue;
    for (const loc of extractLocs(xml)) classify(loc);
  }

  // Angle 5 — rendered section crawl (homepage, blog/section roots, seed URL). Also feeds hubs.
  const crawlTargets = new Set<string>([`https://${host}/`, `https://${host}/blog`, `https://${host}/blog/`]);
  if (isFullUrl) {
    try {
      const u = new URL(seed.trim());
      crawlTargets.add(u.toString());
      const firstSeg = u.pathname.split("/").filter(Boolean)[0];
      if (firstSeg) crawlTargets.add(`https://${host}/${firstSeg}`);
    } catch {}
  }
  for (const target of crawlTargets) {
    if (signal?.aborted) break;
    try {
      const page = await fetchPage(target, signal);
      if (!page?.html) continue;
      const { articles, hubs: h } = extractArticleLinks(page.html, host);
      for (const u of articles) crawlUrls.push(u);
      for (const u of h) hubs.add(u);
    } catch { /* best-effort per section */ }
  }

  // Angle 4 — hub expansion (always runs, never starved). Prioritize AUTHOR hubs (each yields a
  // distinct writer), take a couple posts each to maximize distinct-author coverage. Bounded.
  const hubList = [...hubs].sort((a, b) => (AUTHOR_HUB_RE.test(b) ? 1 : 0) - (AUTHOR_HUB_RE.test(a) ? 1 : 0)).slice(0, MAX_HUBS);
  for (let i = 0; i < hubList.length; i += HUB_CONCURRENCY) {
    if (signal?.aborted) break;
    const batch = hubList.slice(i, i + HUB_CONCURRENCY);
    await Promise.all(batch.map(async (hub) => {
      const html = await fetchText(hub, signal);
      if (!html) return;
      const { articles } = extractArticleLinks(html, host);
      // Editorial-only: an author page's chrome also links to /pricing, /careers, etc.
      const editorial = articles.filter((u) => EDITORIAL_RE.test(u));
      const take = AUTHOR_HUB_RE.test(hub) ? POSTS_PER_AUTHOR_HUB : POSTS_PER_OTHER_HUB;
      for (const u of editorial.slice(0, take)) hubUrls.push(u);
    }));
  }

  // Compose by priority, deduped, capped. Hub-expanded author posts first (distinct writers),
  // then clean feed sources, then the broad sitemap/crawl fill.
  const out = new Set<string>();
  const breakdown = { wp: 0, rss: 0, sitemap: 0, hub: 0, crawl: 0, seedUrl: 0 };
  const drain = (list: string[], key: keyof typeof breakdown) => {
    for (const u of list) {
      if (out.size >= cap) break;
      const before = out.size; out.add(u); if (out.size > before) breakdown[key]++;
    }
  };
  drain(seedUrls, "seedUrl");
  drain(hubUrls, "hub");
  drain(wpUrls, "wp");
  drain(rssUrls, "rss");
  drain(sitemapUrls, "sitemap");
  drain(crawlUrls, "crawl");

  return { urls: [...out], breakdown };
}
