// The three files a site publishes about itself: robots.txt, llms.txt, and the sitemap.
//
// All three are fetched the same way and all three are optional, so a miss is a finding rather than
// an error. Nothing here throws: a site that 404s its robots.txt is a normal, reportable result.
import { XMLParser } from "fast-xml-parser";

import { AI_BOTS, type AiBot } from "@/lib/geo/bots";

const UA = "SearchOpsBot/0.1 (+https://searchops.dev)";
const TIMEOUT = 12_000;

async function getText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "*/*" },
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: "follow",
    });
    const text = res.ok ? await res.text() : "";
    return { ok: res.ok, status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: "" };
  }
}

// ── robots.txt ────────────────────────────────────────────────────────────────
// Parsed per user-agent group, because the whole point is which AGENT is allowed, not whether the
// file exists. A `Disallow: /` under a named bot is the finding; the same line under `*` is a
// different, much louder finding.

export interface RobotsGroup {
  agents: string[];
  disallow: string[];
  allow: string[];
}

export interface BotAccess {
  bot: AiBot;
  /** Blocked at the root — this agent cannot read the site at all. */
  blocked: boolean;
  /** The group that decided it, for evidence. */
  via: string;
}

export interface RobotsReport {
  found: boolean;
  status: number;
  url: string;
  sitemaps: string[];
  groups: RobotsGroup[];
  /** Per AI crawler: can it read the site, and what does blocking it cost. */
  aiAccess: BotAccess[];
  /** Blocked agents whose `controls` is "retrieval" — the ones that cost real visibility. */
  retrievalBlocked: BotAccess[];
}

function parseRobots(text: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      // Consecutive user-agent lines share one group of rules.
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "disallow") current.disallow.push(value);
    else if (field === "allow") current.allow.push(value);
  }
  return { groups, sitemaps };
}

/** Does this group shut the agent out of the whole site? `Disallow: /` with no re-allow. */
function blocksEverything(g: RobotsGroup): boolean {
  const denyRoot = g.disallow.some((d) => d === "/");
  if (!denyRoot) return false;
  return !g.allow.some((a) => a === "/" || a === "");
}

function accessFor(bot: AiBot, groups: RobotsGroup[]): BotAccess {
  // A group naming the agent wins over the wildcard, exactly as crawlers resolve it.
  const named = groups.find((g) => g.agents.some((a) => a === bot.match));
  if (named) return { bot, blocked: blocksEverything(named), via: bot.match };
  const wildcard = groups.find((g) => g.agents.includes("*"));
  if (wildcard) return { bot, blocked: blocksEverything(wildcard), via: "*" };
  return { bot, blocked: false, via: "(no matching group)" };
}

export async function fetchRobots(origin: string): Promise<RobotsReport> {
  const url = new URL("/robots.txt", origin).toString();
  const res = await getText(url);
  if (!res.ok || !res.text.trim()) {
    // No robots.txt means everything is permitted — worth saying explicitly rather than leaving blank.
    return {
      found: false, status: res.status, url, sitemaps: [], groups: [],
      aiAccess: AI_BOTS.map((bot) => ({ bot, blocked: false, via: "(no robots.txt)" })),
      retrievalBlocked: [],
    };
  }
  const { groups, sitemaps } = parseRobots(res.text);
  const aiAccess = AI_BOTS.map((bot) => accessFor(bot, groups));
  return {
    found: true,
    status: res.status,
    url,
    sitemaps,
    groups,
    aiAccess,
    retrievalBlocked: aiAccess.filter((a) => a.blocked && a.bot.controls === "retrieval"),
  };
}

// ── llms.txt ──────────────────────────────────────────────────────────────────
// A markdown file at /llms.txt describing the site for language models. Still a proposal rather
// than a standard, so absence is not a defect — but presence is a real signal, and a present-but-
// empty one is worse than none because it looks handled.

export interface LlmsTxtReport {
  found: boolean;
  status: number;
  url: string;
  bytes: number;
  /** Top-level markdown headings, which is what the file is supposed to carry. */
  headings: string[];
  /** Links listed in the file, the part a model actually follows. */
  linkCount: number;
  preview: string;
  /** /llms-full.txt, the expanded companion. */
  fullFound: boolean;
}

