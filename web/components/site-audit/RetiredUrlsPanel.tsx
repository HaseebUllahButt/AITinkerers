"use client";

// Retired URLs — every place the site still points at something we have decommissioned.
//
// Grouped by target URL, not listed flat. One footer CTA to /dashboard appears on every page on the
// site; a flat list renders that as ~1,500 problems when it is one template edit. The grouping,
// the zone, and the site-wide flag are the difference between a crawl dump and a work list.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, Download, AlertCircle, ExternalLink, ChevronRight, Square } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { FixRetiredGroup } from "./FixRetiredGroup";

interface Group {
  link_url: string;
  matched: string;
  kind: "anchor" | "raw";
  pages: number;
  zones: string[];
  site_wide: boolean;
  sample_anchor: string | null;
  sample_pages: string[];
  all_pages: string[];
}

interface Status {
  ok: boolean;
  running: boolean;
  progress: { index: number; pagesTotal: number; matches: number; log: string[] } | null;
  run: { id: string; status: string; pages_total: number; pages_checked: number; started_at: string; finished_at: string | null } | null;
  groups: Group[];
  total_references: number;
  total_pages_affected: number;
  error?: string;
}

const ZONE_LABEL: Record<string, string> = {
  nav: "nav", header: "header", footer: "footer", aside: "sidebar", main: "page content",
};

