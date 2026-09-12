"use client";

// The research board: what happened, what it becomes, and what is still undone.
//
// One row per release. The two questions it answers are "is this worth making" and "has somebody
// already made it", and they are deliberately different columns — the first is a judgement a person
// can override, the second is a fact the sweep re-derives every morning.
//
// Open in Summer is the whole point of the surface. A board that only lists work is a list; the
// value is that the row carries enough context to start the job in one click, with the subject, the
// source and the decision already written into the prompt.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { RefreshCw, ExternalLink, X, Sparkles, AlertCircle, Search, ClipboardCopy, Check, Telescope } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/PageHeader";
import { SegmentedControl } from "@/components/ui/segmented-control";

/** Mirrors tierOf() in lib/research/sweep.ts. Duplicated rather than imported so a client component
 *  does not pull the sweep module (and Supabase with it) into the browser bundle. */
function isSignal(kind: string | null): boolean {
  return kind === "hackernews" || kind === "reddit" || kind === "x";
}

interface ResearchItem {
  id: string;
  subject: string;
  summary: string | null;
  source_name: string | null;
  source_kind: string | null;
  source_url: string | null;
  item_date: string | null;
  date_kind: string | null;
  modality: string | null;
  surfaces: string[];
  is_model: boolean;
  route_reason: string | null;
  route_confidence: string | null;
  status: string;
  coverage: string;
  coverage_detail: string | null;
  draft_id: string | null;
  last_seen: string;
}

/** The evidence every prompt carries. Everything Summer would otherwise have to be told twice. */
function evidenceFor(it: ResearchItem): string {
  return [
    it.summary ? `\nWhat we know: ${it.summary}` : "",
    it.source_url ? `\nSource: ${it.source_url}` : "",
    it.item_date ? `\nDated ${it.item_date}${it.date_kind === "observed" ? " (observed, not a stated launch date)" : ""}.` : "",
    it.route_reason ? `\nWhy this routing: ${it.route_reason}` : "",
    // The gate travels with the prompt, not just the badge. A badge informs whoever looks at the
    // board; this is what stops an unconfirmed rumour becoming a published page when somebody clicks
    // through without reading it.
    isSignal(it.source_kind)
      ? "\n\nIMPORTANT: this came from a social/forum post, NOT a vendor announcement. Before writing " +
        "anything, find the vendor's own changelog, docs or blog post and confirm it is real. If you " +
        "cannot find one, say so and stop — do not write from the post alone, and never cite it."
      : "",
  ].join("");
}

/**
 * The two prompts, one per surface.
 *
 * Split because a blog post and a cluster page are different jobs with different tools, and one
 * combined "research and draft both" prompt made Summer pick an order and usually do the blog. Naming
 * the surface in the button means the person decides which one they are starting.
 */
function blogPrompt(it: ResearchItem): string {
  return [
    `Research and write a blog post about "${it.subject}".`,
    evidenceFor(it),
    "\n\nCheck it has not already been covered before you start, and check the slug against the live",
    "sitemap rather than proposing one from memory.",
    "\nAsk me which voice to write in before you draft — show me every voice, not a shortlist.",
  ].join("");
}

/**
 * The landing-page brief, written to be pasted somewhere else.
 *
 * Summit no longer builds landing pages, so this is not a Summer prompt any more — it is a handover.
 * That changes what it has to contain: a prompt aimed at Summer could lean on Summer already knowing
 * the house rules, the template registry and the ledger. Pasted into a fresh session with none of
 * that context, every one of those has to be stated, or the receiving agent invents a template name
 * and a benchmark to go with it.
 */
