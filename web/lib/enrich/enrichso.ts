// enrich.so — a second name+domain email finder, alongside Hunter.
//
// Added because Hunter alone is not enough at campaign scale. Measured: the cascade resolves 7.2% of
// authors, Hunter's own quota is the free tier's 50 searches a month, and every waterfall vendor has a
// different slice of the same market — the standard practice in this space is to chain two or three and
// take the first hit, because coverage overlaps only partially.
//
// Contract read from the live docs rather than assumed, because two details here are easy to get wrong
// and both fail silently:
//
//   1. The request wants `firstName` and `lastName` SEPARATELY, not a single full name. Sending
//      `{ name }` returns a 4xx that reads like an auth problem.
//   2. `confidence` is a STRING enum ("high" | "medium" | "low"), not a 0-100 number. Comparing it
//      numerically is always false, so a naive `confidence >= 70` gate discards every result.
//
// That second one is exactly the shape of bug that made the Ahrefs DR backfill silently return nothing
// for 25 domains, so it is spelled out rather than left to a reader.

import { meteredProviderEnabled, meteredKey } from "@/lib/providers/policy";
const BASE = "https://dev.enrich.so/api/v3";

/** enrich.so's own confidence bands, mapped onto the 0-100 scale the rest of the cascade scores on. */
const CONFIDENCE_SCORE: Record<string, number> = { high: 90, medium: 70, low: 45 };

export interface EnrichSoResult {
  email: string;
  /** Normalised to 0-100 so it is comparable with Hunter and Blitz scores. */
  score: number;
  /** enrich.so's raw band, kept for the step log — "high" is more legible than 90. */
  confidence: string;
  /** A catch-all domain accepts anything, so a hit there is not proof the mailbox exists. */
  isCatchAll: boolean;
  creditsRemaining: number | null;
}

function key(): string | null {
  return meteredKey(process.env.ENRICHSO_API_KEY);
}

export function enrichSoEnabled(): boolean {
  return meteredProviderEnabled(!!key());
}

/** Split a full name into the two fields the API requires. */
function splitName(full: string): { firstName: string; lastName: string } | null {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  // One token is not a person for this purpose: without a surname the finder has nothing to disambiguate
  // on and returns whoever shares the first name.
  if (parts.length < 2) return null;
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

/**
 * Find a professional email from a name and a company domain. 10 credits per lookup.
 *
 * Returns null on every failure mode — no key, unusable name, HTTP error, `found: false`, or a body that
 * does not contain an address. The cascade treats null as "try the next step", so a provider outage
 * degrades the hit rate rather than breaking enrichment.
 */
export async function findEmailEnrichSo(
  fullName: string,
  domain: string,
  minScore = 45,
): Promise<EnrichSoResult | null> {
  const k = key();
  if (!k || !fullName || !domain) return null;

  const name = splitName(fullName);
  if (!name) return null;

  try {
    const res = await fetch(`${BASE}/email-finder`, {
      method: "POST",
      headers: { "x-api-key": k, "Content-Type": "application/json" },
      body: JSON.stringify({ ...name, domain }),
      signal: AbortSignal.timeout(25_000),
    });
    // 402/429 mean credits or rate limit, not "no such person" — the caller should stop trying this run
    // rather than burning the rest of the batch against a wall.
    if (res.status === 402 || res.status === 429) return null;
    if (!res.ok) return null;

    const body = await res.json();
    const d = body?.data;
    if (!d?.found || typeof d.email !== "string" || !d.email.includes("@")) return null;

    const band = String(d.confidence ?? "").toLowerCase();
    const score = CONFIDENCE_SCORE[band] ?? 45;
    if (score < minScore) return null;

    return {
      email: d.email.toLowerCase().trim(),
      score,
      confidence: band || "unknown",
      isCatchAll: d.isCatchAll === true,
      creditsRemaining: typeof body?.meta?.creditsRemaining === "number" ? body.meta.creditsRemaining : null,
    };
  } catch {
    return null;
  }
}

/**
 * Credits left, for a settings page or a pre-flight check before a large batch.
 *
 * There is no dedicated balance endpoint, and every response carries `meta.creditsRemaining` — so this
 * reads the balance off a deliberately-failing lookup rather than spending a real one. A name that cannot
 * resolve still returns meta.
 */
export async function enrichSoCredits(): Promise<{ ok: boolean; remaining: number | null }> {
  const k = key();
  if (!k) return { ok: false, remaining: null };
  try {
    const res = await fetch(`${BASE}/email-finder`, {
      method: "POST",
      headers: { "x-api-key": k, "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "", lastName: "", domain: "" }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null);
    const remaining = typeof body?.meta?.creditsRemaining === "number" ? body.meta.creditsRemaining : null;
    // A 4xx here is expected — the point is the meta object, not the lookup.
    return { ok: res.status < 500, remaining };
  } catch {
    return { ok: false, remaining: null };
  }
}
