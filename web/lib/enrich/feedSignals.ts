// Author contact from RSS/Atom feeds — free, no key, and the highest-yield free source for the
// population we actually target.
//
// Why feeds specifically: a sample of tracked prospects with NO email on file was dominated by
// Substack and Medium subdomains, not self-hosted sites. Well-known contact paths do nothing there.
// Their FEEDS do:
//
//   beckyauer369.substack.com/feed  -> becky@beckyauer.com   + dc:creator "Becky Auer"
//   prometheanai.substack.com/feed  -> prometheanai@substack.com (platform address — rejected)
//   kgabeci.medium.com/feed         -> yourfriends@medium.com    (Medium marketing — rejected)
//   kgabeci.medium.com/about        -> pressinquiries@medium.com (the PLATFORM's, not the author's)
//
// So the value is real but so is the trap: three of those four addresses belong to the platform or
// its marketing team, and filing one as an author's address would send a pitch about backlinks to
// Medium's press desk. The platform-domain rejection below is the load-bearing part of this file,
// not the extraction.
//
// Measured and deliberately NOT built: the WordPress REST users endpoint. It returned nothing on
// any host in the sample, and it never exposes emails without authentication anyway — it yields
// names, which we already have from the byline.
import { isRoleEmail, isPlaceholderEmail } from "./personFilter";
import { emailMatchesPerson } from "./nameAffinity";
import { registrableDomain } from "@/lib/util/domain";
import { fetchRaw } from "@/lib/indexing/fetchRendered";

/**
 * Domains whose addresses belong to the PLATFORM, never to the author writing on it. An address
 * here is not a weak signal to be scored down — it is a wrong answer, and it is rejected outright.
 */
const PLATFORM_MAIL_DOMAINS = new Set([
  "substack.com", "medium.com", "ghost.io", "wordpress.com", "blogger.com", "blogspot.com",
  "tumblr.com", "wixsite.com", "wix.com", "squarespace.com", "webflow.io", "hashnode.dev",
  "beehiiv.com", "mailchimp.com", "sendgrid.net", "email.com", "gmail.example",
]);

export function isPlatformMailDomain(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  return PLATFORM_MAIL_DOMAINS.has(registrableDomain(email.slice(at + 1)));
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

export interface FeedItem { creator: string | null; emails: string[] }
export interface ParsedFeed {
  /** Addresses on the feed/channel itself (managingEditor, webMaster, channel-level author). */
  channelEmails: string[];
  items: FeedItem[];
  /** Distinct dc:creator / atom author names, in order of first appearance. */
  creators: string[];
}

function uniqEmails(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(EMAIL_RE) ?? []) {
    const e = raw.toLowerCase().trim();
    if (seen.has(e)) continue;
    seen.add(e);
    if (isPlaceholderEmail(e)) continue;
    out.push(e);
  }
  return out;
}

const stripCdata = (s: string) => s.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();

/**
 * Parse a feed into creators and the addresses that sit beside them. Regex rather than an XML
 * parser on purpose: feeds in the wild are frequently malformed, and a strict parse that throws
 * gives up an address a loose scan would have found. Pure, for the selfcheck.
 */
export function parseFeed(xml: string): ParsedFeed {
  const creators: string[] = [];
  const items: FeedItem[] = [];

  // Split into entries first so an address can be attributed to the creator it sits with, rather
  // than to whichever byline happens to appear first in the document.
  const entryChunks = xml.split(/<(?:item|entry)[\s>]/i).slice(1);
  for (const chunk of entryChunks) {
    const body = chunk.split(/<\/(?:item|entry)>/i)[0] ?? chunk;
    const creatorMatch =
      body.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) ??
      body.match(/<author[^>]*>[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>/i) ??
      body.match(/<author[^>]*>([^<]*)<\/author>/i);
    const creator = creatorMatch ? stripCdata(creatorMatch[1]).replace(/\s+/g, " ").trim() : null;
    if (creator && !creators.includes(creator)) creators.push(creator);
    items.push({ creator: creator || null, emails: uniqEmails(body) });
  }

  // Channel-level: everything before the first entry.
  const head = xml.split(/<(?:item|entry)[\s>]/i)[0] ?? "";
  return { channelEmails: uniqEmails(head), items, creators };
}

