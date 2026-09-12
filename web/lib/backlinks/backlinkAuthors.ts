// Source prospects from the pages that already link to a competitor.
//
// The third supply, and the warmest of the three:
//
//   runBacklinkTargets    roundups and listicles with an open slot. Finite, and everyone emails them.
//   runCompetitorAuthors  writers on a competitor's own blog. Plentiful, but many blogs are unsigned.
//   this                  the pages that have ALREADY linked to a competitor.
//
// The advantage is proof rather than inference. A roundup owner might link out; a writer on a
// competitor's blog might cover us. Someone who has already published a link to invideo.io has
// demonstrated the exact behaviour we want, on the exact topic, and the whole point of a competitor
// backlink report is that their entire link profile is a list of people who did it at least once.
//
// The link row also arrives with Ahrefs' own DR and traffic attached, so prospects can be ranked
// before a single page is fetched — the earlier sources have to crawl first and score afterwards.
//
// ── What this costs ────────────────────────────────────────────────────────────────────────────────
//
// Ahrefs bills per ROW returned, not per request, and `all-backlinks` on a real domain can return
// millions. Three things keep this bounded, and none of them is optional:
//
//   aggregation=1_per_domain   one link per referring domain. Also the correct outreach unit: fifty
//                              links from one site is one relationship, not fifty prospects.
//   order_by DR desc           spend the row budget on the domains worth a link, not the tail.
//   an explicit limit          capped hard below, and surfaced to the caller so a run can never
//                              quietly cost ten times what the last one did.
//
// ── Why most rows are useless for outreach ─────────────────────────────────────────────────────────
//
// Measured against invideo.io: the top rows by DR were wordpress.org support threads, an App Store
// listing and a TikTok profile. All real backlinks, none with a byline to pitch. Filtering to
// editorial pages happens BEFORE any page is fetched, because fetching is the slow part.
import PQueue from "p-queue";
import { supabaseAdmin } from "@/lib/db/supabase";
import {
  upsertDomain, upsertAuthor, upsertArticle, upsertContact, linkArticleAuthor,
  linkAuthorsToCampaign, addWorkflowProspects, isSuppressed,
} from "@/lib/db/queries";
import { fetchRaw, fetchRendered, playwrightEnabled } from "@/lib/indexing/fetchRendered";
import { extractByline, publicationName } from "./authorName";
import { priorContactForHosts, type PriorContact } from "./priorContact";
import { registrableDomain } from "@/lib/util/domain";
import { isLikelyPersonName, cleanAuthorName, isPlaceholderEmail } from "@/lib/enrich/personFilter";
import { type AhrefsBacklink } from "@/lib/writer/ahrefs";
import { cachedAllBacklinks } from "./ahrefsCache";
import { scoreBacklinkProspect } from "./scoring";
import type { BacklinkCampaign } from "./pipeline";

const PAGE_CONCURRENCY = 4;

/** Hard ceiling on rows requested from Ahrefs in one run, whatever the caller asks for. */
const MAX_ROWS = 200;
const DEFAULT_ROWS = 60;

/**
 * Hosts that link but never have a pitchable byline: user-generated platforms, app stores, code
 * hosts, forums, and social. Excluded before fetching rather than after, since each fetch is a
 * second or more and these are consistently the highest-DR rows Ahrefs returns.
 */
