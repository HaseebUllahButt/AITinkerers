// Audit the competitors on the same checks, then say who is ahead and what to do about it.
//
// The comparison is only honest if both sides are measured identically, so competitors go through
// the same discovery and on-page pass the audited site does — not a cheaper approximation. The
// market read is deliberately NOT run on them: it costs a model call per prompt per site, and
// "who does the model name" is already answered once for the whole category.
import { extractOnPage } from "@/lib/indexing/onpage";
import { llmChat, llmEnabled } from "@/lib/providers/llm";

import { fetchLlmsTxt, fetchRobots, fetchSitemap } from "./discovery";

export interface SiteProfile {
  url: string;
  domain: string;
  brand: string;
  reachable: boolean;
  status: number;

  hasTitle: boolean;
  title: string;
  hasMetaDescription: boolean;
  h1Count: number;
  hasJsonLd: boolean;
  wordCount: number;
  metaNoindex: boolean;

  llmsTxt: boolean;
  llmsFullTxt: boolean;
  llmsBytes: number;

  sitemapFound: boolean;
  sitemapUrls: number;

  robotsFound: boolean;
  /** Labels of retrieval-controlling crawlers this site blocks. */
  retrievalBlocked: string[];

  score: number;
  error?: string;
}

// One weighting, applied to every site including ours. The weights say what this product believes
// matters: being readable by the engines that answer questions outranks having a tidy sitemap.
const WEIGHTS = {
  reachable: 15,
  notBlocked: 20,
  title: 8,
  description: 8,
  h1: 5,
  jsonLd: 10,
  substance: 8,
  llmsTxt: 14,
  sitemap: 7,
  indexable: 5,
} as const;

export function scoreProfile(p: Omit<SiteProfile, "score">): number {
  if (!p.reachable) return 0;
  let s = WEIGHTS.reachable;
  if (!p.retrievalBlocked.length) s += WEIGHTS.notBlocked;
  if (p.hasTitle) s += WEIGHTS.title;
  if (p.hasMetaDescription) s += WEIGHTS.description;
  if (p.h1Count === 1) s += WEIGHTS.h1;
  if (p.hasJsonLd) s += WEIGHTS.jsonLd;
  if (p.wordCount >= 120) s += WEIGHTS.substance;
  if (p.llmsTxt) s += WEIGHTS.llmsTxt;
  if (p.sitemapFound) s += WEIGHTS.sitemap;
  if (!p.metaNoindex) s += WEIGHTS.indexable;
  return Math.min(100, s);
}

function brandFromTitle(title: string, domain: string): string {
  const parts = title.split(/\s[-–—·|:]\s|[|–—·]/).map((x) => x.trim()).filter(Boolean);
  const candidate = parts.length > 1 ? parts.sort((a, b) => a.length - b.length)[0] : parts[0];
  if (candidate && candidate.length >= 2 && candidate.length <= 40) return candidate;
  return domain.replace(/\.[a-z.]+$/, "");
}

/** The same pass the audited site gets, minus the model calls. */
export async function profileSite(rawUrl: string): Promise<SiteProfile> {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  let origin: string;
  let domain: string;
  try {
    const u = new URL(url);
    origin = u.origin;
    domain = u.hostname.replace(/^www\./, "");
  } catch {
    return blankProfile(rawUrl, rawUrl, "not a valid URL");
  }

  let html = "";
  let status = 0;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "SearchOpsBot/0.1 (+https://searchops.dev)", accept: "text/html,*/*" },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    status = res.status;
    if (res.ok) html = await res.text();
  } catch {
    return blankProfile(url, domain, "could not be fetched");
  }
  if (!html) return blankProfile(url, domain, `responded HTTP ${status}`);

  const onpage = extractOnPage(html, url);
  const [robots, llms] = await Promise.all([fetchRobots(origin), fetchLlmsTxt(origin)]);
  const sitemap = await fetchSitemap(origin, robots.sitemaps);

  const base = {
    url,
    domain,
    brand: brandFromTitle(onpage.title, domain),
    reachable: true,
    status,
    hasTitle: onpage.hasTitle,
    title: onpage.title,
    hasMetaDescription: onpage.hasMetaDescription,
    h1Count: onpage.h1Count,
    hasJsonLd: onpage.hasJsonLd,
    wordCount: onpage.wordCount,
    metaNoindex: onpage.metaNoindex,
    llmsTxt: llms.found,
    llmsFullTxt: llms.fullFound,
    llmsBytes: llms.bytes,
    sitemapFound: sitemap.found,
    sitemapUrls: sitemap.urlCount,
    robotsFound: robots.found,
    retrievalBlocked: robots.retrievalBlocked.map((a) => a.bot.label),
  };
  return { ...base, score: scoreProfile(base) };
}

