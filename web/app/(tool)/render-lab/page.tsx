"use client";

import { useEffect, useState } from "react";
import {
  Bot, Loader2, Search, RefreshCw, ExternalLink, AlertTriangle, Unlink, PlayCircle, Clock,
  Download, X, Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { toCsv, downloadCsv, stamped, type CsvColumn } from "@/lib/renderlab/csv";
import { FixLinks } from "./FixLinks";
import { PageHeader } from "@/components/layout/PageHeader";

// Render Lab — what a crawler that runs no JavaScript actually sees, plus on-demand broken-link hunting.
//
// DELIBERATELY NOT IN THE SIDEBAR. Same convention /indexing and /link-audit used before they folded
// into Site Audit: a page under src/app that Sidebar.tsx does not list is reachable by URL and
// invisible otherwise. That is what keeps this additive — no existing Summit surface changes.
//
// ── Layout note ────────────────────────────────────────────────────────────────────────────────
//
// The findings are a list of CARDS, not a table, and that is a deliberate second attempt. The first
// version was a seven-column table and every column was a compromise: paths truncated at 380px, the
// Google verdict clipped at 190px, and the issue codes reduced to three badges plus "+2". A finding
// here is one page with a handful of sentences about it, which is a shape a table fights. Giving each
// one a row of its own with the numbers as labelled chips means nothing is truncated and the thing you
// actually read — what is wrong with this page — is prose at a readable size.

type Severity = "critical" | "warn" | "info";

interface Issue { code: string; severity: Severity; detail: string }

interface Finding {
  url: string; path: string; section: string; checked_at: string; rendered_at: string | null;
  http_status: number | null; cloaked: boolean;
  raw_words: number | null; raw_bytes: number | null; rendered_words: number | null;
  word_ratio: number | null; word_delta: number | null; bytes_per_word: number | null;
  existing_mode: string | null; js_gated_tags: string[] | null; js_gated_links: number | null;
  gsc: { coverageState?: string } | null;
  impressions: number | null; clicks: number | null; position: number | null;
  issues: Issue[]; worst: Severity | null; priority: number;
}

interface Summary {
  swept: number; criticals: number; warns: number; cloaked: number;
  blogs: number; features: number; notIndexed: number;
  lastCheckedAt: string | null; oldestCheckedAt: string | null;
  lastRenderedAt: string | null; renderedRows: number;
  codes: Array<{ code: string; count: number; severity: Severity; impressions: number }>;
  rows: Finding[];
}

interface DeadGroup {
  pattern: string; urls: number; impressions: number; clicks: number; linked: number; verdicts: string[];
}
interface DeadRow {
  url: string; path: string; pattern: string; http_status: number | null; verdict: string;
  redirect_to: string | null; clicks: number; impressions: number; position: number | null;
  sources: string[]; suggestion: string | null; checked_at: string | null;
  linked_from: Array<{ page: string; anchor: string; where: string | null }>;
}
interface DeadResponse {
  urls: number; patterns: number; impressions: number; clicks: number; linkedCount: number;
  lastCheckedAt: string | null; groups: DeadGroup[]; pattern: string | null; rows: DeadRow[];
}

interface BrokenLink {
  url: string; anchor: string; verdict: string; status: number | null;
  where: string | null;
  suggestions: Array<{ url: string; path: string; score: number }>;
}
interface HunterPage { url: string; finalUrl?: string; error: string | null; checked: number; links: BrokenLink[] }

// What a findings export can contain. Order here is the column order in the file; `on: false` means
// available but unticked, which is how the noisier columns stay out of a default export without being
// unavailable to somebody who wants them.
const FINDING_COLUMNS: Array<CsvColumn<Finding>> = [
  { key: "path", label: "Path", get: (r) => r.path },
  { key: "url", label: "URL", get: (r) => r.url, on: false },
  { key: "section", label: "Section", get: (r) => r.section },
  { key: "worst", label: "Severity", get: (r) => r.worst ?? "" },
  { key: "impressions", label: "Impressions", get: (r) => r.impressions ?? "" },
  { key: "clicks", label: "Clicks", get: (r) => r.clicks ?? "", on: false },
  { key: "position", label: "Avg position", get: (r) => r.position ?? "", on: false },
  { key: "coverage", label: "Google coverage", get: (r) => r.gsc?.coverageState ?? "" },
  { key: "raw_words", label: "Words without JS", get: (r) => r.raw_words ?? "" },
  { key: "rendered_words", label: "Words with JS", get: (r) => r.rendered_words ?? "" },
  { key: "word_delta", label: "Words hidden pre-JS", get: (r) => r.word_delta ?? "" },
  { key: "word_ratio", label: "Ratio", get: (r) => (r.word_ratio ? r.word_ratio.toFixed(3) : ""),
    hint: "rendered ÷ raw" },
  { key: "issue_codes", label: "Issue codes", get: (r) => r.issues.map((i) => i.code).join("; ") },
  { key: "issue_details", label: "Issue detail", on: false,
    hint: "the full sentences — long cells",
    get: (r) => r.issues.map((i) => `[${i.severity}] ${i.code}: ${i.detail}`).join(" | ") },
  { key: "js_gated_tags", label: "Tags only after JS", get: (r) => (r.js_gated_tags ?? []).join("; "), on: false },
  { key: "js_gated_links", label: "Links only after JS", get: (r) => r.js_gated_links ?? "", on: false },
  { key: "http_status", label: "HTTP status", get: (r) => r.http_status ?? "", on: false },
  { key: "raw_bytes", label: "HTML bytes", get: (r) => r.raw_bytes ?? "", on: false },
  { key: "bytes_per_word", label: "Bytes per word", get: (r) => r.bytes_per_word ?? "", on: false },
  { key: "existing_mode", label: "Existing classifier", get: (r) => r.existing_mode ?? "", on: false },
  { key: "cloaked", label: "Cloaked", get: (r) => (r.cloaked ? "yes" : "no"), on: false },
  { key: "checked_at", label: "Checked at", get: (r) => r.checked_at ?? "", on: false },
  { key: "rendered_at", label: "Render diff at", get: (r) => r.rendered_at ?? "", on: false },
];

const DEAD_COLUMNS: Array<CsvColumn<DeadRow>> = [
  { key: "path", label: "Path", get: (r) => r.path },
  { key: "url", label: "URL", get: (r) => r.url, on: false },
  { key: "verdict", label: "Verdict", get: (r) => r.verdict },
  { key: "http_status", label: "HTTP status", get: (r) => r.http_status ?? "" },
  { key: "impressions", label: "Impressions", get: (r) => r.impressions },
  { key: "clicks", label: "Clicks", get: (r) => r.clicks },
  { key: "position", label: "Avg position", get: (r) => (r.position ? r.position.toFixed(1) : "") },
  { key: "pattern", label: "Path pattern", get: (r) => r.pattern, on: false },
  { key: "suggestion", label: "Closest live page", get: (r) => r.suggestion ?? "" },
  { key: "redirect_to", label: "Redirects to", get: (r) => r.redirect_to ?? "", on: false },
  { key: "sources", label: "Known from", get: (r) => (r.sources ?? []).join("; "), on: false,
    hint: "gsc, sitemap, or both" },
  { key: "linked_count", label: "Inbound links", get: (r) => r.linked_from?.length ?? 0 },
  { key: "linked_from", label: "Linked from", on: false,
    hint: "page, anchor and section for each",
    get: (r) => (r.linked_from ?? []).map((l) => `${l.page}${l.anchor ? ` ("${l.anchor}")` : ""}${l.where ? ` — ${l.where}` : ""}`).join(" | ") },
  { key: "checked_at", label: "Checked at", get: (r) => r.checked_at ?? "", on: false },
];

const SEV: Record<Severity, string> = {
  critical: "bg-destructive/10 text-destructive border-destructive/20",
  warn: "bg-warning/10 text-warning border-warning/20 dark:text-warning",
  info: "bg-muted text-muted-foreground border-border",
};

function num(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}
function ago(iso: string | null): string {
  if (!iso) return "never";
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function RenderLabPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Bot}
        title="Render Lab"
        description="What a no-JavaScript crawler sees on /blogs and /features, and which live links point at nothing. Read-only until Fix Links is turned on."
      />

      <Tabs defaultValue="render">
        <TabsList>
          <TabsTrigger value="render"><AlertTriangle className="mr-2 size-4" />Render diff</TabsTrigger>
          <TabsTrigger value="hunter"><Unlink className="mr-2 size-4" />404 Hunter</TabsTrigger>
          <TabsTrigger value="fix"><Wrench className="mr-2 size-4" />Fix links</TabsTrigger>
        </TabsList>
        <TabsContent value="render" className="mt-6"><RenderDiff /></TabsContent>
        <TabsContent value="hunter" className="mt-6"><Hunter /></TabsContent>
        <TabsContent value="fix" className="mt-6"><FixLinks /></TabsContent>
      </Tabs>
    </div>
  );
}

