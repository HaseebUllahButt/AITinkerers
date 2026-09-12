// Health checks for every external API key the app depends on. Results are cached
// in-process so polling the banner doesn't hammer upstreams. Only configured keys are
// checked; a configured-but-failing key is what the UI warns about.
import { verifyTransport } from "@/lib/email/smtp";

export interface KeyHealth {
  service: string;
  label: string;
  configured: boolean;
  ok: boolean;
  message: string;
  checkedAt: string;
}

const TTL_MS = 10 * 60 * 1000; // 10 min
const cache = new Map<string, { result: KeyHealth; at: number }>();

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

async function checkHunter(): Promise<KeyHealth> {
  const k = process.env.HUNTER_API_KEY;
  const base = { service: "hunter", label: "Hunter.io (email finder)", checkedAt: new Date().toISOString() };
  if (!k) return { ...base, configured: false, ok: true, message: "Not configured" };
  try {
    const res = await fetch(`https://api.hunter.io/v2/account?api_key=${k}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 401) return { ...base, configured: true, ok: false, message: "Invalid API key (401)" };
    if (!res.ok) return { ...base, configured: true, ok: false, message: `HTTP ${res.status}` };
    const d = await res.json();
    const s = d?.data?.requests?.searches;
    const left = s ? s.available - s.used : undefined;
    if (left !== undefined && left <= 0) return { ...base, configured: true, ok: false, message: "Monthly search quota exhausted" };
    return { ...base, configured: true, ok: true, message: left !== undefined ? `${left} searches left this month` : "OK" };
  } catch { return { ...base, configured: true, ok: false, message: "Unreachable" }; }
}

async function checkReoon(): Promise<KeyHealth> {
  const k = process.env.REOON_API_KEY;
  const base = { service: "reoon", label: "Reoon (email verifier)", checkedAt: new Date().toISOString() };
  if (!k) return { ...base, configured: false, ok: true, message: "Not configured" };
  try {
    // Quick mode is cheap; an invalid key returns an error payload rather than a verdict.
    const res = await fetch(`https://emailverifier.reoon.com/api/v1/verify?email=health@example.com&key=${k}&mode=quick`, { signal: AbortSignal.timeout(10000) });
    const d = await res.json().catch(() => null);
    // Reoon returns 403 + {status:"error", reason:"Not enough credits..."} when depleted.
    if (d?.status === "error" || !res.ok) {
      const reason = d?.reason ? String(d.reason) : `HTTP ${res.status}`;
      return { ...base, configured: true, ok: false, message: reason };
    }
    if (d?.status === undefined) return { ...base, configured: true, ok: false, message: `HTTP ${res.status}` };
    return { ...base, configured: true, ok: true, message: "OK" };
  } catch { return { ...base, configured: true, ok: false, message: "Unreachable" }; }
}

async function checkBlitz(): Promise<KeyHealth> {
  const k = process.env.BLITZ_API_KEY;
  const base = { service: "blitz", label: "BlitzAPI (LinkedIn enrichment)", checkedAt: new Date().toISOString() };
  if (!k) return { ...base, configured: false, ok: true, message: "Not configured" };
  try {
    const res = await fetch("https://api.blitz-api.ai/v2/account/key-info", { headers: { "x-api-key": k }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ...base, configured: true, ok: false, message: `HTTP ${res.status}` };
    const d = await res.json();
    if (!d?.valid) return { ...base, configured: true, ok: false, message: "Key reported invalid" };
    return { ...base, configured: true, ok: true, message: `OK (${d.remaining_credits} credits)` };
  } catch { return { ...base, configured: true, ok: false, message: "Unreachable" }; }
}

async function checkOpenRouter(): Promise<KeyHealth> {
  const k = process.env.OPENROUTER_API_KEY;
  const base = { service: "openrouter", label: "OpenRouter (AI generation)", checkedAt: new Date().toISOString() };
  if (!k) return { ...base, configured: false, ok: true, message: "Not configured" };
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401) return { ...base, configured: true, ok: false, message: "Invalid API key (401)" };
    if (!res.ok) return { ...base, configured: true, ok: false, message: `HTTP ${res.status}` };
    return { ...base, configured: true, ok: true, message: "OK" };
  } catch { return { ...base, configured: true, ok: false, message: "Unreachable" }; }
}

async function checkSmtp(): Promise<KeyHealth> {
  const base = { service: "smtp", label: "SMTP (email sending)", checkedAt: new Date().toISOString() };
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { ...base, configured: false, ok: true, message: "Not configured" };
  }
  const v = await withTimeout(verifyTransport(), 10000);
  if (!v) return { ...base, configured: true, ok: false, message: "Verify timed out" };
  return { ...base, configured: true, ok: v.ok, message: v.ok ? "OK" : (v.error ?? "Verify failed") };
}

// ── the providers this file used to miss ─────────────────────────────────────
// Five services were checked and eight were not, which is why "have you checked the credits?" kept
// being the answer to "why are the pitches thin" / "why does the hunter find nothing". A provider
// at zero is invisible by construction: every one of these swallows its own errors and returns
// null, and null is indistinguishable from "nothing found". Instrument all of them.

