// Otterly.ai — the answer-engine visibility data this page is built on.
//
// ── Why a vendor at all, when the old page refused one ─────────────────────────────────────────
//
// The previous version of /geo answered two questions from our own access logs: can the crawlers
// reach us, and do humans arrive from AI. Both are first-party and neither needs anybody's API. What
// it could NOT answer is the question the SEO team actually asks — when somebody asks ChatGPT for the
// best AI video generator, are we in the answer, and who is instead. Nothing in our own logs contains
// that, because the answer happens on the engine's side and we are only told about it if we are cited.
//
// Measuring it means running prompts against seven engines on a schedule and parsing the answers.
// That is a data-collection business, not a feature, so it is bought.
//
// ── Shape of the API, and the two ids everything hangs off ──────────────────────────────────────
//
//   GET /v1/workspaces                      → workspace id
//   GET /v1/reports/brand?workspaceId=…      → brand report id (the brand, its domains, competitors)
//   GET /v1/reports/brand/{id}/stats         → share of voice, coverage, mentions, competitor set
//   GET /v1/reports/brand/{id}/prompts       → per-prompt mentions
//   GET /v1/reports/brand/{id}/citations     → which URLs get cited, and whose
//   GET /v1/reports/brand/{id}/recommendations → what to do about it
//   GET /v1/reports/brand/{id}/agent-analytics/stats → AI agent visits, if logs are connected to them
//   GET /v1/engines                          → which engines exist per country
//
// Everything below /reports/brand/{id} REQUIRES startDate, endDate and country. There is no default
// window: a call without them is a 400, so the caller always states the window it means.
//
// ── Never throws ────────────────────────────────────────────────────────────────────────────────
//
// Same contract as writer/ahrefs.ts, for the same reason: this is one panel on one page. A 401 from a
// wrong key, a 429, or a workspace with no report yet must all render as a page that says what is
// wrong — not as a 500. So every function returns data-or-null and collects a human-readable problem.

const BASE = "https://data.otterly.ai";

/** Engines Otterly can query. Order is the order they are rendered in. */
export const OTTERLY_ENGINES = [
  "chatgpt", "google", "google_ai_mode", "perplexity", "copilot", "gemini", "claude",
] as const;
export type OtterlyEngine = (typeof OTTERLY_ENGINES)[number];

export const ENGINE_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT",
  google: "Google AI Overviews",
  google_ai_mode: "Google AI Mode",
  perplexity: "Perplexity",
  copilot: "Copilot",
  gemini: "Gemini",
  claude: "Claude",
  other: "Other",
};

export function otterlyEnabled(): boolean {
  return !!process.env.OTTERLY_API_KEY?.trim();
}

/**
 * Which OTTERLY_* variables the running process can actually see. NAMES ONLY, never values.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 *
 * "No key yet" and "the key is there under a name I do not read" render identically and have
 * completely different fixes, and the second one is invisible from the outside — which is the exact
 * failure this page's predecessor was written to avoid, and which it then reproduced. Measured on the
 * first live check after the key was added: the deployed route reported `configured: false` with zero
 * problems, which says nothing about whether the variable is missing, misnamed, or simply not yet in
 * the running deployment.
 *
 * Listing the names it CAN see turns all three into one glance. Names are safe to surface — a variable
 * name is not a secret, and the values are never read here.
 */
export function otterlyEnvSeen(): string[] {
  return Object.keys(process.env)
    .filter((k) => /^(?:NEXT_PUBLIC_)?OTTERLY/i.test(k))
    .filter((k) => (process.env[k] ?? "").trim() !== "")
    .sort();
}

/**
 * Which country's results to read.
 *
 * Otterly wants lowercase ISO 3166-1 alpha-2 and takes `uk` rather than `gb` — its own docs say so,
 * and passing `gb` is a silent empty result rather than an error, which is the worst kind.
 */
export function otterlyCountry(): string {
  const c = process.env.OTTERLY_COUNTRY?.trim().toLowerCase();
  return c || "us";
}

/**
 * Pin a specific brand report.
 *
 * Optional. Unset, the client takes the first report in the first workspace, which is right for an
 * account with one brand and wrong the moment somebody adds a second — so the page reports which one
 * it chose rather than leaving it implied.
 */
