import type { SeedTool } from "@/lib/types";

export function detectMentions(text: string, tools: SeedTool[]): { tool: string; count: number }[] {
  const lower = text.toLowerCase();
  const results: { tool: string; count: number }[] = [];

  for (const tool of tools) {
    const terms = [tool.name, ...(Array.isArray(tool.aliases) ? tool.aliases : [])];
    let count = 0;

    for (const term of terms) {
      const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const matches = lower.match(re);
      count += matches?.length ?? 0;
    }

    if (count > 0) {
      results.push({ tool: tool.name, count });
    }
  }

  return results.sort((a, b) => b.count - a.count);
}

export function extractOutboundLinks(html: string, baseUrl: string): { url: string; anchor: string }[] {
  const links: { url: string; anchor: string }[] = [];
  const base = new URL(baseUrl);

  const linkPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;

  while ((m = linkPattern.exec(html)) !== null) {
    const href = m[1]?.trim();
    const anchor = m[2]?.replace(/<[^>]+>/g, "").trim().slice(0, 100);

    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;

    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.hostname !== base.hostname) {
        links.push({ url: resolved.href, anchor: anchor ?? "" });
      }
    } catch {}
  }

  return links.slice(0, 100);
}

// Path segments that mark navigation/section/utility pages rather than articles — an
// author archive page links to plenty of these alongside their actual posts.
const NON_ARTICLE_PATH_SEGMENTS = new Set([
  "category", "categories", "tag", "tags", "topic", "topics", "author", "authors", "page",
  "about", "contact", "subscribe", "newsletter", "search", "login", "signup", "register",
  "privacy", "terms", "sitemap", "feed", "rss", "advertise", "careers", "jobs", "shop", "store",
]);

// Same-domain links only — the complement of extractOutboundLinks. Used to harvest an
// author's own archive/page for their other articles (author-watch rechecks, writer-seeded
// discovery) rather than to track who they link out to. Filters out obvious nav/section
// pages (real article slugs are almost always multi-segment or hyphenated).
export function extractSameDomainLinks(html: string, baseUrl: string, limit = 100): string[] {
  const base = new URL(baseUrl);
  const links = new Set<string>();

  // Capture anchor text too — a short label ("Tech", "Reviews") reads as a nav/section
  // link, while a real headline is almost always longer. This plus the path heuristics
  // below meaningfully cuts nav/category noise out of an author archive page's link list.
  const linkPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;

  while ((m = linkPattern.exec(html)) !== null) {
    const href = m[1]?.trim();
    const anchor = m[2]?.replace(/<[^>]+>/g, "").trim() ?? "";
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    if (anchor.length > 0 && anchor.length < 15) continue; // short label — nav/section link, not a headline
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.hostname !== base.hostname) continue;
      const segments = resolved.pathname.split("/").filter(Boolean);
      if (segments.length === 0) continue; // homepage
      if (segments.some((s) => NON_ARTICLE_PATH_SEGMENTS.has(s.toLowerCase()))) continue;
      // A lone short segment with no hyphen (e.g. /tech, /science) reads as a section link,
      // not an article slug — real article slugs are almost always longer or hyphenated.
      if (segments.length === 1 && segments[0].length < 20 && !segments[0].includes("-")) continue;
      resolved.hash = "";
      links.add(resolved.href);
    } catch {}
    if (links.size >= limit) break;
  }

  return [...links];
}
