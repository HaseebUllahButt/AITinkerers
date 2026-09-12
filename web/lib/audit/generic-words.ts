/**
 * Words that are not brands.
 *
 * Two different bugs share one cause. Competitor discovery ranks whatever domains recur in
 * "alternatives to X" results, and some of those are generic — `english.<tld>`, `online.<tld>` —
 * which then enter the comparison as a company. Worse, share of voice counts a brand as named when
 * its name appears in an answer, so a "brand" called English matches nearly every reply about
 * anything and reports a double-digit share it never earned.
 *
 * So a generic name is refused as a competitor outright, and any brand whose name is on this list
 * must be matched by DOMAIN rather than by name before it counts as a mention.
 */
const GENERIC = new Set([
  // Languages and places that show up as domain names
  "english", "spanish", "french", "german", "chinese", "japanese", "global", "world",
  // Marketing filler that ranks for "best X" queries
  "best", "top", "free", "online", "cheap", "pro", "plus", "premium", "official", "review",
  "reviews", "compare", "comparison", "alternative", "alternatives", "versus", "guide",
  // Category nouns
  "tool", "tools", "app", "apps", "software", "platform", "service", "services", "solution",
  "solutions", "system", "systems", "product", "products", "site", "website", "web", "page",
  "pages", "blog", "news", "home", "cloud", "data", "api", "dev", "code", "team", "teams",
  "work", "project", "projects", "task", "tasks", "issue", "issues", "board", "boards",
  "search", "engine", "content", "media", "digital", "agency", "studio", "labs", "group",
  "company", "inc", "llc", "ltd", "shop", "store", "market", "hub", "space", "zone", "spot",
]);

export function isGenericName(name: string): boolean {
  return GENERIC.has(name.trim().toLowerCase());
}

/** Title-case a name that arrived all lowercase from a domain, leaving real casing alone. */
export function tidyName(name: string): string {
  const t = name.trim();
  if (!t) return t;
  return t === t.toLowerCase() ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
