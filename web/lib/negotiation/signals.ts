// Partner signal collection for the worthiness gate. Best-effort and honest: every signal it
// cannot verify stays null (the scorer treats null as a neutral prior, never a failure), and the
// whole collector never throws — a partner site being down must not crash a negotiation turn.
//
// Cost profile: one homepage fetch (8s cap) + optionally one web search (`site:host`, only when a
// search provider is configured). Results are cached on the domains row for 30 days, so the
// expensive path runs once per partner, not once per reply.

import { supabaseAdmin } from "@/lib/db/supabase";
import { registrableDomain } from "@/lib/util/domain";
import { searchEnabled, webSearch } from "@/lib/search/webSearch";
import { scorePartnerWorthiness, type PartnerSignals, type WorthinessResult, type WorthinessThresholds } from "./worthiness";

const RECHECK_DAYS = 30;

// §8 prohibited niches. Applied to the page's visible head/text — word-boundary matches on
// unambiguous terms only, so "therapy" never trips "pharma" and "crypto" alone (a legit tech
// topic) needs a gambling/loan pairing to count as crypto-SPAM.
const SPAM_NICHE: Array<[RegExp, string]> = [
  [/\b(casino|betting|sportsbook|slots?|poker|roulette|gambl\w*)\b/i, "gambling"],
  [/\b(viagra|cialis|xanax|adderall|payday loans?)\b/i, "pharma/loan spam"],
  [/\b(porn\w*|xxx|escorts?|adult dating)\b/i, "adult"],
  [/\b(crypto (casino|betting|loans?)|binary options)\b/i, "crypto-spam"],
];

// The §6 relevance vocabulary: same or adjacent niche — AI, design, media, marketing, tech.
const NICHE_VOCAB = [
  "ai", "artificial intelligence", "machine learning", "generative", "image", "video", "photo",
  "design", "creative", "media", "marketing", "seo", "content", "tech", "software", "app",
  "editing", "animation", "art", "graphic", "camera", "film", "audio", "music", "startup",
];

function extractVisibleText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const meta = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  return { title, text: `${title} ${meta} ${body.slice(0, 20_000)}` };
}

