// A verdict for every link, using the cheapest authority that can answer it.
//
//   1. THE SITEMAP. If a path is listed there it is live. No request.
//   2. STRAPI. For a slug the sitemap omits, the CMS says why: an unpublished draft 404s, and a
//      published entry at a different path tells us the URL the link SHOULD have used.
//   3. HTTP, only for what neither knows — static routes and external hosts.
//
// The HTTP tier is where an earlier version of this got three things wrong, each of which produced
// hundreds of false positives, so each is written down:
//
//   * The server IGNORES `Range`, so a "cheap" ranged GET downloads the whole 1-3 MB page anyway.
//   * "This page could not be found" ships inside EVERY page's Next.js bundle as dead client code.
//     Matching it flagged the homepage, /video and /image as broken.
//   * An unknown site route returns a real 404, but an unknown /blogs/ slug returns 200 with NO
//     <title> at all. Missing title is the soft-404 signal here; body text is not.
import type { FoundLink, Verdict } from "./types";
import { MEDIA_RE } from "./extract";
import { normPath, type Inventory } from "./sources";

const SITE_HOSTS = new Set(["www.imagine.art", "imagine.art"]);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TITLE_RE = /<title[^>]*>\s*([^<]*?)\s*<\/title>/i;

export interface ProbeResult { status: number; title: string | null; mine: boolean; err?: string }

/** Facts only. Interpretation is separate so a cached probe can be re-judged without re-fetching. */
export async function probe(url: string): Promise<ProbeResult> {
  let mine = false;
  try { mine = SITE_HOSTS.has(new URL(url).hostname.toLowerCase()); } catch { /* not our host */ }
  try {
    // Our own pages need the body — an unknown /blogs/ slug answers 200 with no <title>. Everything
    // external only needs a status, so HEAD keeps it cheap and polite.
    const method = mine ? "GET" : "HEAD";
    let res = await fetch(url, { method, headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!mine && (res.status === 405 || res.status === 501)) {
      res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    }
    let title: string | null = null;
    if (mine && res.status < 400) title = (String(await res.text().catch(() => "")).match(TITLE_RE) ?? ["", ""])[1];
    return { status: res.status, title, mine };
  } catch (e) {
    return { status: 0, title: null, mine, err: String((e as Error)?.message ?? e).slice(0, 80) };
  }
}

/**
 * A 403 or 999 from Trustpilot or Bloomberg is anti-bot, not a broken link — a reader and Googlebot
 * both get the page. Only call it broken when the server says the thing is actually gone.
 */
export function judgeProbe(p: ProbeResult): { verdict: Verdict; why?: string } {
  if (p.status === 0) return { verdict: "broken", why: `unreachable: ${p.err ?? "no response"}` };
  if (p.status === 404 || p.status === 410) return { verdict: "broken", why: `HTTP ${p.status}` };
  if (p.status >= 400) return { verdict: "blocked", why: `HTTP ${p.status} to an automated request — not treated as broken` };
  if (p.mine && (!p.title || /^qwen$/i.test(p.title))) {
    return { verdict: "broken", why: `HTTP ${p.status} with no <title> — the client-rendered 404 shell` };
  }
  return { verdict: "ok" };
}

/**
 * Everything decidable without the network. Returns the link with a verdict set, or with
 * `verdict: "unchecked"` and a `target` when only HTTP can answer.
 */
export function classifyOffline(link: FoundLink, inv: Inventory): FoundLink {
  // A resource card carries a relation, not a URL; the front end renders /blogs/<slug> from it.
  if (link.kind === "relation" && link.relSlug && !link.url) {
    const b = (link.relId != null ? inv.blogById.get(link.relId) : undefined) ?? inv.blogs.get(link.relSlug.toLowerCase());
    const live = Boolean(b?.published);
    return {
      ...link,
      target: `https://www.imagine.art/blogs/${link.relSlug}`,
      targetId: b?.id,
      targetTitle: b?.title ?? link.text,
      verdict: live ? "ok" : "broken",
      why: live ? undefined : "target blog is an unpublished draft",
    };
  }

  const raw = link.url;
  if (!raw) return { ...link, verdict: "ok" };
  if (MEDIA_RE.test(raw)) return { ...link, target: raw, verdict: "asset" };

  let host = "";
  let url: URL | null = null;
  try { url = new URL(raw, "https://www.imagine.art"); host = url.hostname.toLowerCase(); } catch { /* keep as external */ }

  if (/(^|\.)shorts\.imagine\.art$/.test(host) || /\/dashboard(\/|$)/.test(raw)) {
    return { ...link, target: raw, verdict: "dashboard", why: "app route behind login, not a public page" };
  }
  // Other imagine.art subdomains (help., platform., mcp.) route independently — judging their paths
  // against the marketing sitemap judges them against the wrong site.
  if (!url || !SITE_HOSTS.has(host)) return { ...link, target: raw, verdict: "unchecked" };

  const p = normPath(url.pathname);
  const target = `https://www.imagine.art${p}`;
  if (inv.livePaths.has(p)) return { ...link, target, verdict: "ok" };

  const seg = (p.split("/").pop() ?? "").toLowerCase();
  const isBlogPath = /^\/blogs\//.test(p);
  const hit = isBlogPath ? inv.blogs.get(seg) : inv.landings.get(seg);
  if (hit) {
    if (!hit.published) {
      return { ...link, target, targetId: hit.id, targetTitle: hit.title, verdict: "broken", why: "target is an unpublished draft in Strapi" };
    }
    const real = inv.pathBySlug.get(hit.slug);
    if (real && real !== p) {
      return {
        ...link, target, targetId: hit.id, targetTitle: hit.title, verdict: "broken",
        why: `published, but its live URL is ${real}`,
        fixTo: `https://www.imagine.art${real}`,
      };
    }
    return { ...link, target, targetId: hit.id, targetTitle: hit.title, verdict: "unchecked" };
  }
  return { ...link, target, verdict: "unchecked" };
}
