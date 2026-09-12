// Daily broken-link audit for imagine.art. Crawls every page in the sitemap, reads every
// link on every page, and flags links that are dead — hard 404/410s, "soft" 404s (pages
// that return 200 but are really a not-found page), and deep links that now redirect to a
// homepage. Soft-404s are detected per host + first path segment by probing a garbage URL
// with the same shape and comparing signatures (imagine.art itself returns 200 for any
// /blogs/* slug, so this matters even for internal links).
//
// Long-job shape mirrors the discovery pipeline: chunked with a time budget on Vercel,
// state in Redis, auto-continued via QStash, results in Postgres for the /link-audit page,
// and a Slack digest posted when the run completes.
import PQueue from "p-queue";
import { supabaseAdmin } from "@/lib/db/supabase";
import { redis } from "@/lib/redis";
import { qstashPublish, isServerless } from "@/lib/qstash";
import { getIgnoredLinks } from "@/lib/linkaudit/ignore";
import { llmChat, llmEnabled } from "@/lib/providers/llm";
import { isGscConfigured, searchAnalytics, daysAgo } from "@/lib/indexing/gsc";

const SITEMAP_URL = "https://www.imagine.art/sitemap.xml";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const MAX_PAGES = 3000; // sitemap holds ~1,500 today; headroom so growth never silently truncates the crawl
const MAX_LINKS_PER_PAGE = 300;
const MAX_PAGES_PER_BROKEN_LINK = 5; // cap finding rows for a link broken site-wide (nav/footer)
const CHUNK_BUDGET_MS = isServerless() ? 210_000 : Infinity;
const LINK_CONCURRENCY = 8;

const STATE_KEY = "linkaudit:state";
const CHECKED_KEY = "linkaudit:checked";
const FP_KEY = "linkaudit:fp";
const STOP_KEY = "linkaudit:stop";
const LINKED_KEY = "linkaudit:linked"; // internal pages some crawled page links TO — feeds orphan detection

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface AuditState {
  runId: string;
  pages: string[];
  index: number;
  authorMap: Record<string, string>; // page path -> author name (harvested from blog cards)
  linksChecked: number;
  broken: number;
  unreachable: number;
  log: string[]; // rolling verbose progress lines for the /link-audit page
  startedAt: number;
  updatedAt: number;
  /** How many of `pages` came from the sitemap; everything past that was spider-discovered. */
  sitemapCount?: number;
  /** Internal pages found via links but absent from the sitemap, appended to the crawl. */
  discovered?: number;
}

const MAX_LOG_LINES = 120;
function pushLog(state: AuditState, line: string) {
  state.log ??= []; // states saved before this field existed
  state.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES);
}

// verdict: ok | 404 | 410 | soft | home | unreach ; count = pages seen on (for the cap)
interface CheckedMap { [urlKey: string]: { v: string; s?: number; n: number } }

interface Fingerprint { status: number; title: string; h1: string; len: number; usable: boolean }
// Exported so the pre-publish link check (lib/blog/linkCheck.ts) can hold one cache across a
// whole draft, the same way the audit holds one across a whole crawl.
export interface FingerprintMap { [hostPrefix: string]: Fingerprint }

export interface LinkOccurrence { anchor: string; zone: string; heading: string | null }
export interface ExtractedLink { url: string; anchor: string; context: string; occurrences: LinkOccurrence[] }

// Which structural landmark encloses position i? Regex-level check: an opening tag more
// recent than its closing tag means we're inside it.
function zoneAt(html: string, i: number): string {
  for (const tag of ["nav", "header", "footer", "aside"]) {
    const lo = html.lastIndexOf(`<${tag}`, i);
    const lc = html.lastIndexOf(`</${tag}`, i);
    if (lo > lc) return tag;
  }
  return "main";
}

const HEADING_RE = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g;
function nearestHeadingAbove(html: string, i: number): string | null {
  let last: string | null = null;
  HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(html)) !== null) {
    if (m.index >= i) break;
    const t = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (t) last = t.slice(0, 70);
  }
  return last;
}

const ZONE_PHRASE: Record<string, string> = {
  nav: "in the top navigation bar", header: "in the page header",
  footer: "in the page footer", aside: "in a sidebar",
  head: "in the page's social-share metadata (og:image)",
};

// Human sentence built from real DOM landmarks — accurate by construction, no AI guessing.
export function describeOccurrences(occ: LinkOccurrence[]): string | null {
  if (occ.length === 0) return null;
  const parts = occ.slice(0, 3).map((o) => {
    const what = o.anchor ? `the "${o.anchor.slice(0, 50)}" link` : "an icon/image link";
    const where = ZONE_PHRASE[o.zone] ?? (o.heading ? `in the "${o.heading}" section` : "in the main content");
    return `${what} ${where}`;
  });
  const extra = occ.length > 3 ? `; +${occ.length - 3} more spots` : "";
  return `${parts.join("; also ")}${extra}${occ.length > 1 ? ` (${occ.length} places on this page)` : ""}`;
}

// ─── Fetch helpers ─────────────────────────────────────────────────────────────

// Exported so the retired-URL sweep (lib/urlsweep/run.ts) fetches pages exactly the way the audit
// does — same UA, same redirect policy. A second crawler with its own slightly different fetch is
// how two crawls of one site start disagreeing about what is on it.
export async function fetchRaw(url: string, timeoutMs = 12_000): Promise<{ status: number; finalUrl: string; html: string } | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ct = res.headers.get("content-type") ?? "";
    const html = ct.includes("text") || ct.includes("xml") || ct.includes("json") ? await res.text() : "";
    return { status: res.status, finalUrl: res.url, html };
  } catch (e: any) {
    return { error: e?.message ?? "fetch failed" };
  }
}

// ─── Sitemap ───────────────────────────────────────────────────────────────────

// robots.txt is the authoritative registry of a site's sitemaps — assuming /sitemap.xml is
// the only one silently misses any extra sitemap the site declares (a video sitemap, a blog
// sitemap at another path). Returns the absolute Sitemap: URLs, [] on any failure.
export async function discoverRobotsSitemaps(origin: string): Promise<string[]> {
  const res = await fetchRaw(`${origin.replace(/\/$/, "")}/robots.txt`, 10_000);
  if ("error" in res || res.status !== 200) return [];
  const out: string[] = [];
  for (const m of res.html.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
    try { out.push(new URL(m[1]).href); } catch { /* malformed line — skip */ }
  }
  return [...new Set(out)];
}

export async function fetchSitemapUrls(sitemapUrl = SITEMAP_URL): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [sitemapUrl];
  // Every sitemap robots.txt declares joins the queue — coverage starts with finding ALL the maps.
  try {
    const declared = await discoverRobotsSitemaps(new URL(sitemapUrl).origin);
    for (const u of declared) if (u !== sitemapUrl) queue.push(u);
  } catch { /* robots discovery is additive — its absence never blocks the default */ }
  while (queue.length > 0 && seen.size < MAX_PAGES) {
    const sm = queue.shift()!;
    const res = await fetchRaw(sm, 20_000);
    if ("error" in res || res.status !== 200) continue;
    const locs = [...res.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    // A sitemap index nests more sitemaps; a urlset lists pages.
    if (/<sitemapindex/i.test(res.html)) queue.push(...locs.slice(0, 50));
    else for (const u of locs) { if (seen.size < MAX_PAGES) seen.add(u); }
  }
  return [...seen];
}

