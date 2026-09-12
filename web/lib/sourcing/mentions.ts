// Unlinked brand mentions: pages that already talk about imagine.art but do not link to it — the
// warmest cold prospect there is, because the editorial decision to mention us was already made
// and the ask is one <a> tag. Search for the brand terms, fetch each distinct-domain hit, and
// check the page's anchors for a link to any of our hosts.
import * as cheerio from "cheerio";
import PQueue from "p-queue";
import { webSearchDetailed, type SearchHit } from "@/lib/search/webSearch";
import { fetchRaw } from "@/lib/indexing/fetchRendered";
import { hostOf } from "./linkPages";

export const OUR_HOSTS = ["imagine.art"];

const SKIP_HOSTS =
  /(^|\.)(youtube\.com|reddit\.com|facebook\.com|x\.com|twitter\.com|linkedin\.com|pinterest\.\w+|quora\.com|instagram\.com|tiktok\.com|apps\.apple\.com|play\.google\.com|imagine\.art)$/i;

/** Does this HTML contain an anchor to any of our hosts? Pure (cheerio over a string), so the
 *  selfcheck can assert both directions with fixture markup. Href-relative resolution doesn't
 *  matter here: a link to us is by definition absolute or protocol-relative. */
export function htmlLinksToUs(html: string, ourHosts: string[] = OUR_HOSTS): boolean {
  const $ = cheerio.load(html);
  let found = false;
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const m = href.match(/^(?:https?:)?\/\/([^/]+)/i);
    if (!m) return;
    const host = m[1].replace(/^www\./, "").toLowerCase();
    if (ourHosts.some((h) => host === h || host.endsWith(`.${h}`))) found = true;
  });
  return found;
}

export interface MentionRow {
  url: string;
  title: string;
  domain: string;
  linked: boolean | null; // null = page could not be fetched, so unknown
  matched_term: string;
}

export interface MentionsResult {
  terms: string[];
  providers: string[];
  checked: number;
  rows: MentionRow[];
  notes: string[];
}

export async function findUnlinkedMentions(opts: { terms?: string[]; limit?: number } = {}): Promise<MentionsResult> {
  const terms = (opts.terms?.length ? opts.terms : ["\"imagine.art\"", "\"ImagineArt\""]).slice(0, 4);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 40);
  const notes: string[] = [];
  const providers = new Set<string>();

  const candidates = new Map<string, SearchHit & { term: string }>(); // one per domain
  for (const term of terms) {
    const { provider, hits } = await webSearchDetailed(term, 10, undefined, (m) => notes.push(`${term}: ${m}`));
    if (provider) providers.add(provider);
    for (const h of hits) {
      const domain = hostOf(h.url);
      if (!domain || SKIP_HOSTS.test(domain) || candidates.has(domain)) continue;
      candidates.set(domain, { ...h, term });
    }
  }

  const queue = new PQueue({ concurrency: 4 });
  const rows: MentionRow[] = [];
  await Promise.all([...candidates.values()].slice(0, limit).map((c) => queue.add(async () => {
    const raw = await fetchRaw(c.url).catch(() => null);
    const linked = raw?.ok && raw.html ? htmlLinksToUs(raw.html) : null;
    rows.push({ url: c.url, title: (c.title || c.url).slice(0, 120), domain: hostOf(c.url), linked, matched_term: c.term });
  })));

  // Unlinked first (the point of the exercise), unknown after, already-linked last.
  rows.sort((a, b) => Number(a.linked === true) - Number(b.linked === true) || Number(a.linked === null) - Number(b.linked === null));
  return { terms, providers: [...providers], checked: rows.length, rows, notes };
}
