// Template inference + money-page classification (PRD R1, §5.1). CWV and indexing problems
// cluster BY TEMPLATE, not by URL (one hero pattern or one JS bundle degrades thousands of
// pages), so every URL is mapped to a template key and analyzed per-template.

// Money-page path patterns (revenue-critical → P0 on breakage). Mirrors the money-page list
// in the SEO brief; supports one trailing "*" wildcard. Tune as the real list is confirmed.
export const MONEY_PAGE_PATTERNS = [
  "/ai-image-generator",
  "/ai-video-generator",
  "/apps/*",
  "/features/*",
];

/** True if `path` matches any money-page pattern (supports one trailing "*"). */
export function isMoneyPage(path: string, patterns: string[] = MONEY_PAGE_PATTERNS): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*")
      ? path.startsWith(pattern.slice(0, -1))
      : path === pattern || path === `${pattern}/`,
  );
}

/** Normalize a URL or path to a clean pathname (no query/hash, no trailing slash). */
export function toPath(urlOrPath: string): string {
  let path = urlOrPath;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    const q = path.search(/[?#]/);
    if (q >= 0) path = path.slice(0, q);
  }
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
}

/**
 * Map a path to a template key. Families with a dynamic last segment collapse to
 * `seg/[slug]` (or `seg/[...]` when deeper) so programmatic pages cluster; distinct
 * top-level marketing pages keep their own key.
 *   /                        → "home"
 *   /ai-image-generator      → "/ai-image-generator"
 *   /apps/text-to-video      → "apps/[slug]"
 *   /features/upscale        → "features/[slug]"
 *   /blog/how-to-x           → "blog/[slug]"
 *   /tools/video/trim        → "tools/[...]"
 */
export function inferTemplate(urlOrPath: string): string {
  const path = toPath(urlOrPath);
  if (path === "/") return "home";
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 1) return `/${segments[0]}`;
  if (segments.length === 2) return `${segments[0]}/[slug]`;
  return `${segments[0]}/[...]`;
}
