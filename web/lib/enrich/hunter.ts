// Hunter.io email finder — takes name + domain directly (unlike Blitz which needs a
// LinkedIn URL). Free tier: 25 finds/month, no credit card. Returns a confidence score
// so we can drop low-quality guesses. Gated by HUNTER_API_KEY.

import { meteredProviderEnabled, meteredKey } from "@/lib/providers/policy";
function key(): string | null {
  return meteredKey(process.env.HUNTER_API_KEY);
}

export function hunterEnabled(): boolean {
  return meteredProviderEnabled(!!key());
}

export interface HunterResult {
  email: string;
  score: number; // 0-100 confidence
}

// Returns null on no-key, not-found, rate-limit, or low confidence.
// minScore guards deliverability — only keep emails Hunter is reasonably sure about.
export async function findEmailHunter(fullName: string, domain: string, minScore = 70): Promise<HunterResult | null> {
  const k = key();
  if (!k || !fullName || !domain) return null;

  const params = new URLSearchParams({ domain, full_name: fullName, api_key: k });
  try {
    const res = await fetch(`https://api.hunter.io/v2/email-finder?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) return null; // rate/usage limit — caller should stop trying
    if (!res.ok) return null;
    const data = await res.json();
    const email = data?.data?.email as string | undefined;
    const score = (data?.data?.score as number | undefined) ?? 0;
    if (!email || score < minScore) return null;
    return { email, score };
  } catch {
    return null;
  }
}

export interface HunterDomainPerson {
  email: string;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  /** Hunter's own label. "personal" is a named human; "generic" is info@/contact@. */
  type: "personal" | "generic" | null;
  confidence: number;
}

export interface HunterDomainResult {
  /** Everyone Hunter knows at the domain, personal addresses first, then by confidence. */
  people: HunterDomainPerson[];
  /** Hunter's detected address pattern, e.g. "{first}" or "{f}{last}". Null when unknown. */
  pattern: string | null;
  organization: string | null;
}

/**
 * Every address Hunter knows for a domain, plus the pattern it inferred.
 *
 * This exists because `email-finder` needs a correct `full_name` and returns nothing without one — so a
 * prospect whose byline we scraped badly, or who is credited as "Staff", finds no email at all. That is
 * the measured failure: a Film Studio campaign found emails for 2 of 15 prospects, while Hunter's browser
 * extension showed `lion@filmcrux.com` (Lion Aton, Founder, 99%) for one of the misses. The extension uses
 * domain-search, which needs no name.
 *
 * It also returns the real address pattern, which is strictly better than `resolveDomainPattern()`
 * inferring one from whatever addresses we happen to have seen — and pattern quality is what decides
 * whether the constructed-guess fallback bounces.
 *
 * Costs one search credit per call regardless of how many addresses come back, so it is worth calling
 * once per DOMAIN and reusing across every prospect there. The cascade caches it per run for that reason.
 */
export async function domainSearchHunter(domain: string, limit = 10): Promise<HunterDomainResult | null> {
  const k = key();
  if (!k || !domain) return null;

  const params = new URLSearchParams({ domain, api_key: k, limit: String(Math.min(limit, 100)) });
  try {
    const res = await fetch(`https://api.hunter.io/v2/domain-search?${params}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) return null; // quota exhausted — caller should stop trying this run
    if (!res.ok) return null;
    const data = await res.json();
    const d = data?.data;
    if (!d) return null;

    const people: HunterDomainPerson[] = (d.emails ?? [])
      .filter((e: any) => typeof e?.value === "string" && e.value.includes("@"))
      .map((e: any) => ({
        email: String(e.value).toLowerCase().trim(),
        firstName: e.first_name ?? null,
        lastName: e.last_name ?? null,
        position: e.position ?? null,
        type: e.type === "personal" || e.type === "generic" ? e.type : null,
        confidence: typeof e.confidence === "number" ? e.confidence : 0,
      }))
      // A named human outranks a shared inbox even when the inbox scores higher: outreach to a person
      // gets read, outreach to info@ gets triaged.
      .sort((a: HunterDomainPerson, b: HunterDomainPerson) => {
        const rank = (p: HunterDomainPerson) => (p.type === "personal" ? 1 : 0);
        return rank(b) - rank(a) || b.confidence - a.confidence;
      });

    return {
      people,
      pattern: typeof d.pattern === "string" ? d.pattern : null,
      organization: typeof d.organization === "string" ? d.organization : null,
    };
  } catch {
    return null;
  }
}

/**
 * Pick the best address for a named author out of a domain-search result.
 *
 * Returns `matchedName` so the caller can tell the two cases apart, because they are NOT equivalent:
 * a name match is the author we set out to reach, whereas a fallback is a DIFFERENT person at the same
 * publication. For backlink outreach that fallback is often the better contact — an editor or founder can
 * actually place a link where a freelance contributor cannot — but the pitch has to be addressed to whoever
 * it really goes to, so this never silently swaps one for the other.
 */
export function pickFromDomainSearch(
  result: HunterDomainResult,
  fullName?: string | null,
): { person: HunterDomainPerson; matchedName: boolean } | null {
  const people = result.people.filter((p) => p.confidence > 0);
  if (!people.length) return null;

  const wanted = (fullName ?? "").toLowerCase().trim();
  if (wanted) {
    const parts = wanted.split(/\s+/).filter(Boolean);
    const first = parts[0];
    const last = parts.length > 1 ? parts[parts.length - 1] : null;

    const match = people.find((p) => {
      const pf = (p.firstName ?? "").toLowerCase();
      const pl = (p.lastName ?? "").toLowerCase();
      // Require the SURNAME to agree when we have one. Matching on a first name alone would happily
      // return a different Sarah at a publication with two of them.
      if (last) return pl === last && (!pf || !first || pf === first);
      return pf === first || pl === first;
    });
    if (match) return { person: match, matchedName: true };
  }

  // No name match. Prefer a named human; only fall back to a shared inbox if that is all there is.
  const personal = people.find((p) => p.type === "personal");
  return { person: personal ?? people[0], matchedName: false };
}

// Distinguishes "no email found" from "quota exhausted" so bulk callers can stop early.
export async function hunterStatus(): Promise<{ ok: boolean; used?: number; available?: number }> {
  const k = key();
  if (!k) return { ok: false };
  try {
    const res = await fetch(`https://api.hunter.io/v2/account?api_key=${k}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false };
    const d = await res.json();
    const searches = d?.data?.requests?.searches;
    return { ok: true, used: searches?.used, available: searches?.available };
  } catch {
    return { ok: false };
  }
}
