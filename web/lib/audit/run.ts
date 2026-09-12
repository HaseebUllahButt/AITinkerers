// One URL in, one audit out.
//
// Order matters: the page fetch has to land before anything else, because the brand, title and body
// text it yields are what the market read is built from. Everything after that is independent and
// runs together.
import { fetchRawAndRendered, playwrightEnabled } from "@/lib/indexing/fetchRendered";
import { extractOnPage, type OnPageSignals } from "@/lib/indexing/onpage";
import { classifyRenderMode, type RenderModeResult } from "@/lib/indexing/renderMode";
import { fetchLlmsTxt, fetchRobots, fetchSitemap, type LlmsTxtReport, type RobotsReport, type SitemapReport } from "./discovery";
import { compareWithCompetitors, scoreProfile, type CompetitorComparison, type SiteProfile } from "./compare";
import { discoverCompetitors, type CompetitorDiscovery } from "./competitors";
import { readMarket, type MarketRead } from "./market";
import { measureShareOfVoice, type ShareOfVoice } from "./share";

export type Severity = "critical" | "warning" | "ok";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  /** What was observed — never a recommendation, so the evidence stays separate from the opinion. */
  evidence: string;
  /** What to do about it. */
  fix: string;
}

export interface AuditResult {
  url: string;
  origin: string;
  domain: string;
  brand: string;
  fetchedAt: string;
  durationMs: number;

  reachable: boolean;
  status: number;
  onpage: OnPageSignals | null;
  render: RenderModeResult | null;
  renderChecked: boolean;

  robots: RobotsReport;
  llmsTxt: LlmsTxtReport;
  sitemap: SitemapReport;
  market: MarketRead;
  share: ShareOfVoice;
  discovery: CompetitorDiscovery;
  comparison: CompetitorComparison;

  findings: Finding[];
  score: number;
}

export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** A readable brand from the title, falling back to the domain. */
function brandFrom(title: string, domain: string): string {
  // Titles are usually "Thing — tagline", "Page | Brand" or "Thing - Brand"; the brand is the
  // shortest segment. The hyphen must be spaced: splitting on a bare "-" would cut hyphenated
  // names like "Well-Known" in half.
  const parts = title.split(/\s[-–—·|:]\s|[|–—·]/).map((p) => p.trim()).filter(Boolean);
  const candidate = parts.length > 1 ? parts.sort((a, b) => a.length - b.length)[0] : parts[0];
  if (candidate && candidate.length >= 2 && candidate.length <= 40) return candidate;
  return domain.replace(/\.[a-z.]+$/, "");
}

