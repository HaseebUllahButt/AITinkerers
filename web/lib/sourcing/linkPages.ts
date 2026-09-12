// Footprint prospecting: find pages STRUCTURALLY likely to link out — listicles, resource pages,
// "write for us" pages, roundups — with web-search queries instead of Ahrefs units. This is the
// classic manual SEO-team playbook ("best X tools" + "write for us" + niche) that existed nowhere
// in the codebase; the only query-template search was backlinkTargets' four fixed SERP queries.
//
// Search + shaping only, deliberately no database: the Hermes dispatcher owns already-a-prospect
// annotation and suppression, and the query builder + row shaping stay pure enough for the
// selfcheck to assert without a network.
import { webSearchDetailed, type SearchHit } from "@/lib/search/webSearch";

export type LinkPageKind = "listicle" | "resource" | "guest_post" | "roundup";

export const LINK_PAGE_KINDS: readonly LinkPageKind[] = ["listicle", "resource", "guest_post", "roundup"];

/** Hosts that rank for every footprint but never place an editorial link. */
const DROP_HOSTS =
  /(^|\.)(youtube\.com|reddit\.com|facebook\.com|x\.com|twitter\.com|linkedin\.com|pinterest\.\w+|quora\.com|instagram\.com|tiktok\.com|wikipedia\.org|apps\.apple\.com|play\.google\.com|amazon\.\w+|imagine\.art)$/i;

/** The footprint queries per kind. Pure; `year` is injected so the selfcheck can pin it. */
export function buildFootprintQueries(topic: string, kind: LinkPageKind, year: number): string[] {
  const t = topic.trim().replace(/\s+/g, " ");
  switch (kind) {
    case "listicle":
      return [`best ${t} tools ${year}`, `top ${t} tools compared`, `${t} alternatives`];
    case "resource":
      return [`${t} resources`, `useful ${t} links`, `${t} tools list site:.edu OR site:.org`];
    case "guest_post":
      return [`"write for us" ${t}`, `"guest post" ${t} blog`, `"contribute" ${t} site`];
    case "roundup":
      return [`${t} weekly roundup`, `best ${t} newsletters`, `${t} news roundup blog`];
  }
}

export interface LinkPageRow {
  url: string;
  title: string;
  domain: string;
  snippet: string;
  /** How many of the kind's queries surfaced this page — the frequency signal. */
  hits: number;
}

export function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

/** Merge hits across queries into one best row per domain, most-corroborated first. Pure. */
export function shapeLinkPageRows(hitsPerQuery: SearchHit[][], limit: number): LinkPageRow[] {
  const byUrl = new Map<string, LinkPageRow>();
  for (const hits of hitsPerQuery) {
    for (const h of hits) {
      const domain = hostOf(h.url);
      if (!domain || DROP_HOSTS.test(domain)) continue;
      const row = byUrl.get(h.url);
      if (row) { row.hits++; continue; }
      byUrl.set(h.url, { url: h.url, title: (h.title || h.url).slice(0, 120), domain, snippet: h.snippet.slice(0, 160), hits: 1 });
    }
  }
  // One page per domain — the most corroborated one — then rank by corroboration.
  const bestByDomain = new Map<string, LinkPageRow>();
  for (const row of byUrl.values()) {
    const cur = bestByDomain.get(row.domain);
    if (!cur || row.hits > cur.hits) bestByDomain.set(row.domain, row);
  }
  return [...bestByDomain.values()].sort((a, b) => b.hits - a.hits).slice(0, limit);
}

export interface LinkPagesResult {
  kind: LinkPageKind;
  queries: string[];
  providers: string[];
  rows: LinkPageRow[];
  notes: string[];
}

export async function findLinkPages(opts: {
  topic: string; kind: LinkPageKind; limit?: number; year?: number;
}): Promise<LinkPagesResult> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 50);
  const year = opts.year ?? new Date().getUTCFullYear();
  const queries = buildFootprintQueries(opts.topic, opts.kind, year);
  const notes: string[] = [];
  const providers = new Set<string>();
  const perQuery: SearchHit[][] = [];
  for (const q of queries) {
    const { provider, hits } = await webSearchDetailed(q, 10, undefined, (m) => notes.push(`${q}: ${m}`));
    if (provider) providers.add(provider);
    perQuery.push(hits);
  }
  return { kind: opts.kind, queries, providers: [...providers], rows: shapeLinkPageRows(perQuery, limit), notes };
}