export async function fetchLlmsTxt(origin: string): Promise<LlmsTxtReport> {
  const url = new URL("/llms.txt", origin).toString();
  const res = await getText(url);

  // Some hosts answer every path with the SPA shell; an HTML body here is a miss, not a hit.
  const looksHtml = /^\s*<(!doctype|html)/i.test(res.text);
  const found = res.ok && res.text.trim().length > 0 && !looksHtml;

  let fullFound = false;
  if (found) {
    const full = await getText(new URL("/llms-full.txt", origin).toString());
    fullFound = full.ok && full.text.trim().length > 0 && !/^\s*<(!doctype|html)/i.test(full.text);
  }

  return {
    found,
    status: res.status,
    url,
    bytes: found ? new TextEncoder().encode(res.text).length : 0,
    headings: found
      ? res.text.split(/\r?\n/).filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.replace(/^#+\s*/, "").trim()).slice(0, 20)
      : [],
    linkCount: found ? (res.text.match(/\]\(https?:\/\//g) ?? []).length : 0,
    preview: found ? res.text.slice(0, 600) : "",
    fullFound,
  };
}

// ── sitemap ───────────────────────────────────────────────────────────────────
// Index files point at further sitemaps, so this follows one level down — enough for almost every
// real site, and bounded so a misconfigured index cannot walk forever.

export interface SitemapReport {
  found: boolean;
  /** Every sitemap actually read (an index plus its children). */
  sources: string[];
  urlCount: number;
  sample: string[];
  /** Newest lastmod seen, a cheap freshness read. */
  newestLastmod: string | null;
  error?: string;
}

const parser = new XMLParser({ ignoreAttributes: false, isArray: (n) => n === "url" || n === "sitemap" });

async function readSitemap(url: string, depth: number): Promise<{ urls: string[]; lastmods: string[]; sources: string[] }> {
  const out = { urls: [] as string[], lastmods: [] as string[], sources: [] as string[] };
  const res = await getText(url);
  if (!res.ok || !res.text.trim()) return out;
  out.sources.push(url);

  let doc: any;
  try {
    doc = parser.parse(res.text);
  } catch {
    return out;
  }

  if (doc?.sitemapindex?.sitemap && depth > 0) {
    const children = doc.sitemapindex.sitemap.slice(0, 25);
    for (const c of children) {
      const loc = typeof c?.loc === "string" ? c.loc.trim() : "";
      if (!loc) continue;
      const nested = await readSitemap(loc, depth - 1);
      out.urls.push(...nested.urls);
      out.lastmods.push(...nested.lastmods);
      out.sources.push(...nested.sources);
      if (out.urls.length > 50_000) break;
    }
    return out;
  }

  for (const u of doc?.urlset?.url ?? []) {
    const loc = typeof u?.loc === "string" ? u.loc.trim() : "";
    if (loc) out.urls.push(loc);
    if (typeof u?.lastmod === "string") out.lastmods.push(u.lastmod.trim());
  }
  return out;
}

export async function fetchSitemap(origin: string, declared: string[]): Promise<SitemapReport> {
  // Prefer what robots.txt declares; fall back to the conventional locations.
  const candidates = declared.length
    ? declared
    : [new URL("/sitemap.xml", origin).toString(), new URL("/sitemap_index.xml", origin).toString()];

  for (const candidate of candidates) {
    const { urls, lastmods, sources } = await readSitemap(candidate, 1);
    if (urls.length || sources.length) {
      const newest = lastmods.map((d) => Date.parse(d)).filter((n) => !Number.isNaN(n)).sort((a, b) => b - a)[0];
      return {
        found: urls.length > 0,
        sources,
        urlCount: urls.length,
        sample: urls.slice(0, 12),
        newestLastmod: newest ? new Date(newest).toISOString().slice(0, 10) : null,
      };
    }
  }
  return { found: false, sources: [], urlCount: 0, sample: [], newestLastmod: null, error: "no readable sitemap" };
}
