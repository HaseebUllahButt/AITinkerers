// Find who this site actually competes with.
//
// Three sources, deliberately in this order:
//   1. SEARCH — ask the web "alternatives to X". This is grounded in pages that exist, and it works
//      with no model key at all.
//   2. MODEL — hand the search candidates back to a model to separate real competitors from the
//      review sites and marketplaces that rank for those queries, and to name ones search missed.
//      A model alone would confidently invent plausible-sounding domains; a model given candidates
//      is doing judgement rather than recall.
//   3. ANSWERS — whoever the assistants named in the market read, which is a different signal
//      again: not "who competes" but "who the model reaches for".
//
// Everything is then verified by actually fetching it, because a competitor that does not resolve
// is a hallucination or a dead company, and either way it must not reach the comparison table.
import PQueue from "p-queue";

import { isGenericName, tidyName } from "./generic-words";
import { llmChat, llmEnabled } from "@/lib/providers/llm";
import { searchEnabled, webSearch } from "@/lib/search/webSearch";

export type CompetitorSource = "supplied" | "search" | "model" | "answers";

export interface DiscoveredCompetitor {
  name: string;
  domain: string;
  source: CompetitorSource;
  /** Why this counts as a competitor — shown, so the list is never a black box. */
  reason: string;
  /** How many discovery queries surfaced it. Frequency is the ranking signal. */
  weight: number;
}

export interface CompetitorDiscovery {
  ran: boolean;
  competitors: DiscoveredCompetitor[];
  /** The queries that were run, so the result is reproducible. */
  queries: string[];
  methods: CompetitorSource[];
  note?: string;
}

// Hosts that rank for "alternatives to X" without being an alternative to X. Review aggregators,
// marketplaces, forums, code hosts, docs and social — the noise that fills these SERPs.
const NOT_A_COMPETITOR =
  /^(g2|capterra|trustradius|getapp|softwareadvice|slashdot|sourceforge|alternativeto|producthunt|saasworthy|gartner|forrester)\./i;
const GENERIC_HOSTS = new Set([
  "reddit.com", "quora.com", "medium.com", "substack.com", "dev.to", "hashnode.com",
  "youtube.com", "twitter.com", "x.com", "linkedin.com", "facebook.com", "instagram.com",
  "github.com", "gitlab.com", "stackoverflow.com", "wikipedia.org", "news.ycombinator.com",
  "google.com", "bing.com", "duckduckgo.com", "apple.com", "microsoft.com", "amazon.com",
  "forbes.com", "techcrunch.com", "theverge.com", "wired.com", "businessinsider.com",
  "zapier.com", "hubspot.com", "wordpress.org", "wordpress.com", "notion.so",
]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Is this a plausible competitor domain at all? */
function plausible(domain: string, ownDomain: string): boolean {
  if (!domain || !domain.includes(".")) return false;
  if (domain === ownDomain || domain.endsWith(`.${ownDomain}`) || ownDomain.endsWith(`.${domain}`)) return false;
  if (GENERIC_HOSTS.has(domain)) return false;
  if (NOT_A_COMPETITOR.test(domain)) return false;
  // A registrable name plus a TLD; anything longer is usually a subdomain of a platform.
  if (domain.split(".").length > 3) return false;
  // english.<tld> is a domain, not a rival. Letting one through puts a word that appears in almost
  // every answer into the share-of-voice tally.
  if (isGenericName(domain.replace(/\.[a-z.]+$/, "").split(".").pop() ?? "")) return false;
  return true;
}

function nameFromDomain(domain: string): string {
  const base = domain.replace(/\.[a-z.]+$/, "").split(".").pop() ?? domain;
  return tidyName(base);
}

// ── 1. Search ─────────────────────────────────────────────────────────────────

/**
 * The category, cleaned.
 *
 * `category` arrives as the raw <title>, which is usually "Tagline - Brand". Searching for
 * `best Agentic Infrastructure - Vercel tools` finds nothing, so the brand and any separator
 * tail are stripped and the result is only used if what remains reads like a category.
 */
function categoryQuery(brand: string, category: string): string | null {
  if (!category) return null;
  let c = category;
  // Drop the brand wherever it appears, then any separator debris it leaves behind.
  c = c.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  c = c.replace(/[|–—·:]/g, " ").replace(/\s-\s/g, " ").replace(/\s+/g, " ").trim();
  const words = c.split(" ").filter(Boolean);
  if (words.length < 1 || words.length > 5) return null;
  if (c.length < 3 || c.length > 40) return null;
  // "The system for product development" is a tagline, not a category. A leading article is the
  // cheap, reliable tell — searching it returns the brand's own marketing, not a comparison set.
  if (/^(the|a|an|your|our|we|build|make|ship)\b/i.test(c)) return null;
  return `best ${c} tools`;
}

function buildQueries(brand: string, category: string): string[] {
  const q = [`${brand} alternatives`, `${brand} vs`, `${brand} competitors`];
  const cat = categoryQuery(brand, category);
  if (cat) q.push(cat);
  return q.slice(0, 4);
}

async function fromSearch(brand: string, category: string, ownDomain: string) {
  const queries = buildQueries(brand, category);
  const counts = new Map<string, number>();
  if (!searchEnabled()) return { queries, counts };

  // The queries are independent — running them in a row paid four search latencies for nothing.
  const results = await Promise.all(queries.map((q) => webSearch(q, 10).catch(() => [])));
  for (const hits of results) {
    for (const h of hits) {
      const host = hostOf(h.url);
      if (!host || !plausible(host, ownDomain)) continue;
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
  }
  return { queries, counts };
}

// ── 2. Model ──────────────────────────────────────────────────────────────────

function parseJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a === -1 || b === -1) return null;
  try {
    return JSON.parse(body.slice(a, b + 1));
  } catch {
    return null;
  }
}

