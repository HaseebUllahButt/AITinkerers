"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Unlink, Play, Loader2, Square, Download, Wrench, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/PageHeader";
import { StatRow, StatTile } from "@/components/ui/stat-tile";

// 404s — every dead link the CMS can see, and the one button that repairs them.
//
// Deliberately separate from Site Audit. That crawls the rendered site and can only tell you a link
// is broken; this reads the CMS, so it knows the exact field every link lives in and can therefore
// fix it. The daily sweep only ever DETECTS — repair edits live pages, so a person presses Fix.

interface Finding {
  pageUrl: string; surface: string; kind: string; field: string;
  text: string; target?: string; verdict: string; why?: string;
}
interface State {
  phase: string; running: boolean; cursor: number; total: number;
  counts: { pagesScanned: number; linksFound: number; ok: number; broken: number; dashboard: number; assets: number; blocked: number };
  log: string[]; error?: string;
  applied?: { pages: number; edits: number; removed: number; failed: number };
}
interface Plan { total: number; byAction: Record<string, number>; unfixable: number }

const PHASE_COPY: Record<string, string> = {
  inventory: "Reading what exists",
  scanning: "Reading every live page",
  checking: "Checking the links nothing else could answer",
  planned: "Ready to fix",
  applying: "Writing fixes",
  done: "Finished",
  error: "Stopped on an error",
};