const NON_EDITORIAL = new RegExp(
  "(^|\\.)(" + [
    "facebook\\.com", "twitter\\.com", "x\\.com", "t\\.co", "instagram\\.com", "tiktok\\.com",
    "youtube\\.com", "youtu\\.be", "linkedin\\.com", "pinterest\\.[a-z.]+", "reddit\\.com",
    "quora\\.com", "medium\\.com", "wordpress\\.org", "wordpress\\.com", "wixsite\\.com",
    "blogspot\\.[a-z.]+", "apps\\.apple\\.com", "play\\.google\\.com", "apple\\.com",
    "github\\.com", "gitlab\\.com", "stackoverflow\\.com", "stackexchange\\.com",
    "producthunt\\.com", "crunchbase\\.com", "g2\\.com", "capterra\\.com", "trustpilot\\.com",
    "amazon\\.[a-z.]+", "ebay\\.[a-z.]+", "archive\\.org", "wikipedia\\.org", "wikimedia\\.org",
    "substack\\.com", "notion\\.site", "google\\.[a-z.]+", "bing\\.com", "yahoo\\.[a-z.]+",
    // Added after measuring a real run: all of these passed the path test (they publish at
    // /blog/ or /article/) and all of them are dead ends for outreach. Either the post carries
    // no byline, or the "author" is a corporate desk at a company nobody pitches for a link.
    "t\\.me", "telegram\\.me", "vimeo\\.com", "spotify\\.com", "line\\.me",
    "microsoft\\.com", "adobe\\.com", "shopify\\.com", "wix\\.com", "canva\\.com",
    "hubspot\\.com", "salesforce\\.com", "ibm\\.com", "oracle\\.com", "zoom\\.us",
    "soundcloud\\.com", "twitch\\.tv", "discord\\.com", "slideshare\\.net", "issuu\\.com",
  ].join("|") + ")$",
  "i",
);

/** Looks like an article rather than a homepage, tag page or pricing page. */
const EDITORIAL_PATH = /\/(blog|blogs|article|articles|post|posts|news|guide|guides|review|reviews|resources|insights|learn|tutorial|tutorials|best|top|vs|alternatives)(\/|-|$)/i;

export interface BacklinkAuthorReport {
  target: string;
  /** Rows Ahrefs returned (what the run was billed for). */
  rowsReturned: number;
  /** Rows that survived the editorial filter and were actually fetched. */
  pagesRead: number;
  authorsFound: number;
  saved: number;
  skipped: number;
  notes: string[];
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

/** Worth fetching: a real host, not a platform, and a path that reads like an article. */
export function looksEditorial(b: AhrefsBacklink): boolean {
  const host = hostOf(b.url_from);
  if (!host || NON_EDITORIAL.test(host)) return false;
  let path = "";
  try { path = new URL(b.url_from).pathname; } catch { return false; }
  // A bare homepage link is a sponsorship or a footer credit, never a bylined article.
  if (path.replace(/\/+$/, "").length === 0) return false;
  return EDITORIAL_PATH.test(path) || path.split("/").filter(Boolean).length >= 2;
}

/**
 * Find the people who wrote the pages linking to `target`, and file them as prospects.
 *
 * Mirrors runCompetitorAuthors deliberately: same upsert path, same person-name gate, same
 * one-row-per-author rule, same hand-off to the enrichment cascade. Only the source of the page list
 * differs, so a prospect from here is indistinguishable downstream and needs no special handling in
 * the pitch, send or verification stages.
 */
export async function runBacklinkAuthors(
  bl: BacklinkCampaign,
  opts: { target?: string; limit?: number; minDr?: number; maxDr?: number } = {},
): Promise<BacklinkAuthorReport> {
  const notes: string[] = [];
  const target = (opts.target ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase();
  if (!target) {
    return { target: "", rowsReturned: 0, pagesRead: 0, authorsFound: 0, saved: 0, skipped: 0,
      notes: ["No target domain given. Pass the competitor whose backlinks should be mined."] };
  }

  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_ROWS), MAX_ROWS);
  // Default to a BAND, not "strongest first".
  //
  // Measured on a real profile: ordering by DR desc with no ceiling returned 40 rows of which 18
  // were platforms, and of the 22 that passed the path filter only 1 in 8 had a reachable human
  // byline. The DR 90+ tail is Telegram, Vimeo, Microsoft Learn and Spotify — genuine backlinks,
  // useless prospects. A 30-85 band keeps the domains that are authoritative enough to be worth a
  // link and small enough to have a named writer who reads their own inbox.
  const minDr = opts.minDr ?? 30;
  const maxDr = opts.maxDr ?? 85;
  const fetched = await cachedAllBacklinks(target, { limit, minDr, maxDr });
  if (fetched === null) {
    return { target, rowsReturned: 0, pagesRead: 0, authorsFound: 0, saved: 0, skipped: 0,
      notes: ["Ahrefs did not answer. AHREFS_API_KEY may be unset, or the monthly unit budget is spent."] };
  }
  const rows = fetched.rows;
  notes.push(
    `Ahrefs returned ${rows.length} referring domain${rows.length === 1 ? "" : "s"} for ${target}, best domain rating first` +
    (fetched.cached ? ` (served from the fetch cache of ${fetched.fetched_at.slice(0, 10)} — zero units billed).` : "."),
  );

