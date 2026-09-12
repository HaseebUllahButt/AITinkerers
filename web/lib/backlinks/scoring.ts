// Deterministic prospect scoring for Ahrefs-sourced backlink candidates. These rows used to land
// with score = null, so the funnel could only rank them by DR — and the soul's own ranking rule
// (relevancy, then Domain Rating, then trackability) was unenforceable for exactly the prospects
// with the best evidence. Pure function, no model call: cheap on a 50-row batch, and the
// selfcheck can pin its behaviour.

/** Months between two dates, floored; null when the input date is unparseable. */
function monthsSince(iso: string, now: Date): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now.getTime() - t) / (30.44 * 86_400_000));
}

/**
 * 0-100 composite: relevance (does the page's title/anchor mention the campaign topic) weighted
 * highest, then linking-domain DR, then link recency — a 2019 first_seen usually means the writer
 * has moved on (the harvest code has said this for months; now it counts for something).
 */
export function scoreBacklinkProspect(input: {
  topic: string | null;
  title?: string | null;
  anchor?: string | null;
  dr?: number | null;
  firstSeen?: string | null;
  /** Injectable clock so the selfcheck is deterministic. */
  now?: Date;
}): number {
  const now = input.now ?? new Date();

  const topicTokens = (input.topic ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const haystack = `${input.title ?? ""} ${input.anchor ?? ""}`.toLowerCase();
  const relevance = topicTokens.length
    ? Math.round((topicTokens.filter((t) => haystack.includes(t)).length / topicTokens.length) * 100)
    : 50; // no topic to compare against → neutral, not zero

  const dr = typeof input.dr === "number" ? Math.min(Math.max(input.dr, 0), 100) : 40; // unknown DR → mild prior

  const m = input.firstSeen ? monthsSince(input.firstSeen, now) : null;
  const recency = m === null ? 50 : m <= 6 ? 100 : m <= 18 ? 70 : m <= 36 ? 40 : 20;

  return Math.round(0.5 * relevance + 0.3 * dr + 0.2 * recency);
}
