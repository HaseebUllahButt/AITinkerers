// Partner worthiness — the §6 "Partner Site Quality Bar" and §8 "Hard Nos" of the Link Exchange
// Guidelines, as a pure 0-100 score. Decides whether a partner is even worth negotiating with
// BEFORE the ladder spends cycles (and sends) on them.
//
// The six criteria, straight from §6:
//   1. Domain Rating        50+ preferred; lower only with strong relevance and real traffic
//   2. Organic traffic      genuine, non-zero (null = UNVERIFIED — free Ahrefs gives DR only)
//   3. Relevance            same or adjacent niche: AI, design, media, marketing, tech
//   4. Indexing             site indexed in Google (de-indexed = §8 automatic decline)
//   5. Spam profile         clean; no link-farm/PBN footprint
//   6. Outbound links       linking page not stuffed with unrelated outbound links
//
// The convention throughout this codebase (qualifyProspect, maxOfferFor) is that an UNVERIFIED
// metric (null) does not fail a check — it contributes a neutral prior instead. Only a VERIFIED
// bad signal costs points, and only a §8 hard-no disqualifies outright. Pure and deterministic:
// no I/O, no clock, no model — the selfcheck pins every band edge.

export type WorthinessBand = "green" | "amber" | "red";

export interface PartnerSignals {
  dr: number | null;               // domains.dr
  organicTraffic: number | null;   // domains.organic_traffic (null = unverified)
  relevance: number | null;        // 0-100 niche/topic match, from the signal collector
  indexed: boolean | null;         // null = could not verify
  spamSuspect: boolean | null;     // link-farm/PBN footprint detected on the page (null = unchecked)
  spamNiche: string | null;        // §8 niche match (gambling/adult/pharma/crypto-spam), else null
  outboundLinks: number | null;    // external links counted on their page (null = unchecked)
  outboundStuffed: boolean | null; // collector's verdict on link-stuffing (null = unchecked)
}

export interface WorthinessResult {
  score: number;                   // 0-100
  band: WorthinessBand;
  hardNo: string | null;           // the §8 reason when disqualified outright, else null
  reasons: string[];               // short, human-readable — shown on the Negotiation page + handoffs
}

export interface WorthinessThresholds { green: number; amber: number } // score ≥ green → green; ≥ amber → amber; else red

export const DEFAULT_WORTHINESS_THRESHOLDS: WorthinessThresholds = { green: 60, amber: 40 };

// Weights over the six criteria (sum 100). DR and relevance dominate, mirroring the guideline's
// own emphasis ("50+ preferred; LOWER ONLY WITH STRONG RELEVANCE and real traffic").
const W = { dr: 30, traffic: 15, relevance: 30, indexed: 10, spam: 10, outbound: 5 } as const;

// Score one criterion into [0..1]; null (unverified) earns the neutral prior, not a failure.
const NEUTRAL = 0.5;

export function scorePartnerWorthiness(
  signals: PartnerSignals,
  thresholds: WorthinessThresholds = DEFAULT_WORTHINESS_THRESHOLDS,
): WorthinessResult {
  const reasons: string[] = [];

  // ── §8 hard-nos: instant red, no arithmetic ──
  if (signals.spamNiche) {
    return { score: 0, band: "red", hardNo: `prohibited niche (${signals.spamNiche})`, reasons: [`§8 hard no: ${signals.spamNiche} content`] };
  }
  if (signals.indexed === false) {
    return { score: 0, band: "red", hardNo: "site not indexed in Google", reasons: ["§8 hard no: de-indexed site"] };
  }
  if (signals.spamSuspect === true) {
    return { score: 0, band: "red", hardNo: "link-farm / PBN footprint", reasons: ["§8 hard no: spam footprint on the page"] };
  }

  // ── the six criteria ──
  let drU: number;
  if (signals.dr == null) { drU = NEUTRAL; reasons.push("DR unverified"); }
  else if (signals.dr >= 50) { drU = Math.min(1, 0.8 + (signals.dr - 50) / 250); reasons.push(`DR ${Math.round(signals.dr)} clears the 50 bar`); }
  else if (signals.dr >= 30) { drU = 0.4 + ((signals.dr - 30) / 20) * 0.3; reasons.push(`DR ${Math.round(signals.dr)} is below the 50 bar`); }
  else { drU = (signals.dr / 30) * 0.3; reasons.push(`DR ${Math.round(signals.dr)} is far below the bar`); }

  let trU: number;
  if (signals.organicTraffic == null) { trU = NEUTRAL; reasons.push("traffic unverified"); }
  else if (signals.organicTraffic <= 0) { trU = 0; reasons.push("zero organic traffic"); }
  else { trU = Math.min(1, 0.5 + Math.log10(signals.organicTraffic) / 10); reasons.push(`~${signals.organicTraffic.toLocaleString("en-US")} organic visits`); }

  let reU: number;
  if (signals.relevance == null) { reU = NEUTRAL; reasons.push("relevance unchecked"); }
  else { reU = Math.min(1, Math.max(0, signals.relevance / 100)); reasons.push(signals.relevance >= 50 ? "niche is relevant (AI/design/media/tech)" : `weak niche relevance (${Math.round(signals.relevance)}/100)`); }

  const inU = signals.indexed == null ? NEUTRAL : 1; // false already returned above
  if (signals.indexed == null) reasons.push("indexing unverified");
  else reasons.push("indexed in Google");

  const spU = signals.spamSuspect == null ? NEUTRAL : 1; // true already returned above
  if (signals.spamSuspect == null) reasons.push("spam profile unchecked");
  else reasons.push("clean page profile");

  let obU: number;
  if (signals.outboundStuffed == null) { obU = NEUTRAL; reasons.push("outbound links unchecked"); }
  else if (signals.outboundStuffed) { obU = 0; reasons.push(`page stuffed with outbound links${signals.outboundLinks != null ? ` (${signals.outboundLinks})` : ""}`); }
  else { obU = 1; reasons.push("outbound links look natural"); }

  const score = Math.round(
    drU * W.dr + trU * W.traffic + reU * W.relevance + inU * W.indexed + spU * W.spam + obU * W.outbound,
  );

  // §6's own caveat: a sub-bar DR is acceptable ONLY with strong relevance and real traffic. When
  // DR is verified-low and neither backs it up, cap below green so it can't sneak past on priors.
  let capped = score;
  if (signals.dr != null && signals.dr < 50 && !(signals.relevance != null && signals.relevance >= 60 && (signals.organicTraffic ?? 0) > 0)) {
    if (capped >= thresholds.green) { capped = thresholds.green - 1; reasons.push("capped: low DR without strong relevance + real traffic"); }
  }

  const band: WorthinessBand = capped >= thresholds.green ? "green" : capped >= thresholds.amber ? "amber" : "red";
  return { score: capped, band, hardNo: null, reasons };
}
