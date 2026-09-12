"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Loader2, AlertTriangle, ExternalLink, GitPullRequest, Ticket, Send,
  History as HistoryIcon, CheckCircle2, XCircle, HelpCircle, Wrench, Users, Sparkles, TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/util/formatDate";
import type { IndexingReport } from "@/lib/indexing/types";
import type { Verdict } from "@/lib/indexing/gate";
import type { Rating } from "@/lib/indexing/cwv";
import type { Priority, Owner } from "@/lib/indexing/classify";
import type { ChangeRequestPreview } from "@/lib/indexing/routing";

/* ─────────────────────────── plain-language dictionaries ─────────────────────────── */

const VERDICT_UI: Record<Verdict, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  pass: { label: "Healthy", cls: "text-success bg-success/15 border-success/40", Icon: CheckCircle2 },
  flag: { label: "Needs attention", cls: "text-warning bg-warning/10 border-warning/30", Icon: AlertTriangle },
  block: { label: "Serious problem", cls: "text-destructive bg-destructive/10 border-destructive/30", Icon: XCircle },
};

const PRIORITY_UI: Record<Priority, { label: string; cls: string }> = {
  p0: { label: "Urgent", cls: "text-destructive bg-destructive/10 border-destructive/30" },
  p1: { label: "High", cls: "text-warning bg-warning/10 border-warning/30" },
  p2: { label: "Normal", cls: "text-muted-foreground bg-muted border-border" },
};

const OWNER_UI: Record<Owner, string> = { webdev: "Web team", seo: "SEO team", content: "Content team" };

const ratingClass: Record<Rating, string> = {
  good: "text-success", needs_improvement: "text-warning", poor: "text-destructive", unknown: "text-muted-foreground",
};

function renderUI(mode: string): { label: string; cls: string } {
  if (mode === "ssr") return { label: "Loads instantly", cls: "text-success" };
  if (mode === "mixed") return { label: "Some content needs code", cls: "text-warning" };
  if (mode === "client-rendered") return { label: "Content loads via code", cls: "text-destructive" };
  return { label: "Couldn't check", cls: "text-muted-foreground" };
}

function googleResult(state: string): { label: string; cls: string } {
  const m: Record<string, { label: string; cls: string }> = {
    "Submitted and indexed": { label: "Likely to show in Google", cls: "text-success" },
    "Crawled – currently not indexed": { label: "Google may skip this page", cls: "text-warning" },
    "Not found (404)": { label: "Page is broken (404)", cls: "text-destructive" },
    "Soft 404": { label: "Soft 404 (looks empty)", cls: "text-destructive" },
    "Server error (5xx)": { label: "Server error", cls: "text-destructive" },
    "Page with redirect": { label: "Redirects to another page", cls: "text-warning" },
    "Excluded by 'noindex' tag": { label: "Blocked from Google", cls: "text-destructive" },
    "Blocked by robots.txt": { label: "Blocked from crawlers", cls: "text-destructive" },
    "Duplicate, Google chose different canonical": { label: "Google prefers another URL", cls: "text-warning" },
  };
  return m[state] ?? { label: state, cls: "text-muted-foreground" };
}

