"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import { AtSign, Loader2, Search, CheckCircle2, XCircle, Megaphone, Square, ChevronRight, History, ArrowLeft, AlertTriangle, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { LoadFailed, fetchHonest } from "@/components/ui/load-failed";
import { ProspectDrawer } from "@/components/prospects/ProspectDrawer";
import type { Campaign, ProspectCard } from "@/lib/types";
import { PageHeader } from "@/components/layout/PageHeader";

interface Person { name: string; authorId?: string; publication?: string; steps: string[]; status: "running" | "found" | "not_found" | "error"; email?: string; source?: string; issues?: string[]; lastAt: number }
interface Status { running: boolean; total: number; done: number; found: number; bySource?: Record<string, number>; campaignName?: string; people: Person[] }

const SOURCE_LABEL: Record<string, string> = {
  "page-scrape": "on their page", "blitz-linkedin": "LinkedIn → Blitz", social: "social profile",
  "hermes-browser": "via a real browser",
  "ai-scrape": "found on site", hunter: "Hunter", blitz: "Blitz",
  "pattern-verified": "pattern verified", "pattern-catchall": "pattern · GUESS (catch-all)", pattern: "pattern · GUESS",
  "page-scrape-unmatched": "page scrape · GUESS (name mismatch)",
  "linkedin-post": "LinkedIn on a post", "linkedin-social": "LinkedIn via social", "linkedin-websearch": "LinkedIn via search",
};

// Constructed-from-pattern emails are guesses (unless SMTP-verified). Everything else is
// a real found email. Guesses render amber + a "guess" tag; sourced/verified render green.
export function isGuess(source?: string) { return source === "pattern" || source === "pattern-catchall" || source === "page-scrape-unmatched"; }
function isConfident(source?: string) { return !isGuess(source); }
function isLinkedinResult(source?: string) { return !!source && source.startsWith("linkedin-"); }

