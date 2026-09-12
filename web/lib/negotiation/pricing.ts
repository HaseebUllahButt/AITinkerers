import type { PricingRule } from "./settings";

// The most we'll offer a domain, from the editable pricing tiers. Picks the highest-paying
// tier the domain qualifies for. Metrics that are UNVERIFIED (null — free Ahrefs plan gives us
// DR only) do NOT fail a threshold, so DR-based tiers apply now; once a paid source fills
// traffic/US-share, tiers that require them tighten automatically. Returns null if no tier
// matches (e.g. DR below every tier's floor) — meaning "no paid offer, placement-only ask".
export function maxOfferFor(
  dr: number | null | undefined,
  traffic: number | null | undefined,
  usShare: number | null | undefined,
  rules: PricingRule[]
): { offer: number; rule: PricingRule } | null {
  const meets = (min: number | undefined, val: number | null | undefined) =>
    !min || min <= 0 || val == null /* unverified doesn't fail */ || val >= min;

  const matches = (rules ?? []).filter(
    (r) => meets(r.min_dr, dr) && meets(r.min_traffic, traffic) && meets(r.min_us_share, usShare)
  );
  if (matches.length === 0) return null;
  const best = matches.reduce((a, b) => (b.max_offer > a.max_offer ? b : a));
  return { offer: best.max_offer, rule: best };
}
