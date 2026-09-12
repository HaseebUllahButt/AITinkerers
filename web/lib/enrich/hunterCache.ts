// Durable cache over Hunter domain-search (hunter_domain_cache, 074) — ahrefsCache.ts replayed
// for the other metered index. One credit per live call, so the contract mirrors the Ahrefs one:
// a fresh row answers with zero credits AND with no key at all (the index snapshot was already
// paid for); a miss goes live and is stored best-effort; null exactly when the live call fails
// and nothing fresh is cached.
import { supabaseAdmin } from "@/lib/db/supabase";
import { domainSearchHunter, type HunterDomainResult } from "./hunter";

export const HUNTER_CACHE_TTL_DAYS = 14;

export interface CachedDomainSearch extends HunterDomainResult {
  cached: boolean;
  searched_at: string;
  /** 0 on a cache hit — the honest number a caller must report. */
  credits_spent: 0 | 1;
}

export async function cachedDomainSearch(domainRaw: string): Promise<CachedDomainSearch | null> {
  const domain = domainRaw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase();
  if (!domain) return null;

  const cutoff = new Date(Date.now() - HUNTER_CACHE_TTL_DAYS * 86_400_000).toISOString();
  const { data: hit } = await supabaseAdmin
    .from("hunter_domain_cache").select("result, searched_at")
    .eq("domain", domain).gte("searched_at", cutoff).maybeSingle();
  if (hit?.result) {
    return { ...(hit.result as HunterDomainResult), cached: true, searched_at: hit.searched_at as string, credits_spent: 0 };
  }

  const live = await domainSearchHunter(domain);
  if (!live) return null;

  const searchedAt = new Date().toISOString();
  // Best-effort: a cache-write failure must never fail the paid search it would have saved.
  await supabaseAdmin.from("hunter_domain_cache")
    .upsert({ domain, result: live, people_count: live.people.length, searched_at: searchedAt }, { onConflict: "domain" })
    .then(() => {}, () => {});
  return { ...live, cached: false, searched_at: searchedAt, credits_spent: 1 };
}