// ─── Link + author extraction ──────────────────────────────────────────────────

const SKIP_HREF = /^(#|mailto:|tel:|javascript:|data:|blob:)/i;

export function extractLinks(html: string, pageUrl: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const byUrl = new Map<string, ExtractedLink>();
  const re = /<a\s[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < MAX_LINKS_PER_PAGE) {
    const href = m[1].trim();
    if (!href || SKIP_HREF.test(href)) continue;
    let abs: URL;
    try { abs = new URL(href, pageUrl); } catch { continue; }
    if (!/^https?:$/.test(abs.protocol)) continue;
    abs.hash = "";
    const url = abs.href;
    if (url === pageUrl) continue;

    const anchor = m[2].replace(/<[^>]+>/g, " ").replace(/\\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    // A repeated URL (nav + button + footer) keeps ONE entry but records every occurrence's
    // structural location, so "where is this link" covers all the places it appears.
    const existing = byUrl.get(url);
    if (existing) {
      if (existing.occurrences.length < 4) {
        existing.occurrences.push({ anchor, zone: zoneAt(html, m.index), heading: nearestHeadingAbove(html, m.index) });
      }
      continue;
    }
    // Surrounding text: strip tags in a window around the match so the digest can show
    // WHERE on the page the link lives. The slice can split a tag OR a <script> block at
    // either edge — trim half-open tags, drop partial script bodies, and if what's left
    // still reads like JavaScript, drop the context entirely (better nothing than JS soup).
    const winStart = Math.max(0, m.index - 400);
    let win = html.slice(winStart, m.index + m[0].length + 400);
    const firstGt = win.indexOf(">");
    if (firstGt !== -1 && firstGt < win.indexOf("<")) win = win.slice(firstGt + 1);
    const lastLt = win.lastIndexOf("<");
    if (lastLt > win.lastIndexOf(">")) win = win.slice(0, lastLt);
    win = win.replace(/<script[\s\S]*?<\/script>/gi, " ");
    const closeScript = win.search(/<\/script/i);
    const openScript = win.search(/<script/i);
    if (closeScript !== -1 && (openScript === -1 || openScript > closeScript)) win = win.slice(closeScript + 9); // window started mid-script
    if (openScript !== -1 && win.slice(openScript).search(/<\/script/i) === -1) win = win.slice(0, Math.max(openScript, 0)); // window ends mid-script
    let context = win.replace(/<[^>]+>/g, " ").replace(/\\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
    if (/function\s*\(|document\.getElementById|window\.addEventListener|classList\.|appendChild|=>\s*\{|\bvar\s+\w+\s*=/.test(context)) context = "";
    const entry: ExtractedLink = {
      url, anchor, context,
      occurrences: [{ anchor, zone: zoneAt(html, m.index), heading: nearestHeadingAbove(html, m.index) }],
    };
    byUrl.set(url, entry);
    out.push(entry);
  }
  return out;
}

// og:image / twitter:image URLs are links too — a share-card image that errors (the live case:
// /c/*/og-image returning 500s) breaks every social preview of the page, and no <a href> scan
// can see it because it lives in a <meta> tag in the <head>. Extracted here and pushed through
// the same verdict engine as anchors, so a dead one surfaces as an ordinary finding.
export function extractMetaAssets(html: string, pageUrl: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const seen = new Set<string>();
  // Both attribute orders appear in the wild: property-then-content and content-then-property.
  const re = /<meta\s[^>]*?(?:property|name)=["'](og:image|og:image:url|twitter:image)["'][^>]*?content=["']([^"']+)["'][^>]*>|<meta\s[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["'](og:image|og:image:url|twitter:image)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 3) {
    const tag = (m[1] ?? m[4] ?? "og:image").toLowerCase();
    const raw = (m[2] ?? m[3] ?? "").trim();
    if (!raw) continue;
    let abs: URL;
    try { abs = new URL(raw, pageUrl); } catch { continue; }
    if (!/^https?:$/.test(abs.protocol)) continue;
    abs.hash = "";
    if (seen.has(abs.href)) continue;
    seen.add(abs.href);
    const anchor = `${tag} meta tag`;
    out.push({ url: abs.href, anchor, context: "", occurrences: [{ anchor, zone: "head", heading: null }] });
  }
  return out;
}

// imagine.art's blog cards pair each post's URL with its author (avatar img + name <p>).
// Harvesting every card across the crawl builds a URL→author map for the whole blog —
// more reliable than per-page meta, which these pages don't ship.
export function harvestCardAuthors(html: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /<a\s[^>]*?href="(\/blogs\/[^"?#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const block = m[2];
    if (!/img[^>]+src="[^"]*author/i.test(block)) continue;
    const ps = [...block.matchAll(/<p[^>]*>([^<]{2,50})<\/p>/g)].map((x) => x[1].trim());
    const name = ps.reverse().find((p) => /^[A-Za-zÀ-ž'’.-]+(\s+[A-Za-zÀ-ž'’.-]+){1,3}$/.test(p));
    if (name) map[m[1].replace(/\/$/, "")] = name;
  }
  return map;
}

// The page's OWN author. imagine.art blog posts don't ship meta authors, but they render
// two reliable byline patterns: an author-bio box (<h3>Name</h3><p>Name is a …</p>) and a
// byline strip whose avatar <img alt="Name"> is followed by a <p>Name</p> with the same
// text. Falls back to standard meta/JSON-LD author for anything else.
export function extractPageAuthor(html: string): string | null {
  const NAME = "[A-Za-zÀ-ž'’.-]+(?:\\s+[A-Za-zÀ-ž'’.-]+){1,3}";
  // Author-bio box: heading followed by a bio that restates the name ("Tooba Siddiqui is a…")
  const bio = html.match(new RegExp(`<h3[^>]*>(${NAME})</h3>\\s*<p[^>]*>\\1\\s+is\\s`, ""));
  if (bio) return bio[1].trim();
  // Byline strip: avatar alt text and the adjacent <p> agree on the name
  const byline = html.match(new RegExp(`<img[^>]+alt="(${NAME})"[^>]*>(?:(?!<img)[\\s\\S]){0,300}?<p[^>]*>\\1</p>`, ""));
  if (byline) return byline[1].trim();
  const meta = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']{2,60})["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']{2,60})["'][^>]+name=["']author["']/i);
  if (meta) return meta[1].trim();
  const ld = html.match(/"author"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]{2,60})"/);
  return ld ? ld[1].trim() : null;
}

// ─── Smart 404 detection ───────────────────────────────────────────────────────