async function fromModel(opts: {
  brand: string;
  domain: string;
  category: string;
  bodyExcerpt: string;
  candidates: string[];
}): Promise<{ domain: string; name: string; reason: string }[]> {
  if (!llmEnabled()) return [];

  const res = await llmChat({
    system: "You identify direct competitors for a business. Return STRICT JSON only, no prose.",
    prompt:
      `BRAND: ${opts.brand}\nDOMAIN: ${opts.domain}\nWHAT THEY DO: ${opts.bodyExcerpt.slice(0, 1500)}\n\n` +
      (opts.candidates.length
        ? `A web search for alternatives surfaced these domains. Some are genuine competitors, ` +
          `others are review sites, marketplaces or unrelated:\n${opts.candidates.join(", ")}\n\n`
        : "") +
      "List up to 8 DIRECT competitors — companies a buyer would realistically evaluate instead of " +
      "this one. Keep the genuine ones from the list above and add any obvious ones it missed.\n\n" +
      "Rules: give the company's own primary domain, never a review site or marketplace. Exclude " +
      "the brand itself. If you are not confident a company exists at that exact domain, leave it " +
      "out — a wrong domain is worse than a short list.\n\n" +
      '{"competitors":[{"domain":"example.com","name":"Example","reason":"one clause on why they compete"}]}',
    maxTokens: 1500,
    timeoutMs: 45_000,
  });

  const parsed = parseJson(res?.content ?? "");
  if (!Array.isArray(parsed?.competitors)) return [];
  return parsed.competitors
    .filter((c: any) => typeof c?.domain === "string")
    .map((c: any) => ({
      domain: String(c.domain).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim(),
      name: String(c.name ?? "").trim(),
      reason: String(c.reason ?? "").trim(),
    }))
    .filter((c: { domain: string }) => c.domain.includes("."));
}

// ── 3. Verify ─────────────────────────────────────────────────────────────────
// A competitor that does not answer is not evidence of anything. This is the step that stops a
// model's confident guess from reaching the comparison table as fact.

