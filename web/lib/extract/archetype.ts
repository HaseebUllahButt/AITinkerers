export type Archetype = "listicle" | "review" | "comparison" | "explainer" | "news";

const LISTICLE = /\b(\d+|best|top|ultimate|complete|essential|greatest|must.?have|must.?know)\b.{0,30}\b(ai|tool|app|generator|image|video|model)\b/i;
const COMPARISON = /\bvs\.?\b|\bversus\b|\bcompar(e|ison|ative)\b|\balternative\b/i;
const REVIEW = /\breview\b|\brated\b|\btested\b|\bwe tried\b|\bour verdict\b|\bhands.?on\b/i;
const EXPLAINER = /\bhow to\b|\bwhat is\b|\bguide\b|\btutorial\b|\bexplained?\b|\bbeginners?\b/i;

export function classifyArchetype(title: string, text: string): Archetype {
  const combined = `${title} ${text.slice(0, 500)}`;

  if (LISTICLE.test(combined)) return "listicle";
  if (COMPARISON.test(combined)) return "comparison";
  if (REVIEW.test(combined)) return "review";
  if (EXPLAINER.test(combined)) return "explainer";
  return "news";
}

export function isHighValue(archetype: Archetype): boolean {
  return archetype === "listicle" || archetype === "comparison" || archetype === "review";
}
