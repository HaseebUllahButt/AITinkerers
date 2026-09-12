"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RunAuditControls } from "./RunAuditControls";

type Severity = "critical" | "warn" | "info";
interface Issue { code: string; severity: Severity; detail: string }
interface HiddenItem { text: string; selector: string; reasons: string[] }
interface Vitals {
  lcpMs: number | null; cls: number | null;
  ttfbMs: number | null; domContentLoadedMs: number | null; loadMs: number | null;
}
interface ResourceItem { url: string; type: string; bytes: number }
interface ResourceSummary {
  totalBytes: number;
  byType: Record<string, { count: number; bytes: number }>;
  top: ResourceItem[];
  requestCount: number;
  unsizedCount: number;
}
interface Finding {
  url: string; path: string; section: string;
  httpStatus: number | null; cloaked: boolean;
  agents: Array<{ agent: string; status: number; words: number }>;
  rawWords: number; renderedWords: number | null; wordRatio: number | null; wordDelta: number | null;
  bytesPerWord: number | null;
  hiddenCritical: HiddenItem[]; hiddenWarn: HiddenItem[];
  missingHeadings: string[]; missingBlocks: string[];
  vitals: Vitals | null; resources: ResourceSummary | null;
  issues: Issue[]; worst: Severity | null;
}
export interface Report {
  generatedAt: string; base: string;
  droppedFromSitemap: string[] | null;
  sharedHidden: Array<{ text: string; pages: number }>;
  findings: Finding[];
}

// Fixed locale + timeZone, not the environment's default: `toLocaleString()` with no arguments
// renders differently on the server (Node's default locale) than in the browser (the visitor's
// locale), and React throws a hydration-mismatch error the moment the two don't agree on one string.
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
}

const AGENT_LABEL: Record<string, string> = {
  browser: "Browser", googlebot: "Googlebot", gptbot: "GPTBot", bare: "Bare client",
};
// Which section of the card each issue code's detail belongs under — everything else falls
// through to "Other technical notes", the low-priority catch-all.
const CLOAK_CODES = new Set(["cloaking_status", "cloaking_noindex", "cloaking_content", "ua_variance_bare_client"]);
const JS_GATE_CODES = new Set(["js_gated_tags", "js_gated_content", "no_content_pre_js"]);
const PERF_CODES = new Set(["heavy_page", "poor_lcp", "poor_cls"]);

// Google's published Core Web Vitals thresholds — same numbers the script uses to grade LCP/CLS.
function vitalColor(value: number | null, warn: number, critical: number): string {
  if (value === null) return "text-muted-foreground";
  if (value >= critical) return "text-destructive";
  if (value >= warn) return "text-yellow-600 dark:text-yellow-500";
  return "text-emerald-600 dark:text-emerald-400";
}

function SeverityDot({ worst }: { worst: Severity | null }) {
  const color = worst === "critical" ? "bg-destructive" : worst === "warn" ? "bg-yellow-500" : worst === "info" ? "bg-muted-foreground/40" : "bg-emerald-500";
  return <span className={`size-2 shrink-0 rounded-full ${color}`} />;
}

