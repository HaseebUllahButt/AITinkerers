// Author/Publisher Scoring Agent (#5). Qualifies a backlink prospect from a live crawl of its
// page: topical relevance, freshness, outbound-link quality, spam risk, domain authority
// (Ahrefs free Domain Rating endpoint — no key needed), a composite score, and an LLM-suggested
// outreach angle.
// External prospect pages are normal SSR sites, so a plain raw fetch is enough (no Chromium).
import * as cheerio from "cheerio";

import { fetchRaw } from "@/lib/indexing/fetchRendered";
import { llmChat, llmEnabled } from "@/lib/providers/llm";

export interface ProspectScore {
  url: string;
  domain: string;
  title: string;
  relevance: number; // 0..1
  freshnessYear: number | null;
  freshness: "fresh" | "stale" | "unknown";
  outboundQuality: number; // 0..1
  spamRisk: "low" | "medium" | "high";
  domainAuthority: number | null; // Ahrefs Domain Rating 0..100
  replyLikelihood: "high" | "medium" | "low";
  isListicle: boolean;
  angle: string;
  /** 0-100, or null when the page could not be fetched — unknown, not zero. */
  composite: number | null; // 0..100
  note?: string;
}

// Used to gauge topical relevance when no target topic is supplied (ad-hoc single-URL scoring):
// how much the page reads like AI-tool coverage at all.
const DEFAULT_TOPIC_TERMS = ["image", "video", "generator", "art", "photo", "design", "animation", "editor", "creative", "render", "avatar", "prompt"];
const SPAM_TERMS = /\b(casino|viagra|porn|xxx|payday loan|forex|crypto pump|escort|replica watch)\b/i;
const LISTICLE = /(best|top|tools|vs|alternative|alternatives|review|roundup|compared|comparison)/i;

function domainOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return url;
  }
}

function findYear(html: string, $: cheerio.CheerioAPI): number | null {
  const metaDate =
    $('meta[property="article:published_time"]').attr("content") ||
    $('meta[property="article:modified_time"]').attr("content") ||
    $("time[datetime]").attr("datetime") ||
    "";
  const fromMeta = metaDate.match(/(20\d{2})/)?.[1];
  if (fromMeta) return Number(fromMeta);
  // Fallback: a recent year appearing near "updated"/"published" text.
  const near = html.match(/(?:updated|published|last modified)[^0-9]{0,20}(20\d{2})/i)?.[1];
  return near ? Number(near) : null;
}

