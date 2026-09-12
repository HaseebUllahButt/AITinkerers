// Writer/article-seeded discovery — given a writer's name and/or one article URL, find
// their page and pull in candidate URLs for their other articles on that site. Feeds
// discovery_hits the same way keyword harvesters do; Stage 2 (processHit) profiles them.
import { fetchPage } from "@/lib/extract/fetch";
import { extractMetadata } from "@/lib/extract/metadata";
import { extractSameDomainLinks } from "@/lib/extract/mentions";
import { isLikelyPersonName, cleanAuthorName } from "@/lib/enrich/personFilter";
import { googleNewsHarvester } from "@/lib/harvesters/googlenews";
import { duckduckgoHarvester } from "@/lib/harvesters/duckduckgo";
import { webSearchHarvester } from "@/lib/harvesters/websearch";
import { searchEnabled } from "@/lib/search/webSearch";

export interface AuthorSeedResult {
  authorPageUrl?: string;
  domain: string;
  sampleArticleUrl: string;
  resolvedName: string;
}

function normalizeName(n: string): string {
  return n.toLowerCase().replace(/[^a-z\s]/g, "").trim();
}

function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a), nb = normalizeName(b);
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
}

// Given an article URL, extract its byline/domain/author-page directly — ground truth,
// no search needed.
async function resolveFromArticleUrl(articleUrl: string, expectedName?: string): Promise<AuthorSeedResult | null> {
  const fetched = await fetchPage(articleUrl);
  if (!fetched) return null;
  const meta = extractMetadata(fetched.html, fetched.finalUrl);
  const byline = cleanAuthorName(meta.author);
  if (!byline || !isLikelyPersonName(byline, meta.publisher)) return null;
  if (expectedName && !namesMatch(byline, expectedName)) {
    // The article's real byline doesn't match the given name — trust the article (ground
    // truth) but flag the mismatch isn't fatal, just use what we actually found.
  }
  let host: string;
  try { host = new URL(fetched.finalUrl).hostname; } catch { return null; }
  return { authorPageUrl: meta.authorUrl, domain: host, sampleArticleUrl: fetched.finalUrl, resolvedName: byline };
}

// Given only a name, search for them (free + paid search, per campaign owner's choice) and
// accept the first candidate whose actual byline matches the given name.
async function resolveFromName(name: string): Promise<AuthorSeedResult | null> {
  const query = `"${name}" writer articles`;
  const [gn, ddg, ws] = await Promise.all([
    googleNewsHarvester.run(query, { maxResults: 8 }).catch(() => []),
    duckduckgoHarvester.run(query, { maxResults: 8 }).catch(() => []),
    searchEnabled() ? webSearchHarvester.run(query, { maxResults: 8 }).catch(() => []) : Promise.resolve([]),
  ]);
  const candidates = [...ws, ...gn, ...ddg].slice(0, 8); // paid search first — better precision

  for (const c of candidates) {
    const result = await resolveFromArticleUrl(c.url, name).catch(() => null);
    if (result && namesMatch(result.resolvedName, name)) return result;
  }
  return null;
}

export async function resolveAuthorSeed(seed: { name?: string; articleUrl?: string }): Promise<AuthorSeedResult | null> {
  if (seed.articleUrl) return resolveFromArticleUrl(seed.articleUrl, seed.name);
  if (seed.name) return resolveFromName(seed.name);
  return null;
}

// Pull the author's other articles from their known page — same-domain links only, capped,
// deduped against what we already have.
export async function harvestAuthorArchive(authorPageUrl: string, existingUrls: Set<string>, limit = 50): Promise<string[]> {
  const fetched = await fetchPage(authorPageUrl);
  if (!fetched) return [];
  const links = extractSameDomainLinks(fetched.html, fetched.finalUrl, limit * 2);
  return links.filter((u) => !existingUrls.has(u)).slice(0, limit);
}