export default function Link404sPage() {
  const [state, setState] = useState<State | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/link-fix/status", { cache: "no-store" });
      const j = await res.json();
      setState(j.state);
      setPlan(j.plan);
      if (j.state && ["planned", "done"].includes(j.state.phase)) {
        const f = await fetch("/api/link-fix/findings", { cache: "no-store" }).then((r) => r.json());
        setFindings(f.findings ?? []);
      }
    } catch { /* the poll retries; a blip should not blank the page */ }
  }, []);

  const running = Boolean(state?.running);

  // Poll while a run is live; a finished run only needs the occasional refresh. The first fetch is
  // scheduled rather than called inline so the effect never sets state during its own render pass.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      await load();
      if (!alive) return;
      timer.current = setTimeout(tick, running ? 5_000 : 30_000);
    };
    timer.current = setTimeout(tick, 0);
    return () => { alive = false; if (timer.current) clearTimeout(timer.current); };
  }, [load, running]);

  async function post(url: string, okMsg: string) {
    setBusy(true);
    try {
      const res = await fetch(url, { method: "POST" });
      const j = await res.json();
      if (!res.ok) toast.error(j.error ?? "That did not work");
      else toast.success(okMsg);
      await load();
    } finally { setBusy(false); }
  }

  const c = state?.counts;
  const pct = state && state.total > 0 ? Math.round((state.cursor / state.total) * 100) : null;
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return findings;
    return findings.filter((f) => `${f.pageUrl} ${f.target} ${f.text} ${f.why}`.toLowerCase().includes(t));
  }, [findings, q]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <PageHeader
          icon={Unlink}
          title="404s"
          description="Links on live pages that a visitor or crawler cannot follow, scanned from the CMS and repairable in place. Nothing is written until you press Fix."
        />
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {findings.length > 0 && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { window.location.href = "/api/link-fix/findings?format=csv"; }}>
              <Download className="h-3.5 w-3.5" /> CSV
            </Button>
          )}
          {state?.running ? (
            <Button variant="outline" size="sm" onClick={() => post("/api/link-fix/stop", "Stopping after this step")} disabled={busy} className="gap-1.5">
              <Square className="h-3.5 w-3.5" /> Stop
            </Button>
          ) : null}
          {state?.phase === "planned" && plan && plan.total > 0 && (
            <Button onClick={() => post("/api/link-fix/apply", "Applying fixes")} disabled={busy} size="lg" className="gap-1.5">
              <Wrench className="h-4 w-4" /> Fix {plan.total}
            </Button>
          )}
          <Button onClick={() => post("/api/link-fix/run", "Sweep started")} disabled={busy || state?.running} size="lg" className="gap-1.5">
            {state?.running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {state?.running ? "Scanning…" : "Scan now"}
          </Button>
        </div>
      </div>

      {state?.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <span>{state.error}</span>
        </div>
      )}

      {state?.running && (
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="font-medium">{PHASE_COPY[state.phase] ?? state.phase}</span>
            <span className="text-muted-foreground tabular-nums">{pct != null ? `${pct}%` : ""} {state.total ? `(${state.cursor}/${state.total})` : ""}</span>
          </div>
          <div className="h-1.5 rounded bg-border overflow-hidden">
            <div className="h-full bg-highlight-ink transition-all" style={{ width: `${pct ?? 0}%` }} />
          </div>
        </div>
      )}

      <StatRow>
        <StatTile label="Broken links" value={num(c?.broken)} tone={c?.broken ? "destructive" : "default"} />
        <StatTile label="Dashboard CTAs" value={num(c?.dashboard)} tone={c?.dashboard ? "warning" : "default"} />
        <StatTile label="Links checked" value={num(c?.linksFound)} />
        <StatTile label="Pages scanned" value={num(c?.pagesScanned)} />
        <StatTile label="Fixes planned" value={num(plan?.total)} />
      </StatRow>

      {state?.applied && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
          <span>
            Wrote <b className="text-foreground">{state.applied.pages}</b> pages — {state.applied.edits} links
            repointed or unwrapped, {state.applied.removed} dead items removed
            {state.applied.failed ? `, ${state.applied.failed} pages refused by Strapi` : ""}.
          </span>
        </div>
      )}

      <Tabs defaultValue="findings">
        <TabsList>
          <TabsTrigger value="findings" className="gap-1.5">
            Findings{findings.length > 0 && <Badge variant="outline" className="text-xs">{findings.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="plan">What would change</TabsTrigger>
          <TabsTrigger value="log">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="findings" className="mt-4 space-y-3">
          {findings.length === 0 ? (
            <Empty phase={state?.phase} />
          ) : (
            <>
              <Input placeholder="Filter by page, target or anchor text…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-md" />
              <div className="rounded-lg border border-border divide-y divide-border">
                {filtered.slice(0, 400).map((f, i) => (
                  <div key={i} className="p-3 text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={cn("text-xs", f.verdict === "broken" ? "text-destructive border-destructive/30" : "text-warning border-warning/30")}>
                        {f.verdict === "broken" ? "broken" : "dashboard"}
                      </Badge>
                      <a href={f.pageUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-highlight-ink hover:underline break-all">
                        {f.pageUrl.replace(/^https?:\/\/(www\.)?/, "")}
                      </a>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {f.text ? <span className="text-foreground">{f.text}</span> : <em>no label</em>}
                      {" → "}
                      <span className="font-mono text-xs break-all">{f.target?.replace(/^https?:\/\/(www\.)?/, "")}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{f.why} · <span className="font-mono">{f.field}</span></div>
                  </div>
                ))}
              </div>
              {filtered.length > 400 && <p className="text-xs text-muted-foreground">Showing the first 400 of {filtered.length}. The CSV has them all.</p>}
            </>
          )}
        </TabsContent>

        <TabsContent value="plan" className="mt-4">
          {!plan || plan.total === 0 ? (
            <Empty phase={state?.phase} />
          ) : (
            <div className="rounded-lg border border-border p-4 text-sm space-y-2">
              <p className="text-muted-foreground">Pressing Fix would make these changes, and nothing else:</p>
              <ul className="space-y-1">
                {plan.byAction.rewrite ? <li><b className="tabular-nums">{plan.byAction.rewrite}</b> links repointed at a live equivalent or the public studio page</li> : null}
                {plan.byAction.unlink ? <li><b className="tabular-nums">{plan.byAction.unlink}</b> in-body links unwrapped — the sentence keeps its words, the dead link goes</li> : null}
                {plan.byAction.delete ? <li><b className="tabular-nums">{plan.byAction.delete}</b> resource cards and tiles removed, where nothing live is close enough to recommend instead</li> : null}
              </ul>
              {plan.unfixable > 0 && (
                <p className="text-muted-foreground pt-2 border-t border-border">
                  <b className="text-foreground tabular-nums">{plan.unfixable}</b> need a person: the link is broken but it is not a
                  removable list item, so clearing it would leave a required field empty.
                </p>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="log" className="mt-4">
          <div className="rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs space-y-0.5 max-h-96 overflow-auto">
            {(state?.log ?? []).length === 0 ? <span className="text-muted-foreground">Nothing yet.</span> : state!.log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** "—" for a count that has not loaded; a failed read must never render as zero. */
function num(value?: number | null): string {
  return value == null ? "—" : value.toLocaleString();
}

function Empty({ phase }: { phase?: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-6 text-sm text-muted-foreground">
      {phase && !["done", "error", "idle"].includes(phase)
        ? "The sweep is still running — findings appear once every page has been read."
        : "No sweep has finished yet. Press Scan now, or wait for tonight's run."}
    </div>
  );
}