function FindingCard({ f: raw }: { f: Finding }) {
  // Defensive: a report.json written before a field existed (an older run's output, still on
  // disk) has it simply absent, not an empty array — this normalizes every array field once
  // rather than scattering `?? []` at each use and risking one getting missed.
  const f = {
    ...raw,
    issues: raw.issues ?? [],
    agents: raw.agents ?? [],
    missingHeadings: raw.missingHeadings ?? [],
    missingBlocks: raw.missingBlocks ?? [],
    hiddenCritical: raw.hiddenCritical ?? [],
    hiddenWarn: raw.hiddenWarn ?? [],
  };
  const cloakIssues = f.issues.filter((i) => CLOAK_CODES.has(i.code));
  const jsGateIssues = f.issues.filter((i) => JS_GATE_CODES.has(i.code));
  const perfIssues = f.issues.filter((i) => PERF_CODES.has(i.code));
  const otherIssues = f.issues.filter((i) => !CLOAK_CODES.has(i.code) && !JS_GATE_CODES.has(i.code) && !PERF_CODES.has(i.code) && i.code !== "hidden_text");
  const hasJsGateDetail = jsGateIssues.length > 0 || f.missingHeadings.length > 0 || f.missingBlocks.length > 0;
  const hasHiddenDetail = f.hiddenCritical.length > 0 || f.hiddenWarn.length > 0;
  const clean = !f.worst;

  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <SeverityDot worst={f.worst} />
            <CardTitle className="truncate">
              <a href={f.url} target="_blank" rel="noreferrer" className="hover:underline">{f.path}</a>
            </CardTitle>
          </div>
          <Badge variant={f.cloaked ? "destructive" : "secondary"} className="shrink-0">
            Cloaking: {f.cloaked ? "YES" : "No"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs text-muted-foreground">
          raw {f.rawWords}w
          {f.renderedWords !== null && <> · rendered {f.renderedWords}w · {f.wordRatio?.toFixed(2)}x</>}
          {f.httpStatus !== null && <> · HTTP {f.httpStatus}</>}
        </div>

        {f.agents.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground/80">
            {f.agents.map((a) => (
              <span key={a.agent}>{AGENT_LABEL[a.agent] ?? a.agent}: {a.status ? `${a.status}, ${a.words}w` : "failed"}</span>
            ))}
          </div>
        )}

        {(f.vitals || f.resources) && (
          <div className="space-y-1.5 border-t pt-2">
            <p className="text-xs font-medium text-muted-foreground">Performance</p>
            {f.vitals && (
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
                <span className={vitalColor(f.vitals.lcpMs, 2500, 4000)}>
                  LCP {f.vitals.lcpMs !== null ? `${(f.vitals.lcpMs / 1000).toFixed(1)}s` : "—"}
                </span>
                <span className={vitalColor(f.vitals.cls, 0.1, 0.25)}>
                  CLS {f.vitals.cls ?? "—"}
                </span>
                {f.vitals.ttfbMs !== null && <span className="text-muted-foreground">TTFB {f.vitals.ttfbMs}ms</span>}
              </div>
            )}
            {f.resources && (
              <>
                <p className="text-sm">
                  {(f.resources.totalBytes / 1_048_576).toFixed(1)} MB across {f.resources.requestCount} requests
                  {f.resources.unsizedCount > 0 && <span className="text-muted-foreground"> ({f.resources.unsizedCount} unsized)</span>}
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  {Object.entries(f.resources.byType).sort((a, b) => b[1].bytes - a[1].bytes).map(([type, v]) => (
                    <span key={type}>{type}: {(v.bytes / 1_048_576).toFixed(1)} MB ({v.count})</span>
                  ))}
                </div>
                {f.resources.top.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground">biggest files on this page</summary>
                    <ul className="mt-1.5 space-y-1">
                      {f.resources.top.slice(0, 8).map((r, idx) => (
                        <li key={idx} className="flex items-baseline gap-2 text-sm">
                          <span className="shrink-0 tabular-nums text-muted-foreground">{(r.bytes / 1_048_576).toFixed(2)} MB</span>
                          <span className="truncate text-muted-foreground/80">{r.url.split("/").pop()}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
            {perfIssues.map((i, idx) => <p key={idx} className="text-sm text-muted-foreground">{i.detail}</p>)}
          </div>
        )}

        {cloakIssues.length > 0 && (
          <div className="space-y-1 rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            {cloakIssues.map((i, idx) => <p key={idx}>{i.detail}</p>)}
          </div>
        )}

        {hasJsGateDetail && (
          <div className="space-y-1.5 border-t pt-2">
            <p className="text-xs font-medium text-muted-foreground">Missing until JS runs</p>
            {jsGateIssues.map((i, idx) => <p key={idx} className="text-sm text-muted-foreground">{i.detail}</p>)}
            {f.missingHeadings.slice(0, 5).map((h, idx) => (
              <p key={`h-${idx}`} className="truncate text-sm"><span className="text-muted-foreground">heading: </span>&ldquo;{h}&rdquo;</p>
            ))}
            {f.missingBlocks.slice(0, 5).map((b, idx) => (
              <p key={`b-${idx}`} className="text-sm text-muted-foreground">&ldquo;{b.slice(0, 140)}{b.length > 140 ? "…" : ""}&rdquo;</p>
            ))}
          </div>
        )}

        {hasHiddenDetail && (
          <div className="space-y-1.5 border-t pt-2">
            <p className="text-xs font-medium text-muted-foreground">Invisible to a person, present for a crawler</p>
            {[...f.hiddenCritical, ...f.hiddenWarn].slice(0, 5).map((h, idx) => (
              <p key={idx} className="text-sm text-muted-foreground">&ldquo;{h.text}&rdquo; — {h.reasons.join(", ")}</p>
            ))}
          </div>
        )}

        {otherIssues.length > 0 && (
          <details className="border-t pt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">other technical notes ({otherIssues.length})</summary>
            <ul className="mt-1.5 space-y-1">
              {otherIssues.map((i, idx) => (
                <li key={idx} className="flex gap-2 text-sm">
                  <Badge variant={i.severity === "critical" ? "destructive" : i.severity === "warn" ? "outline" : "secondary"} className="mt-0.5 shrink-0">{i.code}</Badge>
                  <span className="text-muted-foreground">{i.detail}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {clean && !cloakIssues.length && !hasJsGateDetail && !hasHiddenDetail && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Nothing found — clean.</p>
        )}
      </CardContent>
    </Card>
  );
}

type SectionFilter = "all" | "features" | "blogs";
type SeverityFilter = "all" | "critical" | "warn" | "clean";

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button size="sm" variant={active ? "default" : "outline"} onClick={onClick}>{children}</Button>
  );
}

export function AuditReport({ report, runId }: { report: Report; runId: string }) {
  const [section, setSection] = useState<SectionFilter>("all");
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [cloakedOnly, setCloakedOnly] = useState(false);

  const counts = useMemo(() => ({
    critical: report.findings.filter((f) => f.worst === "critical").length,
    warn: report.findings.filter((f) => f.worst === "warn").length,
    cloaked: report.findings.filter((f) => f.cloaked).length,
    features: report.findings.filter((f) => f.section === "features").length,
    blogs: report.findings.filter((f) => f.section === "blogs").length,
  }), [report.findings]);

  const heaviestPages = useMemo(() =>
    [...report.findings]
      .filter((f) => f.resources)
      .sort((a, b) => (b.resources!.totalBytes) - (a.resources!.totalBytes))
      .slice(0, 5),
    [report.findings]);

  const filtered = useMemo(() => report.findings.filter((f) => {
    if (section !== "all" && f.section !== section) return false;
    if (severity === "critical" && f.worst !== "critical") return false;
    if (severity === "warn" && f.worst !== "warn") return false;
    if (severity === "clean" && f.worst) return false;
    if (cloakedOnly && !f.cloaked) return false;
    return true;
  }), [report.findings, section, severity, cloakedOnly]);

  return (
    <div className="space-y-6 pb-12">
      <div className="space-y-3">
        <h1 className="text-xl font-heading font-medium">JS-Render Audit</h1>
        <p className="text-sm text-muted-foreground">
          {report.base} · run {runId} · generated {formatDate(report.generatedAt)} UTC
        </p>
        <RunAuditControls />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card size="sm"><CardHeader><CardTitle>Pages audited</CardTitle></CardHeader><CardContent className="text-2xl font-heading">{report.findings.length}</CardContent></Card>
        <Card size="sm"><CardHeader><CardTitle>Critical</CardTitle></CardHeader><CardContent className="text-2xl font-heading text-destructive">{counts.critical}</CardContent></Card>
        <Card size="sm"><CardHeader><CardTitle>Warn</CardTitle></CardHeader><CardContent className="text-2xl font-heading">{counts.warn}</CardContent></Card>
        <Card size="sm"><CardHeader><CardTitle>Cloaked</CardTitle></CardHeader><CardContent className="text-2xl font-heading">{counts.cloaked}</CardContent></Card>
      </div>

      {heaviestPages.length > 0 && (
        <Card size="sm">
          <CardHeader><CardTitle>Heaviest pages</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm">
              {heaviestPages.map((f) => (
                <li key={f.url} className="flex items-baseline gap-2">
                  <span className="shrink-0 tabular-nums font-medium">{(f.resources!.totalBytes / 1_048_576).toFixed(1)} MB</span>
                  <a href={f.url} target="_blank" rel="noreferrer" className="truncate text-muted-foreground hover:underline hover:text-foreground">{f.path}</a>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {report.sharedHidden.length > 0 && (
        <Card size="sm" className="border-yellow-500/40">
          <CardHeader><CardTitle>Shared hidden-text element(s) — one fix, not one per page</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {report.sharedHidden.map((s, i) => (
                <li key={i} className="text-muted-foreground">&ldquo;{s.text}&rdquo; — on {s.pages} pages</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {report.droppedFromSitemap !== null && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>
              {report.droppedFromSitemap.length > 0
                ? `${report.droppedFromSitemap.length} known URL(s) have fallen out of the live sitemap`
                : "Nothing has fallen out of the live sitemap"}
            </CardTitle>
          </CardHeader>
          {report.droppedFromSitemap.length > 0 && (
            <CardContent>
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">show URLs</summary>
                <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                  {report.droppedFromSitemap.map((u, i) => <li key={i}>{u}</li>)}
                </ul>
              </details>
            </CardContent>
          )}
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-wrap gap-1.5">
          <FilterButton active={section === "all"} onClick={() => setSection("all")}>All ({report.findings.length})</FilterButton>
          <FilterButton active={section === "features"} onClick={() => setSection("features")}>Features ({counts.features})</FilterButton>
          <FilterButton active={section === "blogs"} onClick={() => setSection("blogs")}>Blogs ({counts.blogs})</FilterButton>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <FilterButton active={severity === "all"} onClick={() => setSeverity("all")}>Any severity</FilterButton>
          <FilterButton active={severity === "critical"} onClick={() => setSeverity("critical")}>Critical</FilterButton>
          <FilterButton active={severity === "warn"} onClick={() => setSeverity("warn")}>Warn</FilterButton>
          <FilterButton active={severity === "clean"} onClick={() => setSeverity("clean")}>Clean</FilterButton>
        </div>
        <Button size="sm" variant={cloakedOnly ? "default" : "outline"} onClick={() => setCloakedOnly((v) => !v)}>
          Cloaked only
        </Button>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pages match these filters.</p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((f) => <FindingCard key={f.url} f={f} />)}
        </div>
      )}
    </div>
  );
}