const EXPLAIN: Record<string, { title: string; why: string }> = {
  js_gated: { title: "Content only appears after code runs", why: "Google's first look and AI search tools (ChatGPT, Perplexity, Claude) don't run page code. If the main content only shows up after code runs, they may see a nearly-blank page — so it can be invisible in search and AI answers." },
  thin_or_duplicate: { title: "Too little unique content", why: "This page is short or very similar to other pages. Google may decide it isn't worth showing in search." },
  missing_schema: { title: "Missing structured data", why: "Structured data helps Google understand what the page is and can unlock richer search results. This page has none." },
  missing_canonical: { title: "No 'official URL' tag", why: "The canonical tag tells Google which URL is the main one. Without it Google guesses — and can pick the wrong version." },
  not_self_canonical: { title: "Names a different page as the original", why: "This page points at another URL as the 'original', so Google may index that one instead of this page." },
  has_noindex: { title: "Set to hide from Google", why: "This page tells Google not to index it. If that was left on by mistake, the page will never appear in search." },
  is_redirect: { title: "This URL redirects away", why: "The address sends visitors to a different page. Links pointing here lose their value — they should point to the final page." },
  soft_404: { title: "Soft 404 (looks empty to Google)", why: "The page returns a success (200) status but its content reads like a 'not found' page. Google won't index it and it wastes crawl budget — return a real 404, or restore the intended content." },
  robots_disallowed: { title: "Blocked by robots.txt", why: "The site is telling search crawlers not to visit this page. If it should be in Google, that rule needs removing." },
  missing_title: { title: "Missing page title", why: "The title is the blue link text in Google results. Without one, Google makes something up." },
  missing_meta_description: { title: "Missing description", why: "The description is the grey text under the title in Google. Missing it means Google writes its own." },
  missing_h1: { title: "Missing main heading", why: "The main heading (H1) tells Google and readers the page's topic at a glance." },
  multiple_h1: { title: "More than one main heading", why: "Several main headings muddy what the page is mainly about." },
  cwv_slow: { title: "Slow page experience", why: "Real visitors experience this page type as slow, unresponsive, or visually jumpy. Google uses page speed as a ranking tie-breaker, and slow pages lose visitors." },
};

function explain(reason: string, fallbackLabel: string): { title: string; why: string } {
  if (reason.startsWith("http_status=")) {
    const code = reason.split("=")[1];
    return { title: `Page returns an error (${code})`, why: "The page didn't load normally, so Google can't index it." };
  }
  return EXPLAIN[reason] ?? { title: fallbackLabel, why: "" };
}

/* ─────────────────────────── small components ─────────────────────────── */

