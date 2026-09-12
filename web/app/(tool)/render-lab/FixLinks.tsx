"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, PlayCircle, Wrench, ShieldAlert, SkipForward, Clock, Unlink2, Link2, Search, X, ArrowRight, AlertTriangle, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

// The Fix links tab. Two jobs behind one interface, because they are one engine:
//
//   dead    every internal link whose target 404s, with a sitemap-matched replacement
//   prefix  every link under one path segment, rewritten to another — /features → /tools
//
// ── Why the prefix job takes typed input rather than a hardcoded pair ──────────────────────────
//
// Asked for explicitly: "replaces the feature slug with whatever word i type in". It is also the
// safer shape. A hardcoded /features→/tools rename is a one-shot script somebody runs once and then
// re-writes by hand the next time; a parameterised one is a tool, and the preview means the operator
// sees what their word does to a real URL before anything is queued.

interface Occurrence {
  id: string; page_path: string; source: "cta" | "body" | "blog-resource";
  body_format: string | null; section: string | null; anchor: string | null;
  action: "replace" | "remove"; proposed_url: string | null;
  relation_id: number | null; field_path: string;
  // History — populated once a row leaves "pending". old/new are the exact text Strapi held before
  // and after; error is why apply refused (a stale row has one too: "changed since the scan").
  old_value?: string | null; new_value?: string | null;
  error?: string | null; applied_at?: string | null;
}
interface TargetGroup {
  url: string; reason: string | null; occurrences: number; pages: number;
  blog_resources: number; hyperlinks: number; buttons: number;
  proposed_url: string | null; occurrences_detail: Occurrence[];
}
interface PageGroup {
  page_path: string; page_url: string; content_type: string;
  broken: number; blog_resources: number; hyperlinks: number; buttons: number;
  distinct_targets: number;
  links: Array<Occurrence & { url: string; reason: string | null }>;
}

interface Queue {
  job: "dead" | "prefix"; status: string; writesEnabled: boolean;
  pending: number; applied: number; failed: number; skipped: number;
  pages: number; targets: number; scanned: number; scanErrors: number; noRecord: number; lastScanAt: string | null;
  byTarget: Array<{ url: string; occurrences: number; pages: number; proposed: string | null; reason: string | null }>;
  /** Present when the request asked for ?by=target or ?by=page. */
  groups?: TargetGroup[] | PageGroup[];
}

/**
 * What kind of link this occurrence is, in the words that decide what happens to it.
 *
 * The distinction is the whole point of grouping this way: a hyperlink can be unlinked and keep its
 * text, a button cannot (it would be left pointing nowhere), and a blog-resource card is a relation
 * whose removal takes the card out of the section entirely.
 */
function kindOf(o: { source: string; body_format: string | null }): { label: string; tone: string } {
  if (o.source === "blog-resource") return { label: "blog resource", tone: "border-highlight/30 bg-highlight-soft text-highlight-ink" };
  if (o.source === "cta") return { label: "button", tone: "border-chart-2/30 bg-chart-2/10 text-chart-2" };
  if (o.body_format === "cta-fence") return { label: "CTA block", tone: "border-chart-2/30 bg-chart-2/10 text-chart-2" };
  if (o.body_format === "bare-url") return { label: "bare URL", tone: "border-border bg-muted text-muted-foreground" };
  return { label: "hyperlink", tone: "border-success/30 bg-success/10 text-success" };
}

type LinkCategory = "anchor" | "cta" | "blog-resource";

/**
 * The three groups the SEO team wants kept apart (their words: CTA Buttons, Anchor Text, Blog
 * Resource section), because "remove" means something different in each:
 *
 *   anchor         a plain hyperlink or bare URL in body text — remove strips the link, the
 *                  text stays in the sentence.
 *   cta            a button/CTA field, or a CTA-fence block — remove takes the WHOLE button
 *                  out (a button with an empty url still renders and goes nowhere).
 *   blog-resource  a resource card (relation to a blog) — remove drops the card from the
 *                  Resources section; replace repoints it at another blog.
 */
