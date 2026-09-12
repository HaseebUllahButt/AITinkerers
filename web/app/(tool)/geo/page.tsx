"use client";

// GEO — are we in the answer, and who is instead.
//
// ── What changed, and why the old page went ─────────────────────────────────────────────────────
//
// The previous version answered two questions from our own access logs: can the crawlers reach us, and
// do humans arrive from AI. Both first-party, neither needing a vendor. What it could not answer is the
// one the SEO team actually asks — when somebody asks ChatGPT for the best AI video generator, are we
// named, and who is named instead. That answer happens on the engine's side and never appears in our
// logs unless we are cited.
//
// So this page is now built on Otterly's public API, which runs our prompts against seven engines on a
// schedule. The log-ingest endpoint and its store are deliberately left in place and still collecting —
// nothing depends on them today, and deleting a working first-party collector to make room for a vendor
// is a decision to take on purpose rather than as a side effect of a rewrite.
//
// ── The one number this page will not lead with ─────────────────────────────────────────────────
//
// Otterly returns `averagePosition` — mean ordinal position of our mention inside an answer. The old
// page refused a rank column outright, and the reason it gave still holds: an identical ordered list
// recurs across runs in under 1 of 1,000 cases, so a mean position is an average over things that were
// never the same measurement twice.
//
// What IS stable is the aggregate: coverage (in how many answers do we appear at all), share of voice,
// mention counts, citation counts. Those are proportions over many runs, and they move for real
// reasons. So they are the headline, `averagePosition` is shown once, in small type, next to what it
// actually means — and nothing on this page is sorted by it.
import { Fragment, useCallback, useEffect, useState } from "react";
import { Globe, Loader2, AlertTriangle, Info, ExternalLink, Quote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/PageHeader";

const ENGINE_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT", google: "Google AI Overviews", google_ai_mode: "Google AI Mode",
  perplexity: "Perplexity", copilot: "Copilot", gemini: "Gemini", claude: "Claude", other: "Other",
};

interface Report {
  id: string; reportTitle: string; brand: string; brandDomain: string;
  countries: string[]; competitors?: Array<{ brand: string; brandDomain?: string }>;
}
interface BrandRow {
  brand: string; isMainBrand: boolean; rank: number;
  mentions: number; shareOfVoice: number; brandCoverage: number;
  domain?: string; logoUrl?: string;
}
interface Stats {
  status: string; isRecalculating: boolean; totalPrompts: number;
  summary: {
    averageRank: number; averagePosition: number; totalMentions: number; totalSources: number;
    shareOfVoice: number; brandCoverage: number; domainCoverage: number;
  };
  detectedBrands?: Array<{ name: string; mentions: number }>;
  allBrandsAnalysis?: {
    brandMentions?: BrandRow[];
    brandCoverageHistory?: DayPoint[];
    brandVisibilityIndex?: DayPoint[];
    domainCoverageHistory?: DayPoint[];
  };
  competitorBrandsAnalysis?: { brandMentions?: BrandRow[] };
}
interface PromptRow {
  id: string; prompt: string; volume: number;
  brandMentions: number; domainMentions: number;
  competitors?: Array<{ brand: string; brandMentions: number }>;
}
interface CitationRow {
  url: string; domain: string; title: string;
  citations: number; brandMentioned: number; isMyBrandDomain: boolean; domainCategory: string;
}
interface CitationStats {
  domainRank?: { citations?: Array<{ domain: string; rank: number; citations: number; citationShare: number; logoUrl?: string; main: boolean }> };
  domainCitations?: { current: number; total: number; citationShare: number };
  competitors?: Array<{ brandDomain: string; domainCitations: { current: number; total: number; citationShare: number } }>;
}
interface Recommendation {
  id: string; engine: string; group: string; score: number; status: string;
  copy?: { title?: string; headline?: string; reasoning?: string };
}
interface Agents {
  availability: "not_connected" | "connected_no_data" | "connected_with_data";
  totalAgentVisits: number; pagesVisited: number; topEngine: string;
  engines: Array<{ engine: string; visits: number }>;
}
interface Workspace {
  id: string; name: string;
  promptsUsedCount: number; promptsMaxCount: number;
  geoAuditUsedCount: number; geoAuditMaxCount: number;
}
interface Account {
  subscriptionPlan: string; subscriptionEndDate: string;
  promptsUsedCount: number; promptsMaxCount: number;
  apiRequestsUsedCount: number; apiRequestsMaxCount: number; apiRequestsPeriodEnd: string;
}
interface EngineRow { country: string; baseEngines: string[]; addonEngines: string[] }
interface DayPoint {
  date: string;
  brands?: Array<{ brand: string; isMainBrand: boolean; coverage?: number; position?: number; visibilityScore?: number }>;
  domains?: Array<{ domain: string; isMainBrand: boolean; coverage?: number }>;
}
interface CrawlCheck {
  id: string; url: string; domain: string; createdDate: string; completedDate?: string;
  robotsTxtAnalysis?: Record<string, boolean>;
  robotsTxtAnalysisResult?: boolean;
  serverBotAccess?: Record<string, { status: number; ok: boolean; userAgent: string }>;
}
interface ContentCheckRow {
  id: string; url: string; status: string; createdDate: string;
  structuralAnalysis?: { overallScore: number; categoryScores: { structure: number; content: number; metadata: number; technical: number } };
}
interface FanOutRow {
  id: string; query: string; status: string; createdDate: string;
  results?: Array<{ engine: string; state: string; reasoningForCount?: string; expandedQueries?: string[] }>;
}
interface AiResponse { runId: string; runDate: string; engine: string; state: string; content: string }
interface Tag { id: string; name: string; color: string; promptCount: number }
interface WsPrompt { id: string; prompt: string; country: string; tagIds: string[]; intentVolume?: number }
interface CitedPrompt { id: string; prompt: string; engines: string[]; brandMentioned: number }
interface CiteHistory {
  totalPeriodCitations: number; totalCitationsPreviousPeriod: number; percentageChange: number;
  citationsHistory: Array<{ date: string; totalCitations: number }>;
}