async function checkEnrichSo(): Promise<KeyHealth> {
  const k = process.env.ENRICHSO_API_KEY;
  const base = { service: "enrichso", label: "enrich.so (email finder)", checkedAt: new Date().toISOString() };
  if (!k) return { ...base, configured: false, ok: true, message: "Not configured" };
  try {
    const res = await fetch("https://api.enrich.so/v1/api/credits", {
      headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ...base, configured: true, ok: false, message: "Invalid API key (401)" };
    if (!res.ok) return { ...base, configured: true, ok: false, message: `HTTP ${res.status}` };
    const d = await res.json();
    const left = Number(d?.credits ?? d?.data?.credits);
    if (Number.isFinite(left)) {
      return { ...base, configured: true, ok: left > 0, message: left > 0 ? `${left} credits left` : "Out of credits" };
    }
    return { ...base, configured: true, ok: true, message: "OK" };
  } catch { return { ...base, configured: true, ok: false, message: "Unreachable" }; }
}

async function checkSerper(): Promise<KeyHealth> {
  const k = process.env.SERPER_API_KEY;
  const base = { service: "serper", label: "Serper (Google SERP)", checkedAt: new Date().toISOString() };
  if (!k) return { ...base, configured: false, ok: true, message: "Not configured" };
  try {
    // Serper has no balance endpoint; a 1-result search is the cheapest liveness probe. Its credits
    // are ONE-TIME and non-renewing, so "works" here does not mean "will work next month".
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": k, "Content-Type": "application/json" },
      body: JSON.stringify({ q: "test", num: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return { ...base, configured: true, ok: false, message: `Rejected (${res.status}) — key invalid or credits spent` };
    if (!res.ok) return { ...base, configured: true, ok: false, message: `HTTP ${res.status}` };
    return { ...base, configured: true, ok: true, message: "OK (credits are one-time, not renewing)" };
  } catch { return { ...base, configured: true, ok: false, message: "Unreachable" }; }
}

async function checkAhrefs(): Promise<KeyHealth> {
  const k = process.env.AHREFS_API_KEY;
  const base = { service: "ahrefs", label: "Ahrefs (domain rating)", checkedAt: new Date().toISOString() };
  if (!k) return { ...base, configured: false, ok: true, message: "Not configured (free DR endpoint still works unauthenticated)" };
  try {
    const res = await fetch("https://api.ahrefs.com/v3/public/domain-rating-free?target=northwind.example&output=json", {
      headers: { Accept: "application/json", Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { ...base, configured: true, ok: false, message: `HTTP ${res.status}` };
    const d = await res.json();
    const dr = d?.domain_rating?.domain_rating;
    return { ...base, configured: true, ok: typeof dr === "number", message: typeof dr === "number" ? `OK (free DR endpoint, 0 units)` : "Answered without a DR" };
  } catch { return { ...base, configured: true, ok: false, message: "Unreachable" }; }
}

async function checkTavily(): Promise<KeyHealth> {
  const base = { service: "tavily", label: "Tavily (web search)", checkedAt: new Date().toISOString() };
  if (!process.env.TAVILY_API_KEY) return { ...base, configured: false, ok: true, message: "Not configured" };
  try {
    // Reuses the app's own pool accounting rather than a bare env check: the whole point of the
    // pool is that the env key may be exhausted while a pooled one still answers.
    const { getTavilyUsage } = await import("@/lib/search/tavilyUsage");
    const u = await getTavilyUsage();
    const remaining = Math.max(0, u.limit - u.used);
    const poolNote = u.poolTotal ? ` (${u.poolActive}/${u.poolTotal} pool keys live)` : "";
    if (u.over) return { ...base, configured: true, ok: false, message: `Monthly capacity spent — ${u.used}/${u.limit}${poolNote}` };
    return {
      ...base, configured: true, ok: true,
      message: `${remaining} of ${u.limit} left this month${poolNote}${u.near ? " — near the cap" : ""}`,
    };
  } catch { return { ...base, configured: true, ok: true, message: "OK (usage unavailable)" }; }
}

async function checkOpenPageRank(): Promise<KeyHealth> {
  const k = process.env.OPENPAGERANK_API_KEY;
  const base = { service: "openpagerank", label: "Open PageRank (free authority signal)", checkedAt: new Date().toISOString() };
  if (!k) return { ...base, configured: false, ok: true, message: "Not configured — the PBN check runs on domain age + Tranco only" };
  try {
    const res = await fetch("https://openpagerank.com/api/v1.0/getPageRank?domains%5B%5D=northwind.example", {
      headers: { "API-OPR": k }, signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 403) return { ...base, configured: true, ok: false, message: "Rejected (403) — key invalid" };
    if (!res.ok) return { ...base, configured: true, ok: false, message: `HTTP ${res.status}` };
    return { ...base, configured: true, ok: true, message: "OK (free)" };
  } catch { return { ...base, configured: true, ok: false, message: "Unreachable" }; }
}

const CHECKERS: Record<string, () => Promise<KeyHealth>> = {
  smtp: checkSmtp, reoon: checkReoon, hunter: checkHunter, blitz: checkBlitz, openrouter: checkOpenRouter,
  enrichso: checkEnrichSo, serper: checkSerper, tavily: checkTavily, ahrefs: checkAhrefs,
  openpagerank: checkOpenPageRank,
};

export async function checkAllKeys(force = false): Promise<KeyHealth[]> {
  const now = Date.now();
  const out: KeyHealth[] = [];
  await Promise.all(Object.entries(CHECKERS).map(async ([svc, fn]) => {
    const cached = cache.get(svc);
    if (!force && cached && now - cached.at < TTL_MS) { out.push(cached.result); return; }
    const result = await fn();
    cache.set(svc, { result, at: now });
    out.push(result);
  }));
  // stable order: the things that stop outreach dead first, then enrichment, then the free tiers
  const order = [
    "smtp", "openrouter",
    "reoon", "hunter", "enrichso", "blitz",
    "serper", "tavily", "ahrefs", "openpagerank",
  ];
  return out.sort((a, b) => order.indexOf(a.service) - order.indexOf(b.service));
}