function categoryOf(o: { source: string; body_format: string | null }): LinkCategory {
  if (o.source === "blog-resource") return "blog-resource";
  if (o.source === "cta" || o.body_format === "cta-fence") return "cta";
  return "anchor";
}

const CATEGORY_ORDER: LinkCategory[] = ["anchor", "cta", "blog-resource"];
const CATEGORY_META: Record<LinkCategory, { label: string; chip: string; note: string }> = {
  anchor: { label: "Anchors — body text", chip: "Anchor text", note: "Remove keeps the text and drops the link." },
  cta: { label: "CTAs & buttons", chip: "CTA buttons", note: "Remove takes the whole button out — never a dead button." },
  "blog-resource": { label: "Blog resources", chip: "Blog resources", note: "Remove drops the card; Replace repoints it at another blog." },
};

function num(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}

/** The first path segment, as a filter bucket — "/blogs/x" and "/blogs" both become "blogs". */
function sectionOf(path: string): string {
  const seg = path.replace(/^\/+/, "").split("/")[0];
  return seg || "(root)";
}

/** "3m ago" / "2h ago" / "5d ago" — coarse on purpose, this is a history glance, not a log. */
function timeAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Does this occurrence match the search text — across everything a person would actually type? */
function matchesSearch(o: { page_path: string; url?: string; anchor: string | null; proposed_url: string | null }, q: string): boolean {
  const hay = `${o.page_path} ${o.url ?? ""} ${o.anchor ?? ""} ${o.proposed_url ?? ""}`.toLowerCase();
  return hay.includes(q);
}

/**
 * What actually happened to one row — shown only once it has left "pending". This is the history: the
 * exact old and new text Strapi held, straight from the columns `applyFix` writes at apply time, not a
 * guess reconstructed from the proposed URL (which a person may have edited before applying).
 */
function HistoryLine({ o }: { o: Occurrence }) {
  const ago = timeAgo(o.applied_at);
  if (o.error) {
    return (
      <div className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{o.error}</span>
        {ago && <span className="shrink-0 text-muted-foreground">{ago}</span>}
      </div>
    );
  }
  if (o.old_value != null) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <code className="max-w-[280px] truncate text-muted-foreground line-through decoration-destructive/50">{o.old_value || "(empty)"}</code>
        <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
        <code className="max-w-[280px] truncate text-success dark:text-success">{o.new_value || "(removed)"}</code>
        {ago && <span className="shrink-0 text-muted-foreground">· {ago}</span>}
      </div>
    );
  }
  return ago ? <div className="mt-1 text-xs text-muted-foreground">{ago}</div> : null;
}