function landingPrompt(it: ResearchItem): string {
  const path = it.subject
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return [
    `Build the ImagineArt landing page for "${it.subject}".`,
    evidenceFor(it),
    "\n\n## What this page is",
    `\nA cluster-page entry in Strapi, assembled from a registered template — not a blog post. It has`,
    ` no body field: the content lives in nested components (hero, features, FAQ, reviews…) and which`,
    ` ones exist depends on the template chosen. Suggested slug: ${path || "<slug>"} — confirm it against`,
    ` the live sitemap rather than trusting this.`,
    "\n\n## Order of work",
    "\n1. Confirm the subject is real against the VENDOR'S OWN page (changelog, docs, release notes).",
    "\n   If the only source is a forum or social post, stop and say so.",
    "\n2. Check we have not already covered it — the live sitemap, Strapi cluster-pages, and the Notion",
    "\n   backlog. A second page on one intent cannibalises the first; that is the main risk here.",
    "\n3. List the LIVE registered templates and categories and pick from them. Never name a template",
    "\n   or a category enum from memory — a wrong category 404s a page that is otherwise correct.",
    "\n4. Propose the slug and category, then create the entry as a DRAFT.",
    "\n5. Fill every section's copy, then generate and attach the media slots.",
    "\n6. Report what is filled and what still blocks publishing.",
    "\n\n## Rules that are not negotiable",
    "\n- Ask which voice to write in before drafting, and show every voice rather than a shortlist.",
    "\n- Leave a field EMPTY rather than inventing a spec, a benchmark, a price or a testimonial. An",
    "\n  empty required field is a visible publish blocker; an invented one is a fabricated claim that",
    "\n  ships. Reviews must be real ones the team collected.",
    "\n- Every factual claim needs a source you actually read. No figure you cannot attribute.",
    "\n- Nothing publishes. A person opens the entry in Strapi and publishes it.",
  ].join("");
}

const COVERAGE_LABEL: Record<string, { text: string; className: string }> = {
  covered: { text: "covered", className: "text-muted-foreground" },
  drafting: { text: "drafting", className: "text-highlight" },
  open: { text: "open", className: "text-foreground" },
};

/**
 * The tabs, by what a person is actually looking for. Built from `modality` and `source_kind`,
 * which the sweep already stores — no new field. `avatar`, `mcp` and `capability` are real
 * modalities but produce a handful of rows a month between them, so they sit under Other rather
 * than each owning an almost-always-empty tab.
 *
*/

/**
 * Deprecations are matched on SOURCE, not modality, and that is not a shortcut.
 *
 * A row from a vendor deprecation table has the model id as its whole subject — "gpt-4.1-nano |
 * gpt-4.1-nano-2025-04-14" — with no retirement wording in it anywhere, so the text classifier
 * quite correctly reads it as an LLM. Keying the tab on modality left Deprecations empty while 20
 * retirements sat under LLM. Where the row came from is a fact; what its title implies is a guess.
 */
function isDeprecation(it: { source_kind: string | null; modality: string | null }): boolean {
  return it.source_kind === "deprecation" || it.modality === "retirement";
}

type TabItem = { source_kind: string | null; modality: string | null };

const TABS = [
  { key: "all", label: "All", match: () => true },
  { key: "llm", label: "LLM", match: (i: TabItem) => !isDeprecation(i) && i.modality === "llm" },
  { key: "image", label: "Image", match: (i: TabItem) => !isDeprecation(i) && i.modality === "image" },
  { key: "video", label: "Video", match: (i: TabItem) => !isDeprecation(i) && i.modality === "video" },
  { key: "audio", label: "Audio", match: (i: TabItem) => !isDeprecation(i) && i.modality === "audio" },
  { key: "retirement", label: "Deprecations", match: (i: TabItem) => isDeprecation(i) },
  {
    key: "other",
    label: "Other",
    match: (i: TabItem) =>
      !isDeprecation(i) && !["llm", "image", "video", "audio"].includes(i.modality ?? ""),
  },
] as const;

