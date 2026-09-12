// Turn a DOMAIN into a specific article worth pitching.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
//
// The outreach flow assumes every prospect points at a PIECE — the relevance gate reads that page and
// refuses to pitch when it is not about the campaign's subject, and the opener quotes a detail from it.
// But prospects arrive two ways, and only one of them supplies a piece:
//
//   from discovery         → a URL found for a keyword, i.e. already an article
//   from a list of domains → whatever was handed in, which is usually a homepage
//
// `add_prospects_from_urls` files what it is given, so a domain becomes the "article". Measured on one
// live campaign: 43 of 46 in-scope prospects had a bare homepage, and the gate correctly refused all of
// them — "WordPress plugin sales page, not an AI image tool roundup", "agency homepage promoting
// services". The gate was right, the list was unusable, and the person was told only "off-topic".
//
// This closes that gap: given a domain and the campaign's subject, find a real article on that domain.
// It does NOT lower the relevance bar — a domain with nothing relevant on it stays unpitchable, and
// saying so is the useful answer.

import { webSearch } from "@/lib/search/webSearch";

/**
 * Is this URL the site's front door rather than a piece of writing?
 *
 * Deliberately generous about what counts: a homepage, and the handful of paths every site has that
 * are never an article. Anything else is left alone — guessing that a path is "not an article" from its
 * shape is how a legitimate piece gets skipped.
 */
export function looksLikeHomepage(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    if (path === "" || path === "/") return true;
    return /^\/(index\.\w+|home|about|about-us|contact|contact-us|pricing|plans|privacy|terms|login|signup|careers)$/i.test(path);
  } catch {
    return false;
  }
}

/**
 * Not a piece of writing: a listing, or not a page at all.
 *
 * The listing half is about tone — pitching "your article" at a tag index reads as a bot. The rest is
 * about the search index returning things that are not articles: a real result from this was
 * `tamaracamerablog.com/data/manifest?is_workplace_mobile_pwa_dogfooding=0`, which matched on title and
 * would have been filed as the piece to pitch about. A query string, a non-HTML extension and the
 * usual machine paths are all disqualifying — an article URL essentially never has any of them.
 */
function looksLikeIndex(url: string): boolean {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, "");
    if (looksLikeHomepage(url)) return true;
    // Not a document.
    if (u.search) return true;
    if (/\.(json|xml|txt|csv|rss|atom|pdf|zip|png|jpe?g|gif|svg|webp|mp4|js|css|ico|webmanifest)$/i.test(p)) return true;
    if (/^\/(data|api|wp-json|wp-admin|wp-content|cdn-cgi|static|assets|_next)(\/|$)/i.test(p)) return true;
    if (/(^|\/)manifest(\.|$|\/)/i.test(p)) return true;
    // A listing rather than a piece.
    return /\/(tag|tags|category|categories|author|authors|page|search|feed|archives?)(\/|$)/i.test(p)
      || /^\/(blog|news|articles|resources|insights)$/i.test(p);
  } catch {
    return true;
  }
}

export interface ArticleCandidate {
  url: string;
  title: string;
  snippet: string;
}

function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

/**
 * The best article on `domain` for `topic`, or null.
 *
 * Uses the site: operator through the shared provider stack rather than crawling: it is one request
 * per domain against an index that already knows what the site's pages are about, where a crawl is
 * dozens of fetches and still has to guess. `webSearch` falls through its providers, so this works on
 * whichever key is configured.
 *
 * Ranking is deliberately simple and explainable — how many of the topic's words appear in the title,
 * then the snippet, with a small bonus for a deeper path (a piece usually lives below the root). No
 * model call: this picks a candidate, and the relevance gate that already exists is what JUDGES it.
 * Putting a second opinion here would just be a slower, less accountable version of that gate.
 */
export async function findArticleForDomain(input: {
  domain: string;
  topic: string;
  /** Skip these — already used by another prospect in the campaign. */
  exclude?: Set<string>;
  signal?: AbortSignal;
}): Promise<{ best: ArticleCandidate | null; considered: number; reason: string | null }> {
  const domain = input.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase();
  if (!domain) return { best: null, considered: 0, reason: "no domain" };
  const topic = input.topic.trim();
  if (!topic) return { best: null, considered: 0, reason: "campaign has no topic to match against" };

  const hits = await webSearch(`site:${domain} ${topic}`, 10, input.signal).catch(() => [] as ArticleCandidate[]);
  // Same domain only. `site:` is a hint, not a guarantee — providers do return off-site results for it.
  const onSite = hits.filter((h) => hostOf(h.url) === domain);
  const usable = onSite.filter((h) => !looksLikeIndex(h.url) && !(input.exclude?.has(h.url)));
  if (!usable.length) {
    return {
      best: null,
      considered: onSite.length,
      reason: onSite.length
        ? `${onSite.length} page(s) on ${domain} matched, but all were the homepage or a listing page`
        : `nothing on ${domain} matched "${topic}"`,
    };
  }

  const words = topic.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const score = (h: ArticleCandidate): number => {
    const title = h.title.toLowerCase();
    const snip = (h.snippet ?? "").toLowerCase();
    let n = 0;
    for (const w of words) {
      if (title.includes(w)) n += 3;
      else if (snip.includes(w)) n += 1;
    }
    try { if (new URL(h.url).pathname.replace(/\/+$/, "").split("/").filter(Boolean).length > 1) n += 1; } catch { /* keep score */ }
    return n;
  };
  /** Topic words in the TITLE. Counted on its own, never inferred from the score. */
  const titleHits = (h: ArticleCandidate): number => {
    const title = h.title.toLowerCase();
    return words.filter((w) => title.includes(w)).length;
  };
  const ranked = [...usable].sort((a, b) => score(b) - score(a));
  const best = ranked[0];
  // The bar is a topic word in the TITLE, not merely somewhere on the page.
  //
  // Snippet-only matches are how a site's pages get proposed for a subject they only mention in
  // passing. Measured while building this, against topic "ai image generator": a title match returns
  // "7 Best WordPress AI Image Generators" and "Top AI Image to Image Generator Every Designer Should
  // Try", while snippet-only returns "Note-Taking AI for Students" and "How to Redesign a Website" —
  // pages that would be re-filed, sent to the relevance gate, and correctly rejected, having spent a
  // fetch and a model call to learn what the title already said.
  //
  // Checked directly rather than as a score threshold. Reading it off `score` looked equivalent and was
  // not: two snippet words plus the deeper-path bonus also sum to 3, so "How to Redesign a Website" and
  // "Leveraging AI For Efficient Clothing Manufacturing" both cleared a >= 3 test for topic
  // "ai image generator". An arithmetic coincidence is not a rule; this is the rule.
  if (titleHits(best) === 0) {
    return {
      best: null,
      considered: usable.length,
      reason: `${usable.length} page(s) on ${domain}, none whose title is about "${topic}"`
        + ` (closest: "${best.title.slice(0, 60)}")`,
    };
  }
  return { best, considered: usable.length, reason: null };
}