function blankProfile(url: string, domain: string, error: string): SiteProfile {
  return {
    url, domain, brand: domain.replace(/\.[a-z.]+$/, ""), reachable: false, status: 0,
    hasTitle: false, title: "", hasMetaDescription: false, h1Count: 0, hasJsonLd: false,
    wordCount: 0, metaNoindex: false, llmsTxt: false, llmsFullTxt: false, llmsBytes: 0,
    sitemapFound: false, sitemapUrls: 0, robotsFound: false, retrievalBlocked: [],
    score: 0, error,
  };
}

// ── The comparison ────────────────────────────────────────────────────────────

export interface ComparisonRow {
  check: string;
  us: string;
  /** Keyed by competitor domain. */
  them: Record<string, string>;
  /** True when we are at least as good as every competitor on this row. */
  weLead: boolean;
}

export interface Suggestion {
  title: string;
  /** Grounded in the comparison, so it is never generic advice. */
  rationale: string;
  impact: "high" | "medium" | "low";
  effort: "low" | "medium" | "high";
}

/** A change we can actually produce here, rather than only describe. */
export interface Artifact {
  id: "llms-txt" | "title" | "meta-description" | "json-ld";
  label: string;
  /** Where it goes. */
  target: string;
  language: "markdown" | "html" | "json" | "text";
  content: string;
}

export interface CompetitorComparison {
  ran: boolean;
  us: SiteProfile | null;
  competitors: SiteProfile[];
  rows: ComparisonRow[];
  /** Highest-scoring site of all, ours included. */
  leaderDomain: string;
  weLead: boolean;
  /** Checks where at least one competitor beats us — what the suggestions are built from. */
  gaps: string[];
  suggestions: Suggestion[];
  artifacts: Artifact[];
  note?: string;
}

const yesNo = (b: boolean) => (b ? "yes" : "no");

function buildRows(us: SiteProfile, them: SiteProfile[]): ComparisonRow[] {
  const mk = (
    check: string,
    read: (p: SiteProfile) => string,
    better: (p: SiteProfile) => number,
  ): ComparisonRow => ({
    check,
    us: read(us),
    them: Object.fromEntries(them.map((t) => [t.domain, read(t)])),
    weLead: them.every((t) => better(us) >= better(t)),
  });

  return [
    mk("Overall score", (p) => String(p.score), (p) => p.score),
    mk("AI crawlers allowed", (p) => (p.retrievalBlocked.length ? `blocks ${p.retrievalBlocked.join(", ")}` : "yes"), (p) => (p.retrievalBlocked.length ? 0 : 1)),
    mk("llms.txt", (p) => (p.llmsTxt ? `${p.llmsBytes} bytes` : "missing"), (p) => (p.llmsTxt ? 1 : 0)),
    mk("Structured data", (p) => yesNo(p.hasJsonLd), (p) => (p.hasJsonLd ? 1 : 0)),
    mk("Meta description", (p) => yesNo(p.hasMetaDescription), (p) => (p.hasMetaDescription ? 1 : 0)),
    mk("Single H1", (p) => String(p.h1Count), (p) => (p.h1Count === 1 ? 1 : 0)),
    mk("Words on page", (p) => p.wordCount.toLocaleString(), (p) => p.wordCount),
    mk("Sitemap URLs", (p) => (p.sitemapFound ? p.sitemapUrls.toLocaleString() : "missing"), (p) => p.sitemapUrls),
  ];
}

