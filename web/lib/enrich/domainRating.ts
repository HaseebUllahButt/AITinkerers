// Real Ahrefs Domain Rating via the free public endpoint (0 API units). Unauthenticated works
// today; from ~2026-08-01 a FREE api key is required — set AHREFS_API_KEY and it's sent as a
// Bearer token. This is the "free now, Ahrefs-fillable later" source for qualification filter 1.
// Traffic + US-share (filters 2 & 3) come from a paid plan and are enriched separately when one
// is connected — this module only owns DR.
const ENDPOINT = "https://api.ahrefs.com/v3/public/domain-rating-free";

export interface DomainRatingResult { dr: number; source: string }

export async function fetchDomainRating(host: string, signal?: AbortSignal): Promise<DomainRatingResult | null> {
  const target = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
  if (!target || !target.includes(".")) return null;
  const key = process.env.AHREFS_API_KEY;
  try {
    const res = await fetch(`${ENDPOINT}?target=${encodeURIComponent(target)}&output=json`, {
      headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const dr = data?.domain_rating?.domain_rating;
    return typeof dr === "number" ? { dr, source: key ? "ahrefs-free-key" : "ahrefs-free" } : null;
  } catch {
    return null;
  }
}