function buildFindings(r: {
  onpage: OnPageSignals | null;
  render: RenderModeResult | null;
  robots: RobotsReport;
  llmsTxt: LlmsTxtReport;
  sitemap: SitemapReport;
  market: MarketRead;
  share: ShareOfVoice;
  comparison: CompetitorComparison;
}): Finding[] {
  const f: Finding[] = [];
  const { onpage, render, robots, llmsTxt, sitemap, market, share, comparison } = r;

  // ── The one that costs real money, first ──────────────────────────────────
  if (robots.retrievalBlocked.length) {
    f.push({
      id: "ai-retrieval-blocked",
      severity: "critical",
      title: "Blocked to the crawlers that feed AI answers",
      evidence: robots.retrievalBlocked
        .map((a) => `${a.bot.label} is disallowed (matched "${a.via}") — ${a.bot.blockingCosts}`)
        .join(" "),
      fix: "Allow these agents in robots.txt. They control RETRIEVAL, not training — blocking them removes you from the answers without opting out of anything.",
    });
  } else if (robots.found) {
    const training = robots.aiAccess.filter((a) => a.blocked && a.bot.controls === "training");
    f.push({
      id: "ai-retrieval-open",
      severity: "ok",
      title: "AI answer crawlers can read the site",
      evidence: training.length
        ? `Retrieval agents are allowed. ${training.map((t) => t.bot.label).join(", ")} blocked, which only opts out of model training — it costs no visibility.`
        : "No AI crawler is disallowed at the root.",
      fix: "",
    });
  }

  if (render?.jsGated) {
    f.push({
      id: "js-gated",
      severity: "critical",
      title: "Content only appears after JavaScript",
      evidence: render.reasons.join("; "),
      fix: "Server-render the primary content and the SEO tags. Every major AI crawler executes no JavaScript, so anything JS-injected is invisible to them regardless of robots.txt.",
    });
  }

  if (onpage) {
    if (!onpage.hasTitle) {
      f.push({ id: "no-title", severity: "critical", title: "No <title>", evidence: "The document has no title element.", fix: "Add a title that names the thing and what it does." });
    }
    if (!onpage.hasMetaDescription) {
      f.push({ id: "no-description", severity: "warning", title: "No meta description", evidence: "Neither meta description nor og:description is set.", fix: "Write one sentence of description — it is what a model quotes when summarising the page." });
    }
    if (!onpage.hasH1) {
      f.push({ id: "no-h1", severity: "warning", title: "No H1", evidence: "The page has no level-one heading.", fix: "Add one H1 stating what the page is about." });
    } else if (onpage.h1Count > 1) {
      f.push({ id: "many-h1", severity: "warning", title: `${onpage.h1Count} H1 headings`, evidence: "More than one H1 competes to describe the page.", fix: "Keep one H1; demote the rest to H2." });
    }
    if (onpage.metaNoindex) {
      f.push({ id: "noindex", severity: "critical", title: "Page is set to noindex", evidence: "A robots meta tag contains noindex.", fix: "Remove the directive unless this page is deliberately hidden." });
    }
    if (!onpage.hasJsonLd) {
      f.push({ id: "no-jsonld", severity: "warning", title: "No structured data", evidence: "No valid application/ld+json block on the page.", fix: "Add JSON-LD describing the organisation or product. It is the machine-readable version of what the page already says." });
    }
    if (onpage.wordCount < 120) {
      f.push({ id: "thin", severity: "warning", title: "Very little text", evidence: `${onpage.wordCount} words of visible copy.`, fix: "A model can only cite what it can read. Give the page enough self-contained prose to answer a question." });
    }
  }

  f.push(
    llmsTxt.found
      ? { id: "llms-txt", severity: "ok", title: "llms.txt published", evidence: `${llmsTxt.bytes} bytes, ${llmsTxt.headings.length} sections, ${llmsTxt.linkCount} links${llmsTxt.fullFound ? ", plus llms-full.txt" : ""}.`, fix: "" }
      : { id: "no-llms-txt", severity: "warning", title: "No llms.txt", evidence: `Nothing readable at ${llmsTxt.url}.`, fix: "Publish /llms.txt: a short markdown map of what you do and which pages matter. Still a proposal rather than a standard, but it is cheap and it is the file assistants look for." },
  );

  f.push(
    sitemap.found
      ? { id: "sitemap", severity: "ok", title: `Sitemap lists ${sitemap.urlCount} URLs`, evidence: `${sitemap.sources.length} sitemap file(s)${sitemap.newestLastmod ? `, newest lastmod ${sitemap.newestLastmod}` : ""}.`, fix: "" }
      : { id: "no-sitemap", severity: "warning", title: "No readable sitemap", evidence: sitemap.error ?? "Nothing at the declared or conventional locations.", fix: "Publish a sitemap and declare it in robots.txt so crawlers do not have to guess at your URL set." },
  );

  if (share.ran && share.answersCounted) {
    const ours = Math.round(share.ourShare * 100);
    const rival = share.brands.find((b) => !b.isUs);
    f.push({
      id: "share-of-voice",
      severity: ours === 0 ? "critical" : rival && rival.share > share.ourShare ? "warning" : "ok",
      title: `${ours}% share of voice across ${share.enginesUsed.length} engine(s)`,
      evidence:
        `Named in ${share.brands.find((b) => b.isUs)?.mentions ?? 0} of ${share.answersCounted} answers to ${share.prompts.length} synthetic buyer questions` +
        (rival ? `. Highest competitor: ${rival.brand} at ${Math.round(rival.share * 100)}%.` : "."),
      fix: ours === 0
        ? "No assistant volunteers you for your own category. That is earned through mentions on sites the models already trust — on-page changes alone will not move it."
        : rival && rival.share > share.ourShare
          ? `${rival.brand} is named more often than you. The comparison below shows where their site is measurably ahead.`
          : "",
    });
  }

  if (comparison.ran && comparison.gaps.length) {
    f.push({
      id: "competitor-gaps",
      severity: "warning",
      title: `Behind competitors on ${comparison.gaps.length} check(s)`,
      evidence: `${comparison.leaderDomain} leads overall. You trail on: ${comparison.gaps.join(", ")}.`,
      fix: "The suggestions below are built from these gaps, with the generated files ready to ship.",
    });
  }

  if (market.enabled && market.answers.length) {
    const pct = Math.round(market.mentionRate * 100);
    f.push({
      id: "ai-mention-rate",
      severity: pct === 0 ? "critical" : pct < 50 ? "warning" : "ok",
      title: `Named in ${pct}% of buyer questions`,
      evidence: `Mentioned in ${market.answers.filter((a) => a.mentionsBrand).length} of ${market.answers.length} answers. Most-named alternatives: ${market.competitors.slice(0, 3).map((c) => c.domain).join(", ") || "none identified"}.`,
      fix: pct === 0
        ? "The model does not associate you with your own category. That is earned through mentions on sites it already trusts, not through on-page changes."
        : "",
    });
  }

  return f;
}