export function Tip({ text }: { text: string }) {
  return (
    <span title={text} className="inline-flex cursor-help align-middle text-muted-foreground/70 hover:text-muted-foreground">
      <HelpCircle className="h-3.5 w-3.5" />
    </span>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className={cn("text-2xl font-semibold", tone)}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

export interface RunSummary {
  id: string; target: string; started_at: string; finished_at: string;
  analyzed: number; templates_count: number; issues_count: number; p0_count: number;
  js_gated_count: number; created_by: string | null; created_at: string;
}

function Sparkline({ values, color, width = 130, height = 34 }: { values: number[]; color: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pts = values.map((val, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((val - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = values[values.length - 1];
  const lastY = height - ((last - min) / range) * (height - 4) - 2;
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={width} cy={lastY} r={2.5} fill={color} />
    </svg>
  );
}

function TrendCard({ label, values, color }: { label: string; values: number[]; color: string }) {
  const latest = values[values.length - 1] ?? 0;
  const first = values[0] ?? 0;
  const delta = latest - first;
  const improved = delta < 0;
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex items-end gap-3 mt-1">
        <div className="text-2xl font-semibold" style={{ color }}>{latest}</div>
        <Sparkline values={values} color={color} />
      </div>
      {values.length >= 2 && delta !== 0 && (
        <div className={cn("text-xs mt-1", improved ? "text-success" : "text-destructive")}>
          {improved ? "↓" : "↑"} {Math.abs(delta)} since your first check
        </div>
      )}
      {delta === 0 && values.length >= 2 && <div className="text-xs mt-1 text-muted-foreground">no change</div>}
    </div>
  );
}

export function Trends({ history }: { history: RunSummary[] }) {
  const chrono = [...history].reverse();
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-sm font-medium flex items-center gap-2 mb-3">
        <TrendingUp className="h-4 w-4 text-highlight-ink" /> Trend over your last {chrono.length} checks
      </div>
      <div className="grid grid-cols-2 gap-6 max-w-md">
        <TrendCard label="Pages hidden from search" values={chrono.map((h) => h.js_gated_count)} color="#ef4444" />
        <TrendCard label="Total issues found" values={chrono.map((h) => h.issues_count)} color="#f59e0b" />
      </div>
    </div>
  );
}

/* ─────────────────────────── controller hook ─────────────────────────── */

type DispatchState = { status: "idle" | "loading" | "done" | "error"; ref?: string; error?: string };

export interface PageHealth {
  count: number; setCount: (n: number) => void;
  scope: "important" | "sample"; setScope: (s: "important" | "sample") => void;
  device: "mobile" | "desktop"; setDevice: (d: "mobile" | "desktop") => void;
  template: string; setTemplate: (t: string) => void;
  running: boolean; report: IndexingReport | null; runId: string | null; history: RunSummary[];
  run: () => Promise<void>; openHistoryRun: (id: string) => Promise<void>;
  routingState: Record<number, DispatchState>; dispatchRouting: (i: number, preview: ChangeRequestPreview) => Promise<void>;
  slackState: DispatchState; postSlack: () => Promise<void>;
}

export function usePageHealth(): PageHealth {
  const [count, setCount] = useState(15);
  const [scope, setScope] = useState<"important" | "sample">("important");
  const [device, setDevice] = useState<"mobile" | "desktop">("mobile");
  const [template, setTemplate] = useState("");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<IndexingReport | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [routingState, setRoutingState] = useState<Record<number, DispatchState>>({});
  const [slackState, setSlackState] = useState<DispatchState>({ status: "idle" });

  async function loadHistory() {
    const d = await fetch("/api/indexing/history").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (d?.ok) setHistory(d.runs ?? []);
  }
  useEffect(() => { loadHistory(); }, []);

  async function run() {
    setRunning(true); setReport(null); setRunId(null); setRoutingState({}); setSlackState({ status: "idle" });
    try {
      const res = await fetch("/api/indexing/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: count, device, template: template || undefined, moneyFirst: scope === "important" }),
      });
      const d = await res.json();
      if (d?.ok && d.report) {
        setReport(d.report as IndexingReport); setRunId(d.runId ?? null);
        toast.success(`Checked ${d.report.analyzed} pages.`); loadHistory();
      } else toast.error(d?.error ?? "Scan failed.");
    } catch (e: any) {
      toast.error(e?.message ?? "Scan failed.");
    } finally {
      setRunning(false);
    }
  }

  async function openHistoryRun(id: string) {
    const d = await fetch(`/api/indexing/history/${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (d?.ok && d.report) { setReport(d.report as IndexingReport); setRunId(id); setRoutingState({}); setSlackState({ status: "idle" }); }
    else toast.error("Couldn't load that scan.");
  }

  async function dispatchRouting(i: number, preview: ChangeRequestPreview) {
    setRoutingState((s) => ({ ...s, [i]: { status: "loading" } }));
    const endpoint = preview.kind === "pr" ? "/api/indexing/pr" : "/api/indexing/ticket";
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preview, runId }) });
      const d = await res.json();
      if (d?.ok) {
        const ref = preview.kind === "pr" ? d.pr?.url : d.issue?.url;
        setRoutingState((s) => ({ ...s, [i]: { status: "done", ref } }));
        toast.success(preview.kind === "pr" ? `Fix drafted as PR #${d.pr.number}.` : `Ticket ${d.issue.identifier} created.`);
      } else if (d?.needsRepoMapping) {
        // Section has no repo mapped — a Slack notice was sent; tell the user to add it.
        setRoutingState((s) => ({ ...s, [i]: { status: "error", error: d.message } }));
        toast.warning(d.message ?? "No repo mapped for this section — add it to REPO_MAP.");
      } else {
        setRoutingState((s) => ({ ...s, [i]: { status: "error", error: d?.error } }));
        toast.error(d?.error ?? "Failed.");
      }
    } catch (e: any) {
      setRoutingState((s) => ({ ...s, [i]: { status: "error", error: e?.message } }));
      toast.error(e?.message ?? "Failed.");
    }
  }

  async function postSlack() {
    if (!report) return;
    setSlackState({ status: "loading" });
    try {
      const res = await fetch("/api/indexing/slack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: report.slackPreview, runId }) });
      const d = await res.json();
      if (d?.ok) { setSlackState({ status: "done" }); toast.success("Shared to Slack."); }
      else { setSlackState({ status: "error", error: d?.error }); toast.error(d?.error ?? "Slack post failed."); }
    } catch (e: any) {
      setSlackState({ status: "error", error: e?.message }); toast.error(e?.message ?? "Slack post failed.");
    }
  }

  return {
    count, setCount, scope, setScope, device, setDevice, template, setTemplate,
    running, report, runId, history, run, openHistoryRun, routingState, dispatchRouting, slackState, postSlack,
  };
}

/* ─────────────────────────── run controls (options) ─────────────────────────── */

export function PageHealthOptions({ ph }: { ph: PageHealth }) {
  return (
    <div className="rounded-lg border border-border p-4 space-y-4">
      <div className="flex flex-wrap items-end gap-5">
        <div className="space-y-1.5">
          <Label>Which pages to health-check?</Label>
          <div className="flex rounded-md border border-border overflow-hidden w-fit">
            <button onClick={() => ph.setScope("important")} className={cn("px-3 py-2 text-sm", ph.scope === "important" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>My most important pages</button>
            <button onClick={() => ph.setScope("sample")} className={cn("px-3 py-2 text-sm border-l border-border", ph.scope === "sample" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>A sample of the whole site</button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="count" className="flex items-center gap-1">How many pages <Tip text="More pages = more thorough, but the check takes longer. 15 is a good start." /></Label>
          <Input id="count" type="number" min={1} max={40} value={ph.count} onChange={(e) => ph.setCount(Number(e.target.value))} className="w-24" />
        </div>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground w-fit">Advanced</summary>
        <div className="mt-3 flex flex-wrap items-end gap-5">
          <div className="space-y-1.5">
            <Label htmlFor="device" className="flex items-center gap-1">Speed measured for <Tip text="Google mainly judges the mobile experience, so mobile is the default." /></Label>
            <select id="device" value={ph.device} onChange={(e) => ph.setDevice(e.target.value as "mobile" | "desktop")} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm w-32">
              <option value="mobile">Phone</option>
              <option value="desktop">Desktop</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="template" className="flex items-center gap-1">Only one page type <Tip text="Optional. Limits the check to one template, e.g. apps/[slug]." /></Label>
            <Input id="template" placeholder="e.g. apps/[slug]" value={ph.template} onChange={(e) => ph.setTemplate(e.target.value)} className="w-52" />
          </div>
        </div>
      </details>
    </div>
  );
}

/* ─────────────────────────── report sections (top-level Site Audit tabs) ─────────────────────────── */

export function PastChecks({ ph }: { ph: PageHealth }) {
  if (ph.report) return null;
  return (
    <>
      {ph.history.length >= 2 && <Trends history={ph.history} />}
      {ph.history.length > 0 && (
        <div className="rounded-lg border border-border">
          <div className="p-3 border-b border-border text-sm font-medium flex items-center gap-2"><HistoryIcon className="h-4 w-4" /> Past checks</div>
          <div className="divide-y divide-border">
            {ph.history.map((h) => (
              <button key={h.id} onClick={() => ph.openHistoryRun(h.id)} className="w-full text-left p-3 text-sm hover:bg-muted/40 flex items-center gap-3 flex-wrap">
                <span className="text-muted-foreground">{fmtDate(h.created_at)}</span>
                <span>{h.analyzed} pages checked</span>
                {h.js_gated_count > 0 && <><span className="text-muted-foreground">·</span><span className="text-warning">{h.js_gated_count} hidden from search</span></>}
                {h.created_by && <span className="text-muted-foreground ml-auto">{h.created_by}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function EmptyHealth({ running }: { running: boolean }) {
  return (
    <div className="text-sm text-muted-foreground border border-border rounded-lg px-4 py-8 text-center">
      {running ? "Checking your pages…" : "Run an audit to see page-health results here."}
    </div>
  );
}

export function IndexabilitySection({ ph }: { ph: PageHealth }) {
  const report = ph.report;
  if (!report) return <EmptyHealth running={ph.running} />;
  const v = report.counts.verdicts;
  const needsWork = v.flag + v.block;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-base">
        {needsWork === 0 ? (
          <span className="flex items-center gap-2 text-success"><CheckCircle2 className="h-5 w-5" /> All {report.analyzed} pages checked look healthy.</span>
        ) : (
          <span>
            We checked <b>{report.analyzed}</b> pages. <b className="text-warning">{needsWork}</b> need attention
            {report.counts.jsGated > 0 && <> — including <b className="text-destructive">{report.counts.jsGated}</b> that Google &amp; AI search may not be able to see</>}.
          </span>
        )}
      </div>

      {/* What to fix */}
      <p className="text-sm text-muted-foreground">
        Each card is one problem, grouped so a whole page-type is fixed at once. Send it to the right team with one
        click — opens a pull request or a Linear ticket; nothing changes on your site.
      </p>
      {report.routing.length === 0 && <div className="text-sm text-success">Nothing to fix — every page checked passed. 🎉</div>}
      {report.routing.map((r, i) => {
        const st = ph.routingState[i] ?? { status: "idle" as const };
        const ex = explain(r.reason, r.title);
        return (
          <div key={i} className="rounded-lg border border-border p-4">
            <div className="flex items-start gap-2 flex-wrap">
              <Badge variant="outline" className={cn("text-xs uppercase", PRIORITY_UI[r.priority].cls)}>{PRIORITY_UI[r.priority].label}</Badge>
              <div className="font-medium">{ex.title}</div>
              {r.kind === "pr" && (r.repo
                ? <Badge variant="outline" className="text-xs text-muted-foreground gap-1" title={`PR opens in ${r.repo.owner}/${r.repo.repo} (${r.repo.baseBranch})`}><GitPullRequest className="h-3 w-3" />{r.repo.owner}/{r.repo.repo}</Badge>
                : <Badge variant="outline" className="text-xs text-warning border-warning/40 gap-1" title="No repo mapped for this section — add it to REPO_MAP to open a PR."><AlertTriangle className="h-3 w-3" />no repo mapped</Badge>
              )}
              <span className="text-xs text-muted-foreground ml-auto">Affects {r.urls.length} page{r.urls.length === 1 ? "" : "s"}</span>
            </div>
            {ex.why && <p className="text-sm text-muted-foreground mt-2">{ex.why}</p>}
            <div className="mt-3 flex items-start gap-2 text-sm"><Wrench className="h-4 w-4 shrink-0 mt-0.5 text-highlight-ink" /><span><b>What to do:</b> {r.fix}</span></div>
            <div className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground"><Users className="h-4 w-4" /> Best handled by the <b className="text-foreground/90">{OWNER_UI[r.owner]}</b></div>
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer w-fit">Show affected pages</summary>
              <ul className="mt-1.5 space-y-0.5">
                {r.urls.slice(0, 30).map((u) => (<li key={u}><a href={u} target="_blank" rel="noreferrer" className="hover:underline inline-flex items-center gap-1">{u.replace(/^https?:\/\/[^/]+/, "")} <ExternalLink className="h-3 w-3" /></a></li>))}
                {r.urls.length > 30 && <li>…and {r.urls.length - 30} more</li>}
              </ul>
            </details>
            <div className="mt-3 flex items-center gap-2">
              {st.status === "done" ? (
                <a href={st.ref} target="_blank" rel="noreferrer" className="text-sm text-success flex items-center gap-1 hover:underline">
                  <CheckCircle2 className="h-4 w-4" /> {r.kind === "pr" ? "Fix drafted" : "Ticket created"} — open it <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <Button size="sm" disabled={st.status === "loading"} onClick={() => ph.dispatchRouting(i, r)}
                  title={r.kind === "pr" ? "Opens a pull request the web team reviews and merges." : "Creates a Linear ticket for the team to pick up."}>
                  {st.status === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : r.kind === "pr" ? <GitPullRequest className="h-3.5 w-3.5" /> : <Ticket className="h-3.5 w-3.5" />}
                  {r.kind === "pr" ? "Draft the fix (pull request)" : "Create a ticket"}
                </Button>
              )}
              {st.status === "error" && <span className="text-xs text-destructive">{st.error}</span>}
            </div>
          </div>
        );
      })}

      {/* All pages */}
      <div className="pt-2">
        <p className="text-sm font-medium mb-2">All pages checked</p>
        {!report.gscConfigured && (
          <p className="text-xs text-muted-foreground/70 mb-2">Tip: connect Google Search Console (see <code>docs/GSC_SETUP.md</code>) to show the real Google status beside each prediction.</p>
        )}
        <div className="space-y-2">
          {report.urls.map((u) => {
            const vu = VERDICT_UI[u.gate.verdict];
            const gr = googleResult(u.predicted.state);
            const rm = renderUI(u.renderMode);
            return (
              <div key={u.url} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={cn("text-xs gap-1", vu.cls)}><vu.Icon className="h-3 w-3" /> {vu.label}</Badge>
                  <a href={u.url} target="_blank" rel="noreferrer" className="font-mono text-xs hover:underline flex items-center gap-1">{u.path} <ExternalLink className="h-3 w-3" /></a>
                  {u.isMoney && <Badge variant="outline" className="text-highlight-ink border-highlight/40 text-xs">important</Badge>}
                  <span className={cn("text-xs ml-auto", gr.cls)}>{gr.label}</span>
                </div>
                <div className="mt-1.5 text-xs text-muted-foreground flex items-center gap-1 flex-wrap">
                  <span className={rm.cls}>{rm.label}</span>
                  <Tip text="How the page delivers its content. 'Loads instantly' means Google & AI tools can read it right away." />
                  {u.gsc?.coverageState && (<><span className="text-muted-foreground/50">·</span><span className="flex items-center gap-1">Google says: <span className="text-foreground/90">{u.gsc.coverageState}</span></span></>)}
                </div>
                {u.issues.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {u.issues.map((issue) => {
                      const ex = explain(issue.reason, issue.label);
                      return <span key={issue.reason} title={ex.why} className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-xs cursor-help">{ex.title}</span>;
                    })}
                  </div>
                )}
                {u.error && <div className="mt-1 text-xs text-destructive">Couldn't load this page ({u.error}).</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function SpeedSection({ ph }: { ph: PageHealth }) {
  const report = ph.report;
  if (!report) return <EmptyHealth running={ph.running} />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">How fast pages feel to real visitors — Google uses this in rankings. Measured per page-type.</p>
      {report.cwv.length === 0 && <div className="text-sm text-muted-foreground">No speed data yet.</div>}
      {report.cwv.map((c) => (
        <div key={c.template} className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="font-mono text-xs flex items-center gap-1.5">
              {c.template}
              {c.fieldSource === "crux-origin" && (<Badge variant="outline" className="text-xs text-muted-foreground">whole-site data <Tip text="Not enough real-visitor data for this page alone, so this shows site-wide Core Web Vitals." /></Badge>)}
            </span>
            <a href={c.representativeUrl} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:underline">{c.representativeUrl.replace(/^https?:\/\/[^/]+/, "")}</a>
          </div>
          {c.hasField ? (
            <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
              {([["lcp", "Loading speed"], ["inp", "Responsiveness"], ["cls", "Visual stability"]] as const).map(([m, human]) => (
                <div key={m}>
                  <div className="text-xs text-muted-foreground flex items-center gap-1">{human} <Tip text={m === "lcp" ? "Time until main content appears. Good ≤ 2.5s." : m === "inp" ? "How fast the page responds to taps/clicks. Good ≤ 200ms." : "How much the layout jumps while loading. Good ≤ 0.1."} /></div>
                  <div className={cn("font-semibold", ratingClass[c.evaluation[m].rating])}>
                    {c.evaluation[m].value ?? "n/a"}{m === "cls" ? "" : "ms"}{" "}
                    <span className="text-xs">{c.evaluation[m].rating === "good" ? "✓ good" : c.evaluation[m].rating === "needs_improvement" ? "could be better" : c.evaluation[m].rating === "poor" ? "poor" : ""}</span>
                  </div>
                  {c.diagnosis[m].length > 0 && (<ul className="mt-1 text-xs text-muted-foreground list-disc pl-4 space-y-0.5">{c.diagnosis[m].map((d, i) => <li key={i}>{d}</li>)}</ul>)}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 text-xs text-muted-foreground">Not enough real-visitor data yet{c.error ? ` (${c.error})` : ""}.</div>
          )}
          {c.hasField && c.diagnosisError && <div className="mt-2 text-xs text-warning">{c.diagnosisError}</div>}
        </div>
      ))}
    </div>
  );
}

export function PageTypesSection({ ph }: { ph: PageHealth }) {
  const report = ph.report;
  if (!report) return <EmptyHealth running={ph.running} />;
  return (
    <div>
      <p className="text-sm text-muted-foreground mb-3">Your pages grouped by design template. Problems usually hit a whole template at once, so fixing one template fixes many pages.</p>
      <div className="rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-b border-border">
            <tr className="[&>th]:text-left [&>th]:p-3 [&>th]:font-medium">
              <th>Page type</th><th className="flex items-center gap-1">How it loads <Tip text="'Loads instantly' is good for search. 'Loads via code' means Google & AI tools may not see the content." /></th><th>Pages checked</th><th>Health</th>
            </tr>
          </thead>
          <tbody>
            {report.templates.map((t) => {
              const rm = renderUI(t.renderMode);
              const bad = t.verdicts.flag + t.verdicts.block;
              return (
                <tr key={t.template} className="border-b border-border/50 [&>td]:p-3 align-top">
                  <td className="font-mono text-xs">{t.template} {t.moneyPage && <Badge variant="outline" className="ml-1 text-highlight-ink border-highlight/40 text-xs">important</Badge>}</td>
                  <td className={rm.cls}>{rm.label}{t.jsGatedCount > 0 && <span className="text-destructive"> ({t.jsGatedCount}/{t.urlCount} hidden)</span>}</td>
                  <td>{t.urlCount}</td>
                  <td>{bad === 0 ? <span className="text-success">all healthy</span> : <span className="text-warning">{bad} need attention</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ShareHealth({ ph }: { ph: PageHealth }) {
  if (!ph.report) return null;
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-sm text-muted-foreground flex items-center gap-1"><Sparkles className="h-4 w-4" /> Post a summary of this page-health check to your team's Slack.</div>
        {ph.slackState.status === "done" ? (
          <span className="text-xs text-success flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Shared</span>
        ) : (
          <Button size="sm" disabled={ph.slackState.status === "loading"} onClick={ph.postSlack}>
            {ph.slackState.status === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Share to Slack
          </Button>
        )}
      </div>
      {ph.slackState.status === "error" && <div className="text-xs text-destructive mb-2">{ph.slackState.error}</div>}
      <pre className="whitespace-pre-wrap text-xs bg-muted/40 rounded p-3">{ph.report.slackPreview}</pre>
    </div>
  );
}