// ── Tab 1 ─────────────────────────────────────────────────────────────────────────────────────────

function RenderDiff() {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [section, setSection] = useState<"" | "blogs" | "features">("");
  const [worst, setWorst] = useState<"" | Severity>("");
  const [code, setCode] = useState("");
  const [nonce, setNonce] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  // Keyed by url rather than index: the row list is re-fetched on every filter change, and an
  // index-based selection would silently point at different pages afterwards.
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // The fetch lives IN the effect rather than in a callback the effect calls: a callback whose first
  // statement is setLoading(true) is a synchronous setState inside an effect body, which is the
  // cascading-render pattern React's lint rule exists to catch.
  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams();
    if (section) qs.set("section", section);
    if (worst) qs.set("worst", worst);
    if (code) qs.set("code", code);
    fetch(`/api/render-lab/findings?${qs}`)
      .then(async (res) => {
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        return j as Summary;
      })
      .then((j) => { if (alive) { setData(j); setErr(null); setLoading(false); } })
      .catch((e: unknown) => {
        if (alive) { setErr(e instanceof Error ? e.message : "could not load findings"); setLoading(false); }
      });
    // Guards a slow response for stale filters landing after a fast one for the current filters.
    return () => { alive = false; };
  }, [section, worst, code, nonce]);

  // A selection made under one filter means nothing under the next — the rows it referred to may not
  // even be on screen. Dropping it is honest; carrying it forward would export invisible rows.
  //
  // Done in the setters rather than an effect on [section, worst, code]: clearing state in response to
  // state is the cascading-render pattern React's lint rule catches, and a filter change is an event we
  // already own.
  function filter<T>(set: (v: T) => void) {
    return (v: T) => { set(v); setPicked(new Set()); };
  }

  async function rescan() {
    setScanning(true); setScanNote(null);
    try {
      const res = await fetch("/api/render-lab/sweep", { method: "POST" });
      const j = await res.json();
      setScanNote(res.ok ? `Re-measured ${j.checked} page(s) in ${j.seconds}s.` : (j.error ?? `HTTP ${res.status}`));
      setNonce((n) => n + 1);
    } catch (e: unknown) {
      setScanNote(e instanceof Error ? e.message : "re-scan failed");
    } finally { setScanning(false); }
  }

  if (loading && !data) {
    return <div className="flex items-center gap-2.5 py-24 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading findings…</div>;
  }
  if (err) return <Notice tone="bad">{err}</Notice>;
  if (!data) return null;

  if (data.swept === 0) {
    return (
      <Notice>
        <p className="font-medium text-foreground">No sweep has run yet.</p>
        <p className="mt-2">The render diff needs a headless browser, which this deployment does not have. Run it from a machine that does:</p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-background p-3.5 text-xs"><code>npx tsx scripts/render_sweep.mts</code></pre>
      </Notice>
    );
  }

  return (
    <div className="space-y-8">
      {/* ── freshness + actions ── */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-muted/20 px-5 py-3.5 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Clock className="size-3.5" />
          No-JS checks refreshed <strong className="font-medium text-foreground">{ago(data.lastCheckedAt)}</strong>
          {data.oldestCheckedAt && <span className="text-muted-foreground/70">(oldest row {ago(data.oldestCheckedAt)})</span>}
        </span>
        <span className="text-muted-foreground">
          Render diff <strong className="font-medium text-foreground">{ago(data.lastRenderedAt)}</strong>
          <span className="text-muted-foreground/70"> · {num(data.renderedRows)} of {num(data.swept)} pages</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void rescan()} disabled={scanning}>
            {scanning ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />Re-scanning…</> : <><PlayCircle className="mr-1.5 size-3.5" />Re-scan now</>}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { setLoading(true); setNonce((n) => n + 1); }}>
            <RefreshCw className={cn("mr-1.5 size-3.5", loading && "animate-spin")} />Refresh
          </Button>
        </span>
      </div>
      {scanNote && <Notice>{scanNote} A daily job does this automatically; the render diff comes from the local sweep.</Notice>}

      {/* ── headline numbers ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Pages swept" value={num(data.swept)} sub={`${num(data.blogs)} blogs · ${num(data.features)} features`} />
        <Stat label="Critical" value={num(data.criticals)} tone={data.criticals ? "bad" : "good"} sub={`${num(data.warns)} more with warnings`} />
        <Stat label="Cloaking" value={num(data.cloaked)} tone={data.cloaked ? "bad" : "good"}
              sub={data.cloaked ? "different content by user-agent" : "no user-agent differences found"} />
        <Stat label="Not indexed" value={num(data.notIndexed)} tone={data.notIndexed ? "bad" : "good"}
              sub="Google crawled it and left it out" />
      </div>

      {/* ── issue frequency ── */}
      <section className="overflow-hidden rounded-xl border">
        <div className="flex items-baseline justify-between border-b px-5 py-3.5">
          <h2 className="text-sm font-semibold">Issues, by the search impressions behind them</h2>
          <span className="text-xs text-muted-foreground">click to filter</span>
        </div>
        <div className="divide-y">
          {data.codes.map((c) => (
            <button key={c.code} onClick={() => filter(setCode)(code === c.code ? "" : c.code)}
              className={cn("flex w-full items-center gap-4 px-5 py-3 text-left transition-colors hover:bg-muted/40",
                code === c.code && "bg-muted")}>
              <Badge variant="outline" className={cn("shrink-0 border font-mono text-xs", SEV[c.severity] ?? SEV.info)}>
                {c.severity}
              </Badge>
              <code className="shrink-0 text-xs">{c.code}</code>
              <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">{num(c.count)} pages</span>
              <span className="w-32 shrink-0 text-right tabular-nums text-xs font-medium">{num(c.impressions)}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ── filters ── */}
      <div className="flex flex-wrap items-center gap-3">
        <Seg value={section} set={filter(setSection)} options={[["", "All sections"], ["blogs", "Blogs"], ["features", "Features"]]} />
        <Seg value={worst} set={filter(setWorst)} options={[["", "Any severity"], ["critical", "Critical"], ["warn", "Warn"], ["info", "Info"]]} />
        {code && (
          <Button variant="ghost" size="sm" onClick={() => filter(setCode)("")}>
            clear <code className="ml-1.5 text-xs">{code}</code>
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          showing {data.rows.length} {data.rows.length === 1 ? "page" : "pages"}, worst first
        </span>
      </div>

      {/* ── export ── */}
      <ExportBar
        columns={FINDING_COLUMNS}
        loaded={data.rows}
        selected={data.rows.filter((r) => picked.has(r.url))}
        totalHint={data.swept}
        filename="render-lab-findings"
        fetchAll={async () => {
          const qs = new URLSearchParams({ limit: "5000" });
          if (section) qs.set("section", section);
          if (worst) qs.set("worst", worst);
          if (code) qs.set("code", code);
          const res = await fetch(`/api/render-lab/findings?${qs}`);
          const j = await res.json();
          if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
          return { rows: (j.rows ?? []) as Finding[], capped: (j.rows ?? []).length >= 5000 };
        }}
      />

      {/* ── findings ── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2.5 px-1">
          <Checkbox
            checked={data.rows.length > 0 && data.rows.every((r) => picked.has(r.url))}
            onCheckedChange={(v) => setPicked(v ? new Set(data.rows.map((r) => r.url)) : new Set())} />
          <span className="text-xs text-muted-foreground">
            Select all {data.rows.length} shown
            {picked.size > 0 && <> · <button className="text-primary hover:underline" onClick={() => setPicked(new Set())}>clear {picked.size}</button></>}
          </span>
        </div>
        {data.rows.map((r) => (
          <FindingCard key={r.url} r={r}
            picked={picked.has(r.url)}
            onPick={(v) => setPicked((prev) => {
              const n = new Set(prev);
              if (v) n.add(r.url); else n.delete(r.url);
              return n;
            })} />
        ))}
        {data.rows.length === 0 && (
          <div className="rounded-xl border px-5 py-14 text-center text-sm text-muted-foreground">
            Nothing matches those filters.
          </div>
        )}
      </div>
    </div>
  );
}

function FindingCard({ r, picked, onPick }: { r: Finding; picked: boolean; onPick: (v: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const dot = r.worst === "critical" ? "bg-destructive" : r.worst === "warn" ? "bg-warning" : "bg-muted-foreground/40";

  return (
    <article className={cn("overflow-hidden rounded-xl border transition-colors hover:border-foreground/20",
      picked && "border-primary/40 bg-primary/[0.03]")}>
      <div className="flex items-start">
        {/* Outside the expand button, so ticking a row does not also open it. */}
        <label className="cursor-pointer py-4 pl-5 pr-1" onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={picked} onCheckedChange={(v) => onPick(!!v)} />
        </label>
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-4 py-4 pl-3 pr-5 text-left">
        <span className={cn("mt-2 size-2 shrink-0 rounded-full", dot)} />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <code className="text-sm font-medium">{r.path}</code>
            <Badge variant="outline" className="shrink-0 text-xs font-normal">{r.section}</Badge>
            {r.gsc?.coverageState && (
              <span className="text-xs text-muted-foreground">{r.gsc.coverageState}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
            <Chip label="impressions" value={num(r.impressions)} />
            <Chip label="no-JS words" value={num(r.raw_words)} />
            <Chip label="with JS" value={num(r.rendered_words)} />
            {r.word_delta !== null && r.word_delta > 0 && (
              <Chip label="hidden pre-JS" value={`+${num(r.word_delta)}${r.word_ratio ? ` (${r.word_ratio.toFixed(2)}×)` : ""}`}
                    highlight={r.word_delta >= 150} />
            )}
            {r.raw_bytes ? <Chip label="HTML" value={`${(r.raw_bytes / 1_048_576).toFixed(2)} MB`} /> : null}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {r.issues.map((i) => (
              <Badge key={i.code} variant="outline" className={cn("border font-mono text-xs", SEV[i.severity])}>
                {i.code}
              </Badge>
            ))}
          </div>
        </div>
      </button>
      </div>

      {open && (
        <div className="space-y-4 border-t bg-muted/20 px-5 py-4">
          <ul className="space-y-3">
            {r.issues.map((i) => (
              <li key={i.code} className="flex gap-3">
                <Badge variant="outline" className={cn("mt-0.5 h-fit shrink-0 border font-mono text-xs", SEV[i.severity])}>
                  {i.code}
                </Badge>
                <p className="text-xs leading-relaxed text-muted-foreground">{i.detail}</p>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t pt-3 text-xs text-muted-foreground">
            <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              open page <ExternalLink className="size-3" />
            </a>
            <span>HTTP {r.http_status ?? "—"}</span>
            {r.bytes_per_word ? <span>{num(r.bytes_per_word)} bytes of markup per word</span> : null}
            {r.existing_mode ? <span>existing classifier: <code>{r.existing_mode}</code></span> : null}
            {r.js_gated_tags?.length ? <span>tags only after JS: <code>{r.js_gated_tags.join(", ")}</code></span> : null}
            {r.js_gated_links ? <span>{r.js_gated_links} link{r.js_gated_links === 1 ? "" : "s"} only after JS</span> : null}
            <span className="ml-auto">checked {ago(r.checked_at)}{r.rendered_at ? ` · rendered ${ago(r.rendered_at)}` : ""}</span>
          </div>
        </div>
      )}
    </article>
  );
}

// ── Tab 2 ─────────────────────────────────────────────────────────────────────────────────────────

function Hunter() {
  // Discovery first. The paste box was the whole tab and that was the wrong default: it asks you to
  // already know which page is damaged, which is exactly what you do not know. Search Console does —
  // every URL it has ever sent traffic to, whether or not anything still links to it.
  const [mode, setMode] = useState<"found" | "check">("found");
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Seg value={mode} set={setMode} options={[["found", "Dead pages we found"], ["check", "Check specific pages"]]} />
        <p className="text-xs text-muted-foreground">
          {mode === "found"
            ? "Everything Google still has that no longer answers — found for you, no URLs needed."
            : "Paste live pages to check every link on them right now."}
        </p>
      </div>
      {mode === "found" ? <DeadPages /> : <CheckPages />}
    </div>
  );
}

function DeadPages() {
  const [data, setData] = useState<DeadResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [pattern, setPattern] = useState("");
  const [nonce, setNonce] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams();
    if (pattern) qs.set("pattern", pattern);
    fetch(`/api/render-lab/dead?${qs}`)
      .then(async (res) => {
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        return j as DeadResponse;
      })
      .then((j) => { if (alive) { setData(j); setErr(null); setLoading(false); } })
      .catch((e: unknown) => { if (alive) { setErr(e instanceof Error ? e.message : "could not load"); setLoading(false); } });
    return () => { alive = false; };
  }, [pattern, nonce]);

  async function scan() {
    setScanning(true); setNote(null);
    try {
      const res = await fetch("/api/render-lab/dead?batch=400", { method: "POST" });
      const j = await res.json();
      setNote(res.ok
        ? `Checked ${j.checked} of ${j.considered.toLocaleString()} known URLs, found ${j.dead} dead, in ${j.seconds}s.`
        : (j.error ?? `HTTP ${res.status}`));
      setNonce((n) => n + 1);
    } catch (e: unknown) {
      setNote(e instanceof Error ? e.message : "scan failed");
    } finally { setScanning(false); }
  }

  if (loading && !data) {
    return <div className="flex items-center gap-2.5 py-20 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading dead pages…</div>;
  }
  if (err) return <Notice tone="bad">{err}</Notice>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-muted/20 px-5 py-3.5 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Clock className="size-3.5" />Last checked <strong className="font-medium text-foreground">{ago(data.lastCheckedAt)}</strong>
        </span>
        <span className="text-muted-foreground">Refreshes daily at 02:30 UTC</span>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => void scan()} disabled={scanning}>
          {scanning ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />Checking…</> : <><PlayCircle className="mr-1.5 size-3.5" />Check more now</>}
        </Button>
      </div>
      {note && <Notice>{note}</Notice>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Dead pages" value={num(data.urls)} tone={data.urls ? "bad" : "good"} sub={`across ${num(data.patterns)} path patterns`} />
        <Stat label="Impressions lost" value={num(data.impressions)} tone={data.impressions ? "bad" : "good"} sub="what these earned before they died" />
        <Stat label="Clicks lost" value={num(data.clicks)} tone={data.clicks ? "bad" : "good"} sub="real visits landing on nothing" />
        <Stat label="Still linked to" value={num(data.linkedCount)} sub="the rest are unlinked — a link crawl cannot find them" />
      </div>

      <ExportBar
        columns={DEAD_COLUMNS}
        loaded={data.rows}
        selected={data.rows.filter((r) => picked.has(r.url))}
        totalHint={data.urls}
        filename={pattern ? `dead-pages${pattern.replace(/\//g, "-")}` : "dead-pages"}
        fetchAll={async () => {
          // Every dead URL, not just the open group. This is the scope that matters here: the /read
          // cluster alone is 16,686 rows and nobody is going to click through them a group at a time.
          const res = await fetch("/api/render-lab/dead?all=1&limit=5000");
          const j = await res.json();
          if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
          return { rows: (j.rows ?? []) as DeadRow[], capped: (j.rows ?? []).length >= 5000 };
        }}
      />

      {data.urls === 0 ? (
        <Notice>
          <p className="font-medium text-foreground">Nothing dead found yet.</p>
          <p className="mt-2">Press <strong>Check more now</strong>, or wait for the 02:30 UTC run. Each pass works
          through the loudest untested URLs first, so the ones with traffic behind them surface soonest.</p>
        </Notice>
      ) : (
        <section className="overflow-hidden rounded-xl border">
          <div className="flex items-baseline justify-between border-b px-5 py-3.5">
            <h2 className="text-sm font-semibold">Grouped by path, worst traffic first</h2>
            <span className="text-xs text-muted-foreground">click to see the URLs</span>
          </div>
          <div className="divide-y">
            {data.groups.map((g) => (
              <div key={g.pattern}>
                <button onClick={() => setPattern(pattern === g.pattern ? "" : g.pattern)}
                  className={cn("flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 text-left transition-colors hover:bg-muted/40",
                    pattern === g.pattern && "bg-muted")}>
                  <code className="shrink-0 text-xs font-medium">{g.pattern}/</code>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {num(g.urls)} {g.urls === 1 ? "page" : "pages"}
                  </span>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    {g.verdicts.map((v) => (
                      <Badge key={v} variant="outline" className={cn("border font-mono text-xs",
                        v === "410" || v === "404" ? SEV.critical : SEV.warn)}>{v}</Badge>
                    ))}
                  </div>
                  {g.linked > 0 && (
                    <span className="shrink-0 text-xs text-muted-foreground">{num(g.linked)} still linked</span>
                  )}
                  <span className="ml-auto shrink-0 text-right text-xs tabular-nums">
                    <strong className="font-medium">{num(g.impressions)}</strong>
                    <span className="text-muted-foreground"> impressions</span>
                  </span>
                  <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {num(g.clicks)} clicks
                  </span>
                </button>

                {pattern === g.pattern && (
                  <div className="space-y-3 border-t bg-muted/20 px-5 py-4">
                    {data.rows.length > 1 && (
                      <label className="flex cursor-pointer items-center gap-2.5 text-xs text-muted-foreground">
                        <Checkbox
                          checked={data.rows.every((r) => picked.has(r.url))}
                          onCheckedChange={(v) => setPicked((prev) => {
                            const n = new Set(prev);
                            for (const r of data.rows) { if (v) n.add(r.url); else n.delete(r.url); }
                            return n;
                          })} />
                        Select all {data.rows.length} in this group
                      </label>
                    )}
                    {data.rows.map((r) => (
                      <div key={r.url} className={cn("space-y-2 rounded-lg border bg-background px-4 py-3",
                        picked.has(r.url) && "border-primary/40")}>
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <Checkbox className="mt-0.5 shrink-0" checked={picked.has(r.url)}
                            onCheckedChange={(v) => setPicked((prev) => {
                              const n = new Set(prev);
                              if (v) n.add(r.url); else n.delete(r.url);
                              return n;
                            })} />
                          <Badge variant="outline" className={cn("shrink-0 border font-mono text-xs",
                            r.verdict === "404" || r.verdict === "410" ? SEV.critical : SEV.warn)}>
                            {/* Only append the code when it says something the verdict does not — a
                                badge reading "404 404" is noise, but "soft 200" and "redirect 308" earn
                                their second half. */}
                            {r.verdict}{r.http_status && String(r.http_status) !== r.verdict ? ` ${r.http_status}` : ""}
                          </Badge>
                          <code className="break-all text-xs">{r.path}</code>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
                          <Chip label="impressions" value={num(r.impressions)} highlight={r.impressions > 10_000} />
                          <Chip label="clicks" value={num(r.clicks)} highlight={r.clicks > 100} />
                          {r.position ? <Chip label="avg position" value={r.position.toFixed(1)} /> : null}
                          <Chip label="known from" value={r.sources.join(" + ") || "—"} />
                        </div>
                        {r.suggestion && (
                          <p className="text-xs"><span className="text-foreground/70">closest live page: </span><code>{r.suggestion}</code></p>
                        )}
                        {r.linked_from?.length > 0 && (
                          <div className="space-y-1 border-t pt-2 text-xs">
                            <p className="text-foreground/70">still linked from {r.linked_from.length} place(s):</p>
                            {r.linked_from.slice(0, 5).map((l, i) => (
                              <p key={i} className="text-muted-foreground">
                                <code className="text-xs">{(() => { try { return new URL(l.page).pathname; } catch { return l.page; } })()}</code>
                                {l.anchor ? <> — “{l.anchor}”</> : null}
                                {l.where ? <span className="text-muted-foreground/70"> · {l.where}</span> : null}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    {data.rows.length === 0 && <p className="text-xs text-muted-foreground">Loading URLs…</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function CheckPages() {

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pages, setPages] = useState<HunterPage[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function scan() {
    setBusy(true); setErr(null); setPages(null);
    try {
      const res = await fetch("/api/render-lab/links", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: input }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setPages(j.pages);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "scan failed");
    } finally { setBusy(false); }
  }

  const total = pages?.reduce((n, p) => n + p.links.length, 0) ?? 0;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border p-6">
        <h2 className="text-sm font-semibold">Page URLs, one per line</h2>
        <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Up to ten at a time. Every link on each page is checked live — body copy, buttons, CTAs, FAQ
          answers, related-content cards — and reported with the section it sits in. Anything that comes
          back unreachable is re-checked once on its own, because eighty parallel requests to one host
          get throttled and a throttled request looks exactly like a dead link.
        </p>
        <Textarea value={input} onChange={(e) => setInput(e.target.value)} rows={4}
          placeholder={"https://www.imagine.art/features/ai-tattoo-generator\nhttps://www.imagine.art/blogs/ai-dancing-prompts"}
          className="mt-4 font-mono text-xs" />
        <div className="mt-4 flex items-center gap-4">
          <Button onClick={() => void scan()} disabled={busy || !input.trim()}>
            {busy ? <><Loader2 className="mr-2 size-4 animate-spin" />Checking…</> : <><Search className="mr-2 size-4" />Check links</>}
          </Button>
          {pages && (
            <span className="text-sm text-muted-foreground">
              {total === 0 ? "No broken links found." : `${total} broken link${total === 1 ? "" : "s"} across ${pages.length} page${pages.length === 1 ? "" : "s"}.`}
            </span>
          )}
        </div>
      </section>

      {err && <Notice tone="bad">{err}</Notice>}

      {pages?.map((p) => (
        <section key={p.url} className="overflow-hidden rounded-xl border">
          <div className="flex flex-wrap items-center gap-3 border-b bg-muted/30 px-5 py-3.5">
            <code className="text-xs">{p.url}</code>
            <span className="ml-auto text-xs text-muted-foreground">
              {p.error ? p.error : `${p.checked} links checked · ${p.links.length} broken`}
            </span>
          </div>
          {p.links.length > 0 && (
            <div className="divide-y">
              {p.links.map((l, i) => (
                <div key={`${l.url}-${i}`} className="space-y-2.5 px-5 py-4">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <Badge variant="outline" className={cn("shrink-0 border font-mono text-xs", SEV.critical)}>
                      {l.verdict}{l.status ? ` ${l.status}` : ""}
                    </Badge>
                    <code className="break-all text-xs">{l.url}</code>
                  </div>
                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    <p><span className="text-foreground/70">anchor:</span> {l.anchor || "(no text)"}</p>
                    <p><span className="text-foreground/70">where:</span> {l.where ?? "—"}</p>
                  </div>
                  <div className="text-xs">
                    <span className="text-foreground/70">suggested replacement: </span>
                    {l.suggestions.length === 0
                      ? <span className="text-muted-foreground">no close match in the sitemap</span>
                      : l.suggestions.map((s) => (
                          <span key={s.url} className="mr-3 inline-flex items-center gap-1.5">
                            <code>{s.path}</code>
                            <span className="text-xs text-muted-foreground">{Math.round(s.score * 100)}%</span>
                          </span>
                        ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

// ── CSV export ────────────────────────────────────────────────────────────────────────────────────
//
// One panel for both tabs. The two datasets differ only in their column list, so the selection UI, the
// scope rules and the file building are shared — a second copy would be where the two quietly stop
// agreeing about what "everything" means.
//
// Three scopes, and the distinction between the last two is the one worth stating in the UI rather
// than assuming: "loaded" is what the page currently holds, "all matching" goes back to the server for
// rows the page never fetched. A user who exports 60 of 271 findings because the table only had 60 in
// it has been misled by their own export.

export type ExportScope = "selected" | "loaded" | "all";

interface ExportBarProps<T> {
  columns: Array<CsvColumn<T>>;
  loaded: T[];
  selected: T[];
  /** Fetch everything the current filters match. Undefined disables the "all matching" scope. */
  fetchAll?: () => Promise<{ rows: T[]; capped: boolean }>;
  filename: string;
  /** How many rows the filters match in total, when known — so "all" can state its own size. */
  totalHint?: number | null;
}

function ExportBar<T>({ columns, loaded, selected, fetchAll, filename, totalHint }: ExportBarProps<T>) {
  const [open, setOpen] = useState(false);
  const [cols, setCols] = useState<Set<string>>(() => new Set(columns.filter((c) => c.on !== false).map((c) => c.key)));
  const [scope, setScope] = useState<ExportScope>("loaded");
  // Whether the scope above was chosen by a person. Until it is, the scope FOLLOWS the selection.
  //
  // This existed as a comment before it existed as code: the previous version seeded useState from
  // `selected.length`, which is evaluated once at mount — so ticking two rows left the panel still
  // saying "rows shown here", and pressing Download would have quietly exported 60 rows instead of the
  // 2 that were highlighted. A default that describes itself correctly and behaves otherwise is worse
  // than no default.
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const effectiveScope: ExportScope = touched
    ? (scope === "selected" && !selected.length ? "loaded" : scope)
    : (selected.length ? "selected" : "loaded");

  function choose(v: ExportScope) { setScope(v); setTouched(true); }

  const chosen = columns.filter((c) => cols.has(c.key));
  const count = effectiveScope === "selected" ? selected.length
    : effectiveScope === "loaded" ? loaded.length
    : (totalHint ?? loaded.length);

  async function run() {
    setBusy(true); setNote(null);
    try {
      let rows: T[];
      let capped = false;
      if (effectiveScope === "selected") rows = selected;
      else if (effectiveScope === "loaded") rows = loaded;
      else {
        const r = await fetchAll!();
        rows = r.rows; capped = r.capped;
      }
      if (!rows.length) { setNote("Nothing to export."); return; }
      downloadCsv(stamped(filename), toCsv(rows, chosen));
      setNote(capped
        ? `Exported ${rows.length.toLocaleString()} rows — the server caps a single export here, so this is not the full set.`
        : `Exported ${rows.length.toLocaleString()} rows, ${chosen.length} columns.`);
    } catch (e: unknown) {
      setNote(e instanceof Error ? e.message : "export failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <span className="text-xs text-muted-foreground">
          {selected.length
            ? <><strong className="font-medium text-foreground">{selected.length.toLocaleString()}</strong> selected</>
            : <>Nothing selected — export will use whatever scope you pick</>}
        </span>
        <Button variant={open ? "secondary" : "outline"} size="sm" className="ml-auto" onClick={() => setOpen(!open)}>
          <Download className="mr-1.5 size-3.5" />Export CSV
        </Button>
      </div>

      {open && (
        <div className="space-y-5 border-t bg-muted/20 px-5 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Rows</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <ScopeBtn active={effectiveScope === "selected"} disabled={!selected.length}
                onClick={() => choose("selected")}
                label="Selected rows" sub={`${selected.length.toLocaleString()}`} />
              <ScopeBtn active={effectiveScope === "loaded"} onClick={() => choose("loaded")}
                label="Rows shown here" sub={`${loaded.length.toLocaleString()}`} />
              {fetchAll && (
                <ScopeBtn active={effectiveScope === "all"} onClick={() => choose("all")}
                  label="Everything matching filters"
                  sub={totalHint ? `~${totalHint.toLocaleString()}` : "fetches more"} />
              )}
            </div>
          </div>

          <div>
            <div className="flex items-baseline gap-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Columns · {chosen.length} of {columns.length}
              </p>
              <button className="text-xs text-primary hover:underline"
                onClick={() => setCols(new Set(columns.map((c) => c.key)))}>all</button>
              <button className="text-xs text-primary hover:underline"
                onClick={() => setCols(new Set(columns.filter((c) => c.on !== false).map((c) => c.key)))}>reset</button>
              <button className="text-xs text-primary hover:underline" onClick={() => setCols(new Set())}>none</button>
            </div>
            <div className="mt-2.5 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
              {columns.map((c) => (
                <label key={c.key} className="flex cursor-pointer items-start gap-2.5">
                  <Checkbox checked={cols.has(c.key)} className="mt-0.5"
                    onCheckedChange={(v) => setCols((prev) => {
                      const n = new Set(prev);
                      if (v) n.add(c.key); else n.delete(c.key);
                      return n;
                    })} />
                  <span className="min-w-0">
                    <span className="block text-xs leading-snug">{c.label}</span>
                    {c.hint && <span className="block text-xs leading-snug text-muted-foreground">{c.hint}</span>}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t pt-3.5">
            <Button size="sm" onClick={() => void run()} disabled={busy || !chosen.length || !count}>
              {busy ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />Building…</>
                    : <><Download className="mr-1.5 size-3.5" />Download {count.toLocaleString()} rows</>}
            </Button>
            {!chosen.length && <span className="text-xs text-muted-foreground">Pick at least one column.</span>}
            {note && <span className="text-xs text-muted-foreground">{note}</span>}
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setOpen(false)}>
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ScopeBtn({ active, disabled, onClick, label, sub }: {
  active: boolean; disabled?: boolean; onClick: () => void; label: string; sub: string;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={cn("rounded-lg border px-3.5 py-2 text-left transition-colors",
        active ? "border-primary bg-primary/10" : "hover:bg-muted/60",
        disabled && "cursor-not-allowed opacity-40")}>
      <span className="block text-xs font-medium">{label}</span>
      <span className="block text-xs tabular-nums text-muted-foreground">{sub}</span>
    </button>
  );
}

// ── bits ──────────────────────────────────────────────────────────────────────────────────────────

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: "good" | "bad"; sub?: string }) {
  return (
    <div className="rounded-xl border px-5 py-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1.5 text-3xl font-semibold tabular-nums tracking-tight",
        tone === "bad" && "text-destructive", tone === "good" && "text-success dark:text-success")}>{value}</div>
      {sub && <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Chip({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-foreground/50">{label}</span>
      <span className={cn("tabular-nums font-medium", highlight ? "text-warning dark:text-warning" : "text-foreground/80")}>{value}</span>
    </span>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: "bad" }) {
  return (
    <div className={cn("rounded-xl border px-5 py-4 text-xs leading-relaxed",
      tone === "bad" ? "border-destructive/30 bg-destructive/5 text-destructive" : "bg-muted/30 text-muted-foreground")}>
      {children}
    </div>
  );
}

function Seg<T extends string>({ value, set, options }: { value: T; set: (v: T) => void; options: Array<[T, string]> }) {
  return (
    <div className="flex rounded-lg border p-1">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => set(v)}
          className={cn("rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            value === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
          {label}
        </button>
      ))}
    </div>
  );
}