  const candidates = rows.filter(looksEditorial);
  const dropped = rows.length - candidates.length;
  if (dropped) {
    notes.push(`${dropped} skipped as non-editorial (social, app stores, forums, homepages) — real links, but nobody to pitch.`);
  }
  if (!candidates.length) {
    return { target, rowsReturned: rows.length, pagesRead: 0, authorsFound: 0, saved: 0, skipped: dropped, notes };
  }

  const harvest = await harvestAuthors(
    bl,
    candidates.map((b) => ({
      url: b.url_from,
      title: b.title,
      // The angle carries the actual evidence, because it is the strongest thing the pitch has:
      // this person linked to a direct competitor, from this page, on this date.
      angle: [
        `Linked to ${target}`,
        b.first_seen ? ` in ${b.first_seen.slice(0, 7)}` : "",
        " from this page",
        b.is_dofollow === false ? " (nofollow)" : "",
        b.domain_rating_source != null ? `. DR ${Math.round(b.domain_rating_source)}` : "",
      ].join(""),
      score: scoreBacklinkProspect({
        topic: bl.topic, title: b.title, anchor: b.anchor,
        dr: b.domain_rating_source, firstSeen: b.first_seen,
      }),
      dr: b.domain_rating_source ?? null,
      traffic: b.traffic_domain ?? null,
    })),
    "competitor-backlink",
  );

  notes.push(`${harvest.authorsFound} named writer${harvest.authorsFound === 1 ? "" : "s"} from ${harvest.pagesRead} page${harvest.pagesRead === 1 ? "" : "s"} that link to ${target}.`);
  if (harvest.pagesRead && harvest.authorsFound === 0) {
    notes.push("No bylines on any of them. Publisher roundups are often unsigned or credited to a desk, which is normal for this source rather than a failure.");
  }
  if (harvest.duplicates) {
    notes.push(`${harvest.duplicates} of these site${harvest.duplicates === 1 ? " is" : "s are"} already in another campaign or already contacted — flagged in the prospect list, not blocked.`);
  }
  return {
    target, rowsReturned: rows.length, pagesRead: harvest.pagesRead,
    authorsFound: harvest.authorsFound, saved: harvest.saved, skipped: dropped + harvest.skipped, notes,
  };
}

export interface EmailProspectEntry { domain: string; email: string; name?: string | null; position?: string | null }

/**
 * File a human-picked list of ADDRESSES as prospects — the tail of the domain_emails flow, and
 * the fourth supply. No pages are fetched and no bylines guessed: the person already chose who
 * to write to (usually off Hunter's index), so this records exactly that choice. A named person
 * becomes the author; a shared inbox (contacto@, tips@) files under the publication's editorial
 * pseudo-author so no pitch ever greets a wrong first name. Role addresses are stored on
 * purpose — the team uses them to get routed to editors — and the send gate still decides
 * whether the machine may mail one (ALLOW_ROLE_EMAILS).
 */
