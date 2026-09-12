"use client";

import { useRef, useState, useEffect } from "react";
import { ScanSearch, Play, Loader2, FileText, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { BrokenLinksPanel, type BrokenLinksHandle, type BrokenLinksSummary } from "@/components/site-audit/BrokenLinksPanel";
import { SitemapQaPanel } from "@/components/site-audit/SitemapQaPanel";
import { RetiredUrlsPanel } from "@/components/site-audit/RetiredUrlsPanel";
import {
  usePageHealth, PageHealthOptions, PastChecks, IndexabilitySection, SpeedSection, PageTypesSection, ShareHealth, Stat,
} from "@/components/site-audit/pageHealth";
import { PageHeader } from "@/components/layout/PageHeader";
import { StatRow, StatTile } from "@/components/ui/stat-tile";

// Site Audit — one place to scan the site and see everything that's wrong, grouped by category.
// Composes the two existing subsystems (Link Audit + Page Health) via their existing APIs; no
// backend changes. "Run audit" fires both; each category fills independently as its data lands.
export default function SiteAuditPage() {
  const ph = usePageHealth();
  const blRef = useRef<BrokenLinksHandle>(null);
  const [bl, setBl] = useState<BrokenLinksSummary>({ running: false, brokenCount: 0, progressPct: null });
  const [showOptions, setShowOptions] = useState(false);

  const busy = ph.running || bl.running;
  function runAudit() {
    ph.run();
    blRef.current?.run();
  }

  // Populate the detail tabs from the most recent saved run on arrival, so Indexability/Speed/
  // Page-types aren't empty while the overview tiles already show last-run numbers. Runs once.
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!autoLoaded.current && !ph.report && !ph.running && ph.history.length > 0) {
      autoLoaded.current = true;
      ph.openHistoryRun(ph.history[0].id);
    }
  }, [ph]);

  // Overview numbers — from the current in-session report if present, else the latest saved run.
  const latest = ph.history[0];
  const v = ph.report?.counts.verdicts;
  const needsAttention = v ? v.flag + v.block : latest?.issues_count ?? null;
  const hiddenFromSearch = ph.report?.counts.jsGated ?? latest?.js_gated_count ?? null;
  const pagesChecked = ph.report?.analyzed ?? latest?.analyzed ?? null;
  const slowTemplates = ph.report ? ph.report.cwv.filter((c) => c.hasField && (c.evaluation.lcp.rating === "poor" || c.evaluation.inp.rating === "poor" || c.evaluation.cls.rating === "poor")).length : null;
  const show = (n: number | null) => (n == null ? "—" : n);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <PageHeader
          icon={ScanSearch}
          title="Site Audit"
          description="Broken links, pages search can't see, and slow pages in one scan. Nothing changes on the site; you choose what to send to the team."
        />
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Button variant="outline" size="sm" onClick={() => setShowOptions((s) => !s)}>Options</Button>
          <Button variant="outline" size="sm" onClick={() => ph.run()} disabled={ph.running} className="gap-1.5" title="Page health only (Indexability, Speed, Page types) — quick, no site-wide link crawl">
            {ph.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />} Pages only
          </Button>
          <Button variant="outline" size="sm" onClick={() => blRef.current?.run()} disabled={bl.running} className="gap-1.5" title="Broken-link crawl only (background, ~1,500 pages)">
            {bl.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />} Links only
          </Button>
          <Button onClick={runAudit} disabled={busy} size="lg" className="gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {busy ? "Auditing…" : "Run audit"}
          </Button>
        </div>
      </div>

      {showOptions && <PageHealthOptions ph={ph} />}

      {/* Overview strip */}
      <StatRow>
        <StatTile label="Broken links" value={bl.progressPct != null ? `crawling ${bl.progressPct}%` : show(bl.brokenCount)} tone={bl.brokenCount ? "destructive" : "default"} />
        <StatTile label="Need attention" value={show(needsAttention)} tone={needsAttention ? "warning" : "default"} />
        <StatTile label="Hidden from search" value={show(hiddenFromSearch)} tone={hiddenFromSearch ? "destructive" : "default"} />
        <StatTile label="Pages checked" value={show(pagesChecked)} />
      </StatRow>

      {/* Category tabs */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="broken" className="gap-1.5">
            Broken links{bl.brokenCount > 0 && <span className="text-xs font-tabular text-destructive">{bl.brokenCount}</span>}
          </TabsTrigger>
          <TabsTrigger value="index" className="gap-1.5">
            Indexability{ph.report && ph.report.routing.length > 0 && <span className="text-xs font-tabular text-warning">{ph.report.routing.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="speed">Speed{slowTemplates ? <span className="text-xs font-tabular text-destructive">{slowTemplates}</span> : null}</TabsTrigger>
          {/* Deliberately NOT wired into "Run audit". A retired URL is a question you ask when
              something has just been decommissioned, not every night — and the sweep is cheap
              enough to run on demand that scheduling it would only add noise. */}
          <TabsTrigger value="retired">Retired URLs</TabsTrigger>
          <TabsTrigger value="types">Page types</TabsTrigger>
          <TabsTrigger value="prepublish">Pre-publish</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            Hit <b className="text-foreground">Run audit</b> to scan the whole site. Broken-link crawling runs in the
            background (watch the <b className="text-foreground">Broken links</b> tab); page checks fill in
            Indexability, Speed, and Page types. Results below are your most recent audit.
          </div>
          <PastChecks ph={ph} />
          <ShareHealth ph={ph} />
        </TabsContent>

        <TabsContent value="broken" className="mt-4">
          <BrokenLinksPanel ref={blRef} onSummary={setBl} />
        </TabsContent>

        <TabsContent value="index" className="mt-4">
          <IndexabilitySection ph={ph} />
        </TabsContent>

        <TabsContent value="speed" className="mt-4">
          <SpeedSection ph={ph} />
        </TabsContent>

        <TabsContent value="retired" className="mt-4">
          <RetiredUrlsPanel />
        </TabsContent>

        <TabsContent value="types" className="mt-4">
          <PageTypesSection ph={ph} />
        </TabsContent>

        <TabsContent value="prepublish" className="mt-4">
          <SitemapQaPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