async function resolves(domain: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${domain}`, {
      method: "GET",
      headers: { "user-agent": "SearchOpsBot/0.1 (+https://searchops.dev)", accept: "text/html" },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Orchestration ─────────────────────────────────────────────────────────────

export async function discoverCompetitors(opts: {
  brand: string;
  domain: string;
  category: string;
  bodyExcerpt: string;
  /** Names typed by the person running the audit — always kept, never second-guessed. */
  supplied?: string[];
  /** Domains the assistants named in the market read. */
  fromAnswers?: { name: string; domain: string | null }[];
  limit?: number;
}): Promise<CompetitorDiscovery> {
  const limit = opts.limit ?? 5;
  const own = opts.domain.replace(/^www\./, "");
  const methods: CompetitorSource[] = [];
  const merged = new Map<string, DiscoveredCompetitor>();

  const add = (c: DiscoveredCompetitor) => {
    const existing = merged.get(c.domain);
    if (!existing) {
      merged.set(c.domain, c);
      return;
    }
    // Keep the earliest (most trusted) source, but accumulate the frequency signal.
    existing.weight += c.weight;
    if (!existing.reason && c.reason) existing.reason = c.reason;
  };

  // Supplied names win outright.
  for (const raw of opts.supplied ?? []) {
    const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (!d.includes(".") || d === own) continue;
    add({ domain: d, name: nameFromDomain(d), source: "supplied", reason: "You named this one.", weight: 100 });
  }
  if (merged.size) methods.push("supplied");

  const { queries, counts } = await fromSearch(opts.brand, opts.category, own);
  if (counts.size) methods.push("search");
  for (const [domain, weight] of counts) {
    add({
      domain,
      name: nameFromDomain(domain),
      source: "search",
      reason: `Appeared in ${weight} of ${queries.length} alternative searches.`,
      weight,
    });
  }

  // The model sees what search found and decides which of them are real.
  const candidates = [...counts.keys()].slice(0, 20);
  const modelPicks = await fromModel({
    brand: opts.brand,
    domain: own,
    category: opts.category,
    bodyExcerpt: opts.bodyExcerpt,
    candidates,
  });
  if (modelPicks.length) methods.push("model");
  for (const m of modelPicks) {
    if (!plausible(m.domain, own)) continue;
    add({
      domain: m.domain,
      name: m.name || nameFromDomain(m.domain),
      source: "model",
      reason: m.reason || "Named as a direct competitor.",
      // Below a search hit on its own, above nothing — corroboration by both is what ranks.
      weight: 2,
    });
  }

  for (const a of opts.fromAnswers ?? []) {
    if (!a.domain || !plausible(a.domain, own)) continue;
    add({
      domain: a.domain,
      name: a.name || nameFromDomain(a.domain),
      source: "answers",
      reason: "An assistant named this one when asked about the category.",
      weight: 1,
    });
  }
  if ((opts.fromAnswers ?? []).length) methods.push("answers");

  // Rank, then verify. In parallel now: a domain that takes its full 8s timeout no longer blocks
  // every check behind it. The burst is bounded — enough candidates to fill the list, a few deep.
  const ranked = [...merged.values()].sort((a, b) => b.weight - a.weight);
  const toCheck = ranked.slice(0, Math.max(limit * 3, limit + 5));
  const queue = new PQueue({ concurrency: 5 });
  const oks = await Promise.all(toCheck.map((c) =>
    queue.add(() => c.source === "supplied" ? Promise.resolve(true) : resolves(c.domain))));
  const verified = toCheck.filter((_, i) => oks[i]).slice(0, limit);

  if (!verified.length) {
    return {
      ran: false,
      competitors: [],
      queries,
      methods,
      note: searchEnabled()
        ? "No competitors could be identified. Search returned nothing usable and no model is available to suggest any — type them in above."
        : "No search provider is configured and no model is available, so competitors cannot be discovered. Type them in above.",
    };
  }

  return { ran: true, competitors: verified, queries, methods };
}