interface Overview {
  ok: boolean; configured: boolean; days: number; country: string;
  startDate: string; endDate: string;
  report: Report | null; stats: Stats | null;
  prompts: PromptRow[]; citations: CitationRow[];
  citationStats: CitationStats | null;
  recommendations: Recommendation[]; agents: Agents | null;
  problems: Array<{ call: string; detail: string }>;
  /** Names of OTTERLY_* variables the server can see. Never values. */
  envSeen?: string[];
  workspace?: Workspace | null;
  account?: Account | null;
  engines?: EngineRow[];
  tags?: Tag[];
  workspacePrompts?: WsPrompt[];
  appliedEngines?: string[];
  appliedTagId?: string | null;
  agentDetail?: { agents: Array<Record<string, unknown>>; pages: Array<Record<string, unknown>> } | null;
  audits?: {
    crawlability: CrawlCheck[]; crawlabilityDetail?: CrawlCheck | null;
    content: ContentCheckRow[];
    fanOuts: FanOutRow[]; fanOutDetail?: FanOutRow | null;
  };
  error?: string;
}

/**
 * Otterly returns percentages as 0–100 already, NOT as fractions.
 *
 * Verified on the live account: shareOfVoice 2.6 next to 2 mentions out of 76, brandCoverage 47 for a
 * competitor with 28 of 60 runs. The first version of this helper did `n <= 1 ? n * 100 : n`, which
 * happens to be right for every value above 1 and catastrophically wrong below it — a genuine 0.8%
 * share would have rendered as 80%. There is no scale to guess: the units are documented by the data.
 */
const pct = (n: number | null | undefined) => (typeof n === "number" ? `${n.toFixed(1)}%` : "—");
const num = (n: number | null | undefined) => (typeof n === "number" ? n.toLocaleString() : "—");

function Kpi({ label, value, foot }: { label: string; value: string; foot?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {foot && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{foot}</p>}
    </div>
  );
}