export interface AuditOptions {
  /**
   * Competitors named by the person running the audit.
   *
   * The model's list is a guess about who you compete with; yours is not. Supplied names take
   * precedence and the discovered ones fill any remaining slots, so the comparison still works
   * when no model key is configured at all.
   */
  competitors?: string[];
}

export async function runAudit(inputUrl: string, options: AuditOptions = {}): Promise<AuditResult> {
  const started = Date.now();
  const url = normalizeUrl(inputUrl);
  if (!url) throw new Error("That does not look like a URL.");
  const u = new URL(url);
  const origin = u.origin;
  const domain = u.hostname.replace(/^www\./, "");

  // The page first — everything downstream is derived from it.
  const page = await fetchRawAndRendered(url);
  const rawHtml = page.raw?.html ?? "";
  const onpage = rawHtml ? extractOnPage(rawHtml, url) : null;
  const renderedOnpage = page.rendered?.html ? extractOnPage(page.rendered.html, url) : null;
  const renderChecked = playwrightEnabled() && Boolean(page.rendered);
  const render = renderChecked ? classifyRenderMode(onpage, renderedOnpage) : null;

  const brand = brandFrom(onpage?.title ?? "", domain);

  // Independent of each other, so they go together.
  const [robots, llmsTxt] = await Promise.all([fetchRobots(origin), fetchLlmsTxt(origin)]);
  const [sitemap, market] = await Promise.all([
    fetchSitemap(origin, robots.sitemaps),
    readMarket({
      brand,
      domain,
      title: onpage?.title ?? "",
      description: "",
      bodyExcerpt: onpage?.text ?? "",
    }),
  ]);

  // Our own profile, on exactly the weighting every competitor is scored with — otherwise the
  // comparison is two different measurements pretending to be one.
  const usBase = {
    url, domain, brand,
    reachable: Boolean(page.raw?.ok),
    status: page.raw?.status ?? 0,
    hasTitle: onpage?.hasTitle ?? false,
    title: onpage?.title ?? "",
    hasMetaDescription: onpage?.hasMetaDescription ?? false,
    h1Count: onpage?.h1Count ?? 0,
    hasJsonLd: onpage?.hasJsonLd ?? false,
    wordCount: onpage?.wordCount ?? 0,
    metaNoindex: onpage?.metaNoindex ?? false,
    llmsTxt: llmsTxt.found,
    llmsFullTxt: llmsTxt.fullFound,
    llmsBytes: llmsTxt.bytes,
    sitemapFound: sitemap.found,
    sitemapUrls: sitemap.urlCount,
    robotsFound: robots.found,
    retrievalBlocked: robots.retrievalBlocked.map((a) => a.bot.label),
  };
  const us: SiteProfile = { ...usBase, score: scoreProfile(usBase) };

  // The competitor set comes from the market read, so both features agree on who the rivals are
  // rather than each deciding separately.
  // Competitor discovery is its own step, not a by-product of who happened to be mentioned:
  // search for alternatives, let a model sort real rivals from review sites, then verify each
  // one actually resolves before it reaches the comparison.
  const discovery = await discoverCompetitors({
    brand,
    domain,
    category: onpage?.title || brand,
    bodyExcerpt: onpage?.text ?? "",
    supplied: options.competitors,
    fromAnswers: market.competitors.map((c) => ({ name: c.name, domain: c.domain })),
  });
  const competitorDomains = discovery.competitors.map((c) => c.domain);
  const competitorRefs = discovery.competitors.map((c) => ({ name: c.name, domain: c.domain }));

  const [share, comparison] = await Promise.all([
    measureShareOfVoice({
      brand,
      domain,
      category: onpage?.title || brand,
      bodyExcerpt: onpage?.text ?? "",
      competitors: competitorRefs,
    }),
    compareWithCompetitors({ us, competitorDomains }),
  ]);

  const findings = buildFindings({ onpage, render, robots, llmsTxt, sitemap, market, share, comparison });

  // Blunt on purpose: criticals cost more than warnings, and the number only exists to order
  // one audit against the next one for the same site.
  const critical = findings.filter((f) => f.severity === "critical").length;
  const warning = findings.filter((f) => f.severity === "warning").length;
  const score = Math.max(0, 100 - critical * 20 - warning * 6);

  return {
    url,
    origin,
    domain,
    brand,
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    reachable: Boolean(page.raw?.ok),
    status: page.raw?.status ?? 0,
    onpage,
    render,
    renderChecked,
    robots,
    llmsTxt,
    sitemap,
    market,
    share,
    discovery,
    comparison,
    findings,
    score,
  };
}