export default function EmailFinderPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState<string>("");
  const [mode, setMode] = useState<"email" | "linkedin">("email");
  const [onlyNew, setOnlyNew] = useState(false); // email mode only: skip authors already searched before, even if it failed
  const [pending, setPending] = useState<number | null>(null);
  const [totalProspects, setTotalProspects] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [starting, setStarting] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<any[]>([]);
  const [viewingRunId, setViewingRunId] = useState<string | null>(null); // null = live
  const [drawerProspect, setDrawerProspect] = useState<ProspectCard | null>(null);
  /** One banner for this page's three reads (runs history, campaigns, pending counts) — keyed per
   *  read so one read succeeding cannot clear another read's failure. A failed count must render
   *  as unknown ("—"), never as "0 of 0 prospects" stated as fact. */
  const [loadErrors, setLoadErrors] = useState<{ runs?: string; campaigns?: string; pending?: string }>({});
  const loadError = [...new Set(Object.values(loadErrors).filter((r): r is string => !!r))].join(" · ") || null;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Open the shared prospect drawer (profile + all their articles) for an author.
  const openAuthor = useCallback(async (authorId?: string) => {
    if (!authorId) return;
    const d = await fetch(`/api/authors/${authorId}`).then((r) => r.ok ? r.json() : null).catch(() => null);
    if (d) setDrawerProspect(d);
  }, []);

  const toggleExpand = (name: string) =>
    setExpanded((prev) => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });

  const loadRuns = useCallback(() => {
    void fetchHonest<Record<string, unknown>[]>("/api/enrich/runs").then(({ data, reason }) => {
      if (data) setRuns(data); // a failure keeps the history already shown
      setLoadErrors((e) => ({ ...e, runs: reason ?? undefined }));
    });
  }, []);

  const loadCampaigns = useCallback(() => {
    void fetchHonest<Campaign[]>("/api/campaigns").then(({ data, reason }) => {
      if (data) setCampaigns(data);
      setLoadErrors((e) => ({ ...e, campaigns: reason ?? undefined }));
    });
  }, []);

  useEffect(() => {
    loadCampaigns();
    loadRuns();
  }, [loadCampaigns, loadRuns]);

  // Open a past run — loads its people into the SAME activity UI.
  const openRun = useCallback(async (id: string) => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    setViewingRunId(id);
    const st = await fetch(`/api/enrich/runs/${id}`).then((r) => r.json()).catch(() => null);
    if (st) setStatus(st);
  }, []);

  const backToLive = useCallback(() => { setViewingRunId(null); setStatus(null); }, []);

  const loadPending = useCallback((cid: string, m: "email" | "linkedin" = "email", newOnly = false) => {
    setPending(null);
    setTotalProspects(null);
    const params = new URLSearchParams();
    if (cid) params.set("campaign_id", cid);
    if (m === "linkedin") params.set("mode", "linkedin");
    if (m === "email" && newOnly) params.set("only_new", "true");
    const qs = params.toString();
    void fetchHonest<{ count?: number; total?: number }>(`/api/enrich/pending${qs ? `?${qs}` : ""}`).then(({ data, reason }) => {
      // A failed count leaves both null — unknown, rendered as "—", never as a confident zero.
      if (data) { setPending(data.count ?? 0); setTotalProspects(data.total ?? 0); }
      setLoadErrors((e) => ({ ...e, pending: reason ?? undefined }));
    });
  }, []);

  const poll = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    const tick = async () => {
      const st: Status = await fetch("/api/enrich/status").then((r) => r.json()).catch(() => null);
      if (!st) return;
      setStatus(st);
      if (!st.running) {
        if (timer.current) { clearInterval(timer.current); timer.current = null; }
        setStarting(false);
        loadPending(campaignId, mode, onlyNew);
        loadRuns(); // a finished run is now in history
      }
    };
    tick();
    timer.current = setInterval(tick, 2000);
  }, [campaignId, mode, onlyNew, loadPending, loadRuns]);

  useEffect(() => {
    loadPending(campaignId, mode, onlyNew);
    // resume progress if a run is active
    fetch("/api/enrich/status").then((r) => r.json()).then((st) => { if (st?.running) { setStatus(st); poll(); } }).catch(() => {});
    return () => { if (timer.current) clearInterval(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, mode, onlyNew]);

  async function findEmails() {
    setViewingRunId(null); // go back to live
    setStarting(true);
    const res = await fetch("/api/enrich/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(campaignId ? { campaign_id: campaignId } : {}), mode, ...(mode === "email" && onlyNew ? { only_new: true } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.started) { poll(); }
    else {
      setStarting(false);
      if (data.alreadyRunning) { toast.info("A run is already in progress."); poll(); }
      else toast.error(data.reason ?? "Couldn't start.");
    }
  }

  async function stop() {
    await fetch("/api/enrich/stop", { method: "POST" }).catch(() => {});
    toast.info("Stopping after the current lookup…");
  }

  const running = status?.running || starting;
  const pct = status && status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
  // People we couldn't finish because a provider (Blitz/Reoon/search/AI) failed — NOT a
  // genuine "no email exists". Surfaced separately so a bad API run isn't read as absence.
  const erroredCount = status?.people?.filter((p) => p.status === "error").length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={mode === "linkedin" ? Link2 : AtSign}
        title={mode === "linkedin" ? "LinkedIn Finder" : "Email Finder"}
        description={mode === "linkedin"
          ? "Finds and stores each writer's LinkedIn; the email finder later turns it into an email."
          : "Finds emails for prospects that don't have one yet: posts, LinkedIn, socials, verified pattern guessing and AI scan."}
      />

      {loadError && (
        <LoadFailed
          nothing="the email-finder data"
          detail={loadError}
          onRetry={() => { loadCampaigns(); loadRuns(); loadPending(campaignId, mode, onlyNew); }}
        />
      )}

      {/* Controls */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Find</label>
            <select
              className="h-9 w-40 rounded-md border border-input bg-background px-2 text-sm"
              value={mode}
              onChange={(e) => setMode(e.target.value as "email" | "linkedin")}
              disabled={running}
            >
              <option value="email">Emails</option>
              <option value="linkedin">LinkedIns</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Megaphone className="h-3.5 w-3.5" /> Campaign
            </label>
            <select
              className="h-9 w-56 rounded-md border border-input bg-background px-2 text-sm"
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              disabled={running}
            >
              <option value="">All prospects</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {mode === "email" && (
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground opacity-0 select-none">Brand new</label>
              <div className="h-9 flex items-center gap-2">
                <Checkbox id="only-new" checked={onlyNew} onCheckedChange={(v) => setOnlyNew(v === true)} disabled={running} />
                <label htmlFor="only-new" className="text-sm cursor-pointer select-none" title="Skip authors already searched before, even if it failed — only try ones we've never attempted.">
                  Brand new only
                </label>
              </div>
            </div>
          )}

          <div className="flex-1 min-w-[200px]">
            <p className="text-sm">
              {pending === null && !loadErrors.pending ? (
                <span className="text-muted-foreground inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> counting…</span>
              ) : (
                <><span className="text-2xl font-bold text-highlight-ink tabular-nums">{pending?.toLocaleString() ?? "—"}</span> <span className="text-muted-foreground">without a{mode === "linkedin" ? " LinkedIn" : "n email"}{mode === "email" && onlyNew ? " (never searched)" : ""}</span> <span className="text-muted-foreground/60">of {totalProspects?.toLocaleString() ?? "—"} total prospects</span></>
              )}
            </p>
          </div>

          <div className="flex items-center gap-3">
            {running ? (
              <Button variant="outline" onClick={stop} className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10">
                <Square className="h-3.5 w-3.5" /> Stop
              </Button>
            ) : (
              <Button onClick={findEmails} disabled={starting || pending === 0} className={`gap-1.5 text-white ${mode === "linkedin" ? "bg-[#0a66c2] hover:bg-[#0a66c2]/90" : "bg-primary hover:bg-primary"}`}>
                <Search className="h-4 w-4" /> {mode === "linkedin" ? "Find LinkedIns" : "Find Emails"}
              </Button>
            )}
          </div>
        </div>

        {/* Progress */}
        {status && (status.running || status.done > 0) && (
          <div className="space-y-2 pt-2 border-t border-border">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {status.running ? "Finding emails" : "Done"}{status.campaignName ? ` · ${status.campaignName}` : ""}
              </span>
              <span className="tabular-nums">
                <span className="text-foreground font-semibold">{status.done}</span>
                <span className="text-muted-foreground">/{status.total}</span>
                <span className="text-success ml-3">{status.found} found</span>
                {erroredCount > 0 && <span className="text-warning ml-3">{erroredCount} API issue{erroredCount === 1 ? "" : "s"}</span>}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
            </div>
            {/* Per-source breakdown once finished */}
            {!status.running && status.found > 0 && status.bySource && (
              <p className="text-xs text-muted-foreground pt-1">
                {Object.entries(status.bySource)
                  .map(([src, n]) => `${n} via ${SOURCE_LABEL[src] ?? src}`)
                  .join(" · ")}
              </p>
            )}
            {!status.running && erroredCount > 0 && (
              <p className="text-xs text-warning/80 pt-0.5 flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {erroredCount} couldn&apos;t be completed because an API failed (not confirmed missing) — re-run to retry them.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Viewing a past run */}
      {viewingRunId && (
        <div className="flex items-center gap-3 rounded-lg border border-highlight/40 bg-highlight-soft px-4 py-2 text-sm">
          <History className="h-4 w-4 text-highlight-ink shrink-0" />
          <span className="text-muted-foreground">Viewing a past run{status?.campaignName ? ` · ${status.campaignName}` : ""} — {status?.found ?? 0}/{status?.total ?? 0} found</span>
          <Button size="sm" variant="ghost" className="ml-auto gap-1.5 h-10" onClick={backToLive}>
            <ArrowLeft className="h-3.5 w-3.5" /> Back to live
          </Button>
        </div>
      )}

      {/* Activity — one row per person; row text updates live, expand for all steps */}
      {status && (status.people?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {viewingRunId ? "Run activity" : "Activity"}
          </div>
          <div className="max-h-[560px] overflow-y-auto divide-y divide-border/50">
            {status.people.map((p) => {
              const ok = p.status === "found";
              const inProgress = p.status === "running";
              const errored = p.status === "error";
              const isOpen = expanded.has(p.name);
              const liveText = p.steps[p.steps.length - 1] ?? "starting…";
              return (
                <div key={p.name}>
                  <div className="w-full px-4 py-2.5 flex items-center gap-2.5 hover:bg-muted/20 transition-colors">
                    <button onClick={() => toggleExpand(p.name)} className="shrink-0" aria-label="Toggle steps">
                      <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground/50 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    </button>
                    {ok ? <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                      : inProgress ? <Loader2 className="h-4 w-4 text-highlight-ink shrink-0 animate-spin" />
                      : errored ? <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
                      : <XCircle className="h-4 w-4 text-muted-foreground/40 shrink-0" />}
                    <button
                      onClick={() => openAuthor(p.authorId)}
                      disabled={!p.authorId}
                      className="text-sm font-medium truncate max-w-[180px] text-left hover:text-highlight-ink hover:underline disabled:hover:no-underline disabled:hover:text-foreground"
                      title={p.authorId ? "View profile & articles" : undefined}
                    >
                      {p.name}
                    </button>
                    <div onClick={() => toggleExpand(p.name)} className="ml-auto flex items-center gap-2 shrink-0 text-xs cursor-pointer">
                      {ok ? (
                        isLinkedinResult(p.source) ? (
                          <><a href={p.email} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                              className="text-[#0a66c2] hover:underline truncate max-w-[240px]">{p.email?.replace(/^https?:\/\/(www\.)?/, "")}</a>
                            <span className="text-muted-foreground/60">{SOURCE_LABEL[p.source ?? ""] ?? p.source}</span></>
                        ) : (
                          <><span className={`font-mono ${isConfident(p.source) ? "text-success" : "text-warning"}`}>{p.email}</span>
                            <span className={isConfident(p.source) ? "text-muted-foreground/60" : "text-warning/70"}>{SOURCE_LABEL[p.source ?? ""] ?? p.source}</span></>
                        )
                      ) : inProgress ? (
                        <span className="text-muted-foreground/70 truncate max-w-[360px] font-mono">{liveText}</span>
                      ) : errored ? (
                        <span className="text-warning/80 truncate max-w-[360px]" title={p.issues?.join(" · ")}>
                          couldn&apos;t complete — {p.issues?.[0] ?? "API failed"}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">{mode === "linkedin" ? "no LinkedIn found" : "no email found"}</span>
                      )}
                    </div>
                  </div>
                  {isOpen && p.steps.length > 0 && (
                    <div className="px-4 pb-2.5 pl-11 space-y-1 bg-muted/5">
                      {p.steps.map((s, i) => {
                        const warn = s.startsWith("!");
                        return (
                          <div key={i} className={`flex items-center gap-2 text-xs font-mono ${warn ? "text-warning/80" : "text-muted-foreground/60"}`}>
                            <span className={`h-1 w-1 rounded-full shrink-0 ${warn ? "bg-warning/60" : "bg-muted-foreground/30"}`} />
                            <span className="truncate">{s}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Run history — open any past run to replay its exact activity */}
      {runs.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <History className="h-3.5 w-3.5" /> Run history
          </div>
          <div className="divide-y divide-border/50">
            {runs.map((r) => (
              <button
                key={r.id}
                onClick={() => openRun(r.id)}
                className={`w-full px-4 py-2.5 flex items-center gap-3 text-left text-sm hover:bg-muted/20 transition-colors ${viewingRunId === r.id ? "bg-muted/30" : ""}`}
              >
                <span className="text-muted-foreground/70 shrink-0 w-36">{new Date(r.finished_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                <span className="truncate flex-1">{r.campaign_name || "All prospects"}</span>
                <span className="shrink-0 text-xs"><span className="text-success font-semibold">{r.found}</span> <span className="text-muted-foreground/60">found / {r.done} checked</span></span>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      <ProspectDrawer prospect={drawerProspect} open={!!drawerProspect} onClose={() => setDrawerProspect(null)} />
    </div>
  );
}
