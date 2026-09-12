"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Play, Loader2, ShieldCheck, ShieldAlert, ShieldX, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Verdict = "pass" | "block" | "flag";
interface Issue { reason: string; label: string; owner: string; route: string; fix: string; priority: string }
interface UrlGateResult {
  url: string; path: string; template: string; isMoney: boolean; httpStatus: number;
  verdict: Verdict; blockFailures: string[]; flagFailures: string[]; issues: Issue[];
  predicted: { state: string; indexed: boolean; note: string };
  renderMode: string; jsGated: boolean; contentWords: number; uniquenessRatio: number; canonical: string | null; error?: string;
}
interface Report {
  total: number; counts: Record<Verdict, number>; playwrightEnabled: boolean;
  results: UrlGateResult[]; notes: string[]; startedAt: string; finishedAt: string;
}

const VERDICT = {
  block: { label: "Block", icon: ShieldX, cls: "text-destructive border-destructive/40", dot: "bg-destructive", help: "Won't index in this state — don't publish / don't add to the sitemap yet." },
  flag: { label: "Flag", icon: ShieldAlert, cls: "text-warning border-warning/40", dot: "bg-warning", help: "Indexable but weak — safe to publish, but worth fixing." },
  pass: { label: "Pass", icon: ShieldCheck, cls: "text-success border-success/40", dot: "bg-primary", help: "Clears the gate — safe to publish." },
} as const;

export function SitemapQaPanel() {
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [maxPerRun, setMaxPerRun] = useState(100);

  async function run() {
    const urls = text.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
    if (urls.length === 0) { toast.error("Paste at least one URL."); return; }
    setRunning(true); setReport(null);
    try {
      const d = await fetch("/api/sitemap-qa", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls }),
      }).then((r) => r.json());
      if (d?.ok) {
        setReport(d.report); setMaxPerRun(d.maxPerRun ?? 100);
        const c = d.report.counts;
        toast.success(`${d.report.total} checked · ${c.pass} pass · ${c.flag} flag · ${c.block} block`);
      } else toast.error(d?.error ?? "Check failed.");
    } catch (e: any) { toast.error(e?.message ?? "Check failed."); }
    finally { setRunning(false); }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-highlight-ink" />
          <div className="text-sm font-medium">Pre-publish check</div>
        </div>
        <p className="text-xs text-muted-foreground">
          Paste candidate URLs (one per line) — new or draft pages you&apos;re about to publish. Each is run through the
          same indexability gate as the live audit, so you catch a page that <em>won&apos;t index</em> (noindex, thin,
          js-gated, soft-404, bad canonical) before it ships. Nothing is written; up to {maxPerRun} URLs per run.
        </p>
        <Textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={5}
          placeholder={"https://northwind.example/ai-image-generator\nhttps://northwind.example/tools/new-feature"}
          className="font-mono text-xs"
        />
        <Button onClick={run} disabled={running}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {running ? "Checking…" : "Check URLs"}
        </Button>
      </div>

      {report && (
        <div className="space-y-4">
          {report.notes.map((n, i) => <div key={i} className="text-xs text-warning">{n}</div>)}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Checked" value={report.total} />
            <Tile label="Pass" value={report.counts.pass} tone={report.counts.pass ? "text-success" : undefined} />
            <Tile label="Flag" value={report.counts.flag} tone={report.counts.flag ? "text-warning" : undefined} />
            <Tile label="Block" value={report.counts.block} tone={report.counts.block ? "text-destructive" : undefined} />
          </div>

          <div className="rounded-lg border border-border divide-y divide-border">
            {report.results.map((r) => {
              const V = VERDICT[r.verdict];
              return (
                <div key={r.url} className="p-3 space-y-2">
                  <div className="flex items-start gap-2 flex-wrap">
                    <Badge variant="outline" className={cn("text-xs gap-1", V.cls)} title={V.help}>
                      <V.icon className="h-3 w-3" />{V.label}
                    </Badge>
                    {r.isMoney && <Badge variant="outline" className="text-xs text-highlight-ink border-highlight/40">money page</Badge>}
                    <a href={r.url} target="_blank" rel="noreferrer" className="text-sm hover:text-highlight-ink hover:underline break-all flex-1 min-w-0">{r.path}</a>
                    <span className="text-xs text-muted-foreground shrink-0">HTTP {r.httpStatus || "—"} · {r.contentWords}w · {Math.round(r.uniquenessRatio * 100)}% unique</span>
                  </div>
                  {r.error && <div className="text-xs text-destructive">Couldn&apos;t fetch: {r.error}</div>}
                  {r.issues.length > 0 && (
                    <ul className="space-y-1 pl-1">
                      {r.issues.map((iss) => (
                        <li key={iss.reason} className="text-xs text-muted-foreground flex items-start gap-1.5">
                          <span className={cn("mt-1 h-1.5 w-1.5 rounded-full shrink-0", r.blockFailures.includes(iss.reason) ? "bg-destructive" : "bg-warning")} />
                          <span><span className="text-foreground">{iss.label}</span> — {iss.fix}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Predicted in Google: <span className={cn(r.predicted.indexed ? "text-success" : "text-warning")}>{r.predicted.state}</span>
                    {r.jsGated && <span className="ml-2 text-destructive">· content only after JS</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className={cn("text-2xl font-semibold", tone)}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
