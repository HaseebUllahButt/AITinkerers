// On-page signal extraction for the indexability battery (PRD §6.3). Runs on BOTH the raw
// and the rendered HTML so the caller can diff them (render-mode / js-gated detection).
// Uses cheerio (a repo dependency) for correct element counting + text extraction.
import * as cheerio from "cheerio";

export interface OnPageSignals {
  hasTitle: boolean;
  title: string;
  hasMetaDescription: boolean;
  h1Count: number;
  hasH1: boolean;
  /** <link rel="canonical" href>, absolute-resolved when possible. */
  canonical: string | null;
  /** meta robots / name=robots contains "noindex" (header X-Robots-Tag handled by caller). */
  metaNoindex: boolean;
  /** At least one valid application/ld+json block. */
  hasJsonLd: boolean;
  /** Visible primary text (scripts/styles/nav/footer stripped), collapsed. */
  text: string;
  wordCount: number;
}

const EMPTY: OnPageSignals = {
  hasTitle: false,
  title: "",
  hasMetaDescription: false,
  h1Count: 0,
  hasH1: false,
  canonical: null,
  metaNoindex: false,
  hasJsonLd: false,
  text: "",
  wordCount: 0,
};

export function extractOnPage(html: string, url: string): OnPageSignals {
  if (!html || html.trim().length === 0) return { ...EMPTY };
  const $ = cheerio.load(html);

  const title = $("head > title").first().text().trim();

  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    "";

  const h1Count = $("h1").length;

  let canonical = $('link[rel="canonical"]').attr("href")?.trim() || null;
  if (canonical) {
    try {
      canonical = new URL(canonical, url).toString();
    } catch {
      /* leave as-is if it won't resolve */
    }
  }

  // Robots directive: meta name=robots OR googlebot, "noindex" or "none".
  const robotsContent = [
    $('meta[name="robots"]').attr("content"),
    $('meta[name="googlebot"]').attr("content"),
  ]
    .filter(Boolean)
    .join(",")
    .toLowerCase();
  const metaNoindex = /\bnoindex\b|\bnone\b/.test(robotsContent);

  let hasJsonLd = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      JSON.parse(raw);
      hasJsonLd = true;
    } catch {
      /* malformed JSON-LD doesn't count */
    }
  });

  // Primary text: drop non-content elements, then read the body text.
  $("script, style, noscript, svg, template").remove();
  const text = ($("body").text() || $.root().text())
    .replace(/\s+/g, " ")
    .trim();
  const wordCount = text ? text.split(/\s+/).length : 0;

  return {
    hasTitle: title.length > 0,
    title,
    hasMetaDescription: metaDescription.length > 0,
    h1Count,
    hasH1: h1Count >= 1,
    canonical,
    metaNoindex,
    hasJsonLd,
    text,
    wordCount,
  };
}
