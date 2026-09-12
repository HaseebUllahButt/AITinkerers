// JSON-LD for a blog draft, derived rather than written.
//
// markupSchema has been mapped to Strapi correctly all along and has been null on every draft,
// because the only thing that could fill it was a human typing JSON into a code box in the editor.
// Nobody ever did, so every published post shipped without structured data — which is the field
// that decides whether Google shows an article card, an author, a date, or an FAQ accordion.
//
// It does not need writing. Every value in an Article graph already exists on the draft: the title,
// the description, the canonical, the images, the dates. Generating it from those is deterministic,
// cannot hallucinate, and updates itself when the draft changes.
//
// ── What is deliberately NOT here ────────────────────────────────────────────────────────────────
//
// No aggregateRating, no fabricated author when none is set, no invented publisher logo. Structured
// data is a claim made to a search engine in machine-readable form; inventing a rating is the kind
// of thing that earns a manual action, and a wrong author is worse than none. Every field below is
// something the draft actually holds.
import type { BlogDraft } from "@/lib/db/queries";
import { parseBlocks } from "@/lib/blog/markdown";

const SITE = "https://www.northwind.example";
const ORG = "Northwind";

/** FAQ pairs from the body: an H2 phrased as a question, followed by prose.
 *
 *  Only counted when the heading really is a question — a `?` or an interrogative opener. An FAQPage
 *  graph whose questions are section titles ("Pricing", "How it works") is a misrepresentation of
 *  the page, and Google treats a mismatched FAQ block as a reason to distrust the rest. */
function faqsFrom(body: string): { q: string; a: string }[] {
  const blocks = parseBlocks(body || "");
  const out: { q: string; a: string }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.t !== "h" || b.level !== 2) continue;
    const q = b.text.trim();
    if (!/\?$/.test(q) && !/^(what|why|how|when|where|which|who|can|does|do|is|are|should)\b/i.test(q)) continue;
    // The prose immediately under it, up to the next heading.
    const parts: string[] = [];
    for (let j = i + 1; j < blocks.length; j++) {
      const n = blocks[j];
      if (n.t === "h") break;
      if (n.t === "p") parts.push(n.text.trim());
      if (parts.length >= 2) break;
    }
    const a = parts.join(" ").trim();
    if (q && a) out.push({ q, a });
  }
  return out;
}

/** Strip markdown to plain text for a schema value — JSON-LD is read by machines, and `**bold**`
 *  in an answer string is noise that shows up verbatim in a rich result. */
function plain(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the JSON-LD graph for a draft. Returns null when there is not enough to say anything true —
 * an Article with no headline is not structured data, it is noise.
 */
export function buildMarkupSchema(d: Partial<BlogDraft>): Record<string, unknown> | null {
  const title = (d.title ?? "").trim();
  const slug = (d.slug ?? "").trim();
  if (!title || !slug) return null;

  const url = (d.canonical_tag ?? "").trim() || `${SITE}/blogs/${slug}`;
  const description = plain((d.seo_description ?? d.description ?? "").trim());
  const image = (d.cover_media_url ?? d.thumbnail_media_url ?? "").trim();

  const article: Record<string, unknown> = {
    "@type": "BlogPosting",
    "@id": `${url}#article`,
    headline: title,
    // Google truncates a headline past ~110 characters; keeping the full one AND a short name lets
    // it choose without us guessing which it wants.
    ...(title.length > 110 ? { alternativeHeadline: title.slice(0, 107) + "…" } : {}),
    ...(description ? { description } : {}),
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    ...(image ? { image: [image] } : {}),
    ...(d.published_at ? { datePublished: d.published_at } : {}),
    // updated defaults to published rather than to now(): "modified today" on a post nobody touched
    // is a false freshness signal.
    ...(d.updated_at || d.published_at ? { dateModified: d.updated_at ?? d.published_at } : {}),
    publisher: { "@type": "Organization", name: ORG, url: SITE },
    ...(d.seo_keywords ? { keywords: d.seo_keywords } : {}),
    inLanguage: d.locale || "en",
  };

  const graph: Record<string, unknown>[] = [article];

  const faqs = faqsFrom(d.body ?? "");
  if (faqs.length >= 2) {
    graph.push({
      "@type": "FAQPage",
      "@id": `${url}#faq`,
      mainEntity: faqs.map((f) => ({
        "@type": "Question",
        name: plain(f.q),
        acceptedAnswer: { "@type": "Answer", text: plain(f.a).slice(0, 1200) },
      })),
    });
  }

  graph.push({
    "@type": "BreadcrumbList",
    "@id": `${url}#breadcrumb`,
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE },
      { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE}/blogs` },
      { "@type": "ListItem", position: 3, name: title, item: url },
    ],
  });

  return { "@context": "https://schema.org", "@graph": graph };
}
