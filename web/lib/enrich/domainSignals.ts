// Free domain-authority signals: RDAP registration date, Open PageRank, Tranco rank.
//
// These exist to corroborate (or contradict) Ahrefs DR, which is filter 1 of the Outreach
// Requirement sheet and the one metric a link seller can manufacture. See score/spamRisk.ts for
// what is done with them; this file only fetches and caches.
//
// Measured 2026-08-26, so nobody has to re-discover it:
//   RDAP  works for .com / .co.uk / .art via rdap.org (follow the 302 — it redirects to the
//         registry's own server). .io had NO rdap.org mapping, so coverage is good but not
//         universal and a miss must stay null.
//   Open PageRank  endpoint alive, HTTP 403 without a key → needs a free key, so it is inert
//         until OPENPAGERANK_API_KEY is set. Bulk: up to 100 domains per call.
//   Tranco  daily top-1M, 9.7MB zip, ingested by scripts/ingest_tranco.mjs into tranco_ranks.
import { supabaseAdmin } from "@/lib/db/supabase";
import { registrableDomain } from "@/lib/util/domain";

/** How long a free signal is trusted before it is re-fetched. A registration date never changes
 *  and popularity/authority move on the timescale of months, so this is generous on purpose —
 *  the cheapest call is the one not made. */
export const FREE_SIGNAL_TTL_DAYS = 90;

export interface FreeDomainSignals {
  domain: string;
  /** ISO date, or null when RDAP had no answer for this TLD. Null = not established. */
  registeredOn: string | null;
  /** 0-10, or null when Open PageRank is not configured or had no data. */
  openPageRank: number | null;
  /** Tranco rank, or null when the domain is outside the list. */
  trancoRank: number | null;
  /** Whether the Tranco list was actually consulted — distinguishes "outside the list" from
   *  "never looked", which spamRisk must not conflate. */
  trancoChecked: boolean;
}

// ── RDAP: domain registration date ──────────────────────────────────────────────────────────────

/** Pull the registration date out of an RDAP response. Pure, for the selfcheck. RDAP puts it in an
 *  `events` array; registries vary in which actions they publish, so registration is preferred and
 *  nothing else is substituted for it (a "last changed" date is not an age). */