function titleOf(html: string): string {
  return (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}
function h1Of(html: string): string {
  return (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
const NOT_FOUND_RE = /(^|\W)(404|page not found|not found|page doesn'?t exist|no longer (exists|available)|page (is )?missing)(\W|$)/i;

function fpKeyFor(u: URL): string {
  const seg = u.pathname.split("/").filter(Boolean)[0] ?? "";
  return `${u.hostname}|${seg}`;
}

// Bot-walled platforms serve the same interstitial (login/consent/verification wall) for
// every URL, real or dead — soft-404 detection is impossible without a browser, so a 200
// from these counts as alive. Hard 404s (e.g. a deleted YouTube channel) still register.
const SOCIAL_SKIP = new Set([
  "reddit.com", "instagram.com", "facebook.com", "x.com", "twitter.com", "linkedin.com",
  "tiktok.com", "youtube.com", "threads.net", "discord.com", "discord.gg", "pinterest.com", "medium.com",
]);
function isSocialSkip(host: string): boolean {
  const bare = host.replace(/^www\./, "");
  return SOCIAL_SKIP.has(bare) || [...SOCIAL_SKIP].some((d) => bare.endsWith(`.${d}`));
}

// Probe a garbage URL with the same host + first path segment and record its signature.
// Sites with honest 404s return 404 here; soft-404 sites return their not-found page.
// CRITICAL: some sites catch-all unknown sub-paths by serving the SEGMENT ROOT's own
// content (imagine.art/video/garbage returns the /video page) — there, probe equality
// would flag LIVE pages as dead. So a 200 probe is only "usable" if it differs from the
// segment root; a catch-all echo is marked unusable and 200s under it count as alive.
async function getFingerprint(u: URL, cache: FingerprintMap): Promise<Fingerprint | null> {
  const key = fpKeyFor(u);
  if (cache[key]) return cache[key];
  const seg = u.pathname.split("/").filter(Boolean)[0];
  const probePath = `${seg ? `/${seg}` : ""}/la-probe-${Date.now().toString(36)}-definitely-missing`;
  const res = await fetchRaw(`${u.protocol}//${u.host}${probePath}`, 10_000);
  if ("error" in res) return null;
  const fp: Fingerprint = { status: res.status, title: titleOf(res.html), h1: h1Of(res.html), len: res.html.length, usable: false };
  if (res.status === 200) {
    const root = await fetchRaw(`${u.protocol}//${u.host}${seg ? `/${seg}` : "/"}`, 10_000);
    if (!("error" in root) && root.status === 200) {
      const sameTitle = titleOf(root.html) === fp.title;
      const sameLen = Math.abs(root.html.length - fp.len) / Math.max(root.html.length, fp.len, 1) < 0.05;
      fp.usable = !(sameTitle && sameLen); // probe == root → catch-all echo → unusable
    }
  }
  cache[key] = fp;
  return fp;
}

// AI fallback for author detection: only fires when the deterministic byline patterns miss
// on a blog page (never on product pages), and only sees the byline-likely slices of the
// page (top of article + the end where author-bio boxes live), not the whole 1MB+ HTML.
export async function aiExtractAuthor(html: string): Promise<string | null> {
  // Cheap bail before the ~1MB tag-strip below, so a keyless env costs nothing on 700+ pages.
  if (!llmEnabled()) return null;
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 200) return null;
  const slice = `${text.slice(0, 3500)}\n…\n${text.slice(-3500)}`;
  // No `temperature` (was 0): the frontier models 400 on any sampling param, and a 400 here is
  // indistinguishable from "no byline found" — every page would silently lose its author.
  // Determinism is gone as a result; the name regex below is what keeps the output trustworthy.
  // No `maxTokens` either (was 20): on a reasoning model that budget is spent on thinking and the
  // answer comes back empty. The helper's frontier default is deliberately generous — the reply is
  // still one name, so we pay for output we don't use only in the pathological case.
  // Bounded on purpose. This runs once per blog page, serially, inside the ~210s QStash chunk
  // budget — so the helper's 90s frontier ceiling is the wrong bound here: three slow turns would
  // eat an entire chunk and stall the crawl. `hardTimeout` opts out of the floor and says "a lost
  // byline is cheaper than a stalled audit". Losing it is already a supported outcome: the
  // deterministic extractPageAuthor runs first, and null here just means no author on the finding.
  const r = await llmChat({
    prompt: `Below is text from the top and bottom of a blog article page. Who is the article's AUTHOR (the byline of THIS article — not names merely mentioned in the content, not related-article authors)? Reply with ONLY the author's full name, or NONE if no byline is present.\n\n${slice}`,
    timeoutMs: 25_000,
    hardTimeout: true,
  });
  if (!r) return null;
  const out = r.content.trim();
  if (!out || /^none$/i.test(out)) return null;
  return /^[A-Za-zÀ-ž'’.-]+(\s+[A-Za-zÀ-ž'’.-]+){1,3}$/.test(out) ? out : null;
}

// ─── Stop flag (durable — works across serverless instances & QStash chunks) ──────

export async function requestAuditStop(): Promise<void> {
  const r = redis();
  if (r) await r.set(STOP_KEY, "1", { ex: 3600 }).catch(() => {});
}
async function isAuditStopRequested(): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  return !!(await r.get(STOP_KEY).catch(() => null));
}
async function clearAuditStop(): Promise<void> {
  const r = redis();
  if (r) await r.del(STOP_KEY).catch(() => {});
}

export interface LinkVerdict {
  verdict: "ok" | "404" | "410" | "soft" | "home" | "server-error" | "unreach";
  status?: number;
  /** Redirect hygiene (first-party links only, opt-in via traceCache): the link works, but got there through redirects. */
  redirect?: { hops: number; statuses: number[]; chain: string[] };
}

export interface RedirectTrace { hops: Array<{ status: number; to: string }>; finalUrl: string }
export type RedirectTraceMap = Map<string, RedirectTrace | null>;

// Traces per crawl are capped: each trace re-fetches every hop, and redirect hygiene is a
// P2 report, not something worth spending the chunk budget on past the first hundred cases.
const MAX_REDIRECT_TRACES = 100;

// fetchRaw follows redirects silently, so a chain crawlers abandon (>2 hops) and a 302 that
// passes no authority both look identical to a direct 200. This walks the redirects hop by
// hop with redirect:"manual" to see what actually happened. Bodies are cancelled unread —
// only the status and Location header matter.
export async function traceRedirects(url: string, maxHops = 6): Promise<RedirectTrace | null> {
  const hops: Array<{ status: number; to: string }> = [];
  let cur = url;
  for (let i = 0; i <= maxHops; i++) {
    let res: Response;
    try {
      res = await fetch(cur, {
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch { return null; }
    try { await res.body?.cancel(); } catch { /* body already gone */ }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { hops, finalUrl: cur };
      let next: string;
      try { next = new URL(loc, cur).href; } catch { return { hops, finalUrl: cur }; }
      hops.push({ status: res.status, to: next });
      cur = next;
      continue;
    }
    return { hops, finalUrl: cur };
  }
  return { hops, finalUrl: cur };
}

// Human one-liner for a redirect-hygiene finding — paths only, statuses inline.
export function describeRedirect(info: NonNullable<LinkVerdict["redirect"]>): string {
  const path = (s: string) => { try { const u = new URL(s); return u.pathname || "/"; } catch { return s; } };
  return `${info.hops} redirect hop${info.hops === 1 ? "" : "s"} (HTTP ${info.statuses.join(" → ")}): ${info.chain.map(path).join(" → ")}`.slice(0, 300);
}

// ─── Spider mode + coverage ────────────────────────────────────────────────────────────────
//
// The sitemap is a SEED, not the universe. A page that exists and is linked but is missing
// from the sitemap used to get its inbound link verified and nothing more — its own links
// were never crawled, a structural hole in "check everything". Spider mode appends every
// qualifying same-host discovery to the crawl queue, and the coverage report turns "we
// covered everything" from an assumption into numbers: what the sitemap gave, what links
// revealed beyond it, what the sitemap lists that nothing links to (orphans), and what
// Google knows that neither could reach.

// One canonical URL form for all set membership here: hash off, query kept out by the
// candidate filter, trailing slashes collapsed — /pricing and /pricing/ are one page.
// Exported for the JS-links detector, whose raw-vs-rendered diff must use the SAME form —
// two normalizers is how a formatting difference gets reported as a hidden link.
export function normalizeUrl(s: string): string {
  try {
    const u = new URL(s);
    u.hash = "";
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch { return s.replace(/\/+$/, ""); }
}

const ASSET_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|json|xml|txt|pdf|zip|gz|mp3|mp4|webm|mov|woff2?|ttf|eot)$/i;

// Is this link a PAGE we should crawl? Same host as the audit (www-insensitive), http(s),
// no query string (parameter URLs multiply without adding pages — roadmap's crawl-budget
// trap), not a file asset. Returns the normalized URL, or null.
export function spiderCandidate(url: string, host: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.host.replace(/^www\./, "") !== host.replace(/^www\./, "")) return null;
  if (u.search) return null;
  if (ASSET_EXT_RE.test(u.pathname)) return null;
  u.hash = "";
  return normalizeUrl(u.href);
}

export interface CoverageReport {
  sitemap: number;        // pages the sitemap(s) listed
  discovered: number;     // pages found only by following links
  orphans: number;        // sitemap pages no internal link points at
  orphanSample: string[];
  gscUnreached: number;   // pages Google knows that neither sitemap nor links reached
  gscSample: string[];
}

// Pure set arithmetic — exported so the E2E suite can prove the math without a database.
export function coverageOf(sitemapCount: number, pages: string[], linked: Set<string>, gscUrls: string[] = []): CoverageReport {
  const known = new Set(pages.map(normalizeUrl));
  const orphans = pages.slice(0, sitemapCount).filter((p) => {
    let isRoot = false;
    try { isRoot = new URL(p).pathname.replace(/\/+$/, "") === ""; } catch { /* not a URL — not root */ }
    return !isRoot && !linked.has(normalizeUrl(p)); // the homepage needs no inbound link
  });
  const unreached = [...new Set(gscUrls.map(normalizeUrl))].filter((u) => !known.has(u));
  return {
    sitemap: sitemapCount,
    discovered: Math.max(0, pages.length - sitemapCount),
    orphans: orphans.length, orphanSample: orphans.slice(0, 10),
    gscUnreached: unreached.length, gscSample: unreached.slice(0, 10),
  };
}

// First-party = imagine.art and any subdomain (app./shorts./ideate./www.). A 5xx here is OUR
// outage, not a third-party bot-block, so it's worth flagging as broken rather than "unverified".
function isFirstParty(host: string): boolean {
  const h = host.replace(/^www\./, "").toLowerCase();
  return h === "imagine.art" || h.endsWith(".imagine.art");
}

// Tweet-embed plumbing: t.co / pic.twitter.com URLs 404 to bots but are rendered by
// Twitter's embed script in a real browser (the tweet/video plays fine). Never report.
const TWEET_EMBED_HOSTS = new Set(["t.co", "pic.twitter.com", "pic.x.com", "platform.twitter.com"]);

export async function checkLink(url: string, fpCache: FingerprintMap, traceCache?: RedirectTraceMap): Promise<LinkVerdict> {
  let u: URL;
  try { u = new URL(url); } catch { return { verdict: "unreach" }; }
  if (TWEET_EMBED_HOSTS.has(u.hostname.replace(/^www\./, ""))) return { verdict: "ok" };

  const res = await fetchRaw(url);
  if ("error" in res) return { verdict: "unreach" };
  if (res.status === 404 || res.status === 410) {
    // Some SPAs answer 404 while shipping their full working app (app.pixverse.ai/onboard
    // does this) — the browser "recovers" to a normal page and a human sees nothing broken.
    // Only report a 404/410 whose BODY also looks like an error page: tiny, titleless, or
    // not-found wording in title/h1. Healthy-shell 404s count as unverifiable instead.
    // Tradeoff: a branded 404 page with no "404/not found" wording in title or h1 slips
    // through — accepted, since falsely pinging writers is worse than a rare miss.
    const t = titleOf(res.html);
    const h = h1Of(res.html);
    const looksLikeErrorPage = res.html.length < 2048 || !t || NOT_FOUND_RE.test(t) || NOT_FOUND_RE.test(h);
    if (looksLikeErrorPage) return { verdict: res.status === 404 ? "404" : "410", status: res.status };
    return { verdict: "unreach", status: res.status };
  }
  // A 5xx on our OWN domain is a real outage-level problem (e.g. /apps/* returning 500) — flag
  // it as broken. Third-party 5xx/403 stay "unverified" (usually bot-blocks, false-positive risk).
  if (res.status >= 500 && isFirstParty(u.hostname)) return { verdict: "server-error", status: res.status };
  // Bot-blocks, rate limits, third-party server errors: NOT reported as broken.
  if (res.status !== 200) return { verdict: "unreach", status: res.status };

  // Deep link that now lands on a homepage — dead for citation purposes.
  try {
    const fin = new URL(res.finalUrl);
    const hadPath = u.pathname.replace(/\/$/, "").length > 0;
    const finRoot = fin.pathname.replace(/\/$/, "").length === 0;
    if (hadPath && finRoot) return { verdict: "home", status: 200 };
  } catch { /* keep going */ }

  const title = titleOf(res.html);
  const h1 = h1Of(res.html);
  if (NOT_FOUND_RE.test(title) || NOT_FOUND_RE.test(h1)) return { verdict: "soft", status: 200 };

  // Redirect hygiene (first-party only, and only when the caller opted in with a traceCache):
  // the link is alive, but if it got here through redirects the chain itself may be the
  // problem — >2 hops get abandoned by crawlers, 302s pass no authority. Traced hop by hop,
  // cached per URL, capped per crawl.
  let redirect: LinkVerdict["redirect"];
  if (traceCache && isFirstParty(u.hostname)) {
    const strip = (s: string) => s.replace(/\/$/, "");
    if (strip(res.finalUrl) !== strip(url)) {
      let trace = traceCache.get(url);
      if (trace === undefined && traceCache.size < MAX_REDIRECT_TRACES) {
        trace = await traceRedirects(url);
        traceCache.set(url, trace);
      }
      if (trace && trace.hops.length > 0) {
        redirect = { hops: trace.hops.length, statuses: trace.hops.map((h) => h.status), chain: [url, ...trace.hops.map((h) => h.to)] };
      }
    }
  }

  // Bot-walled platforms: a 200 can't be inspected further — count as alive.
  if (isSocialSkip(u.hostname)) return { verdict: "ok", status: 200, redirect };

  // Fingerprint comparison for soft-404 domains — only when the probe produced a genuine
  // distinct not-found page (usable), never against a catch-all echo of a live page.
  const fp = await getFingerprint(u, fpCache);
  if (fp && fp.status === 200 && fp.usable) {
    if (title && title === fp.title) return { verdict: "soft", status: 200 };
    if (!title && !fp.title) {
      if (h1 && h1 === fp.h1) return { verdict: "soft", status: 200 };
      // Both signatures empty (JS-shell pages): only a near-byte-identical match to the
      // known not-found page is damning enough — 2%, not 10%.
      if (!h1 && !fp.h1 && Math.abs(res.html.length - fp.len) / Math.max(res.html.length, fp.len, 1) < 0.02) {
        return { verdict: "soft", status: 200 };
      }
    }
  }
  return { verdict: "ok", status: 200, redirect };
}

// ─── Redis state ───────────────────────────────────────────────────────────────

export async function getAuditState(): Promise<AuditState | null> {
  const r = redis();
  if (!r) return null;
  const raw = await r.get<any>(STATE_KEY).catch(() => null);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}
async function saveState(s: AuditState): Promise<void> {
  const r = redis();
  if (!r) return;
  s.updatedAt = Date.now();
  await r.set(STATE_KEY, JSON.stringify(s), { ex: 60 * 60 * 24 }).catch(() => {});
}
export async function clearAuditState(): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.del(STATE_KEY).catch(() => {});
  await r.del(CHECKED_KEY).catch(() => {});
  await r.del(FP_KEY).catch(() => {});
  await r.del(LINKED_KEY).catch(() => {});
}
async function loadLinked(): Promise<Set<string>> {
  const r = redis();
  if (!r) return new Set();
  const raw = await r.get<unknown>(LINKED_KEY).catch(() => null);
  const arr = raw ? ((typeof raw === "string" ? JSON.parse(raw) : raw) as string[]) : [];
  return new Set(arr);
}
async function saveLinked(s: Set<string>): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.set(LINKED_KEY, JSON.stringify([...s]), { ex: 60 * 60 * 24 }).catch(() => {});
}
async function loadChecked(): Promise<CheckedMap> {
  const r = redis();
  if (!r) return {};
  const raw = await r.get<any>(CHECKED_KEY).catch(() => null);
  return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
}
async function saveChecked(m: CheckedMap): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.set(CHECKED_KEY, JSON.stringify(m), { ex: 60 * 60 * 24 }).catch(() => {});
}
async function loadFp(): Promise<FingerprintMap> {
  const r = redis();
  if (!r) return {};
  const raw = await r.get<any>(FP_KEY).catch(() => null);
  return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
}
async function saveFp(m: FingerprintMap): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.set(FP_KEY, JSON.stringify(m), { ex: 60 * 60 * 24 }).catch(() => {});
}