// Free, no-key-required Domain Rating lookup. Ahrefs requires a bearer token starting
// 2026-08-10 — set AHREFS_API_KEY then (docs.ahrefs.com/en/api/reference/public/get-domain-rating-free)
// and this picks it up automatically; until then it works unauthenticated.
async function domainRating(domain: string): Promise<number | null> {
  try {
    const headers: Record<string, string> = {};
    if (process.env.AHREFS_API_KEY) headers.Authorization = `Bearer ${process.env.AHREFS_API_KEY}`;
    const res = await fetch(`https://api.ahrefs.com/v3/public/domain-rating-free?target=${encodeURIComponent(domain)}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const v = data?.domain_rating?.domain_rating;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

async function angleFor(title: string, domain: string, topic: string): Promise<string> {
  if (llmEnabled()) {
    const res = await llmChat({
      maxTokens: 60,
      temperature: 0.3,
      prompt: `A blogger at ${domain} published an article titled "${title}". We want them to link to ImagineArt (an AI image/video generator) on the topic "${topic}". In ONE sentence, suggest the best outreach angle (e.g. suggest adding us to their list, offer a data point, a broken-link fix, a quote). Reply with only the sentence.`,
    });
    const a = res?.content?.trim();
    if (a && a.length > 8) return a;
  }
  return LISTICLE.test(title) ? `Ask to be added to their "${topic}" list.` : `Offer a relevant mention or resource for their ${topic} coverage.`;
}

export async function scoreProspect(url: string, topicTerms: string[], topicLabel: string): Promise<ProspectScore> {
  const domain = domainOf(url);
  const raw = await fetchRaw(url);
  const base: ProspectScore = {
    url, domain, title: "", relevance: 0, freshnessYear: null, freshness: "unknown",
    outboundQuality: 0, spamRisk: "medium", domainAuthority: null, replyLikelihood: "low",
    isListicle: LISTICLE.test(url), angle: "", composite: 0,
  };
  if (!raw?.ok || !raw.html) {
    // Unknown, not bad. Returning composite 0 buried high-authority sites we simply could not read
    // at the very bottom of the list — venngage.com sat last at composite 0 with a DR of 84. A null
    // composite lets the UI show "—" and sort these separately instead of asserting they are worthless.
    return {
      ...base, composite: null,
      note: "Could not fetch this page — score unknown, not zero.",
      angle: await angleFor(url, domain, topicLabel),
    };
  }
  const $ = cheerio.load(raw.html);
  const title = ($("head > title").first().text() || $("h1").first().text() || "").trim();
  $("script, style, noscript").remove();
  const text = ($("body").text() || "").replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const wordCount = text ? text.split(/\s+/).length : 0;

  // Relevance: share of topic terms present. Fall back to a generic AI-tools vocabulary when no
  // target topic was supplied (ad-hoc single-URL scoring), so relevance is still meaningful.
  const relevanceTerms = topicTerms.length ? topicTerms : DEFAULT_TOPIC_TERMS;
  const shared = relevanceTerms.filter((t) => lower.includes(t));
  const relevance = shared.length / relevanceTerms.length;
  // A near-empty body usually means the page is JS-rendered or bot-protected against our fetch.
  const thinNote = wordCount < 100 ? "Page returned little readable text (JS-rendered or bot-protected) — signals may be understated." : undefined;

  // Freshness.
  const freshnessYear = findYear(raw.html, $);
  const nowYear = new Date().getFullYear();
  const freshness: ProspectScore["freshness"] =
    freshnessYear == null ? "unknown" : freshnessYear >= nowYear - 1 ? "fresh" : "stale";

  // Outbound links: count external; a moderate amount reads as an editorial article, a huge
  // amount reads as a link farm.
  let external = 0, total = 0;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!href.startsWith("http")) return;
    total += 1;
    if (domainOf(href) !== domain) external += 1;
  });
  const outboundQuality = external === 0 ? 0.3 : external <= 60 ? Math.min(1, 0.4 + (external / 60) * 0.6) : Math.max(0.2, 1 - (external - 60) / 200);

  // Spam risk.
  const spammyTld = /\.(xyz|top|loan|click|gq|tk)$/i.test(domain);
  let spam = 0;
  if (SPAM_TERMS.test(lower)) spam += 2;
  if (spammyTld) spam += 1;
  if (wordCount < 250 && total > 30) spam += 1; // thin + link-heavy
  const spamRisk: ProspectScore["spamRisk"] = spam >= 2 ? "high" : spam === 1 ? "medium" : "low";

  const domainAuthority = await domainRating(domain);

  // Composite (0..100). DA weighted when available; otherwise its weight is redistributed.
  const spamScore = spamRisk === "low" ? 1 : spamRisk === "medium" ? 0.5 : 0;
  const freshScore = freshness === "fresh" ? 1 : freshness === "stale" ? 0.4 : 0.6;
  const daScore = domainAuthority == null ? null : Math.min(1, domainAuthority / 100);
  const parts: [number, number][] = [
    [relevance, 0.4], [freshScore, 0.15], [outboundQuality, 0.1], [spamScore, 0.15],
    ...(daScore == null ? [] : ([[daScore, 0.2]] as [number, number][])),
  ];
  const weightSum = parts.reduce((s, [, w]) => s + w, 0);
  const composite = Math.round((parts.reduce((s, [v, w]) => s + v * w, 0) / weightSum) * 100);

  // Reply likelihood: relevant + clean + not a giant publisher tends to reply more.
  const replyLikelihood: ProspectScore["replyLikelihood"] =
    relevance >= 0.4 && spamRisk === "low" ? "high" : relevance >= 0.2 ? "medium" : "low";

  return {
    url, domain, title,
    relevance: Math.round(relevance * 100) / 100,
    freshnessYear, freshness,
    outboundQuality: Math.round(outboundQuality * 100) / 100,
    spamRisk, domainAuthority, replyLikelihood,
    isListicle: LISTICLE.test(title) || LISTICLE.test(url),
    angle: await angleFor(title || url, domain, topicLabel),
    composite,
    note: thinNote,
  };
}

export async function scoreMany(urls: string[], topicTerms: string[], topicLabel: string, concurrency = 4): Promise<ProspectScore[]> {
  const { default: PQueue } = await import("p-queue");
  const queue = new PQueue({ concurrency });
  const out: ProspectScore[] = [];
  await Promise.all(urls.map((u) => queue.add(async () => { out.push(await scoreProspect(u, topicTerms, topicLabel)); })));
  return out.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));
}