export function registrationFromRdap(body: unknown): string | null {
  const events = (body as { events?: Array<{ eventAction?: string; eventDate?: string }> })?.events;
  if (!Array.isArray(events)) return null;
  const reg = events.find((e) => String(e?.eventAction ?? "").toLowerCase() === "registration");
  const raw = reg?.eventDate;
  if (!raw) return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

// rdap.org routes using IANA's bootstrap file, which does not list every TLD. Measured: it 404s
// for .io, and .io is over-represented in our target set (dev tools, AI startups). Identity Digital
// serves .io (and .sh/.ac) even though the bootstrap omits it, so it is tried second — it recovered
// every .io in the sample (n8n.io 2018, invideo.io 2017, flowith.io 2023, massive.io 2008).
// .co and .im stay unresolved, and stay honestly null.
const RDAP_ENDPOINTS = [
  (d: string) => `https://rdap.org/domain/${encodeURIComponent(d)}`,
  (d: string) => `https://rdap.identitydigital.services/rdap/domain/${encodeURIComponent(d)}`,
];

export async function fetchRegistrationDate(domain: string): Promise<string | null> {
  for (const url of RDAP_ENDPOINTS) {
    try {
      const res = await fetch(url(domain), {
        headers: { Accept: "application/rdap+json, application/json" },
        redirect: "follow", // rdap.org is a router: it 302s to the registry's own RDAP server
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const date = registrationFromRdap(await res.json());
      if (date) return date;
    } catch {
      continue;
    }
  }
  return null;
}

// ── Open PageRank ───────────────────────────────────────────────────────────────────────────────

export function openPageRankEnabled(): boolean {
  return !!process.env.OPENPAGERANK_API_KEY;
}

/**
 * Open PageRank for up to 100 domains in one call. Returns a map of domain → 0-10 rank; a domain
 * the API has no data for is simply absent rather than zero, because a zero would read as
 * "no authority" when it means "not in the index".
 */
export async function fetchOpenPageRank(domains: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const key = process.env.OPENPAGERANK_API_KEY;
  if (!key || !domains.length) return out;
  for (let i = 0; i < domains.length; i += 100) {
    const chunk = domains.slice(i, i + 100);
    const qs = chunk.map((d) => `domains[]=${encodeURIComponent(d)}`).join("&");
    try {
      const res = await fetch(`https://openpagerank.com/api/v1.0/getPageRank?${qs}`, {
        headers: { "API-OPR": key },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const d = await res.json();
      for (const row of (d?.response ?? []) as Array<{ domain?: string; page_rank_decimal?: unknown; status_code?: number }>) {
        const dom = String(row?.domain ?? "").toLowerCase();
        const v = Number(row?.page_rank_decimal);
        if (dom && row?.status_code === 200 && Number.isFinite(v)) out.set(dom, v);
      }
    } catch {
      continue; // a chunk that fails leaves those domains unknown, which is the honest outcome
    }
  }
  return out;
}

// ── Tranco ──────────────────────────────────────────────────────────────────────────────────────

/** Whether a Tranco list has actually been ingested. Without this, every domain looks "absent from
 *  the top 1M", which would flag the entire prospect list as suspicious. */
export async function trancoAvailable(): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from("tranco_ranks").select("domain", { count: "exact", head: true });
  if (error) return false;
  return (count ?? 0) > 0;
}

export async function trancoRanks(domains: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!domains.length) return out;
  const { data } = await supabaseAdmin.from("tranco_ranks").select("domain, rank").in("domain", domains);
  for (const r of data ?? []) out.set(String(r.domain), Number(r.rank));
  return out;
}

// ── Read-through ────────────────────────────────────────────────────────────────────────────────

/**
 * Free signals for one host, from `domains` when fresh and from the network when not. Writes what
 * it learns back so the next caller pays nothing.
 *
 * Registration date is fetched even when Open PageRank is unconfigured: it needs no key, and it is
 * the signal that does the most work.
 */
export async function getFreeDomainSignals(host: string): Promise<FreeDomainSignals> {
  const domain = registrableDomain(host);
  const cutoff = new Date(Date.now() - FREE_SIGNAL_TTL_DAYS * 86_400_000).toISOString();
  const { data: row } = await supabaseAdmin
    .from("domains")
    .select("host, registered_on, open_pagerank, tranco_rank, tranco_checked, free_signals_checked_at")
    .eq("host", domain).maybeSingle();

  const fresh = !!row?.free_signals_checked_at && row.free_signals_checked_at >= cutoff;
  if (fresh) {
    return {
      domain,
      registeredOn: row?.registered_on ?? null,
      openPageRank: row?.open_pagerank == null ? null : Number(row.open_pagerank),
      trancoRank: row?.tranco_rank == null ? null : Number(row.tranco_rank),
      // The stored fact, not a live re-check: a cached rank of null only means "outside the list"
      // if a list existed when it was cached.
      trancoChecked: row?.tranco_checked === true,
    };
  }
  const trancoReady = await trancoAvailable();

  const [registeredOn, oprMap, tranMap] = await Promise.all([
    row?.registered_on ? Promise.resolve(String(row.registered_on)) : fetchRegistrationDate(domain),
    fetchOpenPageRank([domain]),
    trancoReady ? trancoRanks([domain]) : Promise.resolve(new Map<string, number>()),
  ]);
  const signals: FreeDomainSignals = {
    domain,
    registeredOn: registeredOn ?? null,
    openPageRank: oprMap.get(domain) ?? null,
    trancoRank: tranMap.get(domain) ?? null,
    trancoChecked: trancoReady,
  };

  // Best-effort write-back. Only touches a domain we already track: inventing rows here would fill
  // `domains` with hosts nobody prospected.
  if (row?.host) {
    await supabaseAdmin.from("domains").update({
      registered_on: signals.registeredOn,
      registration_checked_at: new Date().toISOString(),
      open_pagerank: signals.openPageRank,
      tranco_rank: signals.trancoRank,
      tranco_checked: signals.trancoChecked,
      free_signals_checked_at: new Date().toISOString(),
    }).eq("host", domain).then(() => {}, () => {});
  }
  return signals;
}