export function FixLinks() {
  const [job, setJob] = useState<"dead" | "prefix">("dead");
  const [status, setStatus] = useState("pending");
  const [from, setFrom] = useState("features");
  const [to, setTo] = useState("tools");
  const [data, setData] = useState<Queue | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<null | "scan" | "apply" | "skip" | "unlink" | "relink" | "autofix">(null);
  const [note, setNote] = useState<string | null>(null);
  // Continuous scanning: a ref because the loop below is a plain async function, not a render — it
  // needs to read the CURRENT stop flag on every iteration, not the one captured when it started.
  const [autoScan, setAutoScan] = useState(false);
  const autoScanRef = useRef(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // "target" is the default: you are fixing links, and one dead URL on forty pages is one decision.
  const [groupBy, setGroupBy] = useState<"target" | "page">("target");
  const [search, setSearch] = useState("");
  // null = every section. Sections are derived from whatever is actually loaded, not hardcoded, so
  // this adapts to /blogs, /features, or anything else the scan turns up.
  const [section, setSection] = useState<string | null>(null);
  // null = every kind. The team's three cases — anchor text, CTA buttons, blog resources —
  // each get a filter chip, because the fix for each is a different edit.
  const [category, setCategory] = useState<LinkCategory | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/render-lab/fixes?job=${job}&status=${status}&by=${groupBy}&limit=400`)
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`); return j as Queue; })
      .then((j) => { if (alive) { setData(j); setErr(null); setLoading(false); } })
      .catch((e: unknown) => { if (alive) { setErr(e instanceof Error ? e.message : "could not load"); setLoading(false); } });
    return () => { alive = false; };
  }, [job, status, groupBy, nonce]);

  // Stop the loop if the tab closes mid-scan — otherwise it keeps firing batches into a dead component.
  useEffect(() => () => { autoScanRef.current = false; }, []);

  // Clearing the selection in the setters rather than an effect on [job, status]: a selection made
  // under one job refers to rows that are not even in the other one's list.
  function change<T>(set: (v: T) => void) { return (v: T) => { set(v); setPicked(new Set()); setNote(null); }; }

  // The job tab decides WHAT a running scan walks, so switching it out from under an active loop would
  // silently start scanning something else mid-stream. Stop first, then let the user restart explicitly.
  function changeJob(v: "dead" | "prefix") {
    autoScanRef.current = false; setAutoScan(false);
    setJob(v); setPicked(new Set()); setNote(null);
  }

  // Set the same replacement on every occurrence of one target, then apply them together. The reason
  // by=target exists: /features/nano-banana appears five times across two pages and wants one answer.
  async function retargetAll(ids: string[], url: string) {
    await fetch("/api/render-lab/fixes", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retarget", ids, proposedUrl: url }),
    });
    setNonce((n) => n + 1);
  }

  /** One batch of up to 40 pages. Returns how many are left, or null on failure. */
  async function scanOnce(): Promise<number | null> {
    setBusy("scan"); setNote(null);
    try {
      const qs = job === "prefix"
        ? `job=prefix&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&batch=40`
        : "job=dead&batch=40";
      const res = await fetch(`/api/render-lab/fixes?${qs}`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setNote(`Walked ${j.pagesScanned} page(s), saw ${num(j.linksSeen)} links, queued ${j.queued}. `
        + `${num(j.remaining)} pages still unscanned.${j.notes?.length ? ` ${j.notes.join(" ")}` : ""}`);
      setNonce((n) => n + 1);
      return j.remaining ?? 0;
    } catch (e: unknown) {
      setNote(e instanceof Error ? e.message : "scan failed");
      return null;
    } finally { setBusy(null); }
  }

  /** Fires the next batch the instant the previous one lands — no re-click between them — until
   *  stopped, the pages run out, or a batch fails. */
  async function autoScanLoop() {
    while (autoScanRef.current) {
      const remaining = await scanOnce();
      if (!autoScanRef.current) break; // stopped while this batch was in flight
      if (remaining === null || remaining <= 0) break; // error, or nothing left to walk
    }
    autoScanRef.current = false;
    setAutoScan(false);
  }

  function toggleAutoScan() {
    if (autoScanRef.current) { autoScanRef.current = false; setAutoScan(false); return; }
    autoScanRef.current = true; setAutoScan(true);
    void autoScanLoop();
  }

  // The directed section-wide repair (team ask, Aug 31, "/features"): re-propose every pending
  // replace-row under the active section against the LIVE sitemap and apply the confident
  // matches in one click. Weak matches stay pending for a person — that's the whole contract.
  async function autoFix(seg: string) {
    setBusy("autofix"); setNote(null);
    try {
      const res = await fetch("/api/render-lab/fixes", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "autofix", section: seg }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      const bits = [`Auto-fixed ${j.applied} link(s) in /${seg} — each repointed to the closest relevant live page.`];
      if (j.skippedNoMatch) bits.push(`${j.skippedNoMatch} had no confident live match and stay pending for you.`);
      if (j.skippedExternal) bits.push(`${j.skippedExternal} external link(s) skipped — not ours to repoint.`);
      if (j.failed) bits.push(`${j.failed} failed — see the rows.`);
      if (j.remaining) bits.push(`${j.remaining} left over the time budget — press it again.`);
      if (j.notes?.length) bits.push(j.notes.join(" "));
      setNote(bits.join(" "));
      setPicked(new Set());
      setNonce((n) => n + 1);
    } catch (e: unknown) { setNote(e instanceof Error ? e.message : "autofix failed"); }
    finally { setBusy(null); }
  }

  // Unlink/Relink are back (team decision, Aug 31) — and this time the whole chain behind them
  // is real: the engine removes what each kind actually is (an anchor loses its link and keeps
  // its text, a button comes out whole, a resource card is dropped — no anchors-only guard),
  // and prod arms writes via RENDER_LAB_WRITES=1. Unlink marks intent ("will remove" badge on
  // every row), Relink marks it back, Apply executes whatever each row says. The selection
  // survives a mark on purpose, so Unlink → Apply is two clicks on the same rows.
  async function act(action: "apply" | "skip" | "unlink" | "relink") {
    if (!picked.size) return;
    const ids = [...picked];
    setBusy(action); setNote(null);
    try {
      const res = await fetch("/api/render-lab/fixes", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setNote(
        action === "skip" ? `Skipped ${j.skipped}.`
        : action === "unlink" ? `${j.marked} row(s) marked "will remove" — anchors keep their text, buttons come out whole, resource cards are dropped. Press Apply to make it happen.`
        : action === "relink" ? `${j.marked} row(s) back to replacing the link.`
        : `Applied ${j.applied}${j.failed ? `, ${j.failed} did not apply — see the rows` : ""}.`);
      // A mark is a change of intent, not an action — keep the selection so Apply follows.
      if (action === "apply" || action === "skip") setPicked(new Set());
      setNonce((n) => n + 1);
    } catch (e: unknown) { setNote(e instanceof Error ? e.message : `${action} failed`); }
    finally { setBusy(null); }
  }


  if (loading && !data) {
    return <div className="flex items-center gap-2.5 py-20 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading the queue…</div>;
  }
  if (err) return <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-4 text-xs text-destructive">{err}</div>;
  if (!data) return null;

  const allGroups = (data.groups ?? []) as Array<TargetGroup | PageGroup>;

  // Section chips: every top-level path segment present in what's loaded, ranked by how many broken
  // occurrences sit under it. Built from occurrences (not the group's own url/page_path) so a target
  // group that spans two sections counts toward both.
  const sectionCounts = new Map<string, number>();
  const categoryCounts = new Map<LinkCategory, number>();
  for (const g of allGroups) {
    const occ = "occurrences_detail" in g ? g.occurrences_detail : g.links;
    for (const o of occ) {
      sectionCounts.set(sectionOf(o.page_path), (sectionCounts.get(sectionOf(o.page_path)) ?? 0) + 1);
      categoryCounts.set(categoryOf(o), (categoryCounts.get(categoryOf(o)) ?? 0) + 1);
    }
  }
  const sections = [...sectionCounts.entries()].sort((a, b) => b[1] - a[1]);

  const q = search.trim().toLowerCase();
  const groups = allGroups.filter((g) => {
    const occ = "occurrences_detail" in g ? g.occurrences_detail : g.links;
    const inSection = !section || occ.some((o) => sectionOf(o.page_path) === section);
    if (!inSection) return false;
    if (category && !occ.some((o) => categoryOf(o) === category)) return false;
    if (!q) return true;
    const groupHay = "occurrences_detail" in g ? g.url : g.page_path;
    if (groupHay.toLowerCase().includes(q)) return true;
    return occ.some((o) => matchesSearch("occurrences_detail" in g ? { ...o, url: g.url } : o, q));
  });

  // With a category filter on, "select all" must select only that kind — the cards hide the
  // other kinds, and selecting what a person cannot see is how wrong bulk edits happen.
  const allIds = groups.flatMap((g) => {
    const occ = "occurrences_detail" in g ? g.occurrences_detail : g.links;
    return occ.filter((o) => !category || categoryOf(o) === category).map((o) => o.id);
  });
  const allPicked = allIds.length > 0 && allIds.every((id) => picked.has(id));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Seg value={job} set={changeJob} options={[["dead", "Broken links"], ["prefix", "Rename a path"]]} />
        <Seg value={status} set={change(setStatus)}
             options={[["pending", "Pending"], ["applied", "Applied"], ["stale", "Stale"], ["failed", "Failed"], ["skipped", "Skipped"]]} />
        <Seg value={groupBy} set={change(setGroupBy)} options={[["target", "By link"], ["page", "By page"]]} />
        <p className="text-xs text-muted-foreground">
          {job === "dead"
            ? "Every internal link whose target no longer answers, with the closest live page suggested."
            : "Every link under one path segment, rewritten to another."}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search URL, page, or anchor text…"
            className="h-9 w-72 pl-8 pr-8 text-xs"
          />
          {search && (
            <button onClick={() => setSearch("")} aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {sections.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button onClick={() => setSection(null)}
              className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                !section ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
              All
            </button>
            {sections.slice(0, 12).map(([s, count]) => (
              <button key={s} onClick={() => setSection(section === s ? null : s)}
                className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  section === s ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
                /{s} <span className="opacity-60">{count}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={() => change<LinkCategory | null>(setCategory)(null)}
            className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              !category ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
            All kinds
          </button>
          {CATEGORY_ORDER.map((cat) => (
            <button key={cat} onClick={() => change<LinkCategory | null>(setCategory)(category === cat ? null : cat)}
              title={CATEGORY_META[cat].note}
              className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                category === cat ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
              {CATEGORY_META[cat].chip} <span className="opacity-60">{categoryCounts.get(cat) ?? 0}</span>
            </button>
          ))}
        </div>
        {(search || section || category) && (
          <span className="text-xs text-muted-foreground">showing {groups.length} of {allGroups.length}</span>
        )}
      </div>

      {job === "prefix" && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-muted/20 px-5 py-4">
          <label className="space-y-1.5">
            <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">From</span>
            <div className="flex items-center gap-1"><span className="text-muted-foreground">/</span>
              <Input value={from} disabled={autoScan} onChange={(e) => setFrom(e.target.value.replace(/\//g, ""))} className="h-9 w-36 font-mono text-xs" /></div>
          </label>
          <span className="pb-2.5 text-muted-foreground">→</span>
          <label className="space-y-1.5">
            <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">To</span>
            <div className="flex items-center gap-1"><span className="text-muted-foreground">/</span>
              <Input value={to} disabled={autoScan} onChange={(e) => setTo(e.target.value.replace(/\//g, ""))} className="h-9 w-36 font-mono text-xs" /></div>
          </label>
          <p className="pb-2 text-xs text-muted-foreground">
            <code>/{from || "…"}/ai-tattoo-generator</code> → <code>/{to || "…"}/ai-tattoo-generator</code>
          </p>
        </div>
      )}

      {!data.writesEnabled && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 px-5 py-4">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning dark:text-warning" />
          <div className="space-y-1 text-xs">
            <p className="font-medium text-foreground">Writes are off, so Apply will refuse.</p>
            <p className="text-muted-foreground">
              Scanning and previewing work fully. Set <code>RENDER_LAB_WRITES=1</code> to let this edit
              live published pages — it is off by default so a stray run cannot rewrite the site.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-muted/20 px-5 py-3.5 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Clock className="size-3.5" />{num(data.scanned)} pages walked
          {data.noRecord > 0 && <span className="text-muted-foreground/70">· {num(data.noRecord)} not CMS-backed</span>}
          {data.scanErrors > 0 && <span className="text-warning dark:text-warning">· {num(data.scanErrors)} unreadable</span>}
        </span>
        <span className="text-muted-foreground">
          {num(data.pending)} pending · {num(data.applied)} applied · {num(data.skipped)} skipped
          {data.failed > 0 && <span className="text-destructive"> · {num(data.failed)} failed</span>}
        </span>
        <Button
          variant={autoScan ? "default" : "outline"} size="sm" className="ml-auto"
          onClick={() => toggleAutoScan()}
          disabled={!autoScan && (busy !== null || (job === "prefix" && (!from || !to)))}
          title={autoScan ? "Stop scanning" : "Keeps walking batches back-to-back, updating live, until you press this again"}
        >
          {autoScan
            ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />Scanning… (click to stop)</>
            : <><PlayCircle className="mr-1.5 size-3.5" />Scan more pages</>}
        </Button>
      </div>
      {note && <div className="rounded-xl border bg-muted/30 px-5 py-3.5 text-xs text-muted-foreground">{note}</div>}

      {data.byTarget.length > 0 && status === "pending" && (
        <section className="overflow-hidden rounded-xl border">
          <div className="border-b px-5 py-3.5 text-sm font-semibold">
            {num(data.targets)} distinct targets across {num(data.pages)} pages
          </div>
          <div className="max-h-64 divide-y overflow-y-auto">
            {data.byTarget.slice(0, 60).map((t) => (
              <div key={t.url} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-xs">
                <code className="min-w-0 flex-1 truncate">{t.url}</code>
                <span className="text-muted-foreground">→</span>
                <code className="min-w-0 flex-1 truncate text-success dark:text-success">{t.proposed ?? "— no suggestion —"}</code>
                <span className="shrink-0 tabular-nums text-muted-foreground">{t.occurrences}× on {t.pages} page(s)</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {status === "pending" && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border px-5 py-3">
          <label className="flex cursor-pointer items-center gap-2.5 text-xs">
            <Checkbox checked={allPicked} onCheckedChange={(v) => setPicked(v ? new Set(allIds) : new Set())} />
            Select all {allIds.length} shown
          </label>
          {picked.size > 0 && (
            <span className="text-xs text-muted-foreground">
              <strong className="font-medium text-foreground">{picked.size}</strong> selected
            </span>
          )}
          {job === "dead" && section && (
            <Button size="sm" variant="outline" onClick={() => void autoFix(section)} disabled={busy !== null || !data.writesEnabled}
                    title={`Repoint every dead internal link on /${section} pages to the closest relevant LIVE page — automatically, now. Only confident matches are applied; the rest stay pending for you.`}>
              {busy === "autofix" ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />Auto-fixing /{section}…</> : <><Wand2 className="mr-1.5 size-3.5" />Auto-fix /{section}</>}
            </Button>
          )}
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void act("unlink")} disabled={!picked.size || busy !== null}
                    title="Mark the selected rows for removal instead of replacement: anchor text stays, buttons come out whole, resource cards are dropped. Apply executes it.">
              {busy === "unlink" ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />Marking…</> : <><Unlink2 className="mr-1.5 size-3.5" />Unlink</>}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void act("relink")} disabled={!picked.size || busy !== null}
                    title="Back to replacing the selected rows' links with a new URL">
              <Link2 className="mr-1.5 size-3.5" />Relink
            </Button>
            <Button size="sm" variant="outline" onClick={() => void act("skip")} disabled={!picked.size || busy !== null}>
              <SkipForward className="mr-1.5 size-3.5" />Skip
            </Button>
            <Button size="sm" onClick={() => void act("apply")} disabled={!picked.size || busy !== null || !data.writesEnabled}
                    title="Execute each selected row's intent: replace with its proposed URL, or remove if marked by Unlink.">
              {busy === "apply" ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />Applying…</> : <><Wrench className="mr-1.5 size-3.5" />Apply {picked.size || ""}</>}
            </Button>
          </span>
        </div>
      )}

      <div className="space-y-3">
        {groupBy === "target"
          ? (groups as TargetGroup[]).map((g) => (
              <TargetCard key={g.url} g={g} picked={picked} selectable={status === "pending"} categoryFilter={category}
                onPick={(ids, v) => setPicked((prev) => {
                  const n = new Set(prev);
                  for (const id of ids) { if (v) n.add(id); else n.delete(id); }
                  return n;
                })}
                onRetargetAll={(u) => void retargetAll(g.occurrences_detail.map((o) => o.id), u)} />
            ))
          : (groups as PageGroup[]).map((g) => (
              <PageCard key={g.page_path} g={g} picked={picked} selectable={status === "pending"} categoryFilter={category}
                onPick={(ids, v) => setPicked((prev) => {
                  const n = new Set(prev);
                  for (const id of ids) { if (v) n.add(id); else n.delete(id); }
                  return n;
                })} />
            ))}
        {groups.length === 0 && allGroups.length > 0 && (
          <div className="rounded-xl border px-5 py-14 text-center text-sm text-muted-foreground">
            Nothing matches {search ? `“${search}”` : ""}{search && section ? " in " : ""}{section ? `/${section}` : ""}.
            {" "}<button className="text-primary hover:underline" onClick={() => { setSearch(""); setSection(null); }}>Clear filters</button>
          </div>
        )}
        {allGroups.length === 0 && (
          <div className="rounded-xl border px-5 py-14 text-center text-sm text-muted-foreground">
            {status === "pending"
              ? "Nothing queued. Press “Scan more pages” — each pass walks a batch of CMS pages and queues what it finds."
              : `No ${status} rows.`}
          </div>
        )}
      </div>
    </div>
  );
}

/** One of the three kept-apart lists inside a card. Renders nothing if this category is empty here. */
function CategorySection<T extends Occurrence>({ category, items, picked, selectable, onPick, detail }: {
  category: LinkCategory; items: T[]; picked: Set<string>; selectable: boolean;
  onPick: (ids: string[], v: boolean) => void;
  /** The bit that differs between the "by link" and "by page" views — page_path there, url here. */
  detail: (o: T) => ReactNode;
}) {
  if (!items.length) return null;
  const meta = CATEGORY_META[category];
  const ids = items.map((o) => o.id);
  const allPicked = ids.every((id) => picked.has(id));
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {selectable && <Checkbox className="mr-0.5" checked={allPicked} onCheckedChange={(v) => onPick(ids, !!v)} />}
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{meta.label}</span>
        <span className="text-xs text-muted-foreground">({items.length})</span>
        {selectable && <span className="text-xs text-muted-foreground/70">— {meta.note}</span>}
      </div>
      <ul className="space-y-1.5">
        {items.map((o) => {
          const k = kindOf(o);
          return (
            <li key={o.id}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {selectable && <Checkbox checked={picked.has(o.id)} onCheckedChange={(v) => onPick([o.id], !!v)} />}
                <Badge variant="outline" className={cn("border text-xs", k.tone)}>{k.label}</Badge>
                {detail(o)}
                {o.action === "remove" && <Badge variant="outline" className="border-primary/40 bg-primary/10 text-xs">will remove</Badge>}
              </div>
              {!selectable && <HistoryLine o={o} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TargetCard({ g, picked, selectable, onPick, onRetargetAll, categoryFilter }: {
  g: TargetGroup; picked: Set<string>; selectable: boolean;
  onPick: (ids: string[], v: boolean) => void;
  onRetargetAll: (url: string) => void;
  categoryFilter?: LinkCategory | null;
}) {
  // Collapsed while fixing (you are scanning many targets); expanded for history (you came to read
  // what happened to this one).
  const [open, setOpen] = useState(!selectable);
  const [edit, setEdit] = useState(g.proposed_url ?? "");
  const ids = g.occurrences_detail.map((o) => o.id);
  const allPicked = ids.length > 0 && ids.every((id) => picked.has(id));
  const anyBlogResource = g.blog_resources > 0;

  return (
    <article className={cn("rounded-xl border", allPicked && "border-primary/40 bg-primary/[0.03]")}>
      <div className="flex items-start gap-3.5 px-5 py-4">
        {selectable && <Checkbox className="mt-1 shrink-0" checked={allPicked} onCheckedChange={(v) => onPick(ids, !!v)} />}
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            <code className="break-all text-xs font-medium">{g.url || "(no target)"}</code>
            {g.reason && <Badge variant="outline" className="text-xs font-normal">{g.reason}</Badge>}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span><strong className="font-medium text-foreground">{g.occurrences}</strong> occurrence{g.occurrences === 1 ? "" : "s"} on {g.pages} page{g.pages === 1 ? "" : "s"}</span>
            {g.hyperlinks > 0 && <Badge variant="outline" className={cn("border text-xs", kindOf({ source: "body", body_format: "markdown-link" }).tone)}>{g.hyperlinks} hyperlink</Badge>}
            {g.blog_resources > 0 && <Badge variant="outline" className={cn("border text-xs", kindOf({ source: "blog-resource", body_format: null }).tone)}>{g.blog_resources} blog resource</Badge>}
            {g.buttons > 0 && <Badge variant="outline" className={cn("border text-xs", kindOf({ source: "cta", body_format: null }).tone)}>{g.buttons} button</Badge>}
          </div>

          {selectable && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-foreground/50">→</span>
              <Input value={edit} onChange={(e) => setEdit(e.target.value)}
                placeholder={anyBlogResource ? "a /blogs/… URL (a resource card can only point at a blog)" : "replacement URL"}
                className="h-8 max-w-xl flex-1 font-mono text-xs" />
              {edit.trim() && edit.trim() !== (g.proposed_url ?? "") && (
                <Button size="sm" variant="outline" className="h-8" onClick={() => onRetargetAll(edit.trim())}>
                  set on all {g.occurrences}
                </Button>
              )}
            </div>
          )}

          <button onClick={() => setOpen(!open)} className="text-xs text-primary hover:underline">
            {open ? "hide" : "show"} the {g.occurrences} place{g.occurrences === 1 ? "" : "s"} it appears
          </button>

          {open && (
            <div className="space-y-3 border-t pt-2.5">
              {CATEGORY_ORDER.filter((cat) => !categoryFilter || cat === categoryFilter).map((cat) => (
                <CategorySection key={cat} category={cat} selectable={selectable} picked={picked} onPick={onPick}
                  items={g.occurrences_detail.filter((o) => categoryOf(o) === cat)}
                  detail={(o) => (
                    <>
                      <code className="text-xs">{o.page_path}</code>
                      {o.section && <span className="text-xs text-muted-foreground">§ {o.section}</span>}
                      {o.anchor && <span className="max-w-xs truncate text-xs text-muted-foreground">“{o.anchor}”</span>}
                    </>
                  )} />
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

/** One PAGE and the dead links on it — the auditing view. */
function PageCard({ g, picked, selectable, onPick, categoryFilter }: {
  g: PageGroup; picked: Set<string>; selectable: boolean;
  onPick: (ids: string[], v: boolean) => void;
  categoryFilter?: LinkCategory | null;
}) {
  const [open, setOpen] = useState(!selectable);
  const ids = g.links.map((l) => l.id);
  const allPicked = ids.length > 0 && ids.every((id) => picked.has(id));

  return (
    <article className={cn("rounded-xl border", allPicked && "border-primary/40 bg-primary/[0.03]")}>
      <div className="flex items-start gap-3.5 px-5 py-4">
        {selectable && <Checkbox className="mt-1 shrink-0" checked={allPicked} onCheckedChange={(v) => onPick(ids, !!v)} />}
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            <code className="text-xs font-medium">{g.page_path}</code>
            <Badge variant="outline" className="text-xs font-normal">{g.content_type}</Badge>
            <a href={g.page_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">open</a>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span><strong className="font-medium text-foreground">{g.broken}</strong> broken link{g.broken === 1 ? "" : "s"} · {g.distinct_targets} distinct target{g.distinct_targets === 1 ? "" : "s"}</span>
            {g.hyperlinks > 0 && <Badge variant="outline" className={cn("border text-xs", kindOf({ source: "body", body_format: "markdown-link" }).tone)}>{g.hyperlinks} hyperlink</Badge>}
            {g.blog_resources > 0 && <Badge variant="outline" className={cn("border text-xs", kindOf({ source: "blog-resource", body_format: null }).tone)}>{g.blog_resources} blog resource</Badge>}
            {g.buttons > 0 && <Badge variant="outline" className={cn("border text-xs", kindOf({ source: "cta", body_format: null }).tone)}>{g.buttons} button</Badge>}
          </div>
          <button onClick={() => setOpen(!open)} className="text-xs text-primary hover:underline">
            {open ? "hide" : "show"} the {g.broken} link{g.broken === 1 ? "" : "s"}
          </button>
          {open && (
            <div className="space-y-3 border-t pt-2.5">
              {CATEGORY_ORDER.filter((cat) => !categoryFilter || cat === categoryFilter).map((cat) => (
                <CategorySection key={cat} category={cat} selectable={selectable} picked={picked} onPick={onPick}
                  items={g.links.filter((l) => categoryOf(l) === cat)}
                  detail={(l) => (
                    <>
                      <code className="break-all text-xs">{l.url || "(no target)"}</code>
                      {l.section && <span className="text-xs text-muted-foreground">§ {l.section}</span>}
                    </>
                  )} />
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
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