async function writeSuggestions(us: SiteProfile, them: SiteProfile[], gaps: string[]): Promise<Suggestion[]> {
  // Deterministic first: these follow from the comparison, no model needed, and they are the ones
  // worth doing regardless of what a model would say.
  const fixed: Suggestion[] = [];
  if (us.retrievalBlocked.length) {
    fixed.push({
      title: `Unblock ${us.retrievalBlocked.join(", ")} in robots.txt`,
      rationale: `These crawlers control retrieval, not training. ${them.filter((t) => !t.retrievalBlocked.length).length} of ${them.length} competitors allow them, so their pages are eligible for AI answers and yours are not.`,
      impact: "high", effort: "low",
    });
  }
  if (!us.llmsTxt && them.some((t) => t.llmsTxt)) {
    fixed.push({
      title: "Publish /llms.txt",
      rationale: `${them.filter((t) => t.llmsTxt).map((t) => t.domain).join(", ")} publish one and you do not. It is a single markdown file describing what you do and which pages matter.`,
      impact: "medium", effort: "low",
    });
  }
  if (!us.hasJsonLd && them.some((t) => t.hasJsonLd)) {
    fixed.push({
      title: "Add JSON-LD structured data",
      rationale: `${them.filter((t) => t.hasJsonLd).length} of ${them.length} competitors ship structured data. It is the machine-readable version of what your page already says.`,
      impact: "medium", effort: "low",
    });
  }
  if (!us.hasMetaDescription) {
    fixed.push({
      title: "Write a meta description",
      rationale: "It is what an assistant quotes when summarising the page. Without one the model writes its own summary from whatever text it finds first.",
      impact: "medium", effort: "low",
    });
  }

  // Content depth is a gap the fixed rules above cannot express, because it is relative — there is
  // no "missing" to detect, only "less than theirs".
  const deepest = them.reduce((best, t) => (t.wordCount > best.wordCount ? t : best), them[0]);
  if (deepest && deepest.wordCount > us.wordCount * 1.5 && deepest.wordCount - us.wordCount > 200) {
    fixed.push({
      title: "Put more substance on the page",
      rationale: `${deepest.domain} has ${deepest.wordCount.toLocaleString()} words to your ${us.wordCount.toLocaleString()}. An assistant can only cite what it can read, and a page that says little gives it nothing to quote.`,
      impact: "medium", effort: "medium",
    });
  }

  // Anything still unaddressed gets a plain statement of the gap rather than silence. A detected
  // gap with no suggestion beside it reads as a bug in the report.
  const covered = fixed.map((f) => f.title.toLowerCase()).join(" ");
  for (const gap of gaps) {
    const key = gap.toLowerCase();
    if (key.includes("score")) continue; // The overall score is the sum of the rows, not its own action.
    const alreadyCovered =
      (key.includes("llms") && covered.includes("llms")) ||
      (key.includes("structured") && covered.includes("json-ld")) ||
      (key.includes("description") && covered.includes("description")) ||
      (key.includes("crawler") && covered.includes("robots")) ||
      (key.includes("words") && covered.includes("substance"));
    if (alreadyCovered) continue;
    const leader = them.reduce((best, t) => (t.score > best.score ? t : best), them[0]);
    fixed.push({
      title: `Close the gap on "${gap}"`,
      rationale: `At least one competitor is ahead of you here; ${leader.domain} scores ${leader.score} overall against your ${us.score}. The comparison row shows both values.`,
      impact: "medium", effort: "medium",
    });
  }

  if (!llmEnabled() || !gaps.length) return fixed;

  const res = await llmChat({
    system: "You advise on search and AI-answer visibility. Return STRICT JSON only, no prose.",
    prompt:
      `OUR SITE: ${us.domain} — score ${us.score}, title "${us.title}", ` +
      `llms.txt ${yesNo(us.llmsTxt)}, JSON-LD ${yesNo(us.hasJsonLd)}, ${us.wordCount} words.\n` +
      `COMPETITORS:\n${them.map((t) => `- ${t.domain}: score ${t.score}, llms.txt ${yesNo(t.llmsTxt)}, JSON-LD ${yesNo(t.hasJsonLd)}, ${t.wordCount} words`).join("\n")}\n` +
      `WE LOSE ON: ${gaps.join(", ")}\n\n` +
      "Give up to 4 further changes specific to THIS gap list. Do not repeat the obvious ones " +
      "(robots.txt, llms.txt, JSON-LD, meta description) — those are already covered. No generic " +
      "SEO advice; every rationale must reference the comparison above.\n\n" +
      '{"suggestions":[{"title":"...","rationale":"...","impact":"high|medium|low","effort":"low|medium|high"}]}',
    maxTokens: 1500,
    timeoutMs: 45_000,
  });

  const parsed = (() => {
    const t = res?.content ?? "";
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = f ? f[1] : t;
    const a = body.indexOf("{"), b = body.lastIndexOf("}");
    if (a === -1 || b === -1) return null;
    try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
  })();

  const extra: Suggestion[] = Array.isArray(parsed?.suggestions)
    ? parsed.suggestions
        .filter((s: any) => typeof s?.title === "string" && s.title.trim())
        .slice(0, 4)
        .map((s: any) => ({
          title: String(s.title).trim(),
          rationale: String(s.rationale ?? "").trim(),
          impact: ["high", "medium", "low"].includes(s.impact) ? s.impact : "medium",
          effort: ["low", "medium", "high"].includes(s.effort) ? s.effort : "medium",
        }))
    : [];

  return [...fixed, ...extra];
}

/**
 * Carry out the suggestions as far as is possible from here.
 *
 * We cannot deploy to a site we do not own, so "doing it" means producing the finished artefact —
 * the actual llms.txt, the actual tags — ready to paste, rather than a description of one. That is
 * the whole of the work that does not require write access.
 */