export default function ResearchPage() {
  const [items, setItems] = useState<ResearchItem[]>([]);
  // Separate from the list, for the same reason the Summer rail keeps them apart: a failed read and
  // an empty backlog look identical on screen, and only one of them means "nothing to do".
  const [state, setState] = useState<{ phase: "loading" | "ready" | "error"; detail?: string }>({ phase: "loading" });
  const [sweeping, setSweeping] = useState(false);
  const [tab, setTab] = useState<string>("all");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/research");
      const r = await res.json().catch(() => null);
      if (r?.ok) { setItems(r.items); setState({ phase: "ready" }); }
      else setState({ phase: "error", detail: r?.error ?? `the server did not answer (HTTP ${res.status})` });
    } catch (e) {
      setState({ phase: "error", detail: e instanceof Error ? e.message : "network error" });
    }
  }, []);

  // `load` is async: its setState calls run after an await, so they are not the synchronous
  // cascading-render pattern this rule targets — it cannot see through the promise. The Summer rail
  // carries the same suppression for the same shape, and restructuring around it (a ref, a reducer,
  // a mount flag) would add machinery to satisfy a false positive.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const sweep = useCallback(async () => {
    setSweeping(true);
    try {
      const res = await fetch("/api/research/sweep", { method: "POST" });
      const r = await res.json().catch(() => null);
      if (r?.ok) {
        toast.success(`Swept ${r.swept}: ${r.added} new, ${r.updated} updated, ${r.covered} already covered.`);
        // Source health is reported, not hidden. A dead sweeper and a quiet morning produce the same
        // empty board otherwise, and only one of them is worth acting on.
        for (const s of r.sources ?? []) if (!s.ok) toast.error(`${s.name} failed: ${s.note ?? "no detail"}`);
        await load();
      } else toast.error(r?.error ?? "The sweep failed.");
    } finally { setSweeping(false); }
  }, [load]);

  const decide = useCallback(async (id: string, patch: Record<string, unknown>) => {
    const res = await fetch("/api/research", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
    const r = await res.json().catch(() => null);
    if (r?.ok) await load(); else toast.error(r?.error ?? "That did not save.");
  }, [load]);

  // Search covers the subject AND the description, because half the time the thing you remember is
  // "that Nvidia voice one" and the vendor's name is only in the summary.
  const q = query.trim().toLowerCase();
  const matches = (i: ResearchItem) =>
    !q ||
    i.subject.toLowerCase().includes(q) ||
    (i.summary ?? "").toLowerCase().includes(q) ||
    (i.source_name ?? "").toLowerCase().includes(q);

  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[0];
  const filtered = items.filter((i) => activeTab.match(i) && matches(i));

  // Counts come from the SEARCH-filtered set, not the whole board, so the numbers on the tabs agree
  // with what clicking one actually shows. Counting everything would offer "Video 14" and then
  // render three rows.
  const searched = items.filter(matches);
  const countFor = (t: (typeof TABS)[number]) => searched.filter((i) => t.match(i)).length;

  const open = filtered.filter((i) => i.coverage !== "covered");
  const covered = filtered.filter((i) => i.coverage === "covered");

  return (
    <div>
      <div className="flex items-start justify-between gap-6 mb-6">
        <PageHeader icon={Telescope} title="Research" description="What launched, what it should become, and what nobody has written yet. Swept every weekday morning." />
        <Button variant="outline" onClick={sweep} disabled={sweeping} className="gap-2 shrink-0">
          <RefreshCw className={cn("h-4 w-4", sweeping && "animate-spin")} />
          {sweeping ? "Sweeping…" : "Refresh"}
        </Button>
      </div>

      {state.phase === "ready" && items.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {/* An empty tab is disabled rather than hidden: a Video tab that vanishes on a quiet week
              reads as a broken page, and its absence is itself information. */}
          <SegmentedControl
            aria-label="Kind"
            value={tab}
            onChange={(k) => setTab(k)}
            options={TABS.map((t) => {
              const n = countFor(t);
              return { value: t.key, label: t.label, count: n, disabled: n === 0 && t.key !== "all" };
            })}
          />

          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search subject, description, source…"
              className="h-9 w-64 rounded-md border border-input bg-background pl-8 pr-7 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {state.phase === "loading" && <p className="text-xs text-muted-foreground">Loading…</p>}

      {state.phase === "error" && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <p className="flex items-start gap-1.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Couldn&apos;t load the board — it is <b>not</b> empty ({state.detail}).</span>
          </p>
        </div>
      )}

      {state.phase === "ready" && items.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nothing on the board yet. Hit Refresh to run the first sweep.
        </p>
      )}

      {open.length > 0 && <Row.List items={open} onDecide={decide} />}

      {covered.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {covered.length} already covered
          </summary>
          <div className="mt-2 opacity-60"><Row.List items={covered} onDecide={decide} /></div>
        </details>
      )}
    </div>
  );
}

/** What every row needs to render its actions. One shape, so List and Item cannot drift apart. */
interface RowProps {
  onDecide: (id: string, patch: Record<string, unknown>) => void;
}

const PAGE = 30;