export async function addEmailProspects(
  bl: BacklinkCampaign,
  entries: EmailProspectEntry[],
  note?: string,
): Promise<{ saved: number; skipped: number; notes: string[] }> {
  const notes: string[] = [];
  const authorIds: string[] = [];
  let saved = 0, skipped = 0;

  // Advisory duplicate check for the person doing the picking: these addresses were chosen by
  // hand, so a collision is worth a note per site — but their pick still stands.
  let prior = new Map<string, PriorContact>();
  try {
    prior = await priorContactForHosts(
      entries.map((e) => (e.domain ?? "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase()).filter(Boolean),
      { excludeCampaignId: bl.id, excludeWorkflowId: bl.workflow_id },
    );
  } catch { /* advisory only */ }

  for (const e of entries) {
    const domain = (e.domain ?? "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase();
    const email = (e.email ?? "").trim().toLowerCase().replace(/^mailto:/, "");
    if (!domain || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { skipped++; notes.push(`"${e.email}": not a usable address — skipped.`); continue; }
    if (isPlaceholderEmail(email)) { skipped++; notes.push(`${email}: a documentation placeholder, not a mailbox — skipped.`); continue; }
    if (await isSuppressed(domain).catch(() => false)) { skipped++; notes.push(`${domain} is suppressed — skipped.`); continue; }
    const hit = prior.get(registrableDomain(domain));
    if (hit) {
      notes.push(`${domain}: ${hit.contactedAt
        ? `already emailed ${hit.contactedAt.slice(0, 10)}${hit.contactedBy ? ` by ${hit.contactedBy}` : ""}`
        : `already in ${hit.otherCampaigns.join(", ")}`} — added anyway, flagged in the prospect list.`);
    }

    try {
      const dom = await upsertDomain(domain, { name: publicationName(domain) });
      const personName = e.name?.trim() || null;
      const author = await upsertAuthor({
        full_name: personName ?? `${publicationName(domain)} Editorial`,
        primary_domain_id: dom.id, source: "manual-email", role: e.position?.trim() || "writer",
      });
      await upsertContact({
        author_id: author.id, type: "mailto", value: `mailto:${email}`,
        confidence: 0.9, source: "manual-email", verified_syntax: true,
        owner_name: personName, owner_position: e.position?.trim() || null,
      }, { allowRole: true }); // a deliberate pick — the one path allowed to store a shared inbox
      await supabaseAdmin.from("backlink_prospects").upsert({
        backlink_campaign_id: bl.id, author_id: author.id, domain,
        prospect_url: `https://${domain}/`,
        angle: note?.trim() || "Address picked by hand from the domain's address book (Hunter index + the page itself).",
        score: null, stage: "found", updated_at: new Date().toISOString(),
      }, { onConflict: "backlink_campaign_id,author_id", ignoreDuplicates: true });
      authorIds.push(author.id);
      saved++;
    } catch { skipped++; }
  }

  if (authorIds.length) {
    await linkAuthorsToCampaign(bl.campaign_id, authorIds).catch(() => {});
    await addWorkflowProspects(bl.workflow_id, authorIds).catch(() => {});
  }
  return { saved, skipped, notes };
}

/** One page to mine for a byline, plus the evidence line its prospect should carry. dr/traffic
 *  ride along when the source already paid Ahrefs for them, and are persisted write-once on the
 *  domain — data billed per row and then discarded is money thrown away twice. */
export interface HarvestItem { url: string; title?: string; angle: string; score?: number; dr?: number | null; traffic?: number | null }

/**
 * URLs in, prospects out. The shared core behind every byline-mining source.
 *
 * Extracted rather than duplicated because the sources differ ONLY in how the URL list is
 * produced. Everything after that has to stay identical or prospects start behaving differently
 * downstream depending on where they came from, which is exactly the drift that left
 * runCompetitorAuthors orphaned and cascade.ts missing two of resolve.ts's steps.
 * (runCompetitorAuthors now routes through here too, which is what gave it the Playwright retry
 * and scoring it silently lacked.)
 */
export async function harvestAuthors(
  bl: BacklinkCampaign,
  items: HarvestItem[],
  source: string,
): Promise<{ pagesRead: number; authorsFound: number; saved: number; skipped: number; authorIds: string[]; duplicates: number }> {
  const { data: existing } = await supabaseAdmin
    .from("backlink_prospects").select("prospect_url").eq("backlink_campaign_id", bl.id);
  const seenUrls = new Set((existing ?? []).map((r: any) => r.prospect_url));

  // Advisory cross-campaign check: how many of these sites already sit in someone else's list or
  // were already emailed. Counted for the report only — never blocks a save, because overlap can
  // be deliberate, and the funnel badge shows the detail per prospect.
  let duplicates = 0;
  try {
    const prior = await priorContactForHosts(
      [...new Set(items.map((i) => hostOf(i.url)).filter(Boolean))] as string[],
      { excludeCampaignId: bl.id, excludeWorkflowId: bl.workflow_id },
    );
    duplicates = prior.size;
  } catch { /* advisory only — a failed check must not fail the harvest */ }

  const queue = new PQueue({ concurrency: PAGE_CONCURRENCY });
  const authorIds: string[] = [];
  // One row per (domain, author). A writer with six pages in the list is ONE prospect, not six.
  const claimedAuthors = new Map<string, string>();
  let pagesRead = 0, authorsFound = 0, saved = 0, skipped = 0;

  await Promise.all(items.map((item) => queue.add(async () => {
    const url = item.url;
    const domain = hostOf(url);
    if (!domain || seenUrls.has(url)) { skipped++; return; }
    if (await isSuppressed(domain).catch(() => false)) { skipped++; return; }

    // Plain fetch first, then a real browser if that produced nothing usable.
    //
    // Measured on a realistic curated list: 2 of 4 pages failed at the plain-fetch step, and both
    // were BLOCKED rather than unsigned (buffer.com, descript.com). That is the dominant failure
    // mode for this feature, not missing bylines — publishers increasingly refuse a bare fetch while
    // serving the same page fine to a browser. Retrying those in Chromium is the difference between
    // "your list produced nothing" and a usable prospect.
    //
    // Second, not first, because a browser page is far slower and most pages never need it.
    // Degrades to a no-op when PLAYWRIGHT_ENABLED is unset or Chromium is missing (Vercel), so this
    // helps locally and on any host with a browser, and changes nothing where there isn't one.
    let html = "";
    const raw = await fetchRaw(url).catch(() => null);
    pagesRead++;
    if (raw?.ok && raw.html) html = raw.html;

    let byline = html ? cleanAuthorName(extractByline(html)) : null;
    if ((!html || !byline) && playwrightEnabled()) {
      const rendered = await fetchRendered(url).catch(() => null);
      if (rendered?.ok && rendered.html) {
        html = rendered.html;
        byline = cleanAuthorName(extractByline(html));
      }
    }
    if (!html) { skipped++; return; }
    if (!byline || !isLikelyPersonName(byline, publicationName(domain))) { skipped++; return; }

    const key = `${domain}|${byline.toLowerCase()}`;
    const already = claimedAuthors.get(key);

    try {
      const title = item.title || html.match(/<title[^>]*>([^<]{2,140})</i)?.[1]?.trim() || url;
      const dom = await upsertDomain(domain, { name: publicationName(domain) });
      // Write-once capture of metrics the source already paid Ahrefs for. UPDATE guarded on NULL:
      // a fresher number someone stored deliberately is never clobbered by ride-along data.
      if (item.dr != null && Number.isFinite(item.dr)) {
        await supabaseAdmin.from("domains")
          .update({ dr: Math.round(item.dr), dr_checked_at: new Date().toISOString(), metrics_source: "ahrefs" })
          .eq("id", dom.id).is("dr", null);
      }
      if (item.traffic != null && Number.isFinite(item.traffic)) {
        await supabaseAdmin.from("domains")
          .update({ organic_traffic: Math.round(item.traffic), traffic_checked_at: new Date().toISOString() })
          .eq("id", dom.id).is("organic_traffic", null);
      }
      const author = already
        ? { id: already }
        : await upsertAuthor({ full_name: byline, primary_domain_id: dom.id, source, role: "writer" });
      const article = await upsertArticle({ url_canonical: url, title, domain_id: dom.id });
      await linkArticleAuthor(article.id, author.id);

      if (!already) {
        claimedAuthors.set(key, author.id);
        authorIds.push(author.id);
        authorsFound++;
        await supabaseAdmin.from("backlink_prospects").upsert({
          backlink_campaign_id: bl.id, author_id: author.id, domain,
          prospect_url: url, angle: item.angle,
          // Ahrefs-backed sources score their items up front (scoring.ts). Anything else is scored
          // here from the fetched title once the campaign has a topic — relevance-weighted with
          // neutral priors for the DR/recency it doesn't know — so "unscored" stops meaning
          // "sorts at the bottom of the funnel unpredictably".
          score: item.score ?? (bl.topic ? scoreBacklinkProspect({ topic: bl.topic, title, dr: item.dr }) : null),
          stage: "found", updated_at: new Date().toISOString(),
        }, { onConflict: "backlink_campaign_id,author_id", ignoreDuplicates: true });
        saved++;
      }
    } catch { skipped++; }
  })));

  if (authorIds.length) {
    await linkAuthorsToCampaign(bl.campaign_id, authorIds).catch(() => {});
    await addWorkflowProspects(bl.workflow_id, authorIds).catch(() => {});
  }
  return { pagesRead, authorsFound, saved, skipped, authorIds, duplicates };
}

export interface UrlAuthorReport {
  urlsGiven: number;
  pagesRead: number;
  authorsFound: number;
  saved: number;
  skipped: number;
  notes: string[];
}

/**
 * Find the author of each page in a list someone pasted in.
 *
 * The SEO team's actual workflow, and deliberately NOT the same feature as runBacklinkAuthors above.
 * They already research a competitor's backlinks in Ahrefs for a specific page and pick out the sites
 * relevant to us. What they want is the last mile: hand the tool that curated list, get the author's
 * address back.
 *
 * Doing it this way is better than the automated version on every axis that matters here:
 *
 *   accuracy   a person chose these pages, so the editorial filter that decides which Ahrefs rows are
 *              worth fetching is unnecessary — and it is the part that throws away good rows.
 *   yield      measured, the automated path finds a usable byline on roughly 1 page in 10, because
 *              most of what links to a video tool is unsigned or a platform. A curated list skips
 *              exactly that problem.
 *   cost       zero Ahrefs units. The research already happened in their Ahrefs seat.
 *
 * No editorial filter is applied. They picked these deliberately, and second-guessing a human's
 * curated list would drop pages they specifically wanted.
 */
export async function runUrlAuthors(
  bl: BacklinkCampaign,
  opts: { urls?: string[]; text?: string; note?: string } = {},
): Promise<UrlAuthorReport> {
  const notes: string[] = [];
  // Accept either a parsed array or raw pasted text. Paste is the realistic input: a column copied
  // out of an Ahrefs export arrives as newline-separated URLs, often with stray commas or quotes.
  const raw = opts.urls?.length ? opts.urls : (opts.text ?? "").split(/[\s,]+/);
  const seen = new Set<string>();
  const urls = raw
    .map((u) => u.trim().replace(/^["'<(]+|["'>).,;]+$/g, ""))
    .filter((u) => /^https?:\/\//i.test(u))
    .filter((u) => { const k = u.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

  if (!urls.length) {
    return { urlsGiven: 0, pagesRead: 0, authorsFound: 0, saved: 0, skipped: 0,
      notes: ["No usable URLs found. Paste full addresses starting with http:// or https://, one per line."] };
  }

  const harvest = await harvestAuthors(
    bl,
    urls.map((url) => ({
      url,
      angle: opts.note?.trim()
        ? opts.note.trim()
        : `Added by hand from a backlink list. Their page already links out on this topic.`,
    })),
    "manual-backlink-list",
  );

  notes.push(`${harvest.authorsFound} named author${harvest.authorsFound === 1 ? "" : "s"} from ${harvest.pagesRead} of ${urls.length} page${urls.length === 1 ? "" : "s"}.`);
  if (harvest.duplicates) {
    notes.push(`${harvest.duplicates} of these site${harvest.duplicates === 1 ? " is" : "s are"} already in another campaign or already contacted — flagged in the prospect list, not blocked.`);
  }
  const noByline = harvest.pagesRead - harvest.authorsFound;
  if (noByline > 0) {
    notes.push(`${noByline} had no readable byline. That is usually an unsigned post or a page that blocks automated fetches, not a bad URL.`);
  }
  if (harvest.saved) {
    notes.push("Email finding has been kicked off for the new authors — addresses appear in the prospect list as they resolve.");
  }
  return {
    urlsGiven: urls.length, pagesRead: harvest.pagesRead, authorsFound: harvest.authorsFound,
    saved: harvest.saved, skipped: harvest.skipped, notes,
  };
}
