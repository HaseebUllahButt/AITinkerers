"use client";

import { useEffect, useState, useCallback, useRef, useImperativeHandle, forwardRef } from "react";
import { toast } from "sonner";
import { Play, Loader2, Send, ExternalLink, ChevronRight, CheckCircle2, XCircle, Clock, Square, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { fmtDate } from "@/lib/util/formatDate";

interface Progress { runId: string; pagesChecked: number; pagesTotal: number; linksChecked: number; broken: number; unreachable: number; log: string[] }
interface SweepProgress { runId: string; pagesChecked: number; pagesTotal: number; broken: number; unreachable: number; log: string[] }
interface Coverage { sitemap: number; discovered: number; orphans: number; orphanSample?: string[]; gscUnreached: number; gscSample?: string[] }
interface Run {
  id: string; started_at: string; finished_at: string | null; status: string;
  pages_total: number; pages_checked: number; links_checked: number; broken_found: number; unreachable: number;
  slack_posted_at: string | null; kind?: string | null; coverage?: Coverage | null;
}
interface Finding {
  id: string; page_url: string; page_author: string | null; link_url: string;
  anchor_text: string | null; context_text: string | null; reason: string; http_status: number | null;
  location_hint: string | null;
  pages_seen?: number | null; resolved_at?: string | null;
  page_listed?: boolean | null; draft_target?: boolean | null;
}

const REASON_LABEL: Record<string, string> = {
  "http-404": "404", "http-410": "410 gone", "soft-404": "soft 404", "homepage-redirect": "→ homepage", "http-5xx": "500 error",
  "dead-page": "dead page in sitemap", "redirect-chain": "redirect chain", "temp-redirect": "302 redirect",
  "js-only-link": "JS-only link", "render-failed": "couldn't render",
};

// Alive-but-badly-plumbed links (chains >2 hops, 302-where-301) — reported separately, never
// counted as broken.
const REDIRECT_REASONS = new Set(["redirect-chain", "temp-redirect"]);
// Detector rows: hidden-but-working links and unrendered pages — visibility, not breakage.
const JS_REASONS = new Set(["js-only-link", "render-failed"]);

export interface BrokenLinksSummary { running: boolean; brokenCount: number; progressPct: number | null; }
export interface BrokenLinksHandle { run: () => void; }

// The Link Audit experience, extracted verbatim into a Site Audit panel. Manages its own
// background-crawl run + 4s polling. Exposes an imperative run() so the page's master "Run audit"
// button can trigger it, and reports a summary up for the overview strip + tab pill.
export const BrokenLinksPanel = forwardRef<BrokenLinksHandle, { onSummary?: (s: BrokenLinksSummary) => void }>(
  function BrokenLinksPanel({ onSummary }, ref) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [viewRunId, setViewRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingAll, setTestingAll] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [hasWebhook, setHasWebhook] = useState<boolean | null>(null);
  const [webhookInput, setWebhookInput] = useState("");
  const [hasBotToken, setHasBotToken] = useState<boolean | null>(null);
  const [botTokenInput, setBotTokenInput] = useState("");
  const [mapText, setMapText] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [ignored, setIgnored] = useState<string[]>([]); // false-positive links the crawler skips

  const loadStatus = useCallback(async () => {
    const d = await fetch("/api/link-audit/status").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!d) return;
    setRunning(d.running);
    setProgress(d.progress);
    setRuns(d.runs ?? []);
  }, []);

  const loadFindings = useCallback(async (runId?: string | null) => {
    const qs = runId ? `?run_id=${runId}` : "";
    const d = await fetch(`/api/link-audit/findings${qs}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (d) { setFindings(d.findings ?? []); setViewRunId(d.runId); }
  }, []);

  // The sitemap page sweep runs beside the link crawl (own Redis state, own routes) —
  // tracked separately so both progress boxes can be live at once.
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepProgress, setSweepProgress] = useState<SweepProgress | null>(null);
  const [sweepStarting, setSweepStarting] = useState(false);
  const [sweepStopping, setSweepStopping] = useState(false);
  const loadSweepStatus = useCallback(async () => {
    const d = await fetch("/api/link-audit/pages/status").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!d) return;
    setSweepRunning(d.running);
    setSweepProgress(d.progress);
  }, []);

  // The JS-links detector (jsdom raw-vs-rendered anchor diff) — third independent run.
  interface JsProgress { runId: string; pagesChecked: number; pagesTotal: number; jsOnlyFound: number; broken: number; renderFailed: number; log: string[] }
  const [jsRunning, setJsRunning] = useState(false);
  const [jsProgress, setJsProgress] = useState<JsProgress | null>(null);
  const [jsStarting, setJsStarting] = useState(false);
  const [jsStopping, setJsStopping] = useState(false);
  const loadJsStatus = useCallback(async () => {
    const d = await fetch("/api/link-audit/jslinks/status").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!d) return;
    setJsRunning(d.running);
    setJsProgress(d.progress);
  }, []);

  useEffect(() => {
    loadStatus();
    loadSweepStatus();
    loadJsStatus();
    loadFindings();
    fetch("/api/link-audit/settings").then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) return;
      setHasWebhook(d.hasWebhook);
      setHasBotToken(d.hasBotToken);
      setMapText(Object.entries(d.slackMap ?? {}).map(([k, v]) => `${k} = ${v}`).join("\n"));
    }).catch(() => {});
    fetch("/api/link-audit/ignore").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setIgnored(d.ignored ?? []); }).catch(() => {});
  }, [loadStatus, loadSweepStatus, loadJsStatus, loadFindings]);

  useEffect(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    if (running || sweepRunning || jsRunning) {
      timer.current = setInterval(() => {
        if (running) { loadStatus(); if (progress?.runId) loadFindings(progress.runId); }
        if (sweepRunning) { loadSweepStatus(); loadStatus(); if (sweepProgress?.runId) loadFindings(sweepProgress.runId); }
        if (jsRunning) { loadJsStatus(); loadStatus(); if (jsProgress?.runId) loadFindings(jsProgress.runId); }
      }, 4000);
    }
    return () => { if (timer.current) clearInterval(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, sweepRunning, jsRunning, progress?.runId, sweepProgress?.runId, jsProgress?.runId]);

  async function runNow() {
    setStarting(true);
    const d = await fetch("/api/link-audit/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then((r) => r.json()).catch(() => null);
    setStarting(false);
    if (d?.started) { toast.success(`Audit started — ${d.pagesTotal} pages queued.`); loadStatus(); }
    else if (d?.alreadyRunning) { toast.info("An audit is already running."); loadStatus(); }
    else toast.error(d?.error ?? "Couldn't start.");
  }
  useImperativeHandle(ref, () => ({ run: () => { if (!running && !starting) runNow(); } }));

  const [stopping, setStopping] = useState(false);
  async function stopRun() {
    setStopping(true);
    await fetch("/api/link-audit/stop", { method: "POST" }).catch(() => {});
    toast.info("Stopping — finishes the current page, then halts (partial findings are kept).");
    setTimeout(() => { setStopping(false); loadStatus(); }, 4000);
  }

  async function runSweep() {
    setSweepStarting(true);
    const d = await fetch("/api/link-audit/pages/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then((r) => r.json()).catch(() => null);
    setSweepStarting(false);
    if (d?.started) { toast.success(`Page sweep started — every one of the ${d.pagesTotal} sitemap pages will be checked.`); loadSweepStatus(); }
    else if (d?.alreadyRunning) { toast.info("A page sweep is already running."); loadSweepStatus(); }
    else toast.error(d?.error ?? "Couldn't start the sweep.");
  }
  async function stopSweep() {
    setSweepStopping(true);
    await fetch("/api/link-audit/pages/stop", { method: "POST" }).catch(() => {});
    toast.info("Stopping the sweep — finishes the current batch, then halts (partial findings are kept).");
    setTimeout(() => { setSweepStopping(false); loadSweepStatus(); }, 4000);
  }

  async function runJsDetector() {
    setJsStarting(true);
    const d = await fetch("/api/link-audit/jslinks/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then((r) => r.json()).catch(() => null);
    setJsStarting(false);
    if (d?.started) { toast.success(`JS-link detector started — executing scripts on ${d.pagesTotal} pages.`); loadJsStatus(); }
    else if (d?.alreadyRunning) { toast.info("The detector is already running."); loadJsStatus(); }
    else toast.error(d?.error ?? "Couldn't start the detector.");
  }
  async function stopJsDetector() {
    setJsStopping(true);
    await fetch("/api/link-audit/jslinks/stop", { method: "POST" }).catch(() => {});
    toast.info("Stopping the detector — finishes the current page, then halts (partial findings are kept).");
    setTimeout(() => { setJsStopping(false); loadJsStatus(); }, 4000);
  }

  async function sendTest() {
    setTesting(true);
    const d = await fetch("/api/link-audit/test-slack", { method: "POST" }).then((r) => r.json()).catch(() => null);
    setTesting(false);
    if (d?.ok) toast.success(d.usedRealDigest ? "Sent the latest run's digest to Slack (labeled as a test)." : "Test message sent to Slack.");
    else toast.error(d?.error ?? "Slack post failed.");
  }

  // Sends one clearly-labeled "Testing for SEO tool" sample per Slack message type so every
  // send path can be verified at once.
  async function sendAllTests() {
    setTestingAll(true);
    const d = await fetch("/api/slack/test", { method: "POST" }).then((r) => r.json()).catch(() => null);
    setTestingAll(false);
    if (!d) return toast.error("Slack test failed.");
    if (d.error) return toast.error(d.error);
    const failed = (d.results ?? []).filter((r: any) => !r.ok);
    if (failed.length === 0) toast.success(`Sent all ${d.total} labeled test messages to Slack.`);
    else toast.warning(`Sent ${d.sent}/${d.total}. Failed: ${failed.map((r: any) => r.type).join(", ")}.`);
  }

  // Ignore a false-positive link: purge its findings (locally + server-side) and add it to the
  // skip list so the crawler never checks or reports it again. Un-ignore reverses it next run.
  async function ignoreLink(link: string) {
    setIgnored((g) => (g.includes(link) ? g : [...g, link]));
    setFindings((fs) => fs.filter((f) => f.link_url !== link));
    await fetch("/api/link-audit/ignore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link }) }).catch(() => {});
    toast.success("Ignored — this link won't be checked or reported again.");
  }
  async function unignoreLink(link: string) {
    setIgnored((g) => g.filter((x) => x !== link));
    await fetch(`/api/link-audit/ignore?link=${encodeURIComponent(link)}`, { method: "DELETE" }).catch(() => {});
    toast.info("Un-ignored — it'll be checked again next run.");
  }

  // Live re-verification: probe every still-open broken link in the viewed run right now.
  // Fixed ones get stamped resolved (shown green), still-broken ones get a fresh
  // "last checked" timestamp — closure comes from a live check, not from a report going quiet.
  const [reverifying, setReverifying] = useState(false);
  async function reverify() {
    setReverifying(true);
    const d = await fetch("/api/link-audit/reverify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(viewRunId ? { run_id: viewRunId } : {}),
    }).then((r) => r.json()).catch(() => null);
    setReverifying(false);
    if (!d?.ok) return toast.error(d?.error ?? "Re-verify failed.");
    if (d.checked === 0) toast.info("Nothing open to re-verify in this run.");
    else if (d.fixed === 0) toast.info(`Re-checked ${d.checked} links live — all still broken.`);
    else toast.success(`Re-checked ${d.checked} links live — ${d.fixed} now fixed, ${d.stillBroken} still broken.`);
    loadFindings(viewRunId);
  }

  // Hand a broken link to Render Lab's fix queue: scan exactly the pages the audit saw it on,
  // propose a replacement (or removal) per occurrence, then a person reviews and applies there.
  const [queueing, setQueueing] = useState<string | null>(null);
  async function queueFix(link: string, fs: Finding[]) {
    setQueueing(link);
    const d = await fetch("/api/render-lab/fixes?job=dead", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [link], pages: [...new Set(fs.map((f) => f.page_url))] }),
    }).then((r) => r.json()).catch(() => null);
    setQueueing(null);
    if (!d?.ok) return toast.error(d?.error ?? "Couldn't queue the fix.");
    if (d.queued > 0) toast.success(`${d.queued} fix${d.queued === 1 ? "" : "es"} proposed — review & apply in Render Lab.`);
    else toast.info("No fixable occurrence found in the CMS for those pages — the link may live in a template, not content.");
  }

  async function saveSettings() {
    setSavingSettings(true);
    const slackMap: Record<string, string> = {};
    for (const line of mapText.split("\n")) {
      const m = line.match(/^\s*(.+?)\s*=\s*([A-Z0-9]+)\s*$/);
      if (m) slackMap[m[1]] = m[2];
    }
    const body: Record<string, unknown> = { slackMap };
    if (webhookInput.trim()) body.webhook = webhookInput.trim();
    if (botTokenInput.trim()) body.bot_token = botTokenInput.trim();
    const res = await fetch("/api/link-audit/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      toast.success(d.directoryUsers ? `Settings saved — found ${d.directoryUsers} workspace members for auto-tagging.` : "Settings saved.");
      if (webhookInput.trim()) { setHasWebhook(true); setWebhookInput(""); }
      if (botTokenInput.trim()) { setHasBotToken(true); setBotTokenInput(""); }
    } else toast.error(d.error ?? "Save failed.");
    setSavingSettings(false);
  }

  const brokenAll = findings.filter((f) => f.reason !== "unreachable" && !REDIRECT_REASONS.has(f.reason) && !JS_REASONS.has(f.reason));
  // Team ask (Aug 31): the headline list is broken links on LIVE sitemap pages. Links whose
  // target is an unpublished CMS draft, and findings on pages the sitemap doesn't list, are
  // real work but different queues — rendered in their own sections below, never mixed in.
  const broken = brokenAll.filter((f) => f.draft_target !== true && f.page_listed !== false);
  const draftLinks = brokenAll.filter((f) => f.draft_target === true);
  const unlistedFindings = brokenAll.filter((f) => f.draft_target !== true && f.page_listed === false);
  const unreachable = findings.filter((f) => f.reason === "unreachable");
  const redirectIssues = findings.filter((f) => REDIRECT_REASONS.has(f.reason));
  const jsOnlyIssues = findings.filter((f) => f.reason === "js-only-link");
  const renderFailedCount = findings.filter((f) => f.reason === "render-failed").length;
  const groups = Object.entries(broken.reduce((acc, f) => {
    (acc[f.link_url] ??= []).push(f);
    return acc;
  }, {} as Record<string, Finding[]>));
  const draftGroups = Object.entries(draftLinks.reduce((acc, f) => {
    (acc[f.link_url] ??= []).push(f);
    return acc;
  }, {} as Record<string, Finding[]>));
  const unlistedByPage = Object.entries(unlistedFindings.reduce((acc, f) => {
    (acc[f.page_url] ??= []).push(f);
    return acc;
  }, {} as Record<string, Finding[]>));
  const unreachGroups = Object.entries(unreachable.reduce((acc, f) => {
    (acc[f.link_url] ??= []).push(f);
    return acc;
  }, {} as Record<string, Finding[]>));
  const redirectGroups = Object.entries(redirectIssues.reduce((acc, f) => {
    (acc[f.link_url] ??= []).push(f);
    return acc;
  }, {} as Record<string, Finding[]>));
  // Page-sweep runs render as "broken pages": each group IS the page, so per-page rows and
  // the Render-Lab link-rewrite button don't apply (pages go to dispositions instead).
  const viewingPagesRun = runs.find((r) => r.id === viewRunId)?.kind === "pages";

  // One collapsible row per broken link — shared by the live list and the drafts queue so the
  // two never drift apart in behavior (Queue fix, Ignore, resolved styling work in both).
  const linkGroupRow = ([link, fs]: [string, Finding[]], opts?: { draft?: boolean }) => {
    const fixed = fs.every((f) => f.resolved_at); // verified live since this run
    const pagesSeen = Math.max(fs[0].pages_seen ?? 0, fs.length); // crawl-wide count; rows are capped samples
    return (
      <details key={link} className="group">
        <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 list-none">
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 transition-transform group-open:rotate-90 shrink-0" />
          <a href={link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={`text-sm hover:underline truncate flex-1 min-w-0 ${fixed ? "text-success line-through" : opts?.draft ? "text-warning" : "text-destructive"}`}>
            {link}
          </a>
          {fixed ? (
            <Badge variant="outline" className="text-xs text-success border-success/40 shrink-0">{opts?.draft ? "published · verified live" : "fixed · verified live"}</Badge>
          ) : opts?.draft ? (
            <Badge variant="outline" className="text-xs text-warning border-warning/30 shrink-0" title={`${REASON_LABEL[fs[0].reason] ?? fs[0].reason} — the target exists in the CMS as an unpublished draft`}>unpublished draft</Badge>
          ) : (
            <Badge variant="outline" className="text-xs text-destructive border-destructive/30 shrink-0">{REASON_LABEL[fs[0].reason] ?? fs[0].reason}</Badge>
          )}
          <span className="text-xs text-muted-foreground shrink-0">
            {viewingPagesRun ? "the page itself" : `on ${pagesSeen} page${pagesSeen === 1 ? "" : "s"}${pagesSeen > fs.length ? ` (${fs.length} shown)` : ""}`}
          </span>
          {!fixed && !viewingPagesRun && (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); queueFix(link, fs); }}
              disabled={queueing === link}
              title="Propose a rewrite/removal for every occurrence in the CMS — review & apply in Render Lab."
              className="text-xs text-highlight-ink hover:underline border border-border rounded px-1.5 py-0.5 shrink-0 disabled:opacity-50"
            >
              {queueing === link ? "Queueing…" : "Queue fix"}
            </button>
          )}
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); ignoreLink(link); }}
            title="False positive? Ignore this link — never check or report it again."
            className="text-xs text-muted-foreground hover:text-foreground border border-border rounded px-1.5 py-0.5 shrink-0"
          >
            Ignore
          </button>
        </summary>
        <div className="px-4 pb-3 pl-11 space-y-2">
          {fs.find((f) => f.location_hint)?.location_hint && (
            <p className="text-xs text-highlight-ink flex items-start gap-1.5">
              <MapPin className="h-3.5 w-3.5 shrink-0 mt-px" />
              {fs.find((f) => f.location_hint)!.location_hint}
            </p>
          )}
          {!viewingPagesRun && fs.map((f) => (
            <div key={f.id} className="text-xs space-y-0.5">
              <p>
                <a href={f.page_url} target="_blank" rel="noreferrer" className="text-highlight-ink hover:underline inline-flex items-center gap-1">
                  {new URL(f.page_url).pathname}<ExternalLink className="h-2.5 w-2.5 opacity-60" />
                </a>
                <span className="text-muted-foreground"> — by {f.page_author ?? <i>no author on file</i>}</span>
                {f.anchor_text?.trim() && <span className="text-muted-foreground"> — link text: &quot;{f.anchor_text.slice(0, 60)}&quot;</span>}
              </p>
              {!f.location_hint && f.context_text && <p className="text-muted-foreground/70 italic line-clamp-2">…{f.context_text}…</p>}
            </div>
          ))}
        </div>
      </details>
    );
  };

  // Report summary up for the overview strip + tab pill.
  useEffect(() => {
    onSummary?.({
      running,
      brokenCount: groups.length,
      progressPct: running && progress ? Math.round((progress.pagesChecked / Math.max(progress.pagesTotal, 1)) * 100) : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, groups.length, progress?.pagesChecked, progress?.pagesTotal]);

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground max-w-2xl">
          Crawls every page in imagine.art&apos;s sitemap and flags links that 404 (including soft 404s). Runs in the
          background — safe to leave this tab.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          {(groups.length > 0 || draftGroups.length > 0) && !running && (
            <Button variant="outline" size="sm" onClick={reverify} disabled={reverifying} className="gap-1.5" title="Probe every still-open broken link live, right now — fixed ones close (including drafts that got published), the rest get a fresh 'last checked' stamp">
              {reverifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Re-verify fixes
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={sendTest} disabled={testing || hasWebhook === false} className="gap-1.5" title={hasWebhook === false ? "Add a Slack webhook below first" : "Post the latest digest (or a hello) to Slack"}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Send test to Slack
          </Button>
          {running && (
            <Button variant="outline" size="sm" onClick={stopRun} disabled={stopping} className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10">
              {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              Stop
            </Button>
          )}
          {sweepRunning && (
            <Button variant="outline" size="sm" onClick={stopSweep} disabled={sweepStopping} className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10">
              {sweepStopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              Stop sweep
            </Button>
          )}
          {jsRunning && (
            <Button variant="outline" size="sm" onClick={stopJsDetector} disabled={jsStopping} className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10">
              {jsStopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              Stop detector
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={runJsDetector} disabled={jsStarting || jsRunning} className="gap-1.5"
            title="Execute every sitemap page's JavaScript (jsdom, in-process) and find links that only exist after it runs — invisible to Google's first wave, AI crawlers, and the raw-HTML crawl.">
            {jsStarting || jsRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {jsRunning ? "Detecting…" : "Scan JS links"}
          </Button>
          <Button variant="outline" size="sm" onClick={runSweep} disabled={sweepStarting || sweepRunning} className="gap-1.5"
            title="Re-sync the sitemap, then check every listed URL itself — 404s, soft 404s, homepage redirects, 5xx. Minutes, not hours.">
            {sweepStarting || sweepRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {sweepRunning ? "Sweeping…" : "Scan pages"}
          </Button>
          <Button size="sm" onClick={runNow} disabled={starting || running} className="bg-primary hover:bg-primary text-primary-foreground gap-1.5">
            {starting || running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {running ? "Running…" : "Scan links now"}
          </Button>
        </div>
      </div>

      {/* Live progress */}
      {running && progress && (
        <div className="rounded-xl border border-highlight/40 bg-highlight-soft px-5 py-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="h-4 w-4 animate-spin text-highlight-ink" />
            Crawling — {progress.pagesChecked}/{progress.pagesTotal} pages
          </div>
          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${Math.round((progress.pagesChecked / Math.max(progress.pagesTotal, 1)) * 100)}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            {progress.linksChecked.toLocaleString()} unique links checked · <span className="text-destructive font-medium">{progress.broken} broken</span> · {progress.unreachable} unreachable (not counted as broken) · keeps running if you close this tab
          </p>
          {(progress.log?.length ?? 0) > 0 && (
            <div className="mt-2 max-h-64 overflow-y-auto rounded-md bg-black/40 border border-border font-mono text-xs leading-relaxed p-3 space-y-0.5 flex flex-col-reverse">
              <div>
                {progress.log.map((line, i) => (
                  <p key={i} className={line.includes("BROKEN") ? "text-destructive" : line.includes("failed") ? "text-warning" : "text-muted-foreground"}>{line}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Live page-sweep progress — runs beside the link crawl, own state */}
      {sweepRunning && sweepProgress && (
        <div className="rounded-xl border border-highlight/40 bg-highlight-soft px-5 py-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="h-4 w-4 animate-spin text-highlight-ink" />
            Sweeping the sitemap — {sweepProgress.pagesChecked}/{sweepProgress.pagesTotal} pages checked
          </div>
          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${Math.round((sweepProgress.pagesChecked / Math.max(sweepProgress.pagesTotal, 1)) * 100)}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            every sitemap URL checked as a page · <span className="text-destructive font-medium">{sweepProgress.broken} broken</span> · {sweepProgress.unreachable} didn&apos;t answer · keeps running if you close this tab
          </p>
          {(sweepProgress.log?.length ?? 0) > 0 && (
            <div className="mt-2 max-h-64 overflow-y-auto rounded-md bg-black/40 border border-border font-mono text-xs leading-relaxed p-3 space-y-0.5 flex flex-col-reverse">
              <div>
                {sweepProgress.log.map((line, i) => (
                  <p key={i} className={line.includes("BROKEN") ? "text-destructive" : line.includes("didn't answer") || line.includes("failed") ? "text-warning" : "text-muted-foreground"}>{line}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Live JS-detector progress */}
      {jsRunning && jsProgress && (
        <div className="rounded-xl border border-highlight/40 bg-highlight-soft px-5 py-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="h-4 w-4 animate-spin text-highlight-ink" />
            Executing page scripts for JS-only links — {jsProgress.pagesChecked}/{jsProgress.pagesTotal}
          </div>
          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${Math.round((jsProgress.pagesChecked / Math.max(jsProgress.pagesTotal, 1)) * 100)}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="text-highlight-ink font-medium">{jsProgress.jsOnlyFound} JS-only links</span> · <span className="text-destructive font-medium">{jsProgress.broken} of them broken</span> · {jsProgress.renderFailed} pages couldn&apos;t render (counted, not skipped) · keeps running if you close this tab
          </p>
          {(jsProgress.log?.length ?? 0) > 0 && (
            <div className="mt-2 max-h-64 overflow-y-auto rounded-md bg-black/40 border border-border font-mono text-xs leading-relaxed p-3 space-y-0.5 flex flex-col-reverse">
              <div>
                {jsProgress.log.map((line, i) => (
                  <p key={i} className={line.includes("BROKEN") ? "text-destructive" : line.includes("render failed") ? "text-warning" : "text-muted-foreground"}>{line}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Findings */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <p className="text-sm font-medium">{viewingPagesRun ? "Broken pages" : draftGroups.length > 0 || unlistedByPage.length > 0 ? "Broken links on live pages" : "Broken links"} {viewRunId && runs.find((r) => r.id === viewRunId) ? `— run ${fmtDate(runs.find((r) => r.id === viewRunId)!.started_at)}` : ""}</p>
          <Badge variant="outline" className={groups.length > 0 ? "text-destructive border-destructive/30" : "text-success border-success/40"}>
            {groups.length} broken {viewingPagesRun ? "page" : "link"}{groups.length === 1 ? "" : "s"}
          </Badge>
        </div>
        {viewingPagesRun && groups.length > 0 && (
          <p className="text-xs text-muted-foreground">
            These URLs are in the sitemap but don&apos;t answer as pages. Each has been queued in Render Lab → Dead URLs for a 410 / redirect decision.
          </p>
        )}
        {!viewingPagesRun && (() => {
          const cov = runs.find((r) => r.id === viewRunId)?.coverage;
          if (!cov) return null;
          return (
            <p className="text-xs text-muted-foreground">
              Coverage: {cov.sitemap.toLocaleString()} sitemap pages
              {cov.discovered > 0 && <> + <span className="text-highlight-ink">{cov.discovered} unlisted page{cov.discovered === 1 ? "" : "s"}</span> discovered via links and crawled too</>}
              {cov.orphans > 0 && <> · <span className="text-warning">{cov.orphans} orphan{cov.orphans === 1 ? "" : "s"}</span> (in the sitemap, nothing links to them)</>}
              {cov.gscUnreached > 0 && <> · <span className="text-warning">{cov.gscUnreached}</span> Google-known URL{cov.gscUnreached === 1 ? "" : "s"} the crawl couldn&apos;t reach</>}
            </p>
          );
        })()}
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground border border-border rounded-xl px-4 py-6 text-center">
            {!runs.some((r) => r.status === "completed")
              ? "No completed runs yet — hit Scan links now, or wait for the daily cron."
              : draftGroups.length > 0 || unlistedByPage.length > 0
                ? "No broken links on live sitemap pages. 🎉 The queues below are editorial calls."
                : "No broken links in this run. 🎉"}
          </p>
        ) : (
          <div className="border border-border rounded-xl divide-y divide-border">
            {groups.map((g) => linkGroupRow(g))}
          </div>
        )}
      </div>

      {/* Links to unpublished drafts — the target exists in the CMS, someone unpublished it */}
      {!viewingPagesRun && draftGroups.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <p className="text-sm font-medium">Links to unpublished drafts</p>
            <Badge variant="outline" className="text-warning border-warning/30">{draftGroups.length}</Badge>
            <p className="text-xs text-muted-foreground">each target still exists in the CMS as a draft — publish it, or remove/replace the link (Queue fix)</p>
          </div>
          <div className="border border-border rounded-xl divide-y divide-border">
            {draftGroups.map((g) => linkGroupRow(g, { draft: true }))}
          </div>
        </div>
      )}

      {/* Findings on pages the live sitemap doesn't list — the page is the unit of work here */}
      {!viewingPagesRun && unlistedByPage.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <p className="text-sm font-medium">Findings on unlisted pages</p>
            <Badge variant="outline" className="text-warning border-warning/30">{unlistedByPage.length}</Badge>
            <p className="text-xs text-muted-foreground">not in the sitemap, but still reachable via links — decide the page&apos;s fate before fixing its links</p>
          </div>
          <div className="border border-border rounded-xl divide-y divide-border">
            {unlistedByPage.map(([pageUrl, fs]) => (
              <details key={pageUrl} className="group">
                <summary className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/30 list-none">
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 transition-transform group-open:rotate-90 shrink-0" />
                  <a href={pageUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-sm text-warning hover:underline truncate flex-1 min-w-0">
                    {(() => { try { return new URL(pageUrl).pathname; } catch { return pageUrl; } })()}
                  </a>
                  <span className="text-xs text-muted-foreground shrink-0">{fs.length} finding{fs.length === 1 ? "" : "s"}</span>
                </summary>
                <div className="px-4 pb-3 pl-11 space-y-1">
                  {fs.map((f) => (
                    <p key={f.id} className="text-xs">
                      <a href={f.link_url} target="_blank" rel="noreferrer" className="text-highlight-ink hover:underline break-all">{f.link_url}</a>
                      <span className="text-muted-foreground"> — {REASON_LABEL[f.reason] ?? f.reason}</span>
                    </p>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}

      {/* JS-only links — working, but invisible to every non-rendering crawler */}
      {jsOnlyIssues.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <p className="text-sm font-medium">Links that only exist after JavaScript</p>
            <Badge variant="outline" className="text-highlight-ink border-highlight/40">{jsOnlyIssues.length}</Badge>
            <p className="text-xs text-muted-foreground">invisible to Google&apos;s first wave, AI crawlers, and the raw-HTML crawl — what they alone link to risks orphanhood</p>
          </div>
          <div className="border border-border rounded-xl divide-y divide-border">
            {jsOnlyIssues.map((f, i) => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-2 text-xs">
                <span className="text-muted-foreground shrink-0 w-6 text-right">{i + 1}.</span>
                <a href={f.link_url} target="_blank" rel="noreferrer" className="text-highlight-ink hover:underline truncate flex-1">{f.link_url}</a>
                <span className="text-muted-foreground shrink-0 truncate max-w-[40%]">hidden on {(() => { try { return new URL(f.page_url).pathname; } catch { return f.page_url; } })()}</span>
              </div>
            ))}
          </div>
          {renderFailedCount > 0 && (
            <p className="text-xs text-warning">{renderFailedCount} page{renderFailedCount === 1 ? "" : "s"} couldn&apos;t be rendered this run — their JS-only links are unverified, not absent.</p>
          )}
        </div>
      )}

      {/* Redirect hygiene — alive, but through a chain crawlers abandon or a 302 that passes no authority */}
      {redirectGroups.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <p className="text-sm font-medium">Redirect hygiene</p>
            <Badge variant="outline" className="text-warning border-warning/30">{redirectGroups.length}</Badge>
            <p className="text-xs text-muted-foreground">working links, but &gt;2 hops or a 302 where a 301 belongs — worth consolidating</p>
          </div>
          <div className="border border-border rounded-xl divide-y divide-border">
            {redirectGroups.map(([link, fs], i) => (
              <div key={link} className="px-4 py-2 text-xs space-y-0.5">
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground shrink-0 w-6 text-right">{i + 1}.</span>
                  <a href={link} target="_blank" rel="noreferrer" className="text-warning/90 hover:underline truncate flex-1">{link}</a>
                  <Badge variant="outline" className="text-xs text-warning border-warning/30 shrink-0">{REASON_LABEL[fs[0].reason] ?? fs[0].reason}</Badge>
                </div>
                {fs[0].location_hint && <p className="text-muted-foreground pl-9">{fs[0].location_hint}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ignored links — false positives the crawler skips every run */}
      {ignored.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Ignored links <span className="text-muted-foreground font-normal">({ignored.length} — skipped every run)</span></p>
          <div className="border border-border rounded-xl divide-y divide-border">
            {ignored.map((link) => (
              <div key={link} className="flex items-center gap-3 px-4 py-2">
                <a href={link} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:underline truncate flex-1 min-w-0">{link}</a>
                <button onClick={() => unignoreLink(link)} className="text-xs text-highlight-ink hover:underline shrink-0">un-ignore</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unreachable */}
      {unreachGroups.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <p className="text-sm font-medium">Couldn&apos;t verify</p>
            <Badge variant="outline" className="text-warning border-warning/30">{unreachGroups.length}</Badge>
            <p className="text-xs text-muted-foreground">bot-blocked or timed out — not counted as broken, worth a quick manual check</p>
          </div>
          <div className="border border-border rounded-xl divide-y divide-border">
            {unreachGroups.map(([link, fs], i) => (
              <div key={link} className="flex items-center gap-3 px-4 py-2 text-xs">
                <span className="text-muted-foreground shrink-0 w-6 text-right">{i + 1}.</span>
                <a href={link} target="_blank" rel="noreferrer" className="text-warning/90 hover:underline truncate flex-1">{link}</a>
                <span className="text-muted-foreground shrink-0">{fs[0].http_status ? `HTTP ${fs[0].http_status}` : "timeout"}</span>
                <span className="text-muted-foreground/60 shrink-0">on {fs.length} page{fs.length === 1 ? "" : "s"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Run history */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Run history</p>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <div className="border border-border rounded-xl divide-y divide-border">
            {runs.map((r) => (
              <button key={r.id} onClick={() => loadFindings(r.id)} className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/30 ${viewRunId === r.id ? "bg-muted/40" : ""}`}>
                {r.status === "completed" ? <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                  : r.status === "failed" ? <XCircle className="h-4 w-4 text-destructive shrink-0" />
                  : r.status === "stopped" ? <Square className="h-4 w-4 text-warning shrink-0" />
                  : <Clock className="h-4 w-4 text-highlight-ink shrink-0" />}
                <span className="text-sm shrink-0">{fmtDate(r.started_at)}</span>
                {r.kind === "pages" && <Badge variant="outline" className="text-xs text-highlight-ink border-highlight/40 shrink-0">page sweep</Badge>}
                {r.kind === "jslinks" && <Badge variant="outline" className="text-xs text-highlight-ink border-highlight/40 shrink-0">JS links</Badge>}
                <span className="text-xs text-muted-foreground flex-1 truncate">
                  {r.pages_checked}/{r.pages_total} pages{r.kind === "pages" ? "" : r.kind === "jslinks" ? ` · ${r.links_checked.toLocaleString()} JS-only` : ` · ${r.links_checked.toLocaleString()} links`} · <span className={r.broken_found > 0 ? "text-destructive" : "text-success"}>{r.broken_found} broken</span>
                </span>
                {r.slack_posted_at && <Badge variant="outline" className="text-xs text-muted-foreground shrink-0">slack ✓</Badge>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Settings */}
      <div className="border border-border rounded-xl p-4 space-y-4">
        <p className="text-sm font-medium">Slack settings</p>
        <div className="space-y-1.5">
          <Label className="flex items-center gap-2">
            Webhook
            {hasWebhook !== null && (
              <Badge variant="outline" className={hasWebhook ? "text-success border-success/40 text-xs" : "text-warning border-warning/30 text-xs"}>
                {hasWebhook ? "configured" : "not set"}
              </Badge>
            )}
          </Label>
          <Input type="password" placeholder="Paste a new https://hooks.slack.com/… URL to replace it" value={webhookInput} onChange={(e) => setWebhookInput(e.target.value)} />
          <p className="text-xs text-muted-foreground">Stored encrypted; never displayed back. Leave blank to keep the current one.</p>
        </div>
        <div className="space-y-1.5">
          <Label className="flex items-center gap-2">
            Bot token for automatic @-tagging
            {hasBotToken !== null && (
              <Badge variant="outline" className={hasBotToken ? "text-success border-success/40 text-xs" : "text-warning border-warning/30 text-xs"}>
                {hasBotToken ? "configured — auto-matching on" : "not set — names shown as plain text"}
              </Badge>
            )}
          </Label>
          <Input type="password" placeholder="xoxb-… (Slack app bot token with the users:read scope)" value={botTokenInput} onChange={(e) => setBotTokenInput(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            With a token, digests search the workspace member list and fuzzy-match author names to real users automatically —
            no manual mapping needed. Create one at api.slack.com/apps → OAuth &amp; Permissions → add <code>users:read</code> → install → copy the Bot User OAuth Token. Stored encrypted.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>Manual overrides <span className="text-muted-foreground font-normal">(optional — wins over fuzzy matching)</span></Label>
          <Textarea
            placeholder={"One per line, only needed when auto-match can't find someone:\nRyan Hayden = U0123ABCDEF"}
            className="min-h-[80px] font-mono text-xs"
            value={mapText}
            onChange={(e) => setMapText(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Member ID from Slack profile → ⋯ → Copy member ID. Authors that resolve neither way appear as plain names.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button onClick={saveSettings} disabled={savingSettings} size="sm">
            {savingSettings && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Save settings
          </Button>
          <Button onClick={sendAllTests} disabled={testingAll || hasWebhook === false} variant="outline" size="sm" className="gap-1.5"
            title={hasWebhook === false ? "Add a Slack webhook above first" : "Send one labeled 'Testing for SEO tool' sample of every Slack message type"}>
            {testingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Send test messages (all types)
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Sends one sample of each Slack message type (audit digest, page-health, AI citations, backlinks, internal links, PR review),
          each prefixed with <span className="font-mono">🧪 Testing for SEO tool</span> so teammates ignore them.
        </p>
      </div>
    </div>
  );
});
