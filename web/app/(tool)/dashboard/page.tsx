"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import type { ProspectCard, DashboardStats } from "@/lib/types";
import { Scorecards } from "@/components/dashboard/Scorecards";
import { CompetitorHeatmap, FreshnessTimeline, ProvenanceChart, TopPublications } from "@/components/dashboard/Charts";
import { DraftingRate } from "@/components/dashboard/DraftingRate";
import { ProspectCard as ProspectCardComp } from "@/components/prospects/ProspectCard";
import { ProspectDrawer } from "@/components/prospects/ProspectDrawer";
import { PipelineProgress, type PipelineProgress as PipelineProgressEvent } from "@/components/pipeline/PipelineProgress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadFailed, fetchHonest } from "@/components/ui/load-failed";
import { Download, Rocket, Search, RefreshCw, Radio, CheckCircle2, XCircle, Clock, Loader2, Megaphone, UserPlus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import type { Campaign } from "@/lib/types";
import { PageHeader } from "@/components/layout/PageHeader";

const EMPTY_STATS: DashboardStats = {
  totalProspects: 0, totalAuthors: 0, totalPublications: 0, contactablePercent: 0, newThisWeek: 0,
};

export default function HomePage() {
  const [prospects, setProspects] = useState<ProspectCard[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS);
  const [toolCounts, setToolCounts] = useState<{ tool: string; count: number }[]>([]);
  const [timeline, setTimeline] = useState<{ date: string; count: number }[]>([]);
  const [provenance, setProvenance] = useState<{ source: string; count: number }[]>([]);
  const [publications, setPublications] = useState<{ name: string; host: string; count: number; avgScore: number }[]>([]);

  const [loading, setLoading] = useState(true);
  /** A failed prospects load must not render the onboarding "No prospects yet" — the prospects
   *  are not gone, the fetch failed. Rendered instead of the EmptyState, above stale results. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Same rule for the pipeline's run history — a failure keeps what's shown and says so. */
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [archetype, setArchetype] = useState("all");
  const [minScore, setMinScore] = useState("0");
  const [hasContact, setHasContact] = useState(false);
  const [qualifiedOnly, setQualifiedOnly] = useState(false);
  const [emailStatus, setEmailStatus] = useState("any");
  const [sortBy, setSortBy] = useState("composite");
  const [selectedTool, setSelectedTool] = useState("all");

  const [selectedProspect, setSelectedProspect] = useState<ProspectCard | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [pipelineEvents, setPipelineEvents] = useState<PipelineProgressEvent[]>([]);
  const [pipelineDone, setPipelineDone] = useState(false);
  const [pipelineError, setPipelineError] = useState(false);
  const [pipelineStats, setPipelineStats] = useState<Record<string, number>>({});
  const [pipelineStartMs, setPipelineStartMs] = useState<number>(0);
  const [pipelineElapsedMs, setPipelineElapsedMs] = useState<number>(0);
  const [runHistory, setRunHistory] = useState<any[]>([]);
  const [savedHitCounts, setSavedHitCounts] = useState<{ total: number; unprofiled: number } | null>(null);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [isWiping, setIsWiping] = useState(false);
  const [liveRun, setLiveRun] = useState<any>(null);
  const [isReconnected, setIsReconnected] = useState(false);
  const isReconnectedRef = useRef(false);
  const liveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sawRunningRef = useRef(false);   // have we observed the run actually running yet?
  const discoverStartRef = useRef(0);    // when we kicked off discovery (startup-race guard)

  const setReconnected = (v: boolean) => {
    isReconnectedRef.current = v;
    setIsReconnected(v);
  };

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [discoveryCampaignId, setDiscoveryCampaignId] = useState<string>("");
  const [filterCampaignId, setFilterCampaignId] = useState<string>("");
  const [campaignProspectCount, setCampaignProspectCount] = useState(0);

  // Manual "Add Prospect"
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ full_name: "", email: "", publication: "", campaign_id: "" });
  const [addArticles, setAddArticles] = useState<string[]>([""]);
  const [addSaving, setAddSaving] = useState(false);
  const [resumableCheckpoint, setResumableCheckpoint] = useState<{ round: number; usedQueries: string[]; savedAt: string } | null>(null);

  const [activeTab, setActiveTab] = useState("overview");

  const limit = 24;

  const fetchProspects = useCallback(async (reset = false) => {
    setLoading(true);
    const off = reset ? 0 : offset;
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(off),
      sortBy,
      include: "stats,charts",
    });
    if (search) params.set("search", search);
    if (archetype && archetype !== "all") params.set("archetype", archetype);
    if (minScore && minScore !== "0") params.set("minScore", minScore);
    if (hasContact) params.set("hasContact", "true");
    if (qualifiedOnly) params.set("qualified_only", "true");
    if (emailStatus && emailStatus !== "any") params.set("email_status", emailStatus);
    if (selectedTool && selectedTool !== "all") params.set("tool", selectedTool);
    if (filterCampaignId) params.set("campaign_id", filterCampaignId);

    const { data, reason } = await fetchHonest<{
      prospects?: ProspectCard[]; total?: number; stats?: DashboardStats; error?: unknown;
      toolCounts?: { tool: string; count: number }[]; timeline?: { date: string; count: number }[];
      provenance?: { source: string; count: number }[];
      publications?: { name: string; host: string; count: number; avgScore: number }[];
    }>(`/api/prospects?${params}`);
    const rows = data?.prospects;
    if (data && Array.isArray(rows)) {
      setProspects(reset ? rows : (prev: ProspectCard[]) => [...prev, ...rows]);
      setTotal(data.total ?? 0);
      if (reset) setOffset(0);
      if (data.stats) setStats(data.stats);
      if (data.toolCounts) setToolCounts(data.toolCounts);
      if (data.timeline) setTimeline(data.timeline);
      if (data.provenance) setProvenance(data.provenance);
      if (data.publications) setPublications(data.publications);
      setLoadError(null);
    } else {
      // A failed read — or a 200-shaped error body with no rows in it, which used to set
      // `prospects` undefined and TypeError further down. Keep whatever is already shown.
      setLoadError(reason ?? (typeof data?.error === "string" && data.error ? data.error : "the server sent an unexpected response"));
    }
    setLoading(false);
  }, [offset, search, archetype, minScore, hasContact, qualifiedOnly, emailStatus, sortBy, selectedTool, filterCampaignId]);

  const loadRunHistory = useCallback(async () => {
    const [runs, counts] = await Promise.all([
      fetchHonest<Record<string, unknown>[]>("/api/pipeline"),
      fetchHonest<{ total: number; unprofiled: number }>("/api/reprocess"),
    ]);
    if (Array.isArray(runs.data)) setRunHistory(runs.data);
    if (counts.data) setSavedHitCounts(counts.data.total != null ? counts.data : null);
    // A failure keeps the history already on screen instead of hiding the section.
    setHistoryError(runs.reason ?? counts.reason);
  }, []);

  // Poll live stats every 4s; replays buffered events into PipelineProgress after a refresh
  const pollLive = useCallback(async () => {
    try {
      const data = await fetch("/api/pipeline/live").then((r) => r.json());
      setLiveRun(data);

      if (data.isRunning) {
        sawRunningRef.current = true;
        const evs: PipelineProgressEvent[] = data.bufferedEvents ?? [];
        if (evs.length > 0) setPipelineEvents(evs);
        setPipelineElapsedMs(data.elapsedMs ?? 0);
        // Cumulative progress for the WHOLE discovery (aggregated across every serverless
        // chunk), so the numbers climb steadily instead of resetting each chunk and looking
        // like a restart. `runProgress` is the delta from the baseline captured at start;
        // fall back to the latest event's per-run stats if the server didn't supply it.
        const s = [...evs].reverse().find((e) => e.hitsDiscovered != null || e.processed != null || e.authors != null);
        setPipelineStats((prev) => ({
          ...prev,
          hitsDiscovered: data.runProgress?.discovered ?? s?.hitsDiscovered ?? prev.hitsDiscovered ?? 0,
          processed: data.runProgress?.processed ?? s?.processed ?? prev.processed ?? 0,
          authors: data.runProgress?.authors ?? s?.authors ?? prev.authors ?? 0,
          errors: s?.errors ?? prev.errors ?? 0,
        }));
        if (!isReconnectedRef.current) setReconnected(true);
      } else if (isReconnectedRef.current && !sawRunningRef.current && discoverStartRef.current && Date.now() - discoverStartRef.current < 30_000) {
        // Just kicked off — the after() pipeline may not have registered yet. Keep polling
        // (don't declare "done") until we've actually seen it running, up to a 30s grace.
      } else {
        if (liveRef.current) { clearInterval(liveRef.current); liveRef.current = null; }
        setIsStopping(false);
        setIsDiscovering(false);
        if (isReconnectedRef.current) {
          setReconnected(false);
          if (sawRunningRef.current) {
            setPipelineDone(true);
            loadRunHistory();
            fetchProspects(true);
            toast.success("Pipeline finished — prospects updated.");
          } else {
            setPipelineError(true); // never started within the grace window
            toast.error("Discovery didn't start — check the logs and try again.");
          }
        } else {
          loadRunHistory();
        }
      }
    } catch {}
  }, [loadRunHistory, fetchProspects]);

  // Poll when Pipeline tab is open and not actively streaming via SSE
  useEffect(() => {
    if (activeTab !== "pipeline") return;
    if (isDiscovering && !isReconnected) return; // SSE active — don't double-poll
    pollLive();
    if (liveRef.current) clearInterval(liveRef.current);
    liveRef.current = setInterval(pollLive, 4000);
    return () => { if (liveRef.current) clearInterval(liveRef.current); };
  }, [activeTab, isDiscovering, isReconnected, pollLive]);

  useEffect(() => {
    fetch("/api/campaigns").then((r) => r.ok ? r.json() : []).then(setCampaigns).catch(() => {});
    fetch("/api/pipeline/checkpoint").then((r) => r.ok ? r.json() : null).then(setResumableCheckpoint).catch(() => {});
  }, []);

  useEffect(() => {
    if (!discoveryCampaignId) { setCampaignProspectCount(0); return; }
    fetch(`/api/prospects?campaign_id=${discoveryCampaignId}&limit=1`)
      .then((r) => r.json())
      .then((d) => setCampaignProspectCount(d.total ?? 0))
      .catch(() => {});
  }, [discoveryCampaignId]);

  useEffect(() => {
    fetchProspects(true);
    loadRunHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, archetype, minScore, hasContact, qualifiedOnly, emailStatus, sortBy, selectedTool, filterCampaignId]);

  useEffect(() => {
    if (offset > 0) fetchProspects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const runDiscovery = async (resume = false) => {
    // Kick the run off server-side (via after()), then drive the UI purely by polling
    // /api/pipeline/live. The run is independent of this tab — closing it doesn't stop it.
    setIsDiscovering(true);
    setReconnected(true);          // treat as a polled (not tab-bound) run
    sawRunningRef.current = false;
    discoverStartRef.current = Date.now();
    setIsStopping(false);
    setPipelineEvents([]);
    setPipelineDone(false);
    setPipelineError(false);
    setPipelineStats({});
    setActiveTab("pipeline");
    if (resume) setResumableCheckpoint(null);
    setPipelineStartMs(Date.now());
    setPipelineElapsedMs(0);

    try {
      const body: Record<string, unknown> = resume ? { resume: true } : {};
      if (!resume && discoveryCampaignId) body.campaign_id = discoveryCampaignId;
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.started === false) {
        setPipelineError(true);
        setIsDiscovering(false);
        setReconnected(false);
        toast.error(data.reason ?? data.error ?? "Couldn't start discovery.");
        return;
      }
      toast.success("Discovery started — it keeps running even if you close this tab.");
      pollLive(); // begin polling immediately; the polling effect keeps it going
    } catch (e: unknown) {
      setPipelineError(true);
      setIsDiscovering(false);
      setReconnected(false);
      toast.error(`Discovery error: ${(e as Error)?.message}`);
    }
  };

  const stopDiscovery = async () => {
    setIsStopping(true);
    await fetch("/api/pipeline/stop", { method: "POST" }).catch(() => {});
  };

  const runReprocess = async (source?: string) => {
    setIsReprocessing(true);
    setIsDiscovering(true);
    setIsStopping(false);
    setPipelineEvents([]);
    setPipelineDone(false);
    setPipelineError(false);
    setPipelineStats({});
    setActiveTab("pipeline");
    const start = Date.now();
    setPipelineStartMs(start);
    setPipelineElapsedMs(0);

    if (elapsedRef.current) clearInterval(elapsedRef.current);
    elapsedRef.current = setInterval(() => setPipelineElapsedMs(Date.now() - start), 1000);

    try {
      const res = await fetch("/api/reprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, campaign_id: discoveryCampaignId || undefined }),
      });
      if (!res.body) throw new Error("No stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const data = JSON.parse(line.slice(5));
            if (data.stage === "done") {
              setPipelineDone(true);
              setPipelineStats(data.stats ?? {});
              toast.success(`Reprocess complete! ${data.stats?.processed ?? 0} articles re-extracted.`);
              fetchProspects(true);
              loadRunHistory();
            } else if (data.stage === "error") {
              setPipelineError(true);
              toast.error(`Reprocess failed: ${data.message}`);
            } else {
              setPipelineEvents((prev) => [...prev, data]);
              if (data.stats) setPipelineStats(data.stats);
            }
          } catch {}
        }
      }
    } catch (e: unknown) {
      setPipelineError(true);
      toast.error(`Reprocess error: ${(e as Error)?.message}`);
    } finally {
      setIsDiscovering(false);
      setIsReprocessing(false);
      setIsStopping(false);
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    }
  };

  const wipeAndReset = async () => {
    if (!confirm("This will permanently delete ALL articles, authors, scores, and discovery hits. Seed tools and harvester config are kept. Continue?")) return;
    setIsWiping(true);
    try {
      const res = await fetch("/api/admin/wipe", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        toast.success("Database wiped — ready for a fresh discovery run.");
        setSavedHitCounts(null);
        setProspects([]);
        setTotal(0);
        setStats(EMPTY_STATS);
        loadRunHistory();
      } else {
        toast.error("Wipe failed: " + JSON.stringify(data));
      }
    } catch (e: any) {
      toast.error("Wipe error: " + e?.message);
    } finally {
      setIsWiping(false);
    }
  };

  const handleExport = (fmt: "csv" | "json") => {
    const params = new URLSearchParams({ format: fmt });
    if (archetype && archetype !== "all") params.set("archetype", archetype);
    if (minScore && minScore !== "0") params.set("minScore", minScore);
    if (selectedTool && selectedTool !== "all") params.set("tool", selectedTool);
    window.open(`/api/export?${params}`, "_blank");
    toast.success(`Exporting ${fmt.toUpperCase()}…`);
  };

  const openAddProspect = () => {
    setAddForm({ full_name: "", email: "", publication: "", campaign_id: filterCampaignId || discoveryCampaignId || "" });
    setAddArticles([""]);
    setAddOpen(true);
  };

  const submitAddProspect = async () => {
    const articleUrls = addArticles.map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
    if (!addForm.full_name.trim()) { toast.error("Name is required."); return; }
    if (articleUrls.length === 0) { toast.error("At least one article link (https://…) is required."); return; }
    setAddSaving(true);
    try {
      const res = await fetch("/api/prospects/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: addForm.full_name,
          email: addForm.email || undefined,
          publication: addForm.publication || undefined,
          article_urls: articleUrls,
          campaign_id: addForm.campaign_id || undefined,
        }),
      });
      if (res.ok) {
        const camp = campaigns.find((c) => c.id === addForm.campaign_id);
        toast.success(`Added ${addForm.full_name}${camp ? ` to “${camp.name}”` : ""}.`);
        setAddOpen(false);
        // Jump straight to the new prospect so it's visibly added (it sorts by score, so it
        // wouldn't otherwise land on page 1). Clear the campaign filter + search their name.
        setActiveTab("prospects");
        setFilterCampaignId("");
        setSearch(addForm.full_name);
      } else {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? "Failed to add prospect.");
      }
    } catch {
      toast.error("Failed to add prospect.");
    } finally {
      setAddSaving(false);
    }
  };

  const topTools = toolCounts.slice(0, 15).map((t) => t.tool);

  return (
    <div className="space-y-4">
      {/* ── Global loading bar ── */}
      {loading && (
        <div className="fixed top-0 left-0 right-0 z-50 h-[2px] overflow-hidden">
          <div className="h-full bg-primary animate-[loading-bar_1.4s_ease-in-out_infinite]"
            style={{ animation: "loading-bar 1.4s ease-in-out infinite" }} />
          <style>{`@keyframes loading-bar{0%{transform:translateX(-100%)}50%{transform:translateX(0%)}100%{transform:translateX(100%)}}`}</style>
        </div>
      )}

      {/* Page header */}
      <div className="flex items-start justify-between gap-6">
        <PageHeader title="Prospects" />
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => handleExport("csv")} className="gap-2">
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          {campaigns.length > 0 && (
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={discoveryCampaignId}
              onChange={(e) => setDiscoveryCampaignId(e.target.value)}
              disabled={isDiscovering}
              title="Campaign to discover for"
            >
              <option value="">No campaign</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
          {resumableCheckpoint && !isDiscovering && (
            <Button
              onClick={() => runDiscovery(true)}
              size="sm"
              variant="outline"
              className="gap-2 border-warning text-warning hover:bg-amber-50"
              title={`Resume from round ${resumableCheckpoint.round} — ${resumableCheckpoint.usedQueries.length} queries already done`}
            >
              <RefreshCw className="h-4 w-4" />
              Resume (round {resumableCheckpoint.round})
            </Button>
          )}
          <Button
            onClick={() => runDiscovery(false)}
            disabled={isDiscovering}
            size="sm"
            className="bg-primary hover:bg-primary text-primary-foreground gap-2"
          >
            {isDiscovering ? (
              <><RefreshCw className="h-4 w-4 animate-spin" />Discovering…</>
            ) : (
              <><Rocket className="h-4 w-4" />Run Discovery</>
            )}
          </Button>
        </div>
      </div>

      {/* Keywords of the selected discovery campaign */}
      {(() => {
        const c = campaigns.find((c) => c.id === discoveryCampaignId);
        if (!c) return null;
        return (
          <div className="flex flex-wrap items-center gap-1.5 -mt-1">
            <span className="text-xs text-muted-foreground">Keywords for “{c.name}”:</span>
            {c.keywords && c.keywords.length > 0
              ? c.keywords.map((k) => (
                  <Badge key={k} variant="secondary" className="text-xs px-1.5 py-0 h-5 font-normal">{k}</Badge>
                ))
              : <span className="text-xs text-muted-foreground/60 italic">no keywords set</span>}
          </div>
        );
      })()}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="prospects">
            Prospects
            {loading && activeTab === "prospects"
              ? <Loader2 className="ml-2 h-3 w-3 animate-spin" />
              : total > 0 && (
                  <Badge variant="secondary" className="ml-2 text-xs py-0 h-5">
                    {total.toLocaleString()}
                  </Badge>
                )
            }
          </TabsTrigger>
          <TabsTrigger value="pipeline">
            Pipeline
            {isDiscovering && (
              <span className="ml-2 h-2 w-2 rounded-full bg-primary animate-pulse inline-block" />
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── OVERVIEW ── */}
        <TabsContent value="overview" className="space-y-4">
          <Scorecards stats={stats} loading={loading && stats.totalProspects === 0} />

          {/* Full width and first: this is the one chart that answers "is the tool paying for
              itself", and it loads independently so a slow CMS read never holds the dashboard. */}
          <DraftingRate />

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
            <div className="col-span-4">
              <CompetitorHeatmap data={toolCounts} />
            </div>
            <div className="col-span-3">
              <FreshnessTimeline data={timeline} />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
            <div className="col-span-4">
              <TopPublications data={publications} />
            </div>
            <div className="col-span-3">
              <ProvenanceChart data={provenance} />
            </div>
          </div>
        </TabsContent>

        {/* ── PROSPECTS ── */}
        <TabsContent value="prospects" className="space-y-4">
          <Card>
            <CardContent className="pt-4 pb-3 space-y-3">
              <div className="flex flex-wrap gap-3 items-end">
                {/* Search */}
                <div className="flex-1 min-w-48 space-y-1">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                    Search
                    {loading && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                  </Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Authors, publications…"
                      className="pl-9"
                    />
                  </div>
                </div>

                {/* Article type */}
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Article type</Label>
                  <Select value={archetype} onValueChange={(v) => setArchetype(v ?? "all")} disabled={loading}>
                    <SelectTrigger className="w-38">
                      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All types</SelectItem>
                      <SelectItem value="listicle">Listicle</SelectItem>
                      <SelectItem value="comparison">Comparison</SelectItem>
                      <SelectItem value="review">Review</SelectItem>
                      <SelectItem value="explainer">Explainer</SelectItem>
                      <SelectItem value="news">News</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* AI tool mentioned */}
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">AI tool covered</Label>
                  <Select value={selectedTool} onValueChange={(v) => setSelectedTool(v ?? "all")} disabled={loading}>
                    <SelectTrigger className="w-44">
                      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Any tool</SelectItem>
                      {topTools.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                {/* Min score */}
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Min score</Label>
                  <Select value={minScore} onValueChange={(v) => setMinScore(v ?? "0")} disabled={loading}>
                    <SelectTrigger className="w-32">
                      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Any</SelectItem>
                      <SelectItem value="20">20+</SelectItem>
                      <SelectItem value="30">30+</SelectItem>
                      <SelectItem value="50">50+</SelectItem>
                      <SelectItem value="70">70+ (top)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Email status */}
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Email</Label>
                  <Select value={emailStatus} onValueChange={(v) => setEmailStatus(v ?? "any")} disabled={loading}>
                    <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any</SelectItem>
                      <SelectItem value="has">Has email</SelectItem>
                      <SelectItem value="verified">Found / sourced</SelectItem>
                      <SelectItem value="guessed">Guessed (pattern)</SelectItem>
                      <SelectItem value="none">No email</SelectItem>
                      <SelectItem value="linkedin_no_email">Has LinkedIn, no email</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Sort by */}
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Sort by</Label>
                  <Select value={sortBy} onValueChange={(v) => setSortBy(v ?? "composite")} disabled={loading}>
                    <SelectTrigger className="w-40">
                      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="composite">Score</SelectItem>
                      <SelectItem value="relevance">Relevance</SelectItem>
                      <SelectItem value="authority">Authority</SelectItem>
                      <SelectItem value="freshness">Most recent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Has contact */}
                <div className="flex items-center gap-2 pb-0.5">
                  <Switch id="hasContact" checked={hasContact} onCheckedChange={setHasContact} disabled={loading} />
                  <Label htmlFor="hasContact" className={`text-sm whitespace-nowrap ${loading ? "opacity-50" : "cursor-pointer"}`}>Has contact</Label>
                </div>

                {/* Qualified only — DR>=50 + relevant (from the Outreach Requirement filters) */}
                <div className="flex items-center gap-2 pb-0.5">
                  <Switch id="qualifiedOnly" checked={qualifiedOnly} onCheckedChange={setQualifiedOnly} disabled={loading} />
                  <Label htmlFor="qualifiedOnly" className={`text-sm whitespace-nowrap ${loading ? "opacity-50" : "cursor-pointer"}`}>Qualified only</Label>
                </div>

                {/* Campaign filter */}
                {campaigns.length > 0 && (
                  <div className="space-y-1">
                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                      <Megaphone className="h-3 w-3" />Campaign
                    </Label>
                    <select
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                      value={filterCampaignId}
                      onChange={(e) => setFilterCampaignId(e.target.value)}
                      disabled={loading}
                    >
                      <option value="">All authors</option>
                      {campaigns.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                <Button variant="outline" size="sm" onClick={openAddProspect} className="ml-auto gap-1.5 self-end">
                  <UserPlus className="h-3.5 w-3.5" />
                  Add Prospect
                </Button>
                <Button variant="outline" size="sm" onClick={() => handleExport("json")} className="gap-1.5 self-end" disabled={loading}>
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  JSON
                </Button>
              </div>
            </CardContent>
          </Card>

          {loadError && (
            <LoadFailed nothing="your prospects" detail={loadError} onRetry={() => void fetchProspects(true)} />
          )}

          {loading && prospects.length === 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-72 rounded-xl" />
              ))}
            </div>
          ) : loading && prospects.length > 0 ? (
            <div className="relative">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pointer-events-none opacity-40">
                {prospects.map((p) => (
                  <ProspectCardComp key={p.author.id} prospect={p} onClick={() => {}} />
                ))}
              </div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex items-center gap-3 rounded-xl border border-border bg-[var(--glass-bg)] backdrop-blur-[20px] px-5 py-3 shadow-lg backdrop-blur-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-highlight-ink" />
                  <span className="text-sm font-medium">Updating results…</span>
                </div>
              </div>
            </div>
          ) : prospects.length === 0 ? (
            // With a load error the banner above already says what happened — the onboarding
            // EmptyState would falsely read as "you have no prospects".
            loadError ? null : (
              <EmptyState
                onRunDiscovery={() => { setActiveTab("pipeline"); runDiscovery(false); }}
                isRunning={isDiscovering}
              />
            )
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {prospects.map((p) => (
                  <ProspectCardComp
                    key={p.author.id}
                    prospect={p}
                    onClick={() => { setSelectedProspect(p); setDrawerOpen(true); }}
                  />
                ))}
              </div>
              {prospects.length < total && (
                <div className="flex justify-center mt-4">
                  <Button
                    variant="outline"
                    onClick={() => setOffset((prev) => prev + limit)}
                    disabled={loading}
                  >
                    {loading ? "Loading…" : `Load more (${total - prospects.length} remaining)`}
                  </Button>
                </div>
              )}
            </>
          )}
        </TabsContent>

        {/* ── PIPELINE ── */}
        <TabsContent value="pipeline" className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold">Discovery Pipeline</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                Harvests writers from GDELT, Hacker News, Reddit, RSS, WordPress, Ghost, Common Crawl &amp; Wayback
              </p>
            </div>
            {!isDiscovering && (
              <Button onClick={() => runDiscovery()} className="bg-primary hover:bg-primary text-primary-foreground gap-2">
                <Rocket className="h-4 w-4" />
                {pipelineEvents.length > 0 || liveRun?.isRunning ? "Run Again" : "Run Discovery"}
              </Button>
            )}
          </div>

          {/* Pipeline view — active SSE stream OR reconnected after page refresh */}
          {(pipelineEvents.length > 0 || isDiscovering || isReconnected) && (
            <Card>
              <CardContent className="pt-5 pb-4">
                {(liveRun?.isRunning || isDiscovering || isReconnected) && (
                  <div className="flex items-center gap-2 text-xs mb-4 bg-highlight-soft border border-highlight/25 rounded-md px-3 py-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse shrink-0" />
                    <span className="text-muted-foreground">Running discovery for</span>
                    <span className="font-semibold text-highlight-ink truncate">{liveRun?.campaign?.name || "All prospects (no campaign)"}</span>
                  </div>
                )}
                {isReconnected && (
                  <div className="flex items-center gap-2 text-xs text-warning/90 mb-4 bg-warning/8 border border-warning/25 rounded-md px-3 py-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse shrink-0" />
                    Reconnected after page refresh — replaying events from server buffer · polling every 4s
                  </div>
                )}
                <PipelineProgress
                  events={pipelineEvents}
                  isRunning={isDiscovering || isReconnected}
                  isDone={pipelineDone}
                  isError={pipelineError}
                  isStopping={isStopping}
                  stats={pipelineStats}
                  onStop={stopDiscovery}
                  onRestart={() => runDiscovery(false)}
                  elapsedMs={pipelineElapsedMs}
                />
              </CardContent>
            </Card>
          )}

          {/* Empty state */}
          {!isDiscovering && !isReconnected && pipelineEvents.length === 0 && (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <Rocket className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="font-semibold text-lg mb-2">Ready to discover</h3>
                <p className="text-muted-foreground text-sm max-w-md mb-6">
                  Click "Run Discovery" to harvest articles from 8 sources, score authors, and build your contact database.
                  Every run learns new sources automatically.
                </p>
                <Button onClick={() => runDiscovery()} className="bg-primary hover:bg-primary text-primary-foreground gap-2">
                  <Rocket className="h-4 w-4" />
                  Start Discovery
                </Button>
              </CardContent>
            </Card>
          )}

          {/* ── Reprocess saved articles — only shown when a campaign is selected ── */}
          {discoveryCampaignId && savedHitCounts && savedHitCounts.unprofiled > 0 && !isDiscovering && (
            <Card className="border-highlight/40 bg-highlight-soft">
              <CardContent className="py-4 px-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-sm font-semibold">Profile New Articles</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {savedHitCounts.unprofiled.toLocaleString()} saved hits have never been processed (already-handled ones are skipped).
                      Runs extraction + scoring on just those and links them to the selected campaign.
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2 border-highlight/40 text-highlight-ink hover:bg-highlight-soft"
                      onClick={() => runReprocess()}
                      disabled={isDiscovering}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Profile ({savedHitCounts.unprofiled.toLocaleString()} left)
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── Danger zone ── */}
          <Card className="border-destructive/20 bg-destructive/5">
            <CardContent className="py-4 px-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-destructive">Wipe Database</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Delete all articles, authors, scores and hits — keeps seed tools &amp; config. Use before a clean re-run with Claude filtering active.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 shrink-0"
                  onClick={wipeAndReset}
                  disabled={isWiping || isDiscovering}
                >
                  {isWiping ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wiping…</> : <><XCircle className="h-3.5 w-3.5" />Wipe &amp; Start Fresh</>}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ── Run History ── */}
          {historyError && (
            <p className="text-xs text-warning">
              Couldn&apos;t load the run history — it is not gone ({historyError}).{" "}
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void loadRunHistory()}>
                Try again
              </button>
            </p>
          )}
          {runHistory.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Run History</h3>
              <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                {runHistory.map((run: any) => {
                  const s = (run.stats ?? {}) as Record<string, number>;
                  const durMs = run.finished_at
                    ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
                    : Date.now() - new Date(run.started_at).getTime();
                  const durS = Math.round(durMs / 1000);
                  const durLabel = durS < 60 ? `${durS}s` : `${Math.floor(durS / 60)}m ${durS % 60}s`;
                  const isActive = run.status === "running";
                  return (
                    <div key={run.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30 transition-colors">
                      {/* Status dot */}
                      <div className={`h-2 w-2 rounded-full shrink-0 ${
                        run.status === "completed" ? "bg-primary" :
                        run.status === "failed"    ? "bg-destructive"  :
                        "bg-warning animate-pulse"
                      }`} />

                      {/* Time + duration */}
                      <div className="min-w-[140px]">
                        <p className="text-xs font-medium tabular-nums">
                          {new Date(run.started_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </p>
                        <p className="text-xs text-muted-foreground">{durLabel} {isActive ? "· running" : ""}</p>
                      </div>

                      {/* Stat pills */}
                      <div className="flex items-center gap-2 flex-1 flex-wrap">
                        {s.hitsDiscovered != null && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-highlight-soft border border-highlight/20 px-2 py-0.5 text-xs font-medium text-highlight-ink">
                            {s.hitsDiscovered.toLocaleString()} hits
                          </span>
                        )}
                        {s.processed != null && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-highlight-soft border border-highlight/40 px-2 py-0.5 text-xs font-medium text-highlight-ink">
                            {s.processed.toLocaleString()} processed
                          </span>
                        )}
                        {s.authors != null && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-success/15 border border-success/20 px-2 py-0.5 text-xs font-medium text-success">
                            {s.authors.toLocaleString()} authors
                          </span>
                        )}
                        {(s.errors ?? 0) > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-destructive/10 border border-destructive/20 px-2 py-0.5 text-xs font-medium text-destructive">
                            {s.errors} errors
                          </span>
                        )}
                      </div>

                      {/* Status badge */}
                      <span className={`text-xs font-semibold uppercase tracking-wide shrink-0 ${
                        run.status === "completed" ? "text-success" :
                        run.status === "failed"    ? "text-destructive"  :
                        "text-warning"
                      }`}>{run.status}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <ProspectDrawer prospect={selectedProspect} open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      {/* Add Prospect dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add prospect</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Full name</Label>
              <Input placeholder="Jane Smith" value={addForm.full_name} onChange={(e) => setAddForm((f) => ({ ...f, full_name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Email <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input placeholder="jane@example.com" value={addForm.email} onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Article links <span className="text-muted-foreground font-normal">(at least one)</span></Label>
              <div className="space-y-2">
                {addArticles.map((u, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <Input
                      placeholder="https://example.com/their-article"
                      value={u}
                      onChange={(e) => setAddArticles((arr) => arr.map((x, j) => j === i ? e.target.value : x))}
                    />
                    {addArticles.length > 1 && (
                      <Button variant="ghost" size="sm" className="h-10 w-10 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => setAddArticles((arr) => arr.filter((_, j) => j !== i))}>
                        <XCircle className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <Button variant="ghost" size="sm" className="h-10 text-xs gap-1 text-highlight-ink hover:text-highlight-ink"
                onClick={() => setAddArticles((arr) => [...arr, ""])}>
                <UserPlus className="h-3 w-3" />Add another link
              </Button>
              <p className="text-xs text-muted-foreground">Links to pieces they wrote. The publication domain is taken from the first link unless you set one below.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Publication / website <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input placeholder="example.com" value={addForm.publication} onChange={(e) => setAddForm((f) => ({ ...f, publication: e.target.value }))} />
              <p className="text-xs text-muted-foreground">Overrides the domain inferred from the article link.</p>
            </div>
            {campaigns.length > 0 && (
              <div className="space-y-1.5">
                <Label>Campaign</Label>
                <select
                  className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={addForm.campaign_id}
                  onChange={(e) => setAddForm((f) => ({ ...f, campaign_id: e.target.value }))}
                >
                  <option value="">No campaign</option>
                  {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={submitAddProspect} disabled={addSaving || !addForm.full_name.trim() || !addArticles.some((u) => /^https?:\/\//i.test(u.trim()))}>
              {addSaving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Add Prospect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({ onRunDiscovery, isRunning }: { onRunDiscovery: () => void; isRunning: boolean }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-20 text-center">
        <Search className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold mb-2">No prospects yet</h3>
        <p className="text-muted-foreground text-sm mb-6 max-w-md">
          Run discovery to harvest writers who cover generative AI tools from GDELT, Hacker News, Reddit, RSS, WordPress and more.
        </p>
        <Button
          onClick={onRunDiscovery}
          disabled={isRunning}
          className="bg-primary hover:bg-primary text-primary-foreground gap-2"
        >
          {isRunning ? (
            <><RefreshCw className="h-4 w-4 animate-spin" />Discovering…</>
          ) : (
            <><Rocket className="h-4 w-4" />Run your first discovery</>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
