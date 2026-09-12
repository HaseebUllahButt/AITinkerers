import { registrableDomain } from "./domain";

// Video / social / audio platforms that are NOT blog posts or articles. We only want
// written editorial content (author writes a piece → we can pitch them), so URLs on these
// platforms are dropped at ingest and skipped at profiling. Matched by registrable domain,
// so subdomains (m.youtube.com, open.spotify.com) are covered too.
const BLOCKED_DOMAINS = new Set([
  "youtube.com", "youtu.be",
  "vimeo.com", "dailymotion.com", "twitch.tv",
  "tiktok.com",
  "instagram.com",
  "facebook.com", "fb.com", "fb.watch",
  "twitter.com", "x.com", "t.co",
  "threads.net",
  "reddit.com", "redd.it",
  "pinterest.com",
  "snapchat.com",
  "spotify.com", "soundcloud.com",
  "podcasts.apple.com", "apple.co",
  "flipboard.com",
]);

// Exact hosts to block (not whole registrable domains). news.google.com serves opaque
// redirect wrappers, not fetchable articles — profiling them yields no author, so drop them
// (blocking by host avoids nuking legit google.com content like developers/cloud blogs).
const BLOCKED_HOSTS = new Set([
  "news.google.com",
  "google.com", "www.google.com",       // search/redirect pages, not articles
  "play.google.com", "books.google.com",
]);

// True if this URL is a video/social/audio platform, an aggregator/redirect wrapper, or
// otherwise unfit to profile as editorial content.
export function isBlockedUrl(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return true; } // unparseable → skip
  const bare = host.replace(/^www\./, "");
  return BLOCKED_HOSTS.has(host) || BLOCKED_HOSTS.has(bare) || BLOCKED_DOMAINS.has(registrableDomain(host));
}

/**
 * Query parameters that describe how someone ARRIVED at a page rather than which page it is.
 *
 * The reason this matters enough to be a hard rule: a language model asked for a source URL will often
 * hand back the URL it was itself given, and those increasingly carry the referring tool's own name —
 * `utm_source=chatgpt.com`, `ref=perplexity`, `utm_source=openai`. Publishing that on an northwind.example page
 * credits a third party for the traffic in the destination's analytics, from our own content. It is not a
 * cosmetic problem and it cannot be caught by reading the prose.
 *
 * Everything here is provably navigational. Params that can change WHICH page renders (`id`, `page`, `q`,
 * `v`, `p`) are deliberately absent — stripping one of those turns a working link into a wrong one, which
 * is worse than the tracking it removes.
 */
const TRACKING_PARAMS = new Set([
  // Google Analytics / UTM family, including the paid-search variants.
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "utm_source_platform", "utm_creative_format", "utm_marketing_tactic",
  // Click identifiers injected by ad platforms.
  "gclid", "gclsrc", "dclid", "wbraid", "gbraid", "fbclid", "msclkid", "twclid", "ttclid",
  "igshid", "li_fat_id", "epik", "yclid", "vero_id", "s_kwcid",
  // Generic referrer slots. `ref` and `source` are the two an LLM most often fills with its own name.
  "ref", "referrer", "referer", "source", "src",
  // Email/marketing platforms.
  "mc_cid", "mc_eid", "_hsenc", "_hsmi", "hsa_cam", "hsa_grp", "hsa_ad", "hsa_src", "hsa_tgt",
  "oly_anon_id", "oly_enc_id", "mkt_tok", "trk", "trkCampaign",
  // Misc analytics.
  "_ga", "_gl", "spm", "scm", "share_id", "campaign_id", "at_medium", "at_campaign",
]);

/**
 * Clean an external URL for publication: strip tracking params, drop the fragment, normalise the shape.
 *
 * Returns null when the input is not a usable public http(s) URL, so a caller can treat "unusable" and
 * "unsafe" as the same branch rather than having to test both.
 *
 * The fragment goes because a `#section` on someone else's page is a deep link into markup we do not
 * control, and it breaks silently and invisibly when they redesign. A trailing `?` or `&` left behind by
 * stripping is removed too, since `example.com/post?` renders as a different URL to a human reader.
 */
export function cleanExternalUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname.includes(".")) return null; // bare hostnames and localhost are never publishable

  for (const key of [...u.searchParams.keys()]) {
    // Case-insensitive: `UTM_Source` is the same param and appears in the wild.
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  u.hash = "";

  let out = u.toString();
  out = out.replace(/\?$/, "");
  return out;
}

/** True when a URL carries at least one tracking parameter. Cheaper than diffing cleanExternalUrl. */
export function hasTrackingParams(input: string): boolean {
  try {
    const u = new URL(input);
    for (const key of u.searchParams.keys()) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export type UrlLiveness =
  /** Resolved to a success status. `finalUrl` differs from the input when it redirected. */
  | { ok: true; status: number; finalUrl: string }
  /** Reachable but not a page we should link to (404, 410, 5xx), or unreachable at all. */
  | { ok: false; status: number | null; reason: string };

/**
 * Is this URL actually live?
 *
 * The existing `link_provenance` gate proves a URL was RETURNED BY A TOOL, which is not the same as it
 * resolving — a search index can hand back a URL that 404s, and a model can reproduce a real-looking URL
 * from a page that has since moved. Provenance catches invention; this catches rot.
 *
 * HEAD first because it is a fraction of the bytes, then GET on 405/501: plenty of servers, including some
 * large publishers, reject HEAD outright while serving GET perfectly well. Treating that as dead would
 * refuse exactly the high-authority sources most worth citing.
 *
 * 403 and 429 count as ALIVE. Both mean "something is there and it does not want a robot", which is a
 * statement about us, not about whether a human following the link gets a page.
 */
export async function checkUrlLive(url: string, timeoutMs = 10_000): Promise<UrlLiveness> {
  const clean = cleanExternalUrl(url);
  if (!clean) return { ok: false, status: null, reason: "not a valid http(s) URL" };

  const attempt = async (method: "HEAD" | "GET"): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(clean, {
        method,
        redirect: "follow",
        signal: ctrl.signal,
        // A default fetch UA gets blanket-blocked by a lot of CDNs, which would report healthy pages as
        // dead. This is the same UA the enrichment scraper already presents.
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await attempt("HEAD");
    if (res.status === 405 || res.status === 501 || res.status === 404) {
      // 404 is retried on GET as well: some frameworks return it for HEAD on routes that exist.
      const viaGet = await attempt("GET").catch(() => null);
      if (viaGet) res = viaGet;
    }

    if (res.ok || res.status === 403 || res.status === 429) {
      return { ok: true, status: res.status, finalUrl: cleanExternalUrl(res.url) ?? clean };
    }
    return { ok: false, status: res.status, reason: `returned ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: null, reason: /abort/i.test(msg) ? `no response in ${timeoutMs}ms` : msg };
  }
}
