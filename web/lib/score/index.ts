import type { Author, Article, Contact, Mention } from "@/lib/types";

interface ScoreInput {
  author: Author;
  articles: Article[];
  contacts: Contact[];
  allMentions: Mention[];
  domainArticleCount?: number;
  ourProductNames?: string[];
  llmRelevanceScore?: number; // 0-100 from Claude, overrides keyword-based relevance when set
}

export function computeScore(input: ScoreInput): {
  relevance: number;
  freshness: number;
  authority: number;
  competitor_overlap: number;
  contact_confidence: number;
  composite: number;
} {
  const {
    author, articles, contacts, allMentions, domainArticleCount = 1,
    ourProductNames = ["imagineart", "imagine.art", "ImagineArt"],
    llmRelevanceScore,
  } = input;

  // ─── Relevance (35%) ────────────────────────────────────────────────────────
  const totalMentions = allMentions.reduce((s, m) => s + m.count, 0);
  const archetypeBonus = articles.some((a) =>
    ["listicle", "comparison", "review"].includes(a.archetype ?? "")
  ) ? 15 : 0;
  const keywordRelevance = Math.min(100, Math.round(
    Math.min(60, totalMentions * 3) + archetypeBonus + (articles.length > 1 ? 10 : 0)
  ));
  // Prefer LLM score when available (more accurate than keyword counting)
  const relevance = llmRelevanceScore != null
    ? Math.round(llmRelevanceScore * 0.7 + keywordRelevance * 0.3) // blend both signals
    : keywordRelevance;

  // ─── Freshness (15%) ────────────────────────────────────────────────────────
  const latestDate = articles
    .map((a) => a.published_at ? new Date(a.published_at).getTime() : 0)
    .sort((a, b) => b - a)[0] ?? 0;
  const daysOld = latestDate > 0 ? (Date.now() - latestDate) / (1000 * 60 * 60 * 24) : 365;
  const freshness = Math.round(Math.max(0, 100 - (daysOld / 180) * 100));

  // ─── Authority (20%) ────────────────────────────────────────────────────────
  // Proxy: article count at domain, inbound references in our crawl
  const authority = Math.min(100, Math.round(
    Math.min(50, domainArticleCount * 5) + Math.min(30, articles.length * 10)
  ));

  // ─── Competitor overlap (20%) ────────────────────────────────────────────────
  // Tools mentioned that are NOT ImagineArt — these are link-gap targets
  const mentionedTools = [...new Set(allMentions.map((m) => m.tool_name))];
  const competitorTools = mentionedTools.filter(
    (t) => !ourProductNames.some((n) => t.toLowerCase().includes(n.toLowerCase()))
  );
  const hasImagineArt = mentionedTools.some((t) =>
    ourProductNames.some((n) => t.toLowerCase().includes(n.toLowerCase()))
  );
  const competitor_overlap = Math.min(100, Math.round(
    competitorTools.length * 12 + (hasImagineArt ? 0 : 15)
  ));

  // ─── Contact confidence (10%) ────────────────────────────────────────────────
  const bestContact = contacts.sort((a, b) => b.confidence - a.confidence)[0];
  const contact_confidence = bestContact
    ? Math.round(bestContact.confidence * 100)
    : 0;

  // ─── Composite ────────────────────────────────────────────────────────────────
  const composite = Math.round(
    relevance * 0.35 +
    competitor_overlap * 0.20 +
    freshness * 0.15 +
    authority * 0.20 +
    contact_confidence * 0.10
  );

  return { relevance, freshness, authority, competitor_overlap, contact_confidence, composite };
}

export function generateDescription(author: Author, articles: Article[], mentionedTools: string[]): string {
  const pub = author.domain?.name ?? author.domain?.host ?? "a digital publication";
  const toolList = mentionedTools.slice(0, 3).join(", ");
  const archetype = articles.find((a) => a.archetype)?.archetype ?? "news";
  const archetypeWord = archetype === "listicle" ? "roundups" : archetype === "comparison" ? "comparisons" : "coverage";

  if (author.bio) {
    return author.bio.slice(0, 200);
  }

  return `${author.full_name} writes ${archetypeWord} about generative AI tools at ${pub}${
    toolList ? `, with coverage including ${toolList}` : ""
  }. A strong candidate for editorial outreach targeting AI tool placements.`;
}