// 0-100: how much of the niche vocabulary (plus the campaign topic's own words) the page speaks.
function nicheRelevance(text: string, topic: string | null): number {
  const t = text.toLowerCase();
  const vocabHits = NICHE_VOCAB.filter((w) => new RegExp(`\\b${w.replace(/[^a-z ]/g, "")}\\b`, "i").test(t)).length;
  const vocabScore = Math.min(1, vocabHits / 8); // 8+ distinct niche words ≈ fully in-niche
  const topicTokens = (topic ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  const topicScore = topicTokens.length ? topicTokens.filter((w) => t.includes(w)).length / topicTokens.length : vocabScore;
  return Math.round((0.6 * vocabScore + 0.4 * topicScore) * 100);
}

function countOutbound(html: string, host: string): { total: number; external: number } {
  const own = registrableDomain(host);
  let total = 0, external = 0;
  for (const m of html.matchAll(/<a\s[^>]*href=["'](https?:\/\/[^"']+)["']/gi)) {
    total += 1;
    try { if (registrableDomain(new URL(m[1]).hostname) !== own) external += 1; } catch { /* malformed href */ }
  }
  return { total, external };
}

async function fetchHomepage(host: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${host}`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; SearchOpsBot/1.0; +https://www.imagine.art)" },
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html/i.test(ct)) return null;
    return (await res.text()).slice(0, 500_000);
  } catch {
    return null;
  }
}

// Collect what can be verified about a partner site right now. Every failure degrades to null.
export async function collectPartnerSignals(
  host: string,
  opts: { dr: number | null; organicTraffic: number | null; topic: string | null },
): Promise<PartnerSignals> {
  const signals: PartnerSignals = {
    dr: opts.dr, organicTraffic: opts.organicTraffic,
    relevance: null, indexed: null, spamSuspect: null, spamNiche: null,
    outboundLinks: null, outboundStuffed: null,
  };

  const html = await fetchHomepage(host);
  if (html) {
    const { text } = extractVisibleText(html);
    for (const [re, label] of SPAM_NICHE) if (re.test(text)) { signals.spamNiche = label; break; }
    signals.relevance = nicheRelevance(text, opts.topic);
    const { total, external } = countOutbound(html, host);
    signals.outboundLinks = external;
    // "Stuffed" = a wall of external links: 80+ external, or 40+ where they dominate the page.
    signals.outboundStuffed = external >= 80 || (external >= 40 && external / Math.max(1, total) > 0.6);
    // Link-farm footprint: extreme external density is itself the §8 PBN signal.
    signals.spamSuspect = external >= 150 ? true : false;
  }

  // Indexing: only when a search provider is configured, and only a POSITIVE result is proof.
  // Zero hits could be the provider, not Google, so it stays null (unverified), never false —
  // a wrongly-"false" here would be an automatic §8 decline, and we don't decline on a guess.
  if (searchEnabled()) {
    try {
      const hits = await webSearch(`site:${host}`, 3);
      if (hits.some((h) => { try { return registrableDomain(new URL(h.url).hostname) === registrableDomain(host); } catch { return false; } })) {
        signals.indexed = true;
      }
    } catch { /* stays null */ }
  }

  return signals;
}

export interface StoredWorthiness extends WorthinessResult { checkedAt: string }

// The cached gate: reuse a fresh (<30d) stored verdict, else collect → score → persist on the
// domains row. domainId may be null (no domain linked) — then we score from nothing (all-neutral
// priors) without persisting. A human override (band forced green via markWorthinessOverride)
// refreshes checked_at, so it holds for the same 30-day window before re-evaluation.
export async function getOrScoreWorthiness(
  domainId: string | null,
  host: string,
  opts: { dr: number | null; organicTraffic: number | null; topic: string | null; thresholds: WorthinessThresholds },
): Promise<StoredWorthiness> {
  if (domainId) {
    const { data } = await supabaseAdmin
      .from("domains")
      .select("worthiness_score, worthiness_band, worthiness_reasons, worthiness_hard_no, worthiness_checked_at")
      .eq("id", domainId).maybeSingle();
    const at = (data as any)?.worthiness_checked_at;
    if (at && Date.now() - Date.parse(at) < RECHECK_DAYS * 86_400_000 && (data as any).worthiness_band) {
      return {
        score: Number((data as any).worthiness_score ?? 0),
        band: (data as any).worthiness_band,
        hardNo: (data as any).worthiness_hard_no ?? null,
        reasons: Array.isArray((data as any).worthiness_reasons) ? (data as any).worthiness_reasons : [],
        checkedAt: at,
      };
    }
  }

  const signals = await collectPartnerSignals(host, opts);
  const result = scorePartnerWorthiness(signals, opts.thresholds);
  const checkedAt = new Date().toISOString();
  if (domainId) {
    // Persistence is advisory (a failed write must not block the negotiation turn).
    await supabaseAdmin.from("domains").update({
      worthiness_score: result.score,
      worthiness_band: result.band,
      worthiness_reasons: result.reasons,
      worthiness_hard_no: result.hardNo,
      worthiness_checked_at: checkedAt,
    }).eq("id", domainId);
  }
  return { ...result, checkedAt };
}

// A human said "worth it" (assisted a worthiness_review handoff): force the band green so the
// gate does not re-flag the same partner on their next reply. The score is kept for context.
export async function markWorthinessOverride(domainId: string, byEmail: string | null): Promise<void> {
  await supabaseAdmin.from("domains").update({
    worthiness_band: "green",
    worthiness_hard_no: null,
    worthiness_reasons: [`human override${byEmail ? ` by ${byEmail}` : ""}`],
    worthiness_checked_at: new Date().toISOString(),
  }).eq("id", domainId);
}
