// URL discovery + robots.txt (PRD R1/§6.2). Reads the sitemap (handling a sitemap index),
// stratifies a bounded sample across templates so a small run still shows render-mode
// clustering, and parses robots.txt into a disallow matcher for the gate's ROBOTS check.
import { XMLParser } from "fast-xml-parser";
import { inferTemplate, isMoneyPage, toPath, MONEY_PAGE_PATTERNS } from "./template";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function getText(url: string, timeoutMs = 12_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/xml,text/xml,text/plain,*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Collect <loc> URLs from a sitemap or sitemap index (one level of nesting). */
async function collectSitemapUrls(sitemapUrl: string, cap = 5000): Promise<string[]> {
  const xml = await getText(sitemapUrl);
  if (!xml) return [];
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }

  if (doc?.sitemapindex) {
    const children = asArray<any>(doc.sitemapindex.sitemap)
      .map((s) => s?.loc)
      .filter(Boolean) as string[];
    const out: string[] = [];
    // Bound the number of child sitemaps we fetch so discovery stays quick.
    for (const child of children.slice(0, 10)) {
      const urls = await collectSitemapUrls(child, cap);
      out.push(...urls);
      if (out.length >= cap) break;
    }
    return out;
  }

  if (doc?.urlset) {
    return (asArray<any>(doc.urlset.url).map((u) => u?.loc).filter(Boolean) as string[]).slice(0, cap);
  }
  return [];
}

/** Stratified sample: round-robin across templates so a small limit spans page types. */
function stratifiedSample(urls: string[], limit: number): string[] {
  const byTemplate = new Map<string, string[]>();
  for (const u of urls) {
    const t = inferTemplate(u);
    (byTemplate.get(t) ?? byTemplate.set(t, []).get(t)!).push(u);
  }
  const buckets = [...byTemplate.values()];
  const out: string[] = [];
  let i = 0;
  while (out.length < limit && buckets.some((b) => b.length > 0)) {
    const bucket = buckets[i % buckets.length];
    const next = bucket.shift();
    if (next) out.push(next);
    i += 1;
  }
  return out;
}

export interface DiscoverOptions {
  domain?: string;
  sitemapUrl?: string;
  robotsUrl?: string;
  limit?: number;
  /** Restrict to URLs whose inferred template matches this key. */
  template?: string;
  /** Force money pages into the sample first. */
  moneyFirst?: boolean;
}

export interface Discovery {
  urls: string[];
  totalDiscovered: number;
  robots: RobotsMatcher;
  notes: string[];
}

/** Seed URLs used when the sitemap can't be read. */
function seedUrls(domain: string): string[] {
  return MONEY_PAGE_PATTERNS.filter((p) => !p.includes("*")).map((p) => `https://${domain}${p}`);
}

/**
 * Every money-page path in the full sitemap (no sampling) — for UI pickers ("pick a page you
 * want backlinks/links to") where the point is complete coverage of real candidates, not a
 * bounded crawl sample. Just parses sitemap.xml; no rendering, no per-page fetches.
 */
export async function listMoneyPages(domain = "northwind.example"): Promise<string[]> {
  const all = await collectSitemapUrls(`https://${domain}/sitemap.xml`);
  const paths = (all.length ? all : seedUrls(domain)).map(toPath).filter((p) => isMoneyPage(p));
  return [...new Set(paths)].sort();
}

export async function discover(opts: DiscoverOptions = {}): Promise<Discovery> {
  const domain = opts.domain ?? "northwind.example";
  const sitemapUrl = opts.sitemapUrl ?? `https://${domain}/sitemap.xml`;
  const robotsUrl = opts.robotsUrl ?? `https://${domain}/robots.txt`;
  const limit = opts.limit ?? 20;
  const notes: string[] = [];

  const robots = await loadRobots(robotsUrl);

  let all = await collectSitemapUrls(sitemapUrl);
  const totalDiscovered = all.length;
  if (all.length === 0) {
    notes.push(`No URLs from ${sitemapUrl} — falling back to a money-page seed list.`);
    all = seedUrls(domain);
  } else {
    notes.push(`Discovered ${all.length} URLs from sitemap.`);
  }

  if (opts.template) {
    all = all.filter((u) => inferTemplate(u) === opts.template);
    notes.push(`Filtered to template "${opts.template}": ${all.length} URLs.`);
  }

  let sample = stratifiedSample(all, limit);

  if (opts.moneyFirst) {
    const money = all.filter((u) => isMoneyPage(toPath(u)));
    const merged = [...new Set([...money.slice(0, limit), ...sample])].slice(0, limit);
    sample = merged;
  }

  return { urls: sample, totalDiscovered, robots, notes };
}

// ── robots.txt ──────────────────────────────────────────────────────────────
export interface RobotsMatcher {
  disallowed: (path: string) => boolean;
  rules: string[];
}

export async function loadRobots(robotsUrl: string): Promise<RobotsMatcher> {
  const txt = await getText(robotsUrl, 8000);
  if (!txt) return { disallowed: () => false, rules: [] };

  // Collect Disallow rules under the global (User-agent: *) group.
  const lines = txt.split(/\r?\n/).map((l) => l.trim());
  const disallows: string[] = [];
  let inStar = false;
  for (const line of lines) {
    if (/^user-agent:/i.test(line)) {
      inStar = line.split(":")[1]?.trim() === "*";
    } else if (inStar && /^disallow:/i.test(line)) {
      const path = line.split(":").slice(1).join(":").trim();
      if (path) disallows.push(path);
    }
  }
  const prefixes = disallows.map((d) => d.replace(/\*$/, ""));
  return {
    rules: disallows,
    disallowed: (path: string) => prefixes.some((p) => p !== "" && path.startsWith(p)),
  };
}