// ─── Runner ────────────────────────────────────────────────────────────────────

// Exported for the sitemap page sweep (lib/linkaudit/pages.ts), which maps page verdicts
// through the same names so both run kinds share one findings vocabulary.
export const VERDICT_REASON: Record<string, string> = { "404": "http-404", "410": "http-410", soft: "soft-404", home: "homepage-redirect", "server-error": "http-5xx" };

// The reasons that mean "this thing is actually broken" — the run-over-run diff and the
// re-verify pass operate on these. Unreachable is inconclusive and redirect hygiene is a
// quality report, so neither belongs in "N fixed since yesterday" arithmetic.
export const HARD_BROKEN_REASONS = new Set(["http-404", "http-410", "soft-404", "homepage-redirect", "http-5xx", "dead-page"]);

// Pure set arithmetic for the run-over-run comparison (PDF 12.2): what appeared, what's
// still there, what disappeared (= fixed, since the crawler just re-checked everything).
// Exported for the finalize pass, the digest, and the E2E suite.
export function diffRunLinks(prev: string[], cur: string[]): { newLinks: string[]; persisting: string[]; fixed: string[] } {
  const prevSet = new Set(prev);
  const curSet = new Set(cur);
  return {
    newLinks: [...curSet].filter((l) => !prevSet.has(l)),
    persisting: [...curSet].filter((l) => prevSet.has(l)),
    fixed: [...prevSet].filter((l) => !curSet.has(l)),
  };
}