export function otterlyReportId(): string | null {
  return process.env.OTTERLY_REPORT_ID?.trim() || null;
}

/**
 * Per-process cache.
 *
 * 15 minutes. Otterly's numbers move once a day at most — the prompts are run on a schedule their
 * side — so a shorter TTL would buy nothing and a dashboard that is reloaded four times while
 * somebody reads it would pay four times for the same answer.
 */
const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 15 * 60_000;

export interface Problem { call: string; detail: string }

async function call<T>(
  path: string,
  params: Record<string, string | string[] | undefined>,
  problems: Problem[],
): Promise<T | null> {
  const key = process.env.OTTERLY_API_KEY?.trim();
  if (!key) { problems.push({ call: path, detail: "OTTERLY_API_KEY is not set." }); return null; }
  // Otterly's own 403 message states the expected form: `Authorization: Bearer oai_live_<your-key>`.
  // Checking the prefix turns the commonest setup mistake — pasting a dashboard session token, or the
  // key with `Bearer ` already on the front — into a sentence that says so, instead of a 403 that
  // reads as an expired subscription. A warning, not a refusal: the prefix is theirs to change.
  if (!/^oai_live_/.test(key)) {
    problems.push({
      call: path,
      detail: `OTTERLY_API_KEY does not start with "oai_live_", which is the form Otterly documents. `
        + "If the call below fails with a 403, this is the first thing to check — paste the key alone, "
        + "without the word Bearer.",
    });
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    // `engines` is repeated rather than comma-joined — the spec says "repeat the param or pass a
    // single value", and a comma-joined list comes back as an unfiltered result rather than an error.
    if (Array.isArray(v)) for (const one of v) qs.append(k, one);
    else qs.set(k, v);
  }
  const url = `${BASE}${path}${qs.toString() ? `?${qs}` : ""}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      // The body is worth quoting rather than replacing. Probed against the live API: a MISSING header
      // is 401 and a bad, expired or unsubscribed key is 403 — not the "valid but unentitled" reading
      // 403 usually implies — and Otterly's own message spells out which of those four it is. A
      // hand-written message here would have asserted the wrong one.
      const body = await res.text().catch(() => "");
      let served = "";
      try { served = String((JSON.parse(body) as { message?: string }).message ?? ""); } catch { served = body.slice(0, 240); }
      problems.push({
        call: path,
        detail: res.status === 401
          ? `Otterly saw no usable credentials (401)${served ? `: ${served}` : ". Check that OTTERLY_API_KEY is set."}`
          : res.status === 403
            ? `Otterly rejected the key (403)${served ? `: ${served}` : ". It may be malformed, expired, or its subscription inactive — and the public API is a paid add-on."}`
            : res.status === 429
              ? "Rate limited by Otterly (429). The page will fill on the next load."
              : `Otterly answered ${res.status}${served ? `: ${served}` : ""}`,
      });
      return null;
    }
    const json = (await res.json()) as T;
    cache.set(url, { at: Date.now(), value: json });
    return json;
  } catch (e: unknown) {
    problems.push({
      call: path,
      detail: e instanceof Error && e.name === "TimeoutError"
        ? "Otterly did not answer within 25s."
        : `Otterly could not be reached: ${e instanceof Error ? e.message : "unknown"}`,
    });
    return null;
  }
}

// ── Response types, transcribed from the OpenAPI spec at data.otterly.ai/v1/openapi.json ─────────

export interface Paged<T> { items: T[]; paging?: { nextCursor?: string; hasMore?: boolean; limit?: number; offset?: number } }

export interface EngineRow { country: string; baseEngines: string[]; addonEngines: string[] }

export interface Workspace {
  id: string; name: string;
  promptsUsedCount: number; promptsMaxCount: number;
  geoAuditUsedCount: number; geoAuditMaxCount: number;
}

export interface BrandReport {
  id: string; workspaceId: string; reportTitle: string;
  brand: string; brandDomain: string; countries: string[];
  competitors?: Array<{ brand: string; brandDomain?: string }>;
}

export interface BrandMention {
  brand: string; isMainBrand: boolean; rank: number;
  mentions: number; shareOfVoice: number; brandCoverage: number;
  domain?: string; logoUrl?: string;
}

/** One day of a time series. `brands` or `domains` depending on the series. */
export interface DayPoint {
  date: string;
  brands?: Array<{ brand: string; isMainBrand: boolean; logoUrl?: string; coverage?: number; position?: number; visibilityScore?: number; likelihood?: number }>;
  domains?: Array<{ domain: string; isMainBrand: boolean; logoUrl?: string; coverage?: number }>;
}

export interface BrandStats {
  id: string; status: string; isRecalculating: boolean; totalPrompts: number;
  brand: { brand: string; brandDomain: string };
  summary: {
    averageRank: number; averagePosition: number;
    /** Across EVERY brand, not ours. Ours is on the isMainBrand row of brandMentions. */
    totalMentions: number; totalSources: number;
    shareOfVoice: number; brandCoverage: number; domainCoverage: number;
  };
  /**
   * Brands Otterly found in the answers that are NOT in the configured competitor set.
   *
   * 37 of them on the live account, led by YouTube on 10 mentions. The most interesting list in the
   * whole payload and it was going unread: the competitor set is who we decided to watch, and this is
   * who actually turns up.
   */
  detectedBrands?: Array<{ name: string; mentions: number }>;
  allBrandsAnalysis?: {
    brandMentions?: BrandMention[];
    brandRankHistory?: DayPoint[];
    brandCoverageHistory?: DayPoint[];
    brandPositionHistory?: DayPoint[];
    brandVisibilityIndex?: DayPoint[];
    domainCoverageHistory?: DayPoint[];
  };
  /** Same shape, restricted to the configured competitors — and the only one whose logoUrl is real.
   *  allBrandsAnalysis returns the literal string "undefined/logos/brands/…", which is a bug on their
   *  side and must never reach an <img>. See `usableLogo`. */
  competitorBrandsAnalysis?: {
    brandMentions?: BrandMention[];
    brandCoverageHistory?: DayPoint[];
    domainCoverageHistory?: DayPoint[];
    brandVisibilityIndex?: DayPoint[];
  };
}

/**
 * Otterly's logo URLs are sometimes the literal string "undefined/logos/brands/<name>".
 *
 * Observed on every `allBrandsAnalysis` row while `competitorBrandsAnalysis` carries a real
 * cdn.brandfetch.io URL for the same brand. Rendering the broken one gives a row of alt-text boxes, so
 * anything that is not an absolute http(s) URL is treated as no logo at all.
 */
export function usableLogo(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return url;
}

export interface PromptRow {
  id: string; prompt: string; country: string;
  rank: number; volume: number;
  brandMentions: number; domainMentions: number;
  tags?: Array<{ id: string; name: string; color?: string }>;
  competitors?: Array<{ brand: string; brandMentions: number; domainMentions: number }>;
}

export interface CitationRow {
  url: string; domain: string; title: string;
  citations: number; brandMentioned: number;
  isMyBrandDomain: boolean;
  domainCategory: string;
}

export interface CitationStats {
  /** The cited-domain leaderboard. youtube.com led it with 33 of 345 on the live account, and none of
   *  it was on the page. */
  domainRank?: { citations?: Array<{ domain: string; rank: number; citations: number; citationShare: number; logoUrl?: string; main: boolean }> };
  domainCitations?: { current: number; total: number; citationShare: number; mostCitedUrls?: Array<{ url: string; rank: number; currentCitations: number; citationShare: number }> };
  /** Per-competitor citation share, against the same total. */
  competitors?: Array<{ brandDomain: string; domainCitations: { current: number; total: number; citationShare: number } }>;
}

export interface Recommendation {
  id: string; engine: string; type: string; group: string;
  score: number; state: string; status: string;
  copy?: { title?: string; headline?: string; reasoning?: string; suggestions?: unknown[] };
}

export interface AgentStats {
  availability: "not_connected" | "connected_no_data" | "connected_with_data";
  /** Null, not 0, when `availability` is not `connected_with_data` — observed on the live API, where
   *  the spec types them as integers. Rendering a null as "0 agent visits" would assert something
   *  measured about a domain Otterly cannot see. */
  totalAgentVisits: number | null; pagesVisited: number | null;
  topEngine: string | null;
  engines: Array<{ engine: string; visits: number }> | null;
}

// ── The calls ────────────────────────────────────────────────────────────────────────────────────

/**
 * The window every report endpoint requires, plus the two optional filters they all accept.
 *
 * `engines` is REPEATED rather than comma-joined — the spec says "repeat the param or pass a single
 * value", and a comma-joined list comes back as an unfiltered result rather than an error, which is the
 * worst kind of wrong: a filter that silently does nothing.
 */
export interface Filters { engines?: string[]; tagId?: string }

const win = (startDate: string, endDate: string, country: string, f: Filters = {}) => ({
  startDate, endDate, country,
  ...(f.engines?.length ? { engines: f.engines } : {}),
  ...(f.tagId ? { tagId: f.tagId } : {}),
});

export async function listEngines(problems: Problem[], country?: string): Promise<EngineRow[]> {
  const d = await call<Paged<EngineRow>>("/v1/engines", { country }, problems);
  return d?.items ?? [];
}

export async function listWorkspaces(problems: Problem[]): Promise<Workspace[]> {
  const d = await call<Paged<Workspace>>("/v1/workspaces", {}, problems);
  return d?.items ?? [];
}

export async function listBrandReports(problems: Problem[], workspaceId?: string): Promise<BrandReport[]> {
  const d = await call<Paged<BrandReport>>("/v1/reports/brand", { workspaceId }, problems);
  return d?.items ?? [];
}

export async function brandStats(
  reportId: string, startDate: string, endDate: string, country: string, problems: Problem[], f: Filters = {},
): Promise<BrandStats | null> {
  return call<BrandStats>(`/v1/reports/brand/${reportId}/stats`, win(startDate, endDate, country, f), problems);
}

export async function brandPrompts(
  reportId: string, startDate: string, endDate: string, country: string, problems: Problem[], limit = 50, f: Filters = {},
): Promise<PromptRow[]> {
  const d = await call<Paged<PromptRow>>(
    `/v1/reports/brand/${reportId}/prompts`,
    { ...win(startDate, endDate, country, f), limit: String(limit), sortBy: "brandMentions", sortOrder: "desc" },
    problems,
  );
  return d?.items ?? [];
}

export async function brandCitations(
  reportId: string, startDate: string, endDate: string, country: string, problems: Problem[], limit = 40, f: Filters = {},
): Promise<CitationRow[]> {
  const d = await call<Paged<CitationRow>>(
    `/v1/reports/brand/${reportId}/citations`,
    { ...win(startDate, endDate, country, f), limit: String(limit), sortBy: "citations", sortOrder: "desc" },
    problems,
  );
  return d?.items ?? [];
}

export async function brandCitationStats(
  reportId: string, startDate: string, endDate: string, country: string, problems: Problem[], f: Filters = {},
): Promise<CitationStats | null> {
  return call<CitationStats>(`/v1/reports/brand/${reportId}/citations/stats`, win(startDate, endDate, country, f), problems);
}

export async function brandRecommendations(
  reportId: string, country: string, problems: Problem[],
): Promise<Recommendation[]> {
  const d = await call<Paged<Recommendation>>(`/v1/reports/brand/${reportId}/recommendations`, { country }, problems);
  // `removed` and `archived` are decisions somebody already made. Showing them again is how a
  // recommendations list becomes something people stop reading.
  return (d?.items ?? []).filter((r) => r.state !== "removed" && r.state !== "archived");
}

export async function agentStats(
  reportId: string, startDate: string, endDate: string, problems: Problem[],
): Promise<AgentStats | null> {
  return call<AgentStats>(`/v1/reports/brand/${reportId}/agent-analytics/stats`, { startDate, endDate }, problems);
}

// ── Account and entitlements ─────────────────────────────────────────────────────────────────────

export interface AccountInfo {
  subscriptionPlan: string; subscriptionEndDate: string;
  promptsUsedCount: number; promptsMaxCount: number;
  geoAuditUsedCount: number; geoAuditMaxCount: number;
  apiRequestsUsedCount: number; apiRequestsMaxCount: number; apiRequestsPeriodEnd: string;
  mcpRequestsUsedCount: number; mcpRequestsMaxCount: number;
}

/**
 * Plan, quota and expiry.
 *
 * On the page because every number here is a reason the rest of the page might be empty tomorrow: the
 * live account is a TRIAL ending 2026-09-04 with 15 of 50 prompts and a 1,000-request monthly API cap.
 * A visibility dashboard that goes blank without saying why is the failure this surface keeps being
 * rewritten to avoid.
 */
export async function accountInfo(problems: Problem[]): Promise<AccountInfo | null> {
  return call<AccountInfo>("/v1/accounts/info", {}, problems);
}

// ── The actual answers ───────────────────────────────────────────────────────────────────────────

export interface AiResponse {
  runId: string; runDate: string; engine: string;
  state: string; content: string;
}

/**
 * What an engine actually said, per run, for one prompt.
 *
 * The highest-value endpoint in the API and the one the first version ignored completely. Coverage
 * tells you that 13 of 15 prompts never mention us; this tells you what they said instead, with the
 * cited links inline — which is the difference between a number and a brief.
 *
 * Fetched on demand rather than for every prompt: 15 prompts would be 15 calls against a 1,000-request
 * monthly cap, to render text nobody has asked to read yet.
 */
export async function promptResponses(
  reportId: string, promptId: string, startDate: string, endDate: string, country: string, problems: Problem[],
): Promise<AiResponse[]> {
  const d = await call<Paged<AiResponse>>(
    `/v1/reports/brand/${reportId}/prompts/${promptId}/ai-responses`,
    win(startDate, endDate, country), problems,
  );
  return d?.items ?? [];
}

// ── Agent analytics, beyond the summary ──────────────────────────────────────────────────────────

export interface AgentRow { agent?: string; bot?: string; engine?: string; visits?: number }
export interface AgentPage { url?: string; path?: string; visits?: number; engine?: string }

export async function agentAgents(reportId: string, problems: Problem[]): Promise<{ availability: string; items: AgentRow[] }> {
  const d = await call<{ availability: string } & Paged<AgentRow>>(
    `/v1/reports/brand/${reportId}/agent-analytics/agents`, {}, problems);
  return { availability: d?.availability ?? "not_connected", items: d?.items ?? [] };
}

export async function agentPages(reportId: string, problems: Problem[]): Promise<{ availability: string; items: AgentPage[] }> {
  const d = await call<{ availability: string } & Paged<AgentPage>>(
    `/v1/reports/brand/${reportId}/agent-analytics/pages`, {}, problems);
  return { availability: d?.availability ?? "not_connected", items: d?.items ?? [] };
}

// ── Audits ───────────────────────────────────────────────────────────────────────────────────────

export interface CrawlabilityCheck {
  id: string; url: string; domain: string; status?: string;
  createdDate: string; completedDate?: string;
  /** Bot name → allowed by robots.txt. 21 bots on the live check. */
  robotsTxtAnalysis?: Record<string, boolean>;
  robotsTxtAnalysisResult?: boolean;
  /** Bot name → what the server ACTUALLY answered when Otterly fetched as that bot. This is the part
   *  robots.txt cannot tell you: a WAF can return 403 to a bot robots.txt permits. */
  serverBotAccess?: Record<string, { status: number; ok: boolean; userAgent: string }>;
}

export interface ContentCheck {
  id: string; url: string; status: string; createdDate: string;
  crawlerIdentity?: string; sendOtterlyHeader?: boolean;
  structuralAnalysis?: {
    overallScore: number;
    categoryScores: { structure: number; content: number; metadata: number; technical: number };
    structure?: { score: number; breakdown?: Record<string, unknown> };
    content?: { score: number; breakdown?: Record<string, unknown> };
    metadata?: { score: number; breakdown?: Record<string, unknown> };
    technical?: { score: number; breakdown?: Record<string, unknown> };
  };
}

export interface FanOut {
  id: string; query: string; status: string; createdDate: string;
  engines?: string[];
  /** How each engine expanded the one query into the several it actually searched. */
  results?: Array<{ engine: string; state: string; reasoningForCount?: string; expandedQueries?: string[]; failureReason?: string }>;
}

export async function crawlabilityChecks(problems: Problem[]): Promise<CrawlabilityCheck[]> {
  const d = await call<Paged<CrawlabilityCheck>>("/v1/audits/geo/crawlability-checks", {}, problems);
  return d?.items ?? [];
}
export async function crawlabilityCheck(id: string, problems: Problem[]): Promise<CrawlabilityCheck | null> {
  return call<CrawlabilityCheck>(`/v1/audits/geo/crawlability-checks/${id}`, {}, problems);
}
export async function contentChecks(problems: Problem[]): Promise<ContentCheck[]> {
  const d = await call<Paged<ContentCheck>>("/v1/audits/geo/content-checks", {}, problems);
  return d?.items ?? [];
}
export async function contentCheck(id: string, problems: Problem[]): Promise<ContentCheck | null> {
  return call<ContentCheck>(`/v1/audits/geo/content-checks/${id}`, {}, problems);
}
export async function fanOuts(workspaceId: string, problems: Problem[]): Promise<FanOut[]> {
  const d = await call<Paged<FanOut>>("/v1/audits/query-fan-outs", { workspaceId }, problems);
  return d?.items ?? [];
}
export async function fanOut(id: string, problems: Problem[]): Promise<FanOut | null> {
  return call<FanOut>(`/v1/audits/query-fan-outs/${id}`, {}, problems);
}

/**
 * Create an audit. The only writes this module makes.
 *
 * Each one spends from `geoAuditMaxCount` — 5 on the live plan — so these are never called on page
 * load. They are wired to buttons that name the cost, and the cache is bypassed because a POST that
 * returned a cached id would silently do nothing.
 */
async function post<T>(path: string, body: Record<string, unknown>, problems: Problem[]): Promise<T | null> {
  return write<T>("POST", path, body, problems);
}

/** Every mutating call. One error path, so a PATCH reports a 403 the same way a POST does. */
async function write<T>(
  method: "POST" | "PATCH" | "DELETE", path: string, body: Record<string, unknown> | null, problems: Problem[],
): Promise<T | null> {
  const key = process.env.OTTERLY_API_KEY?.trim();
  if (!key) { problems.push({ call: path, detail: "OTTERLY_API_KEY is not set." }); return null; }
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let served = text.slice(0, 240);
      try { served = String((JSON.parse(text) as { message?: string }).message ?? served); } catch { /* keep raw */ }
      problems.push({ call: path, detail: `Otterly answered ${res.status}: ${served}` });
      return null;
    }
    // A DELETE answers 204 with no body, which JSON.parse would throw on. An empty successful body is
    // still a success, so it resolves to an empty object rather than to null (null means failed).
    if (!text.trim()) return {} as T;
    return JSON.parse(text) as T;
  } catch (e: unknown) {
    problems.push({ call: path, detail: `Could not reach Otterly: ${e instanceof Error ? e.message : "unknown"}` });
    return null;
  }
}

export function createCrawlabilityCheck(workspaceId: string, url: string, problems: Problem[]) {
  return post<{ id: string; status: string }>("/v1/audits/geo/crawlability-checks", { workspaceId, url }, problems);
}
export function createContentCheck(workspaceId: string, url: string, crawlerIdentity: string, problems: Problem[]) {
  return post<{ id: string; status: string }>(
    "/v1/audits/geo/content-checks", { workspaceId, url, crawlerIdentity, sendOtterlyHeader: false }, problems);
}
export function createFanOut(workspaceId: string, query: string, problems: Problem[]) {
  return post<{ id: string; status: string }>("/v1/audits/query-fan-outs", { workspaceId, query }, problems);
}

/** Crawler identities a content check may impersonate. */
export const CRAWLER_IDENTITIES = ["ChatGPT-User", "OAI-SearchBot", "PerplexityCrawler", "GoogleBot"] as const;

// ── Prompts and tags: the parts of Otterly this dashboard can actually CHANGE ─────────────────────
//
// Everything above reads. These write, and they are what turn the page from a mirror of Otterly into
// the place the work happens: the prompts ARE the measurement, so being able to add one without
// leaving Summit is the difference between "we should track that" and tracking it.
//
// Bulk by design. POST takes an array, and a coverage gap or an unmentioned competitor usually suggests
// several prompts at once — one call for ten of them rather than ten calls against a request cap.

export interface WorkspacePrompt {
  id: string; prompt: string; country: string;
  tagIds: string[]; intentVolume?: number; createdDate: string;
}
export interface Tag {
  id: string; workspaceId: string; name: string; color: string;
  promptCount: number; createdDate: string;
}

export async function workspacePrompts(workspaceId: string, problems: Problem[]): Promise<WorkspacePrompt[]> {
  const d = await call<Paged<WorkspacePrompt>>(`/v1/workspaces/${workspaceId}/prompts`, {}, problems);
  return d?.items ?? [];
}

export async function workspaceTags(workspaceId: string, problems: Problem[]): Promise<Tag[]> {
  const d = await call<Paged<Tag>>(`/v1/workspaces/${workspaceId}/tags`, {}, problems);
  return d?.items ?? [];
}

/**
 * Add prompts. Each one consumes from promptsMaxCount — 50 on this plan, 15 used — so the caller shows
 * the remaining budget and this refuses to send an empty list rather than spending a request to learn
 * that nothing was selected.
 */
export async function createPrompts(
  workspaceId: string,
  input: { prompts: string[]; country: string; tagIds?: string[]; brandReportIds?: string[] },
  problems: Problem[],
): Promise<WorkspacePrompt[] | null> {
  const prompts = input.prompts.map((p) => p.trim()).filter(Boolean);
  if (!prompts.length) { problems.push({ call: "createPrompts", detail: "No prompts to add." }); return null; }
  const d = await post<{ items: WorkspacePrompt[] }>(
    `/v1/workspaces/${workspaceId}/prompts`,
    { prompts, country: input.country, ...(input.tagIds?.length ? { tagIds: input.tagIds } : {}),
      ...(input.brandReportIds?.length ? { brandReportIds: input.brandReportIds } : {}) },
    problems,
  );
  return d?.items ?? null;
}

export async function setPromptTags(workspaceId: string, promptId: string, tagIds: string[], problems: Problem[]) {
  return patch<{ id: string; tagIds: string[] }>(`/v1/workspaces/${workspaceId}/prompts/${promptId}`, { tagIds }, problems);
}

export async function deletePrompt(workspaceId: string, promptId: string, problems: Problem[]): Promise<boolean> {
  return del(`/v1/workspaces/${workspaceId}/prompts/${promptId}`, problems);
}

export async function createTag(workspaceId: string, name: string, color: string, problems: Problem[]) {
  return post<Tag>(`/v1/workspaces/${workspaceId}/tags`, { name, color }, problems);
}

export async function deleteTag(workspaceId: string, tagId: string, problems: Problem[]): Promise<boolean> {
  return del(`/v1/workspaces/${workspaceId}/tags/${tagId}`, problems);
}

// ── Citation drill-downs ─────────────────────────────────────────────────────────────────────────

export interface CitedPromptRow { id: string; prompt: string; engines: string[]; brandMentioned: number }
export interface CitationHistory {
  totalPeriodCitations: number; totalCitationsPreviousPeriod: number; percentageChange: number;
  citationsHistory: Array<{ date: string; totalCitations: number; citationsByEngine?: unknown[] }>;
}

/** Which prompts produced an answer citing this URL. The "why is this page cited" answer. */
export async function citationPrompts(
  reportId: string, url: string, startDate: string, endDate: string, country: string, problems: Problem[], f: Filters = {},
): Promise<CitedPromptRow[]> {
  const d = await call<Paged<CitedPromptRow>>(
    `/v1/reports/brand/${reportId}/citations/prompts`, { url, ...win(startDate, endDate, country, f) }, problems);
  return d?.items ?? [];
}

/** Citation count over time for one URL, with the change against the preceding window. */
export async function citationHistory(
  reportId: string, url: string, startDate: string, endDate: string, country: string, problems: Problem[], f: Filters = {},
): Promise<CitationHistory | null> {
  return call<CitationHistory>(
    `/v1/reports/brand/${reportId}/citations/history`, { url, ...win(startDate, endDate, country, f) }, problems);
}

/** PATCH and DELETE, sharing post()'s error handling. */
async function patch<T>(path: string, body: Record<string, unknown>, problems: Problem[]): Promise<T | null> {
  return write<T>("PATCH", path, body, problems);
}
async function del(path: string, problems: Problem[]): Promise<boolean> {
  return (await write<unknown>("DELETE", path, null, problems)) !== null;
}