export interface FeedContact {
  email: string;
  /** The dc:creator the address was found next to, when there was one. */
  creator: string | null;
  /** Why we believe it — carried into the step log so a human can audit the decision. */
  why: string;
  score: number;
}

/**
 * Choose an address for `personName` out of a parsed feed, or null.
 *
 * Returns null rather than a best guess whenever attribution is uncertain: an address filed against
 * the wrong person is the one mistake a recipient cannot un-see, and this source runs BEFORE the
 * paid finders, so a wrong answer here suppresses a right answer later. Pure, for the selfcheck.
 */
export function pickFeedEmail(feed: ParsedFeed, personName: string, feedHost: string): FeedContact | null {
  const usable = (e: string) => !isPlatformMailDomain(e) && !isRoleEmail(e) && !isPlaceholderEmail(e);
  const nameMatches = (c: string | null) =>
    !!c && !!personName && c.toLowerCase().replace(/[^a-z ]/g, "").trim() === personName.toLowerCase().replace(/[^a-z ]/g, "").trim();

  // 1) An address in the same entry as a byline matching our person, that also looks like theirs.
  for (const item of feed.items) {
    if (!nameMatches(item.creator)) continue;
    const hit = item.emails.filter(usable).find((e) => emailMatchesPerson(e, personName, feedHost));
    if (hit) {
      return { email: hit, creator: item.creator, score: 88, why: `found beside their own byline in the feed` };
    }
  }

  // 2) A single-author feed: every byline in it is our person. A channel-level address is then
  //    plausibly theirs — but only if it still passes the name/domain affinity test, which is what
  //    stops a platform or newsletter-service address from being adopted.
  const singleAuthor = feed.creators.length === 1 && nameMatches(feed.creators[0]);
  if (singleAuthor) {
    const pool = [...feed.channelEmails, ...feed.items.flatMap((i) => i.emails)].filter(usable);
    const hit = pool.find((e) => emailMatchesPerson(e, personName, feedHost));
    if (hit) {
      return { email: hit, creator: feed.creators[0], score: 82, why: `the feed has a single author (${feed.creators[0]}) and this address matches them` };
    }
  }
  return null;
}

// ── fetching ────────────────────────────────────────────────────────────────────────────────────

const FEED_PATHS = ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml", "/feed/"];

/** Feed URLs declared by a page's own <link rel="alternate">. Pure, for the selfcheck. */
export function declaredFeeds(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try { out.push(new URL(href, baseUrl).toString()); } catch { /* skip unparseable */ }
  }
  return [...new Set(out)];
}

const looksLikeFeed = (body: string) => /<(rss|feed|rdf:RDF)[\s>]/i.test(body);

/**
 * Find this host's feed and pull a contact for `personName`.
 *
 * Cheap by construction: at most a handful of plain GETs, no browser, no key. It runs before every
 * paid provider in the cascade for that reason.
 */
export async function discoverViaFeed(
  host: string,
  personName: string,
  onStep?: (msg: string) => void,
): Promise<FeedContact | null> {
  const base = `https://${host.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
  const candidates: string[] = FEED_PATHS.map((p) => `${base}${p}`);

  // The homepage may declare a feed at a path we would never guess (/blog/rss, ?feed=rss2).
  const home = await fetchRaw(base).catch(() => null);
  if (home?.ok && home.html) {
    for (const url of declaredFeeds(home.html, base)) {
      if (!candidates.includes(url)) candidates.unshift(url);
    }
  }

  for (const url of candidates.slice(0, 8)) {
    const res = await fetchRaw(url).catch(() => null);
    if (!res?.ok || !res.html || !looksLikeFeed(res.html)) continue;
    const parsed = parseFeed(res.html);
    const hit = pickFeedEmail(parsed, personName, host);
    if (hit) {
      onStep?.(`found an address in ${url.replace(/^https?:\/\//, "")} — ${hit.why}`);
      return hit;
    }
    // A feed that parsed but yielded nothing is a dead end for THIS person; other feed paths on
    // the same host are unlikely to differ, so stop rather than hammer.
    onStep?.(`read ${url.replace(/^https?:\/\//, "")} (${parsed.items.length} items, ${parsed.creators.length} bylines) — no address attributable to ${personName}`);
    return null;
  }
  return null;
}
