// Is this "high authority" domain actually a private blog network?
//
// Filter 1 of the Outreach Requirement sheet is "DR >= 50", and DR is the one metric a link seller
// can manufacture: buy an expired domain, point bought links at it, and it scores like a real
// publisher. A backlink from one is worth nothing and can be worth less than nothing.
//
// Nothing here costs money. All three inputs are free (RDAP registration date, Open PageRank,
// Tranco rank — see scripts/091_free_domain_signals.mjs), which is the point: the paid metric is
// the one being second-guessed, so the check has to come from somewhere else.
//
// Pure, so the selfcheck can pin every rule.

export type SpamRiskLevel = "unknown" | "none" | "low" | "high";

export interface SpamRiskInput {
  dr: number | null;
  /** ISO date from RDAP. Null means NOT CHECKED — never "new". */
  registeredOn?: string | null;
  /** Open PageRank 0-10, or null if not checked. */
  openPageRank?: number | null;
  /** Tranco popularity rank, or null. See `trancoChecked` — null is ambiguous on its own. */
  trancoRank?: number | null;
  /** Whether the Tranco list was actually consulted. Without this, "no rank" and "never looked"
   *  are the same value, and treating the second as the first invents evidence. */
  trancoChecked?: boolean;
  now?: Date;
}

export interface SpamRisk {
  level: SpamRiskLevel;
  reasons: string[];
}

/** Whole years between a registration date and now. Null when the date is missing or unparseable —
 *  an unknown age must stay unknown. */
export function domainAgeYears(registeredOn: string | null | undefined, now: Date = new Date()): number | null {
  if (!registeredOn) return null;
  const t = Date.parse(registeredOn);
  if (!Number.isFinite(t)) return null;
  const years = (now.getTime() - t) / (365.25 * 86_400_000);
  // A registration date in the future is bad data, not a brand-new domain.
  if (years < -1) return null;
  return Math.max(0, years);
}

// A domain needs real authority before its authority is worth doubting. Below this, a young domain
// is just a young domain — normal, and not what we are hunting for.
const SUSPECT_DR = 40;

/**
 * Assess PBN risk from free signals only.
 *
 * Deliberately conservative in one direction: with no signals at all the answer is "unknown", not
 * "none". A clean bill of health we never actually checked is the failure mode that matters here,
 * because it reads as evidence of quality when it is the absence of evidence.
 */
export function assessSpamRisk(i: SpamRiskInput): SpamRisk {
  const now = i.now ?? new Date();
  const age = domainAgeYears(i.registeredOn, now);
  const dr = i.dr;
  const haveAnySignal = age !== null || i.openPageRank != null || i.trancoChecked === true;
  if (!haveAnySignal) {
    return { level: "unknown", reasons: ["no free authority signals have been checked for this domain"] };
  }
  // Without a DR there is no claim to contradict, so there is nothing to assess.
  if (dr == null) {
    return { level: "unknown", reasons: ["no DR on file, so there is no authority claim to corroborate"] };
  }

  const high: string[] = [];
  const low: string[] = [];
  const fmtAge = (y: number) => (y < 1 ? `${Math.round(y * 12)} months` : `${y.toFixed(1)} years`);

  if (dr >= SUSPECT_DR && age !== null) {
    if (age < 1) high.push(`DR ${Math.round(dr)} on a domain registered ${fmtAge(age)} ago`);
    else if (age < 2) low.push(`DR ${Math.round(dr)} on a domain only ${fmtAge(age)} old`);
  }
  if (dr >= SUSPECT_DR && i.trancoChecked && i.trancoRank == null) {
    low.push(`DR ${Math.round(dr)} but absent from the Tranco top 1M — authority without measurable traffic`);
  }
  if (dr >= SUSPECT_DR && i.openPageRank != null && i.openPageRank < 2) {
    low.push(`DR ${Math.round(dr)} but Open PageRank only ${i.openPageRank.toFixed(1)}/10 — the two authority sources disagree`);
  }

  // Two independent weak tells make a strong one: any single signal has innocent explanations
  // (a genuinely new publication, a niche site outside the top 1M), but they rarely co-occur by
  // accident on a legitimate site.
  if (high.length || low.length >= 2) {
    return { level: "high", reasons: [...high, ...low] };
  }
  if (low.length === 1) return { level: "low", reasons: low };
  return {
    level: "none",
    reasons: age !== null ? [`domain is ${fmtAge(age)} old with no conflicting authority signals`] : ["no conflicting authority signals"],
  };
}