export function RetiredUrlsPanel() {
  const [s, setS] = useState<Status | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [detail, setDetail] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/url-sweep/status");
      const r = (await res.json().catch(() => null)) as Status | null;
      if (r?.ok) { setS(r); setPhase("ready"); }
      else { setPhase("error"); setDetail(r?.error ?? `the server did not answer (HTTP ${res.status})`); }
    } catch (e) {
      setPhase("error");
      setDetail(e instanceof Error ? e.message : "network error");
    }
  }, []);

  // `load` is async: its setState calls land after an await, so this is not the synchronous
  // cascading-render shape the rule targets — it cannot see through the promise. Same suppression,
  // same reason, as the Summer rail and the research board.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  // Poll only while a sweep is in flight. A finished report is static, and polling it forever would
  // put a request every four seconds behind a tab nobody is looking at.
  useEffect(() => {
    if (!s?.running) return;
    const t = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(t);
  }, [s?.running, load]);

  const run = useCallback(async () => {
    setStarting(true);
    try {
      const res = await fetch("/api/url-sweep/run", { method: "POST" });
      const r = await res.json().catch(() => null);
      if (r?.started) toast.success(`Sweep started — ${r.pagesTotal} pages queued.`);
      else if (r?.alreadyRunning) toast.info("A sweep is already running.");
      else toast.error(r?.error ?? "Could not start the sweep.");
      await load();
    } finally { setStarting(false); }
  }, [load]);

  const stop = useCallback(async () => {
    await fetch("/api/url-sweep/run", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stop: true }),
    });
    toast.info("Stopping after the current batch.");
  }, []);

  const running = !!s?.running;
  const pct = s?.progress ? Math.round((s.progress.index / Math.max(s.progress.pagesTotal, 1)) * 100) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground max-w-2xl">
          Every place the site still references a retired URL — old dashboard paths and decommissioned
          subdomains. These mostly still return <b className="text-foreground">200</b> or redirect, so the
          broken-link crawl never reports them; this sweep looks for them by name instead.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          {running && (
            <Button variant="outline" size="sm" onClick={stop} className="gap-1.5">
              <Square className="h-3.5 w-3.5" /> Stop
            </Button>
          )}
          <a
            href="/api/url-sweep/export"
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm transition-colors hover:bg-accent",
              !s?.run && "pointer-events-none opacity-40",
            )}
          >
            <Download className="h-3.5 w-3.5" /> CSV
          </a>
          <Button size="sm" onClick={run} disabled={starting || running} className="gap-1.5">
            {starting || running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {running ? "Sweeping…" : "Run sweep"}
          </Button>
        </div>
      </div>

      {phase === "error" && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <p className="flex items-start gap-1.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Couldn&apos;t read the sweep — this is <b>not</b> an empty result ({detail}).</span>
          </p>
        </div>
      )}

      {running && s?.progress && (
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-sm">
            Crawling — <b>{s.progress.index}</b> of {s.progress.pagesTotal} pages ({pct}%), {s.progress.matches} reference(s) found.
          </p>
          {/* Said plainly rather than implied by a spinner: a half-finished crawl has a real list,
              and someone acting on it as if it were complete is the failure mode worth preventing. */}
          <p className="mt-1 text-xs text-muted-foreground">The list below is partial until this finishes.</p>
        </div>
      )}

      {phase === "ready" && !s?.run && (
        <p className="text-sm text-muted-foreground">No sweep has been run yet. Hit <b>Run sweep</b>.</p>
      )}

      {s?.run && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
            <span><b className="text-lg">{s.groups.length}</b> retired URL{s.groups.length === 1 ? "" : "s"} referenced</span>
            {/* "references" counts every occurrence, and one shared config payload can hold dozens
                on a single page — so the honest headline is the group count, not this. Said out
                loud rather than quietly inflating a scary number. */}
            <span className="text-muted-foreground" title="Counts every occurrence, including repeats inside one payload on a page.">
              {s.total_references} reference(s) across {s.total_pages_affected} page(s)
            </span>
            <span className="text-muted-foreground text-xs">
              {s.run.pages_checked}/{s.run.pages_total} pages · {s.run.status}
              {s.run.finished_at ? ` · ${new Date(s.run.finished_at).toLocaleString()}` : ""}
            </span>
          </div>

          <div className="flex flex-col gap-2">
            {s.groups.map((g) => {
              const key = `${g.kind}|${g.link_url}`;
              const isOpen = open === key;
              return (
                <div key={key} className="rounded-lg border border-border/60">
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : key)}
                    className="flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
                  >
                    <ChevronRight className={cn("mt-1 h-3.5 w-3.5 shrink-0 transition-transform", isOpen && "rotate-90")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium break-all">
                          {g.kind === "raw" ? `${g.matched} (not a link)` : g.link_url}
                        </span>
                        {/* The one flag worth colour: it says "fix the template, not the pages". */}
                        {g.site_wide && <Badge variant="outline" className="border-highlight/40 text-highlight text-xs">site-wide</Badge>}
                        {g.kind === "raw" && (
                          <Badge variant="outline" className="border-warning/40 text-warning text-xs" title="Found in the HTML but not as an <a href> — a button handler, data attribute or serialised payload. Needs a human look.">
                            non-anchor
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <b className="text-foreground">{g.pages}</b> page{g.pages === 1 ? "" : "s"}
                        {g.zones.length > 0 && ` · in ${g.zones.map((z) => ZONE_LABEL[z] ?? z).join(", ")}`}
                        {g.sample_anchor && ` · “${g.sample_anchor.slice(0, 60)}”`}
                        {` · ${g.matched}`}
                      </p>
                    </div>
                  </button>

                  {isOpen && (
                    <div className="border-t border-border/60 px-3 py-2">
                      {/* The fix, above the page list: the list is evidence, this is the action. Only for
                          anchors — a "raw" hit is a URL in a script payload or data attribute, where a
                          blind string replace is as likely to break a handler as fix a link. */}
                      {g.kind === "anchor" && <FixRetiredGroup from={g.matched} siteWide={g.site_wide} />}
                      <p className="mb-1.5 mt-2 text-xs text-muted-foreground">
                        {g.site_wide
                          ? "Appears in a shared template — fix it once there rather than page by page. Pages:"
                          : "Pages that reference it:"}
                      </p>
                      <ul className="space-y-0.5">
                        {g.all_pages.slice(0, 200).map((p) => (
                          <li key={p}>
                            <a href={p} target="_blank" rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground break-all">
                              <ExternalLink className="h-3 w-3 shrink-0" />{p}
                            </a>
                          </li>
                        ))}
                      </ul>
                      {g.all_pages.length > 200 && (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          +{g.all_pages.length - 200} more — the CSV has every row.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {s.groups.length === 0 && s.run.status === "completed" && (
            <p className="text-sm text-muted-foreground">
              Nothing found — no page in the sitemap references any of the retired URLs.
            </p>
          )}
        </>
      )}
    </div>
  );
}