export async function startAudit(): Promise<{ runId: string; pagesTotal: number }> {
  const pages = await fetchSitemapUrls();
  const { data: run, error } = await supabaseAdmin
    .from("link_audit_runs")
    .insert({ status: "running", pages_total: pages.length })
    .select()
    .single();
  if (error) throw error;
  await clearAuditState();
  const state: AuditState = {
    runId: run.id, pages, index: 0, authorMap: {},
    linksChecked: 0, broken: 0, unreachable: 0, log: [],
    startedAt: Date.now(), updatedAt: Date.now(),
    sitemapCount: pages.length, discovered: 0,
  };
  pushLog(state, `Sitemap fetched — ${pages.length} pages queued; internal pages found via links will be appended (spider mode)`);
  await saveState(state);
  await clearAuditStop(); // stale stop flag from a previous run must not kill this one
  return { runId: run.id, pagesTotal: pages.length };
}

// Process pages from state.index until done or the chunk budget runs out. On budget, hands
// off to a fresh invocation via QStash. On completion, resolves authors onto findings,
// finalizes the run row, posts the Slack digest, and clears state.
export async function processAuditChunk(): Promise<void> {
  const state = await getAuditState();
  if (!state) return;
  const deadline = Date.now() + CHUNK_BUDGET_MS;
  const checked = await loadChecked();
  const fpCache = await loadFp();
  // Per-chunk, not persisted: redirect hygiene is best-effort and re-tracing a URL in a later
  // chunk costs a few bounded fetches, which is cheaper than another Redis key to keep honest.
  const traceCache: RedirectTraceMap = new Map();
  // Spider bookkeeping: which internal pages links point at (orphan detection), and which
  // pages the crawl already knows (sitemap + previously discovered) so a discovery is
  // appended exactly once. Both in the crawl's canonical URL form.
  const auditHost = new URL(SITEMAP_URL).host;
  const linkedSeen = await loadLinked();
  const knownPages = new Set(state.pages.map(normalizeUrl));
  let spiderCapLogged = false;
  // Internal links that are themselves sitemap pages are alive by definition — skip
  // re-checking them (saves hundreds of fetches per run).
  const sitemapSet = new Set(state.pages.map((p) => p.replace(/\/$/, "")));
  // The pages the LIVE sitemap actually lists — the first sitemapCount entries; everything
  // after was spider-discovered. Findings on unlisted pages are real but belong in a separate
  // queue (the team reads the main view as "pages we published").
  const listedSet = new Set(state.pages.slice(0, state.sitemapCount ?? state.pages.length).map((p) => p.replace(/\/$/, "")));
  const ignoredSet = new Set(await getIgnoredLinks()); // team-flagged false positives — never checked/reported
  const queue = new PQueue({ concurrency: LINK_CONCURRENCY });

  while (state.index < state.pages.length && Date.now() < deadline) {
    // Durable stop — the page's Stop button sets a Redis flag any instance sees.
    if (await isAuditStopRequested()) {
      pushLog(state, `Stopped by user at page ${state.index}/${state.pages.length}.`);
      await saveState(state);
      await supabaseAdmin.from("link_audit_runs").update({
        status: "stopped", finished_at: new Date().toISOString(),
        pages_checked: state.index, links_checked: state.linksChecked,
        broken_found: state.broken, unreachable: state.unreachable,
      }).eq("id", state.runId);
      await clearAuditState();
      await clearAuditStop();
      return;
    }

    const pageUrl = state.pages[state.index];
    const pageListed = listedSet.has(pageUrl.replace(/\/$/, ""));
    const res = await fetchRaw(pageUrl, 15_000);

    if (!("error" in res) && res.status === 200 && res.html) {
      // Card-harvested authors fill gaps; a page's OWN byline is authoritative and must
      // never be overwritten by another page's card, so it's prefixed to mark priority.
      const cards = harvestCardAuthors(res.html);
      for (const [path, name] of Object.entries(cards)) {
        if (!state.authorMap[`!${path}`] && !state.authorMap[path]) state.authorMap[path] = name;
      }
      // Deterministic byline patterns first (free); LLM fallback only when they miss on
      // a blog post — never for product pages, which genuinely have no author.
      let ownAuthor = extractPageAuthor(res.html);
      if (!ownAuthor && pageUrl.includes("/blogs/")) {
        ownAuthor = await aiExtractAuthor(res.html);
        if (ownAuthor) pushLog(state, `AI byline fallback found author "${ownAuthor}" on ${pageUrl.slice(-60)}`);
      }
      if (ownAuthor) {
        try { state.authorMap[`!${new URL(pageUrl).pathname.replace(/\/$/, "")}`] = ownAuthor; } catch { /* ignore */ }
      }

      // Anchors plus og:image/twitter:image meta URLs — a dead share image is a finding too.
      const anchorLinks = extractLinks(res.html, pageUrl);
      const anchorUrls = new Set(anchorLinks.map((l) => l.url));
      const links = [...anchorLinks, ...extractMetaAssets(res.html, pageUrl).filter((l) => !anchorUrls.has(l.url))];
      const findings: Array<{ link: ExtractedLink; verdict: LinkVerdict }> = [];

      const unreachables: Array<{ link: ExtractedLink; status?: number }> = [];
      const redirectIssues: Array<{ link: ExtractedLink; info: NonNullable<LinkVerdict["redirect"]> }> = [];
      const pagesBefore = state.pages.length;
      await Promise.all(links.map((link) => queue.add(async () => {
        // Spider mode: an internal page the crawl doesn't know yet joins the queue — the
        // sitemap seeds the crawl, links extend it. (No awaits between the check and the
        // push, so concurrent tasks can't double-append.)
        const cand = spiderCandidate(link.url, auditHost);
        if (cand) {
          linkedSeen.add(cand); // some page links here — not an orphan
          if (!knownPages.has(cand) && !ignoredSet.has(link.url)) {
            if (state.pages.length < MAX_PAGES) {
              knownPages.add(cand);
              state.pages.push(cand);
              state.discovered = (state.discovered ?? 0) + 1;
            } else if (!spiderCapLogged) {
              spiderCapLogged = true;
              pushLog(state, `SPIDER CAP: crawl queue reached ${MAX_PAGES} — raise MAX_PAGES to keep full coverage.`);
            }
          }
        }
        if (sitemapSet.has(link.url.replace(/\/$/, ""))) return; // known-live sitemap page (dead ones were removed from the set below)
        if (ignoredSet.has(link.url)) return; // team-ignored false positive — skip entirely
        const prior = checked[link.url];
        if (prior) {
          prior.n++;
          if (VERDICT_REASON[prior.v] && prior.n <= MAX_PAGES_PER_BROKEN_LINK) {
            findings.push({ link, verdict: { verdict: prior.v as LinkVerdict["verdict"], status: prior.s } });
          } else if (prior.v === "unreach" && prior.n <= MAX_PAGES_PER_BROKEN_LINK) {
            unreachables.push({ link, status: prior.s });
          }
          return;
        }
        const v = await checkLink(link.url, fpCache, traceCache);
        checked[link.url] = { v: v.verdict, s: v.status, n: 1 };
        state.linksChecked++;
        if (VERDICT_REASON[v.verdict]) { state.broken++; findings.push({ link, verdict: v }); }
        else if (v.verdict === "unreach") { state.unreachable++; unreachables.push({ link, status: v.status }); }
        else if (v.redirect && (v.redirect.hops > 2 || v.redirect.statuses.some((s) => s === 302 || s === 307))) {
          // Alive but badly plumbed: a chain crawlers give up on, or a temporary redirect
          // that should be a 301. Reported in its own digest section — never as "broken",
          // never pinging a writer.
          redirectIssues.push({ link, info: v.redirect });
        }
      })));
      await queue.onIdle();

      if (findings.length > 0 || unreachables.length > 0 || redirectIssues.length > 0) {
        // Stamp the best author we know RIGHT NOW (the page's own byline, extracted just
        // above) so the live findings view is correct mid-run; the finalize pass still
        // backfills pages whose author only surfaces later via other pages' cards.
        const pagePath = (() => { try { return new URL(pageUrl).pathname.replace(/\/$/, ""); } catch { return ""; } })();
        const knownAuthor = ownAuthor ?? state.authorMap[`!${pagePath}`] ?? state.authorMap[pagePath] ?? null;
        // Location built from real DOM landmarks at capture time — accurate by construction.
        await supabaseAdmin.from("link_audit_findings").upsert(
          [
            ...findings.map((f) => ({
              run_id: state.runId, page_url: pageUrl, page_author: knownAuthor,
              link_url: f.link.url, anchor_text: f.link.anchor, context_text: f.link.context,
              occurrences: f.link.occurrences, location_hint: describeOccurrences(f.link.occurrences),
              reason: VERDICT_REASON[f.verdict.verdict], http_status: f.verdict.status ?? null,
              page_listed: pageListed,
            })),
            // Unreachable (bot-blocked/timeout/odd status) — stored so the digest can list
            // them for a human eyeball, but never counted or shown as broken.
            ...unreachables.map((u) => ({
              run_id: state.runId, page_url: pageUrl, page_author: knownAuthor,
              link_url: u.link.url, anchor_text: u.link.anchor, context_text: u.link.context,
              occurrences: u.link.occurrences, location_hint: describeOccurrences(u.link.occurrences),
              reason: "unreachable", http_status: u.status ?? null,
              page_listed: pageListed,
            })),
            // Redirect hygiene (PDF 1.3/1.4): the target answers, but through a chain crawlers
            // abandon or a 302 that passes no authority. One row per target (the verdict cache
            // short-circuits repeats), hint carries the traced chain.
            ...redirectIssues.map((r) => ({
              run_id: state.runId, page_url: pageUrl, page_author: knownAuthor,
              link_url: r.link.url, anchor_text: r.link.anchor, context_text: r.link.context,
              occurrences: r.link.occurrences, location_hint: describeRedirect(r.info),
              reason: r.info.hops > 2 ? "redirect-chain" : "temp-redirect", http_status: r.info.statuses[0] ?? null,
              page_listed: pageListed,
            })),
          ],
          { onConflict: "run_id,page_url,link_url", ignoreDuplicates: true },
        );
      }

      const path = (() => { try { return new URL(pageUrl).pathname || "/"; } catch { return pageUrl; } })();
      const authorNote = ownAuthor ? ` · author: ${ownAuthor}` : "";
      const brokenNote = findings.length > 0 ? ` · ${findings.length} BROKEN: ${findings.map((f) => f.link.url).join(", ").slice(0, 160)}` : "";
      const discoveredNote = state.pages.length > pagesBefore ? ` · +${state.pages.length - pagesBefore} unlisted page(s) queued` : "";
      pushLog(state, `[${state.index + 1}/${state.pages.length}] ${path} — ${links.length} links${authorNote}${brokenNote}${discoveredNote}`);
    } else if (!("error" in res) && (res.status === 404 || res.status === 410 || res.status >= 500)) {
      // The crawled page ITSELF is dead (PDF 3.4). Before this branch existed the page was a
      // log line and — worse — the "sitemap pages are alive by definition" skip meant every
      // link pointing at it was silently excused. Record it as a finding and evict it from
      // the alive set so links to it from pages crawled later get checked like any other URL.
      // Spider-discovered pages land here too — the hint must not claim the sitemap sent us.
      await supabaseAdmin.from("link_audit_findings").upsert(
        [{
          run_id: state.runId, page_url: pageUrl, page_author: null,
          link_url: pageUrl, anchor_text: null, context_text: null,
          occurrences: [], location_hint: pageListed
            ? `listed in the sitemap but the page itself returns HTTP ${res.status}`
            : `not in the sitemap (found by following links) and the page itself returns HTTP ${res.status}`,
          reason: "dead-page", http_status: res.status,
          page_listed: pageListed,
        }],
        { onConflict: "run_id,page_url,link_url", ignoreDuplicates: true },
      );
      sitemapSet.delete(pageUrl.replace(/\/$/, ""));
      // Seed the verdict cache so links to this page (from pages still ahead in the crawl)
      // resolve instantly instead of re-fetching a page we just watched die.
      checked[pageUrl] = { v: res.status === 404 ? "404" : res.status === 410 ? "410" : "server-error", s: res.status, n: 0 };
      state.broken++;
      pushLog(state, `[${state.index + 1}/${state.pages.length}] ${pageUrl} — BROKEN PAGE: ${pageListed ? "in the sitemap but" : "unlisted, and"} returns HTTP ${res.status}`);
    } else {
      pushLog(state, `[${state.index + 1}/${state.pages.length}] ${pageUrl} — page fetch failed (${"error" in res ? res.error : `HTTP ${res.status}`})`);
    }

    state.index++;
    if (state.index % 5 === 0 || state.index === state.pages.length) {
      await saveState(state);
      await saveChecked(checked);
      await saveFp(fpCache);
      await saveLinked(linkedSeen);
      await supabaseAdmin.from("link_audit_runs").update({
        pages_checked: state.index, links_checked: state.linksChecked,
        broken_found: state.broken, unreachable: state.unreachable,
        pages_total: state.pages.length, // spider mode grows the queue as it finds unlisted pages
      }).eq("id", state.runId);
    }
  }

  await saveState(state);
  await saveChecked(checked);
  await saveFp(fpCache);
  await saveLinked(linkedSeen);

  if (state.index < state.pages.length) {
    // Budget hit with pages remaining → continue in a fresh invocation.
    pushLog(state, `Time budget reached — continuing in a fresh run (${state.pages.length - state.index} pages left)`);
    await saveState(state);
    await qstashPublish("/api/link-audit/run", { continue: true, auto: true });
    return;
  }
  pushLog(state, `Crawl complete — resolving authors and posting the Slack digest…`);
  await saveState(state);

  // ── Finalize ──────────────────────────────────────────────────────────────
  // Resolve authors onto findings now that the card map is complete.
  const { data: rows } = await supabaseAdmin
    .from("link_audit_findings").select("id, page_url").eq("run_id", state.runId);
  for (const row of rows ?? []) {
    try {
      const path = new URL(row.page_url).pathname.replace(/\/$/, "");
      const author = state.authorMap[`!${path}`] ?? state.authorMap[path]; // own byline wins over card data
      if (author) await supabaseAdmin.from("link_audit_findings").update({ page_author: author }).eq("id", row.id);
    } catch { /* ignore */ }
  }

  // True page counts (PDF sequencing input): finding rows are capped at MAX_PAGES_PER_BROKEN_LINK
  // per link, but the verdict cache counted every page each link was seen on. Persist that count
  // so the UI and digest can say "on 2,111 pages" while storing five sample rows.
  try {
    const { data: linkRows } = await supabaseAdmin
      .from("link_audit_findings").select("link_url").eq("run_id", state.runId).neq("reason", "unreachable");
    const distinctLinks = [...new Set((linkRows ?? []).map((r) => r.link_url as string))];
    for (const link of distinctLinks.slice(0, 500)) {
      const n = checked[link]?.n ?? 0;
      if (n > 0) {
        await supabaseAdmin.from("link_audit_findings")
          .update({ pages_seen: n }).eq("run_id", state.runId).eq("link_url", link);
      }
    }
  } catch { /* counts are best-effort — the sample rows still tell the story */ }

  // Live closure (PDF 12.1/12.3): a link that was broken in the previous completed run and is
  // absent from this one was just re-checked by this very crawl and passed — that IS the live
  // re-verification. Stamp resolved_at so history reads "fixed on <date>", not "vanished".
  try {
    const { data: prevRun } = await supabaseAdmin
      .from("link_audit_runs").select("id").eq("status", "completed").neq("id", state.runId)
      .eq("kind", "links") // never diff a link crawl against a page sweep — different universes
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (prevRun) {
      const [{ data: prevRows }, { data: curRows }] = await Promise.all([
        supabaseAdmin.from("link_audit_findings").select("link_url, reason").eq("run_id", prevRun.id),
        supabaseAdmin.from("link_audit_findings").select("link_url, reason").eq("run_id", state.runId),
      ]);
      const hard = (rows: Array<{ link_url: string; reason: string }> | null) =>
        [...new Set((rows ?? []).filter((r) => HARD_BROKEN_REASONS.has(r.reason)).map((r) => r.link_url))];
      const { fixed } = diffRunLinks(hard(prevRows), hard(curRows));
      const now = new Date().toISOString();
      for (let i = 0; i < fixed.length; i += 100) {
        await supabaseAdmin.from("link_audit_findings")
          .update({ resolved_at: now, last_checked_at: now })
          .in("link_url", fixed.slice(i, i + 100)).is("resolved_at", null);
      }
      if (fixed.length > 0) pushLog(state, `${fixed.length} link(s) broken last run now check out — marked fixed.`);
    }
  } catch { /* the diff is reporting, not correctness — never fail the run over it */ }

  // Draft targets (team ask, Aug 31): a broken internal link whose target still EXISTS in
  // Strapi as an unpublished draft is an editorial decision — publish the post, or drop the
  // link — not a URL to hand-fix. Measured: the Aug-26 sitemap halving reverted ~750 blogs to
  // draft and buried one run under 836 soft-404s, all this case, none labeled. The flag routes
  // them to their own queue; the reason stays the truthful verdict.
  try {
    const { data: frows } = await supabaseAdmin
      .from("link_audit_findings").select("link_url, reason").eq("run_id", state.runId);
    const hostBare = new URL(SITEMAP_URL).host.replace(/^www\./, "");
    const targets = [...new Set((frows ?? [])
      .filter((r) => HARD_BROKEN_REASONS.has(r.reason as string))
      .map((r) => r.link_url as string))]
      .filter((u) => { try { return new URL(u).host.replace(/^www\./, "") === hostBare; } catch { return false; } });
    if (targets.length > 0) {
      const { draftTargetsAmong } = await import("@/lib/renderlab/draftLookup");
      const drafts = [...await draftTargetsAmong(targets)];
      for (let i = 0; i < drafts.length; i += 100) {
        await supabaseAdmin.from("link_audit_findings")
          .update({ draft_target: true })
          .eq("run_id", state.runId).in("link_url", drafts.slice(i, i + 100));
      }
      pushLog(state, `${drafts.length} of ${targets.length} broken internal link target(s) are unpublished CMS drafts — flagged.`);
    }
  } catch (e) {
    // Skipped is fine; skipped SILENTLY is not — an unlabeled draft flood is exactly the noise
    // this flag exists to prevent, so the log says the labeling didn't happen.
    pushLog(state, `Draft-target check skipped (${e instanceof Error ? e.message.slice(0, 120) : "error"}).`);
  }

  // AI location hints — one Haiku call per unique broken link (capped), persisted so the
  // page and the Slack digest both show the same plain-words "where is this link".
  try {
    const { aiLocateFinding } = await import("./slack");
    const { data: allFindings } = await supabaseAdmin
      .from("link_audit_findings")
      .select("id, page_url, link_url, anchor_text, context_text, location_hint")
      .eq("run_id", state.runId);
    const byLink = new Map<string, any[]>();
    for (const f of allFindings ?? []) (byLink.get(f.link_url) ?? byLink.set(f.link_url, []).get(f.link_url)!).push(f);
    let hintCalls = 0;
    for (const [link, fs] of byLink) {
      if (hintCalls >= 30) break;
      if (fs.every((f) => f.location_hint)) continue;
      // Base the hint on the occurrence with the richest context.
      const best = [...fs].sort((a, b) => (b.context_text?.length ?? 0) - (a.context_text?.length ?? 0))[0];
      hintCalls++;
      const hint = await aiLocateFinding(best);
      if (hint) {
        await supabaseAdmin.from("link_audit_findings").update({ location_hint: hint }).eq("run_id", state.runId).eq("link_url", link);
      }
    }
  } catch { /* hints are best-effort */ }

  // Coverage accounting: turn "we crawled everything" into numbers — sitemap vs discovered
  // vs orphans vs what Google knows that neither reached. Persisted on the run row so the
  // digest and the UI report measured coverage, not assumed coverage.
  let coverage: CoverageReport | null = null;
  try {
    let gscUrls: string[] = [];
    if (isGscConfigured()) {
      const rows = await searchAnalytics({ startDate: daysAgo(28), endDate: daysAgo(1), dimensions: ["page"], rowLimit: 5000 });
      const auditHost = new URL(SITEMAP_URL).host.replace(/^www\./, "");
      gscUrls = rows.map((r) => r.keys[0]).filter((u) => {
        try { const x = new URL(u); return x.host.replace(/^www\./, "") === auditHost && !x.search; } catch { return false; }
      });
    }
    coverage = coverageOf(state.sitemapCount ?? state.pages.length, state.pages, linkedSeen, gscUrls);
    pushLog(state, `Coverage: ${coverage.sitemap} sitemap + ${coverage.discovered} discovered via links · ${coverage.orphans} orphan(s) · ${coverage.gscUnreached} GSC-only URL(s)`);
    await saveState(state);
  } catch { /* coverage is reporting — never fail the run over it */ }

  // Spider discoveries join the site_urls inventory (source='spider') so the page sweep and
  // the JS-links detector cover them too — a page the sitemap forgot shouldn't have to be
  // rediscovered by every tool separately. Upsert refreshes last_seen while it stays linked;
  // once nothing links to it for a week it ages out of the default enumeration window.
  try {
    const discovered = state.pages.slice(state.sitemapCount ?? state.pages.length);
    if (discovered.length > 0) {
      const now = new Date().toISOString();
      const rows = discovered.map((url) => {
        const path = (() => { try { return new URL(url).pathname.replace(/\/+$/, "") || "/"; } catch { return url; } })();
        const section = path.split("/").filter(Boolean)[0] ?? "";
        return { url, path, section, source: "spider", last_seen: now };
      });
      for (let i = 0; i < rows.length; i += 400) {
        await supabaseAdmin.from("site_urls").upsert(rows.slice(i, i + 400), { onConflict: "url" });
      }
      pushLog(state, `${discovered.length} spider-discovered page(s) added to the site inventory.`);
    }
  } catch { /* inventory enrichment is best-effort */ }

  await supabaseAdmin.from("link_audit_runs").update({
    status: "completed", finished_at: new Date().toISOString(),
    pages_checked: state.index, links_checked: state.linksChecked,
    broken_found: state.broken, unreachable: state.unreachable,
    pages_total: state.pages.length,
    ...(coverage ? { coverage } : {}),
  }).eq("id", state.runId);

  try {
    const { postAuditDigest } = await import("./slack");
    await postAuditDigest(state.runId);
  } catch { /* digest failure shouldn't fail the run */ }

  await clearAuditState();
}
