// Best-effort byline extraction for a backlink prospect page. Backlink targets are often
// roundups/listicles; if we can find a real author byline we outreach to a person, otherwise we
// fall back to a "<Publication> Editorial" pseudo-author so the record still fits the existing
// authors schema and enrichment can try to find a real contact.
import * as cheerio from "cheerio";
import { isLikelyPersonName } from "@/lib/enrich/personFilter";
import { extractPageAuthor } from "@/lib/linkaudit/run";

export function extractByline(html: string): string | null {
  const $ = cheerio.load(html);
  const raw = [
    $('meta[name="author"]').attr("content"),
    $('meta[property="article:author"]').attr("content"),
    $('[rel="author"]').first().text(),
    $('[itemprop="author"]').first().text(),
    $('.author-name, .byline__name, .post-author, .author, .byline').first().text(),
  ];
  for (const c of raw) {
    const name = (c || "")
      .replace(/^\s*by\s+/i, "")
      .split(/[|,·—\n]/)[0]
      .replace(/\s+/g, " ")
      .trim();
    if (name && isLikelyPersonName(name)) return name;
  }

  // Fall through to the link-audit's extractor, which is strictly stronger and predates this one.
  //
  // Same drift the enrichment cascade had: two byline extractors grew up in parallel, and the one
  // the backlink pipeline happened to call is the weaker of the two. This version reads meta tags,
  // rel/itemprop and a handful of CSS classes; extractPageAuthor also reads JSON-LD, author-bio
  // boxes ("<h3>Name</h3><p>Name is a...") and avatar-alt bylines.
  //
  // Measured: zapier.com/blog/best-ai-video-generator carries a textbook
  // "author":{"@type":"Person","name":"Miguel Rebelo"} and this function returned null for it,
  // because it has no JSON-LD path at all. JSON-LD is the most common modern byline format, so that
  // gap was costing prospects across every source that calls this.
  //
  // Ordered second rather than first so the existing behaviour is unchanged wherever it already
  // worked, and the regex-based fallback only runs when the DOM lookups found nothing.
  const fallback = extractPageAuthor(html);
  if (fallback) {
    const name = fallback.replace(/^\s*by\s+/i, "").split(/[|,·—\n]/)[0].replace(/\s+/g, " ").trim();
    if (name && isLikelyPersonName(name)) return name;
  }
  return null;
}

/** "cnet.com" -> "CNET", "smashingmagazine.com" -> "Smashingmagazine". */
export function publicationName(domain: string): string {
  const core = domain.replace(/^www\./, "").split(".")[0];
  return core.length <= 4 ? core.toUpperCase() : core.charAt(0).toUpperCase() + core.slice(1);
}