async function makeArtifacts(us: SiteProfile, suggestions: Suggestion[]): Promise<Artifact[]> {
  const wanted = new Set(suggestions.map((s) => s.title.toLowerCase()));
  const needLlms = !us.llmsTxt || [...wanted].some((w) => w.includes("llms.txt"));
  const needJsonLd = !us.hasJsonLd;
  const needMeta = !us.hasMetaDescription;
  const needTitle = !us.hasTitle;
  if (!llmEnabled() || !(needLlms || needJsonLd || needMeta || needTitle)) return [];

  const res = await llmChat({
    system: "You write production-ready web metadata. Return STRICT JSON only, no prose, no code fences.",
    prompt:
      `SITE: ${us.domain}\nCURRENT TITLE: ${us.title || "(none)"}\n` +
      `PAGE SUMMARY: a site whose homepage contains roughly ${us.wordCount} words.\n\n` +
      "Produce the missing assets below. Ground everything in the domain and title — invent no " +
      "facts, no statistics, no claims about features you cannot see.\n" +
      (needLlms ? "- llms_txt: a complete /llms.txt in markdown. An H1 with the name, one-line summary, then ## sections with linked key pages.\n" : "") +
      (needTitle ? "- title: a <title>, under 60 characters.\n" : "") +
      (needMeta ? "- meta_description: one sentence, under 155 characters.\n" : "") +
      (needJsonLd ? "- json_ld: a valid schema.org Organization JSON-LD object.\n" : "") +
      '\nReturn {"llms_txt":"...","title":"...","meta_description":"...","json_ld":{...}} omitting any you were not asked for.',
    maxTokens: 2500,
    timeoutMs: 60_000,
  });

  const t = res?.content ?? "";
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = f ? f[1] : t;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  let parsed: any = null;
  if (a !== -1 && b !== -1) { try { parsed = JSON.parse(body.slice(a, b + 1)); } catch { parsed = null; } }
  if (!parsed) return [];

  const out: Artifact[] = [];
  if (needLlms && typeof parsed.llms_txt === "string" && parsed.llms_txt.trim()) {
    out.push({ id: "llms-txt", label: "llms.txt", target: `${us.url.replace(/\/$/, "")}/llms.txt`, language: "markdown", content: parsed.llms_txt.trim() });
  }
  if (needTitle && typeof parsed.title === "string" && parsed.title.trim()) {
    out.push({ id: "title", label: "Title tag", target: "<head>", language: "html", content: `<title>${parsed.title.trim()}</title>` });
  }
  if (needMeta && typeof parsed.meta_description === "string" && parsed.meta_description.trim()) {
    out.push({ id: "meta-description", label: "Meta description", target: "<head>", language: "html", content: `<meta name="description" content="${parsed.meta_description.trim().replace(/"/g, "&quot;")}" />` });
  }
  if (needJsonLd && parsed.json_ld && typeof parsed.json_ld === "object") {
    out.push({
      id: "json-ld", label: "Structured data", target: "<head>", language: "json",
      content: `<script type="application/ld+json">\n${JSON.stringify(parsed.json_ld, null, 2)}\n</script>`,
    });
  }
  return out;
}

export async function compareWithCompetitors(opts: {
  us: SiteProfile;
  competitorDomains: string[];
}): Promise<CompetitorComparison> {
  const domains = opts.competitorDomains.filter(Boolean).slice(0, 4);
  if (!domains.length) {
    return {
      ran: false, us: opts.us, competitors: [], rows: [], leaderDomain: opts.us.domain,
      weLead: true, gaps: [], suggestions: [], artifacts: [],
      note: "No competitors were identified, so there is nothing to compare against. The market read names them — it has to run first.",
    };
  }

  const competitors = (await Promise.all(domains.map((d) => profileSite(d)))).filter((p) => p.reachable || p.error);
  const reachable = competitors.filter((c) => c.reachable);
  if (!reachable.length) {
    return {
      ran: false, us: opts.us, competitors, rows: [], leaderDomain: opts.us.domain,
      weLead: true, gaps: [], suggestions: [], artifacts: [],
      note: "None of the identified competitor sites could be fetched.",
    };
  }

  const rows = buildRows(opts.us, reachable);
  const gaps = rows.filter((r) => !r.weLead).map((r) => r.check);
  const all = [opts.us, ...reachable];
  const leader = all.reduce((best, p) => (p.score > best.score ? p : best), all[0]);

  const suggestions = await writeSuggestions(opts.us, reachable, gaps);
  const artifacts = await makeArtifacts(opts.us, suggestions);

  return {
    ran: true,
    us: opts.us,
    competitors,
    rows,
    leaderDomain: leader.domain,
    weLead: leader.domain === opts.us.domain,
    gaps,
    suggestions,
    artifacts,
  };
}