export default function GeoPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  // Which prompt row is expanded, and the answers fetched for it. Keyed by prompt id so reopening a row
  // does not re-spend a request against the monthly API cap.
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, AiResponse[] | "loading" | "failed">>({});
  const [showDetected, setShowDetected] = useState(false);
  const [auditUrl, setAuditUrl] = useState("https://www.northwind.example");
  const [fanQuery, setFanQuery] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [runNote, setRunNote] = useState<string | null>(null);
  // Filters. Every report endpoint accepts these, and Otterly's own UI leads with them — without them
  // the page can answer "how are we doing" but not "how are we doing on ChatGPT, on video prompts".
  const [engineFilter, setEngineFilter] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string>("");
  const [country, setCountry] = useState<string>("");
  const [newPrompts, setNewPrompts] = useState("");
  const [newTag, setNewTag] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [openCite, setOpenCite] = useState<string | null>(null);
  const [citeDetail, setCiteDetail] = useState<Record<string, { prompts: CitedPrompt[]; history: CiteHistory | null } | "loading" | "failed">>({});

  /**
   * Load one window.
   *
   * `alive` rather than a bare fetch, for a reason the day-switcher makes easy to hit: eight Otterly
   * calls behind one route means a 90-day load can still be in flight when somebody clicks 7, and
   * without this the slower response lands last and overwrites the window the page is showing.
   */
  const load = useCallback(async (d: number, alive: () => boolean) => {
    if (!alive()) return;
    setLoading(true); setFailed(null);
    try {
      const qs = new URLSearchParams({ days: String(d) });
      if (engineFilter.length) qs.set("engines", engineFilter.join(","));
      if (tagFilter) qs.set("tagId", tagFilter);
      if (country) qs.set("country", country);
      const res = await fetch(`/api/geo/overview?${qs}`);
      const json = (await res.json()) as Overview;
      if (!alive()) return;
      if (!res.ok || !json.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      setData(json);
    } catch (e) {
      if (alive()) setFailed(e instanceof Error ? e.message : "Could not load");
    } finally {
      if (alive()) setLoading(false);
    }
  }, [engineFilter, tagFilter, country]);

  // The await yields before any state is touched, so the effect body itself sets nothing
  // synchronously — which is both what the react-hooks rule asks for and what makes the cancellation
  // above meaningful.
  /** Fetch the real AI answers for one prompt, once. */
  const openAnswers = useCallback(async (promptId: string) => {
    setOpenPrompt((cur) => (cur === promptId ? null : promptId));
    if (answers[promptId] || !data?.report) return;
    setAnswers((a) => ({ ...a, [promptId]: "loading" }));
    try {
      const qs = new URLSearchParams({
        reportId: data.report.id, promptId,
        startDate: data.startDate, endDate: data.endDate, country: data.country,
      });
      const res = await fetch(`/api/geo/responses?${qs}`);
      const json = (await res.json()) as { ok: boolean; items: AiResponse[] };
      setAnswers((a) => ({ ...a, [promptId]: json.ok ? json.items : "failed" }));
    } catch {
      setAnswers((a) => ({ ...a, [promptId]: "failed" }));
    }
  }, [answers, data]);

  /** Start an audit. Spends from the monthly GEO-audit quota, so only ever from a click. */
  const runAudit = useCallback(async (kind: "crawlability" | "content" | "fanout") => {
    if (!data?.workspace) return;
    setRunning(kind); setRunNote(null);
    try {
      const res = await fetch("/api/geo/audit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind, workspaceId: data.workspace.id,
          ...(kind === "fanout" ? { query: fanQuery } : { url: auditUrl }),
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string; status?: string };
      setRunNote(json.ok
        ? `Started (${json.status ?? "pending"}). Otterly takes a few seconds for a crawlability check and longer for a fan-out — reload to see the result.`
        : `Could not start: ${json.error ?? "unknown"}`);
    } catch (e) {
      setRunNote(`Could not start: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setRunning(null);
    }
  }, [data, auditUrl, fanQuery]);

  /** One helper for every write: run it, report it, reload. */
  const mutate = useCallback(async (label: string, fn: () => Promise<Response>) => {
    setBusy(label); setRunNote(null);
    try {
      const res = await fn();
      const json = (await res.json()) as { ok: boolean; error?: string; added?: number };
      setRunNote(json.ok
        ? json.added !== undefined ? `Added ${json.added}.` : "Done."
        : `Failed: ${json.error ?? "unknown"}`);
      if (json.ok) await load(days, () => true);
    } catch (e) {
      setRunNote(`Failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy(null);
    }
  }, [days, load]);

  /** Which prompts cited one page, and how it is trending. Two calls, only when a row opens. */
  const openCitation = useCallback(async (url: string) => {
    setOpenCite((cur) => (cur === url ? null : url));
    if (citeDetail[url] || !data?.report) return;
    setCiteDetail((c) => ({ ...c, [url]: "loading" }));
    try {
      const qs = new URLSearchParams({
        reportId: data.report.id, url,
        startDate: data.startDate, endDate: data.endDate, country: data.country,
      });
      if (engineFilter.length) qs.set("engines", engineFilter.join(","));
      if (tagFilter) qs.set("tagId", tagFilter);
      const res = await fetch(`/api/geo/citation?${qs}`);
      const json = (await res.json()) as { ok: boolean; prompts: CitedPrompt[]; history: CiteHistory | null };
      setCiteDetail((c) => ({ ...c, [url]: json.ok ? { prompts: json.prompts, history: json.history } : "failed" }));
    } catch {
      setCiteDetail((c) => ({ ...c, [url]: "failed" }));
    }
  }, [citeDetail, data, engineFilter, tagFilter]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      await load(days, () => !cancelled);
    })();
    return () => { cancelled = true; };
  }, [days, load, engineFilter, tagFilter, country]);

  const s = data?.stats?.summary;
  // competitorBrandsAnalysis first: it is the only one of the two whose logoUrl is a real URL rather
  // than the literal string "undefined/logos/brands/…".
  const brands = data?.stats?.competitorBrandsAnalysis?.brandMentions
    ?? data?.stats?.allBrandsAnalysis?.brandMentions ?? [];
  // Rank is DERIVED from the mention order, not read off the row.
  //
  // competitorBrandsAnalysis is preferred above for its real logo URLs, and its rows turn out not to
  // carry `rank` at all — allBrandsAnalysis's do. The page rendered "undefined of 12" because of it.
  // Sorting by mentions gives the same answer for either source and cannot go undefined.
  const ranked = [...brands].sort((a, b) => (b.mentions ?? 0) - (a.mentions ?? 0));
  const ours = ranked.find((b) => b.isMainBrand);
  // A rank among brands that all scored zero is array order, not a placing. Filtering to one engine
  // makes that easy to hit — ChatGPT alone puts us on 0 mentions alongside four others, and "7 of 12"
  // there reads as a position we earned rather than as a tie nobody won.
  const ourRank = ours && (ours.mentions ?? 0) > 0 ? ranked.indexOf(ours) + 1 : null;
  const unplaced = !!ours && (ours.mentions ?? 0) === 0;
  const rivals = ranked.filter((b) => !b.isMainBrand);
  const detected = data?.stats?.detectedBrands ?? [];
  // How many distinct days Otterly actually has in this window. This is what makes the 7/14/30/90
  // buttons honest: with one day of history every window returns identical numbers, and three buttons
  // that change nothing read as a broken page rather than as a young report.
  const history = data?.stats?.allBrandsAnalysis?.brandCoverageHistory ?? [];
  const daysOfHistory = history.length;
  const crawl = data?.audits?.crawlabilityDetail ?? null;
  const fan = data?.audits?.fanOutDetail ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Globe}
        title="GEO"
        description="When somebody asks an AI engine about what we do, are we in the answer, and who is instead. Measured by Otterly."
      />

      {failed && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">Could not load</p>
          <p className="mt-1 text-muted-foreground">{failed}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void load(days, () => true)}>Try again</Button>
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading Otterly…
        </div>
      )}

      {data && (
        <>
          {/* ── Not configured: the whole page, until a key exists ────────────────── */}
          {!data.configured && (
            <div className="space-y-3 rounded-xl border border-highlight/30 bg-highlight-soft/20 p-5">
              <div className="flex items-start gap-2.5">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-highlight-ink" />
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    {data.envSeen?.length
                      ? "An Otterly variable is set, but not the one this page reads."
                      : "No Otterly key yet, so there is nothing to read."}
                  </p>
                  {!!data.envSeen?.length && (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      The server can see{" "}
                      {data.envSeen.map((k) => (
                        <code key={k} className="mr-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">{k}</code>
                      ))}
                      — but not <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">OTTERLY_API_KEY</code>.
                      Names only; the values are never read here.
                    </p>
                  )}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Every number on this page comes from Otterly&apos;s public API. It runs our prompts
                    against the engines on its own schedule; SearchOps only reads the results.
                  </p>
                  <ol className="ml-4 list-decimal space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                    <li>
                      Set <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">OTTERLY_API_KEY</code> in
                      SearchOps&apos;s environment. The public API is a paid add-on on Otterly&apos;s side —
                      a key that works in their UI can still return 403 here.
                    </li>
                    <li>
                      Optionally set{" "}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">OTTERLY_COUNTRY</code>{" "}
                      (default <code className="font-mono text-xs">us</code>; use{" "}
                      <code className="font-mono text-xs">uk</code> rather than <code className="font-mono text-xs">gb</code>)
                      and <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">OTTERLY_REPORT_ID</code>{" "}
                      to pin one brand report. Unpinned, the first report in the first workspace is used
                      and this page says which.
                    </li>
                    <li>
                      On Vercel, a variable added <em>after</em> the current deployment was built does not
                      reach it. If it is set in the dashboard and this page still says no key, redeploy —
                      that is the usual cause, not a bad key. Check the scope is Production too.
                    </li>
                    <li>
                      The prompts themselves are managed in Otterly, not here. This page reads; it does not
                      create prompts.
                    </li>
                  </ol>
                </div>
              </div>
            </div>
          )}

          {/* ── Partial failures, named ───────────────────────────────────────────── */}
          {!!data.problems.length && (
            <div className="space-y-1.5 rounded-xl border border-warning/40 bg-warning/5 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="h-4 w-4 text-warning" />
                {data.problems.length === 1 ? "One call did not answer" : `${data.problems.length} calls did not answer`}
              </div>
              <ul className="ml-6 list-disc space-y-1 text-xs text-muted-foreground">
                {data.problems.map((p, i) => (
                  <li key={i}><code className="font-mono text-xs">{p.call}</code> — {p.detail}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Everything below is what did come back. A blank panel here means unmeasured, not zero.
              </p>
            </div>
          )}

          {/* ── Plan, quota, and which engines are actually measured ────────────────
              Every number here is a reason the rest of the page could be empty tomorrow, and the
              engine list corrects a claim the header used to make on its own: the base plan measures
              four engines, not seven. Saying "measured across seven engines" while three of them are
              add-ons you do not have is the kind of quiet overstatement this page is supposed to catch. */}
          {data.configured && (data.account || data.engines?.length) && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
              {data.account && (
                <>
                  <span>
                    Plan <span className="font-medium text-foreground">{data.account.subscriptionPlan}</span>
                    {data.account.subscriptionEndDate && <> until {data.account.subscriptionEndDate.slice(0, 10)}</>}
                  </span>
                  <span>Prompts {data.account.promptsUsedCount}/{data.account.promptsMaxCount}</span>
                  <span>
                    API {data.account.apiRequestsUsedCount}/{data.account.apiRequestsMaxCount}
                    {data.account.apiRequestsPeriodEnd && <> to {data.account.apiRequestsPeriodEnd}</>}
                  </span>
                </>
              )}
              {data.workspace && (
                <span>GEO audits {data.workspace.geoAuditUsedCount}/{data.workspace.geoAuditMaxCount} this month</span>
              )}
              {(() => {
                const row = data.engines?.find((e) => e.country === data.country) ?? data.engines?.[0];
                if (!row) return null;
                return (
                  <span>
                    Measuring{" "}
                    <span className="font-medium text-foreground">
                      {row.baseEngines.map((e) => ENGINE_LABEL[e] ?? e).join(", ")}
                    </span>
                    {!!row.addonEngines.length && (
                      <> · {row.addonEngines.map((e) => ENGINE_LABEL[e] ?? e).join(", ")} are add-ons not on this plan</>
                    )}
                  </span>
                );
              })()}
            </div>
          )}

          {data.configured && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex gap-1">
                  {[7, 14, 30, 90].map((d) => (
                    <button
                      key={d} onClick={() => setDays(d)}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs transition-colors",
                        days === d ? "bg-highlight-soft font-medium text-highlight-ink" : "text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {d} days
                    </button>
                  ))}
                </div>

                {/* Engine filter. Only the engines this plan actually measures are offered — offering
                    Gemini on a plan without it would return an empty result that reads as "we are
                    invisible on Gemini" rather than "we do not measure Gemini". */}
                {(() => {
                  const row = data.engines?.find((e) => e.country === data.country) ?? data.engines?.[0];
                  const available = row?.baseEngines ?? [];
                  if (!available.length) return null;
                  return (
                    <div className="flex items-center gap-1 border-l pl-3">
                      {available.map((e) => {
                        const on = engineFilter.includes(e);
                        return (
                          <button key={e}
                            onClick={() => setEngineFilter((f) => (on ? f.filter((x) => x !== e) : [...f, e]))}
                            className={cn("rounded-md px-2 py-1 text-xs transition-colors",
                              on ? "bg-highlight-soft font-medium text-highlight-ink" : "text-muted-foreground hover:bg-accent")}>
                            {ENGINE_LABEL[e] ?? e}
                          </button>
                        );
                      })}
                      {!!engineFilter.length && (
                        <button onClick={() => setEngineFilter([])}
                          className="ml-1 text-xs text-muted-foreground underline-offset-2 hover:underline">clear</button>
                      )}
                    </div>
                  );
                })()}

                {/* Tag filter. Every report endpoint takes a tagId, so this is how "how do we do on
                    video prompts specifically" becomes answerable. */}
                {!!data.tags?.length && (
                  <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}
                    className="rounded-md border bg-background px-2 py-1 text-xs">
                    <option value="">All tags</option>
                    {data.tags.map((t) => (
                      <option key={t.id} value={t.id}>{t.name} ({t.promptCount})</option>
                    ))}
                  </select>
                )}

                {/* Country. Otterly measures 68 of them; only the ones with a report make sense here,
                    so the report's own country list is the option set. */}
                {(data.report?.countries?.length ?? 0) > 1 && (
                  <select value={country || data.country} onChange={(e) => setCountry(e.target.value)}
                    className="rounded-md border bg-background px-2 py-1 text-xs">
                    {data.report!.countries.map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}
                  </select>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {data.report ? <>{data.report.brand} · {data.report.brandDomain} · </> : null}
                {data.country.toUpperCase()} · {data.startDate} to {data.endDate}
                {data.stats?.isRecalculating ? " · Otterly is recalculating, numbers may shift" : ""}
                {data.stats?.status && data.stats.status !== "finished" ? ` · ${data.stats.status.replace(/_/g, " ")}` : ""}
              </p>
            </div>
          )}

          {/* ── Why the window buttons may all agree ───────────────────────────────
              The question this answers is "nothing changes between 7 and 90 days". With one day in the
              series that is correct rather than broken, and saying so is cheaper than letting somebody
              conclude the filter is dead. */}
          {data.configured && daysOfHistory > 0 && daysOfHistory < 3 && (
            <p className="rounded-lg border border-highlight/30 bg-highlight-soft/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              Otterly has {daysOfHistory === 1 ? "one day" : `${daysOfHistory} days`} of history for this
              report ({history.map((h) => h.date).join(", ")}), so 7, 14, 30 and 90 days all cover the same
              runs and return the same numbers. That changes as the schedule adds days — it is not the
              filter failing.
            </p>
          )}

          {/* ── A window Otterly has not run ───────────────────────────────────────
              Distinct from "no key" and from "we score zero". All three render as zeros otherwise, and
              they have completely different fixes — which is the distinction this page exists to make. */}
          {data.configured && data.stats?.status === "no_data" && (
            <div className="rounded-xl border border-highlight/30 bg-highlight-soft/20 p-4 text-sm">
              <p className="font-medium">Otterly has no results for this window.</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                The report exists and the prompts are defined, but no run falls inside{" "}
                {data.startDate} to {data.endDate}. On a report created recently there is only a day or two
                of history — try a shorter window, or wait for the next scheduled run. Zeros below would mean
                &ldquo;never measured&rdquo;, not &ldquo;measured as absent&rdquo;.
              </p>
            </div>
          )}

          {/* ── Headline: coverage and share, never position ──────────────────────── */}
          {s && data.stats?.status !== "no_data" && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Kpi label="Brand coverage" value={pct(s.brandCoverage)}
                  foot={`Share of answers that name us, across ${num(data.stats?.totalPrompts)} prompts`} />
                <Kpi label="Share of voice" value={pct(s.shareOfVoice)}
                  foot="Our mentions as a share of every brand mentioned" />
                {/* OURS, not summary.totalMentions.
                    `summary.totalMentions` is the total across EVERY brand — on the live account it read
                    76 while ours was 2, so labelling it "Mentions" overstated us by a factor of 38. The
                    only place our own count exists is the isMainBrand row of brandMentions. */}
                <Kpi label="Our mentions" value={num(ours?.mentions)}
                  foot={`of ${num(s.totalMentions)} mentions across all brands`} />
                <Kpi label="Where we place"
                  value={ourRank ? `${ourRank} of ${ranked.length}` : unplaced ? "unplaced" : "—"}
                  foot={unplaced
                    ? `Not mentioned at all in this slice, so there is no placing — ${ranked.length} brands tracked`
                    : "By mentions, against the competitor set in Otterly"} />
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {pct(s.domainCoverage)} of answers cited northwind.example itself rather than only naming us, from{" "}
                {num(s.totalSources)} sources in total. Otterly also reports an average position of{" "}
                <span className="tabular-nums">{s.averagePosition?.toFixed?.(2) ?? "—"}</span> — the mean place
                our mention appears inside an answer. It is shown for completeness and nothing on this page is
                sorted by it: an identical ordered list recurs across runs in under 1 of 1,000 cases, so a mean
                over them averages measurements that were never the same twice. Coverage and share of voice are
                counts over many runs, which is why they lead.
              </p>
            </>
          )}

          {/* ── Who else is in the answers ────────────────────────────────────────── */}
          {!!rivals.length && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Who else is in the answers</h2>
              <div className="overflow-hidden rounded-xl border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Brand</th>
                      <th className="px-3 py-2 text-right font-medium">Mentions</th>
                      <th className="px-3 py-2 text-right font-medium">Share of voice</th>
                      <th className="px-3 py-2 text-right font-medium">Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...(ours ? [ours] : []), ...rivals].map((b) => (
                      <tr key={b.brand} className={cn("border-t", b.isMainBrand && "bg-highlight-soft/20")}>
                        <td className="px-3 py-2">
                          {b.brand}
                          {b.isMainBrand && <Badge variant="secondary" className="ml-2 text-xs">us</Badge>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(b.mentions)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{pct(b.shareOfVoice)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{pct(b.brandCoverage)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── Brands Otterly found that we never asked it to watch ───────────────
              The most interesting list in the payload and it was going unread. The competitor set is
              who we decided to track; this is who actually turns up in the answers. On the live account
              it is led by YouTube, which is not a competitor at all — it is where the answers are
              coming from, and that is a content decision rather than a rivalry one. */}
          {!!detected.length && (
            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">Turning up, but not on our watch list</h2>
                <button onClick={() => setShowDetected((v) => !v)}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                  {showDetected ? "Show fewer" : `Show all ${detected.length}`}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {detected
                  .filter((b) => !brands.some((k) => k.brand.toLowerCase() === b.name.toLowerCase()))
                  .slice(0, showDetected ? detected.length : 14)
                  .map((b) => (
                    <span key={b.name} className="rounded-md border bg-card px-2 py-1 text-xs">
                      {b.name} <span className="tabular-nums text-muted-foreground">{b.mentions}</span>
                    </span>
                  ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Named in the answers over this window, with mention counts. Anything here worth tracking
                should be added to the competitor set in Otterly so it gets coverage and share-of-voice too.
              </p>
            </section>
          )}

          {/* ── Prompts: where we are absent is the finding ───────────────────────── */}
          {!!data.prompts.length && (
            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">Prompts</h2>
                <p className="text-xs text-muted-foreground">
                  {data.prompts.filter((p) => !p.brandMentions).length} of {data.prompts.length} shown never mention us
                </p>
              </div>
              <div className="overflow-hidden rounded-xl border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Prompt</th>
                      <th className="px-3 py-2 text-right font-medium">Us</th>
                      <th className="px-3 py-2 text-right font-medium">Our domain</th>
                      <th className="px-3 py-2 text-left font-medium">Named instead</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.prompts.map((p) => {
                      const instead = (p.competitors ?? [])
                        .filter((c) => c.brandMentions > 0)
                        .sort((a, b) => b.brandMentions - a.brandMentions)
                        .slice(0, 3);
                      const open = openPrompt === p.id;
                      const got = answers[p.id];
                      return (
                        <Fragment key={p.id}>
                          <tr
                            onClick={() => void openAnswers(p.id)}
                            className={cn("cursor-pointer border-t hover:bg-accent/50", !p.brandMentions && "bg-destructive/5")}
                          >
                            <td className="px-3 py-2">
                              <span className="mr-1.5 inline-block text-muted-foreground">{open ? "▾" : "▸"}</span>
                              {p.prompt}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {p.brandMentions ? num(p.brandMentions) : <span className="text-destructive">0</span>}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{num(p.domainMentions)}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {instead.length ? instead.map((c) => c.brand).join(", ") : "—"}
                            </td>
                          </tr>
                          {open && (
                            <tr className="border-t bg-muted/20">
                              <td colSpan={4} className="px-3 py-3">
                                {got === "loading" && (
                                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Loader2 className="h-3 w-3 animate-spin" /> Fetching what the engines said…
                                  </p>
                                )}
                                {got === "failed" && (
                                  <p className="text-xs text-destructive">Could not load the answers for this prompt.</p>
                                )}
                                {Array.isArray(got) && !got.length && (
                                  <p className="text-xs text-muted-foreground">No stored answers for this prompt in this window.</p>
                                )}
                                {Array.isArray(got) && got.map((r) => (
                                  <div key={r.runId} className="mb-3 last:mb-0">
                                    <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                                      <Badge variant="secondary" className="text-xs">{ENGINE_LABEL[r.engine] ?? r.engine}</Badge>
                                      {r.runDate?.slice(0, 16).replace("T", " ")}
                                      {r.state !== "finished" && <span className="text-warning">{r.state}</span>}
                                    </p>
                                    {/* Whitespace preserved and NOT parsed as markdown: the content carries the
                                        engine's own inline citation links, and re-rendering them as HTML would
                                        mean trusting third-party text to produce markup on our page. */}
                                    <p className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-card p-2.5 text-xs leading-relaxed">
                                      {r.content}
                                    </p>
                                  </div>
                                ))}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                A row with 0 and a competitor beside it is a content gap with demand already proven — somebody
                asked, an answer was given, and it was not ours. Open a row to read what each engine actually
                said, citations included; those are fetched per row rather than all at once, because fifteen
                prompts would be fifteen calls against a monthly API cap to render text nobody asked for.
              </p>
            </section>
          )}

          {/* ── Citations ─────────────────────────────────────────────────────────── */}
          {!!data.citations.length && (
            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Quote className="h-3.5 w-3.5" /> What the engines cite
                </h2>
                {data.citationStats?.domainCitations && (
                  <p className="text-xs text-muted-foreground">
                    {num(data.citationStats.domainCitations.current)} of{" "}
                    {num(data.citationStats.domainCitations.total)} citations are ours
                    {" "}({pct(data.citationStats.domainCitations.citationShare)})
                  </p>
                )}
              </div>
              {/* Which DOMAINS the engines lean on, before which pages. This is the more actionable of
                  the two: youtube.com at the top of the live account is not a competitor, it is a
                  statement about the format the answers are drawn from. */}
              {!!data.citationStats?.domainRank?.citations?.length && (
                <div className="flex flex-wrap gap-1.5">
                  {data.citationStats.domainRank.citations.map((d) => (
                    <span key={d.domain}
                      className={cn("rounded-md border px-2 py-1 text-xs", d.main ? "border-highlight/50 bg-highlight-soft/30" : "bg-card")}>
                      <span className="text-muted-foreground">{d.rank}.</span> {d.domain}{" "}
                      <span className="tabular-nums text-muted-foreground">{d.citations}</span>
                      {d.main && <Badge variant="secondary" className="ml-1.5 text-xs">ours</Badge>}
                    </span>
                  ))}
                </div>
              )}
              {/* Per-competitor citation share against the same total — who the engines lean on when
                  they answer, expressed the same way as ours so the two are comparable. */}
              {!!data.citationStats?.competitors?.length && (
                <p className="text-xs text-muted-foreground">
                  Competitor domains cited:{" "}
                  {data.citationStats.competitors
                    .filter((c) => c.domainCitations.current > 0)
                    .sort((a, b) => b.domainCitations.current - a.domainCitations.current)
                    .map((c) => `${c.brandDomain} ${c.domainCitations.current} (${c.domainCitations.citationShare}%)`)
                    .join(" · ") || "none in this window"}
                </p>
              )}
              <div className="overflow-hidden rounded-xl border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Cited page</th>
                      <th className="px-3 py-2 text-left font-medium">Kind</th>
                      <th className="px-3 py-2 text-right font-medium">Citations</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.citations.map((c) => {
                      const open = openCite === c.url;
                      const got = citeDetail[c.url];
                      return (
                        <Fragment key={c.url}>
                          <tr className={cn("border-t", c.isMyBrandDomain && "bg-highlight-soft/20")}>
                            <td className="px-3 py-2">
                              <button onClick={() => void openCitation(c.url)}
                                className="mr-1.5 text-muted-foreground hover:text-foreground" title="Which prompts cited this">
                                {open ? "▾" : "▸"}
                              </button>
                              <a href={c.url} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 hover:underline">
                                {c.title || c.url}
                                <ExternalLink className="h-3 w-3 shrink-0 opacity-50" />
                              </a>
                              <span className="ml-1.5 text-xs text-muted-foreground">{c.domain}</span>
                              {c.isMyBrandDomain && <Badge variant="secondary" className="ml-2 text-xs">ours</Badge>}
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">{c.domainCategory}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{num(c.citations)}</td>
                          </tr>
                          {open && (
                            <tr className="border-t bg-muted/20">
                              <td colSpan={3} className="px-3 py-3">
                                {got === "loading" && (
                                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Loader2 className="h-3 w-3 animate-spin" /> Looking up which prompts cited this…
                                  </p>
                                )}
                                {got === "failed" && <p className="text-xs text-destructive">Could not load this page&apos;s detail.</p>}
                                {got && got !== "loading" && got !== "failed" && (
                                  <div className="space-y-2">
                                    {got.history && (
                                      <p className="text-xs text-muted-foreground">
                                        {num(got.history.totalPeriodCitations)} citations this window vs{" "}
                                        {num(got.history.totalCitationsPreviousPeriod)} in the one before
                                        {typeof got.history.percentageChange === "number" && (
                                          <span className={cn("ml-1 font-medium",
                                            got.history.percentageChange > 0 ? "text-success" : got.history.percentageChange < 0 ? "text-destructive" : "")}>
                                            ({got.history.percentageChange > 0 ? "+" : ""}{got.history.percentageChange}%)
                                          </span>
                                        )}
                                      </p>
                                    )}
                                    {got.prompts.length ? (
                                      <ul className="space-y-1">
                                        {got.prompts.map((pr) => (
                                          <li key={pr.id} className="text-xs">
                                            <span className={cn("mr-1.5 tabular-nums", pr.brandMentioned ? "text-success" : "text-destructive")}>
                                              {pr.brandMentioned ? "we were named" : "we were not named"}
                                            </span>
                                            {pr.prompt}
                                            <span className="ml-1.5 text-xs text-muted-foreground">
                                              {(pr.engines ?? []).map((e) => ENGINE_LABEL[e] ?? e).join(", ")}
                                            </span>
                                          </li>
                                        ))}
                                      </ul>
                                    ) : (
                                      <p className="text-xs text-muted-foreground">No prompt rows returned for this URL in this window.</p>
                                    )}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── Otterly's recommendations ─────────────────────────────────────────── */}
          {!!data.recommendations.length && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">What Otterly suggests</h2>
              <div className="space-y-2">
                {data.recommendations.slice(0, 12).map((r) => (
                  <div key={r.id} className="rounded-xl border bg-card p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{r.copy?.title || r.copy?.headline || r.id}</p>
                      <Badge variant="outline" className="text-xs">{r.group.replace("_", " ")}</Badge>
                      <Badge variant="secondary" className="text-xs">{ENGINE_LABEL[r.engine] ?? r.engine}</Badge>
                      {r.status !== "notStarted" && <Badge className="text-xs">{r.status}</Badge>}
                    </div>
                    {r.copy?.reasoning && (
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{r.copy.reasoning}</p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── AI agent traffic, if their side is connected to logs ──────────────── */}
          {data.agents && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">AI agents arriving on the site</h2>
              {data.agents.availability !== "connected_with_data" ? (
                <p className="rounded-xl border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                  {data.agents.availability === "not_connected"
                    ? "Otterly has no log connection for this domain, so it cannot see agent visits. This is separate from the visibility numbers above and needs setting up on their side."
                    : "Connected, but no agent visits recorded in this window."}
                </p>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Kpi label="Agent visits" value={num(data.agents.totalAgentVisits)} />
                    <Kpi label="Pages visited" value={num(data.agents.pagesVisited)} />
                    <Kpi label="Most active" value={ENGINE_LABEL[data.agents.topEngine ?? ""] ?? data.agents.topEngine ?? "—"} />
                  </div>
                  {/* Which agents, and which pages they went to. Fetched with the summary and previously
                      discarded — the summary says how many visits, these say what they were interested in. */}
                  {!!data.agentDetail?.agents?.length && (
                    <div className="flex flex-wrap gap-1.5">
                      {data.agentDetail.agents.slice(0, 20).map((a, i) => (
                        <span key={i} className="rounded-md border bg-card px-2 py-1 text-xs">
                          {String(a.bot ?? a.agent ?? a.engine ?? "agent")}
                          <span className="ml-1.5 tabular-nums text-muted-foreground">{String(a.visits ?? "")}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {!!data.agentDetail?.pages?.length && (
                    <div className="overflow-hidden rounded-xl border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">Page an agent fetched</th>
                            <th className="px-3 py-2 text-right font-medium">Visits</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.agentDetail.pages.slice(0, 25).map((pg, i) => (
                            <tr key={i} className="border-t">
                              <td className="px-3 py-2">{String(pg.url ?? pg.path ?? "—")}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{String(pg.visits ?? "")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {/* ── The prompts themselves ──────────────────────────────────────────────
              Everything above is downstream of which questions get asked, so this is the one section
              that changes what the page will say tomorrow. Adding spends from the plan's prompt
              allowance, so the count is on the button; deleting is here and deliberately NOT a tool
              Summer has, because it throws away that prompt's measurement history. */}
          {data.configured && data.workspace && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">Tracked prompts</h2>
                <button onClick={() => setManaging((v) => !v)}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                  {managing ? "Done" : `Manage (${data.workspace.promptsUsedCount}/${data.workspace.promptsMaxCount} used)`}
                </button>
              </div>

              {managing && (
                <div className="space-y-3 rounded-xl border bg-card p-3">
                  <div className="space-y-1">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                      Add prompts — one per line
                    </span>
                    <textarea value={newPrompts} onChange={(e) => setNewPrompts(e.target.value)} rows={4}
                      placeholder={"best ai video generator for ecommerce\nhow do I make a product video with ai"}
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline"
                        disabled={busy !== null || !newPrompts.trim()}
                        onClick={() => void mutate("add-prompts", () => fetch("/api/geo/prompts", {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            prompts: newPrompts.split("\n").map((x) => x.trim()).filter(Boolean),
                            country: country || data.country,
                            tagIds: tagFilter ? [tagFilter] : undefined,
                          }),
                        }).then((r) => { setNewPrompts(""); return r; }))}>
                        {busy === "add-prompts" ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                        Add {newPrompts.split("\n").filter((x) => x.trim()).length || ""} prompt(s)
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {data.workspace.promptsMaxCount - data.workspace.promptsUsedCount} of{" "}
                        {data.workspace.promptsMaxCount} slots left
                        {tagFilter ? " · will carry the selected tag" : ""}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-end gap-2 border-t pt-3">
                    <label className="space-y-1">
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">New tag</span>
                      <input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="video"
                        className="rounded-md border bg-background px-2.5 py-1.5 text-sm" />
                    </label>
                    <Button size="sm" variant="outline" disabled={busy !== null || !newTag.trim()}
                      onClick={() => void mutate("add-tag", () => fetch("/api/geo/tags", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: newTag.trim() }),
                      }).then((r) => { setNewTag(""); return r; }))}>
                      {busy === "add-tag" ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                      Create tag
                    </Button>
                    {data.tags?.map((t) => (
                      <span key={t.id} className="inline-flex items-center gap-1 rounded-md border bg-muted/30 px-2 py-1 text-xs">
                        {t.name} <span className="tabular-nums text-muted-foreground">{t.promptCount}</span>
                        <button title="Delete tag" disabled={busy !== null}
                          onClick={() => void mutate(`del-tag-${t.id}`, () => fetch(`/api/geo/tags?tagId=${t.id}`, { method: "DELETE" }))}
                          className="ml-0.5 text-muted-foreground hover:text-destructive">×</button>
                      </span>
                    ))}
                  </div>
                  {runNote && <p className="text-xs font-medium">{runNote}</p>}
                </div>
              )}

              <div className="overflow-hidden rounded-xl border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Prompt</th>
                      <th className="px-3 py-2 text-left font-medium">Country</th>
                      <th className="px-3 py-2 text-left font-medium">Tags</th>
                      {managing && <th className="px-3 py-2 text-right font-medium">Remove</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(data.workspacePrompts ?? []).map((wp) => (
                      <tr key={wp.id} className="border-t">
                        <td className="px-3 py-2">{wp.prompt}</td>
                        <td className="px-3 py-2 text-xs uppercase text-muted-foreground">{wp.country}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {(wp.tagIds ?? []).map((id) => data.tags?.find((t) => t.id === id)?.name ?? id).join(", ") || "—"}
                        </td>
                        {managing && (
                          <td className="px-3 py-2 text-right">
                            <button disabled={busy !== null}
                              onClick={() => void mutate(`del-${wp.id}`, () => fetch(`/api/geo/prompts?promptId=${wp.id}`, { method: "DELETE" }))}
                              className="text-xs text-muted-foreground hover:text-destructive">
                              {busy === `del-${wp.id}` ? "…" : "Delete"}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                These are the questions Otterly runs against the engines. A coverage gap only becomes
                measurable once it is a prompt here — Otterly picks new ones up on its own schedule, so
                results appear on the next run rather than immediately.
              </p>
            </section>
          )}

          {/* ── GEO audit tools ────────────────────────────────────────────────────
              The three things on this page that ASK Otterly a question rather than read an answer, and
              the only writes this surface makes. Each spends from the monthly audit quota shown in the
              strip at the top, so every one is behind a click and the button says what it costs. */}
          {data.configured && data.workspace && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">GEO audits</h2>

              <div className="rounded-xl border bg-card p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex-1 min-w-[240px] space-y-1">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">URL to audit</span>
                    <input value={auditUrl} onChange={(e) => setAuditUrl(e.target.value)}
                      placeholder="https://www.northwind.example/features/…"
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" />
                  </label>
                  <Button size="sm" variant="outline" disabled={running !== null}
                    onClick={() => void runAudit("crawlability")}>
                    {running === "crawlability" ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                    Check crawlability
                  </Button>
                  <Button size="sm" variant="outline" disabled={running !== null}
                    onClick={() => void runAudit("content")}>
                    {running === "content" ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                    Check content
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="flex-1 min-w-[240px] space-y-1">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                      Query to expand (fan-out)
                    </span>
                    <input value={fanQuery} onChange={(e) => setFanQuery(e.target.value)}
                      placeholder="best ai video generator"
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" />
                  </label>
                  <Button size="sm" variant="outline" disabled={running !== null || !fanQuery.trim()}
                    onClick={() => void runAudit("fanout")}>
                    {running === "fanout" ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                    Run fan-out
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Each run spends one of the {data.workspace.geoAuditMaxCount} monthly GEO audits
                  ({data.workspace.geoAuditUsedCount} used). Crawlability finishes in seconds; a fan-out asks
                  every engine and takes longer. Reload to see a finished result.
                </p>
                {runNote && <p className="mt-1.5 text-xs font-medium">{runNote}</p>}
              </div>

              {/* Crawlability: robots.txt says what we ALLOW, the live fetch says what the server
                  actually returned. They disagree exactly when a WAF blocks a bot robots.txt permits,
                  which is the failure nobody finds by reading robots.txt. */}
              {crawl && (
                <div className="space-y-2 rounded-xl border bg-card p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-xs font-medium">
                      Crawlability · {crawl.url}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {(crawl.completedDate ?? crawl.createdDate)?.slice(0, 10)}
                      </span>
                    </p>
                    {(() => {
                      const server = Object.entries(crawl.serverBotAccess ?? {});
                      const robots = Object.entries(crawl.robotsTxtAnalysis ?? {});
                      const blockedServer = server.filter(([, v]) => !v.ok);
                      const blockedRobots = robots.filter(([, v]) => !v);
                      return (
                        <p className="text-xs text-muted-foreground">
                          robots.txt allows {robots.length - blockedRobots.length}/{robots.length} ·
                          server answered 200 for {server.length - blockedServer.length}/{server.length}
                        </p>
                      );
                    })()}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(crawl.serverBotAccess ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([bot, v]) => {
                      const allowedByRobots = crawl.robotsTxtAnalysis?.[bot];
                      const bad = !v.ok || allowedByRobots === false;
                      return (
                        <span key={bot} title={`${v.userAgent} → HTTP ${v.status}`}
                          className={cn("rounded-md border px-2 py-1 text-xs",
                            bad ? "border-destructive/50 bg-destructive/5" : "bg-muted/30")}>
                          {bot}
                          <span className={cn("ml-1.5 tabular-nums", bad ? "text-destructive" : "text-muted-foreground")}>
                            {v.status}
                          </span>
                          {allowedByRobots === false && <span className="ml-1 text-destructive">robots</span>}
                        </span>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Otterly fetches from proxy IPs, so a block can be bot-impersonation protection rather
                    than a policy against the real bot — worth confirming from our own logs before changing
                    anything. Blocking a TRAINING crawler costs nothing in visibility; blocking a RETRIEVAL
                    one (OAI-SearchBot, PerplexityBot, Claude-SearchBot) makes us uncitable.
                  </p>
                </div>
              )}

              {/* Content checks: a structural GEO score per URL. */}
              {!!data.audits?.content?.length && (
                <div className="overflow-hidden rounded-xl border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Content check</th>
                        <th className="px-3 py-2 text-right font-medium">Overall</th>
                        <th className="px-3 py-2 text-right font-medium">Structure</th>
                        <th className="px-3 py-2 text-right font-medium">Content</th>
                        <th className="px-3 py-2 text-right font-medium">Metadata</th>
                        <th className="px-3 py-2 text-right font-medium">Technical</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.audits.content.map((c) => {
                        const a = c.structuralAnalysis;
                        return (
                          <tr key={c.id} className="border-t">
                            <td className="px-3 py-2">
                              {c.url}
                              {c.status !== "completed" && (
                                <Badge variant="outline" className="ml-2 text-xs">{c.status}</Badge>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right font-medium tabular-nums">{num(a?.overallScore)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{num(a?.categoryScores?.structure)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{num(a?.categoryScores?.content)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{num(a?.categoryScores?.metadata)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{num(a?.categoryScores?.technical)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Fan-out: the sub-queries an engine actually searched for one query. This is the closest
                  thing in the API to "what is the engine really looking for", and it is a keyword list we
                  could not get any other way. */}
              {fan && (
                <div className="space-y-2 rounded-xl border bg-card p-3">
                  <p className="text-xs font-medium">
                    Fan-out · &ldquo;{fan.query}&rdquo;
                    <span className="ml-2 font-normal text-muted-foreground">{fan.status}</span>
                  </p>
                  {(fan.results ?? []).map((r) => (
                    <div key={r.engine} className="space-y-1">
                      <p className="text-xs">
                        <Badge variant="secondary" className="mr-1.5 text-xs">{ENGINE_LABEL[r.engine] ?? r.engine}</Badge>
                        <span className="text-muted-foreground">
                          {r.expandedQueries?.length ?? 0} expanded quer{(r.expandedQueries?.length ?? 0) === 1 ? "y" : "ies"}
                          {r.reasoningForCount ? ` — ${r.reasoningForCount}` : ""}
                        </span>
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {(r.expandedQueries ?? []).map((q, i) => (
                          <span key={i} className="rounded border bg-muted/30 px-1.5 py-0.5 text-xs">{q}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ── Configured, but the account has nothing to read ───────────────────── */}
          {data.configured && !data.report && !data.problems.length && (
            <div className="rounded-xl border bg-muted/30 p-5 text-sm text-muted-foreground">
              The key works, but this account has no brand report yet. Create one in Otterly — it is where
              the brand, its domains, the competitor set and the prompts are defined.
            </div>
          )}
        </>
      )}
    </div>
  );
}