const Row = {
  List({ items, onDecide }: RowProps & { items: ResearchItem[] }) {
    // Two hundred cards at once made a 35,000px page. Thirty is a screen and a half; the rest is a
    // click away, and the count says how much is left.
    const [shown, setShown] = useState(PAGE);
    const visible = items.slice(0, shown);
    const rest = items.length - visible.length;
    return (
      <div className="flex flex-col gap-2">
        {visible.map((it) => <Row.Item key={it.id} item={it} onDecide={onDecide} />)}
        {rest > 0 && (
          <Button variant="outline" className="mx-auto mt-2" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, rest)} more <span className="ml-1.5 text-muted-foreground font-tabular">{rest} left</span>
          </Button>
        )}
      </div>
    );
  },

  Item({ item: it, onDecide }: RowProps & { item: ResearchItem }) {
    const cov = COVERAGE_LABEL[it.coverage] ?? COVERAGE_LABEL.open;
    const landing = it.surfaces.includes("landing");
    const [copied, setCopied] = useState(false);

    // navigator.clipboard is undefined on a plain-HTTP origin, and a silent no-op would look like a
    // copy that worked. Say so instead, and show the prompt so the brief is still recoverable.
    const copyPrompt = async () => {
      const text = landingPrompt(it);
      try {
        if (!navigator.clipboard) throw new Error("the clipboard needs an https origin");
        await navigator.clipboard.writeText(text);
        setCopied(true);
        toast.success("Landing-page prompt copied", { description: "Paste it into the landing-page tooling." });
        setTimeout(() => setCopied(false), 2000);
      } catch (e) {
        toast.error("Could not copy the prompt", {
          description: e instanceof Error ? e.message : "the clipboard was unavailable",
        });
        console.info("landing-page prompt:\n" + text);
      }
    };

    return (
      <div className="rounded-lg border border-border/60 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium">{it.subject}</span>
              {/* Surfaces, not a single label: a model earns both, and showing one would hide half
                  the work the row implies. */}
              {landing && <Badge className="bg-highlight/15 text-highlight">landing</Badge>}
              <Badge className="bg-muted text-muted-foreground">blog</Badge>
              {/* A signal is a pointer at a source, not a source. Marked on the row itself because
                  the difference decides whether you can start writing or have to go confirm it
                  first, and that is not something to leave to whoever recognises the domain. */}
              {isSignal(it.source_kind) && (
                <Badge className="bg-warning/15 text-warning" title="Spotted on HN / Reddit / X — nobody has confirmed it against the vendor yet.">
                  unconfirmed
                </Badge>
              )}
              {it.route_confidence === "low" && !isSignal(it.source_kind) && (
                <Badge className="bg-warning/15 text-warning">unsure</Badge>
              )}
              <span className={cn("text-xs ml-auto", cov.className)}>{cov.text}</span>
            </div>

            {/* What the thing actually IS. The sweep has always stored this — every source writes a
                summary — and the board simply never rendered it, so a row said "gpt-sovits-ptbr-base"
                and then explained its own routing, which tells you nothing about the model. The
                description is the first thing a person needs and it was the one thing missing. */}
            {it.summary && (
              <p className="mt-0.5 text-xs text-foreground/80 line-clamp-2">{it.summary}</p>
            )}

            <p className="mt-0.5 text-xs text-muted-foreground">
              {it.item_date ?? "no date"}
              {it.date_kind === "observed" && " (observed)"}
              {it.source_name ? ` · ${it.source_name}` : ""}
              {it.coverage_detail ? ` · ${it.coverage_detail}` : ""}
            </p>
            {it.route_reason && <p className="mt-1 text-xs text-muted-foreground italic">{it.route_reason}</p>}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {/* One button per surface, and both start the work rather than recording an opinion about it.
              The pair replaces an "Open in Summer" that did not say what it would write, plus a
              surfaces toggle that only rewrote a tag — clicking it looked like starting a job and
              started nothing, which is the whole reason it is gone. The badges above still show what
              the classifier thinks; they are information, not an action. */}
          <Link
            href={`/summer?prompt=${encodeURIComponent(blogPrompt(it))}`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <Sparkles className="h-3.5 w-3.5" /> Write the blog
          </Link>

          {/* Offered on every row, not only where the classifier said "landing". It is wrong often
              enough that hiding the option would make the person go and retag the item first, which is
              the friction the toggle used to be.

              Copies rather than opening Summer: Summit does not build landing pages any more, so the
              brief has to leave the building. */}
          <button
            type="button"
            onClick={copyPrompt}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
              landing
                ? "border border-border bg-background text-foreground hover:bg-accent"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {copied
              ? <><Check className="h-3.5 w-3.5" /> Prompt copied</>
              : <><ClipboardCopy className="h-3.5 w-3.5" /> Copy the landing-page prompt</>}
          </button>

          {it.source_url && (
            <a
              href={it.source_url} target="_blank" rel="noreferrer"
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Source
            </a>
          )}

          {/* Kept: this one removes the row, which is a real action with a visible result. */}
          <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-muted-foreground"
            onClick={() => onDecide(it.id, { status: "dismissed" })}>
            <X className="h-3.5 w-3.5" /> Not covering
          </Button>
        </div>
      </div>
    );
  },
};

function Badge({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("rounded px-1.5 py-0.5 text-xs uppercase tracking-wide", className)}>
      {children}
    </span>
  );
}
