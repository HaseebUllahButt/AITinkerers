"use client";

// The drafts shell: the list on the left, the editor on the right.
// All editing, saving and Strapi syncing lives in src/components/blog/DraftEditor.tsx.
import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Newspaper, Plus, Loader2, AlertCircle, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadFailed, fetchHonest } from "@/components/ui/load-failed";
import { cn } from "@/lib/utils";
import type { BlogDraft, BlogDraftSummary } from "@/lib/db/queries";
import { DraftEditor } from "@/components/blog/DraftEditor";
import { deriveSyncState, SYNC_STATE_META } from "@/lib/blog/state";
import { publishReadiness } from "@/lib/strapi/mapDraft";
import { destinationOf, canonicalConflict } from "@/lib/blog/destination";
import { labelFor } from "@/lib/blog/origin";
import type { LiveStatus } from "@/lib/blog/liveStatus";
import * as journal from "@/lib/blog/journal";
import { PageHeader } from "@/components/layout/PageHeader";

interface MetaOption { id: number; name?: string; title?: string; slug?: string }

/**
 * Where a draft came from, as a short searchable label.
 *
 * DERIVED from created_by rather than stored in the tags column, because created_by is already the
 * truth — `api:atlas`, `api:atlas (ImagineArt automation)` and `api:atlas-endpoint-test` are all in
 * the live data. A copy in `tags` would be a second place to keep correct and would be wrong the
 * first time somebody edited it.
 */
/**
 * A short, scannable stamp — and the strings it is searchable BY.
 *
 * `label` is what the row shows. `terms` is everything a person might type to find it: the ISO date
 * for "2026-08-13", the month name for "august", the time for "12:20", and "today"/"yesterday"
 * because that is what someone actually types when a draft went missing an hour ago.
 */
function stampOf(iso: string | null | undefined): { label: string; terms: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yesterday = new Date(now.getTime() - 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = sameDay(d, now) ? "Today" : sameDay(d, yesterday) ? "Yesterday"
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const iso10 = d.toISOString().slice(0, 10);
  return {
    label: `${day} ${time}`,
    terms: [
      iso10, time, day,
      d.toLocaleDateString(undefined, { month: "long" }),
      d.toLocaleDateString(undefined, { weekday: "long" }),
      sameDay(d, now) ? "today" : "",
      sameDay(d, yesterday) ? "yesterday" : "",
    ].join(" ").toLowerCase(),
  };
}

function sourceOf(createdBy: string | null | undefined): { label: string; atlas: boolean } | null {
  // The label itself comes from blog/origin.ts, which is also what ensureThumbnails gates on — one
  // definition of "who made this", so a badge can never disagree with a sweep about it.
  const label = labelFor(createdBy);
  if (!label) return null;
  return { label, atlas: /^api:atlas/i.test((createdBy ?? "").trim()) };
}

export function DraftsShell({ initialDraftId }: { initialDraftId?: string }) {
  const [tab, setTab] = useState<"draft" | "published">("draft");
  const [drafts, setDrafts] = useState<BlogDraftSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  /** A failed list load must not render as "No posts yet" — the posts are not gone. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BlogDraft | null>(null);
  const [authors, setAuthors] = useState<MetaOption[]>([]);
  const [categories, setCategories] = useState<MetaOption[]>([]);
  const [creating, setCreating] = useState(false);
  /** Drafts with unsaved work stranded on this device — surfaced so recovery doesn't depend on
   *  remembering which post the tab died in. */
  const [orphans, setOrphans] = useState<journal.Journal[]>([]);
  /** Searches title, slug AND origin — "atlas" finds every externally-triggered draft. */
  const [query, setQuery] = useState("");
  const router = useRouter();
  /** A deep link is followed ONCE. Without this guard, every list refresh would yank the editor back
   *  to the URL's draft while someone was reading a different one. */
  const deepLinkedRef = useRef(false);
  /** What Summit is doing to each draft right now, keyed by draft id. Empty when nothing is running. */
  const [live, setLive] = useState<Record<string, LiveStatus>>({});

  const loadList = useCallback(async () => {
    setLoadingList(true);
    const { data, reason } = await fetchHonest<{ drafts: BlogDraftSummary[]; live?: Record<string, LiveStatus> }>(`/api/blog/drafts?status=${tab}`);
    if (data) { setDrafts(data.drafts); setLive(data.live ?? {}); setLoadError(null); }
    else setLoadError(reason); // keep whatever list is already on screen
    setLoadingList(false);
  }, [tab]);

  useEffect(() => { loadList(); }, [loadList]);

  // Follow a /drafts/<id> deep link. Fires after the first list load rather than on mount so a
  // failed fetch does not leave the editor open beside a list that says "couldn't load".
  useEffect(() => {
    if (!initialDraftId || deepLinkedRef.current) return;
    deepLinkedRef.current = true;
    void openDraft(initialDraftId);
    // openDraft is a stable function declaration over setState and the router; including it would
    // rebuild this effect on every render and re-open the draft mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDraftId]);

  /**
   * Re-poll only while something is actually running, and only while the tab is visible.
   *
   * A list that polls forever is a request every few seconds for a number that has not changed
   * since yesterday. The moment the last run finishes, `live` empties and this stops on its own.
   */
  const anyRunning = Object.keys(live).length > 0;
  useEffect(() => {
    if (!anyRunning) return;
    const tick = () => { if (document.visibilityState === "visible") void loadList(); };
    const id = setInterval(tick, 8000);
    return () => clearInterval(id);
  }, [anyRunning, loadList]);
  useEffect(() => {
    fetch("/api/blog/meta").then((r) => r.json()).then((d) => {
      if (d?.ok) { setAuthors(d.authors); setCategories(d.categories); }
    }).catch(() => {});
  }, []);

  // Recomputed after the list loads so the banner can count the affected posts. Kept in an effect
  // rather than a render-time useMemo because it reads localStorage — a browser side effect that
  // would risk a hydration mismatch during render.
  useEffect(() => {
    if (!journal.available()) return;
    const known = new Set(drafts.map((d) => d.id));
    setOrphans(journal.listOrphans().filter((j) => known.has(j.draftId) && j.draftId !== selected?.id));
  }, [drafts, selected?.id]);

  async function newPost() {
    setCreating(true);
    try {
      const d = await fetch("/api/blog/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "", body: "", description: "", is_featured: false, should_index: true }),
      }).then((r) => r.json());
      if (d?.ok) { setTab("draft"); await loadList(); setSelected(d.draft); }
      else toast.error(d?.error ?? "Failed to create draft.");
    } catch (e: any) { toast.error(e?.message ?? "Failed."); }
    finally { setCreating(false); }
  }

  /** Keep the list row in step with the editor without refetching on every autosave. */
  const onDraftChanged = useCallback((row: BlogDraft) => {
    setSelected((s) => (s?.id === row.id ? { ...s, ...row } : s));
    setDrafts((list) => list.map((d) => (d.id === row.id ? { ...d, ...row } : d)));
  }, []);

  async function remove(d: BlogDraft) {
    const live = !!d.strapi_published_at;
    const inStrapi = !!d.strapi_id;
    const note = live
      ? "It stays LIVE in Strapi — unpublish there first if you want it taken down."
      : inStrapi ? "The Strapi draft is not affected." : "";
    if (!confirm(`Delete "${d.title || "untitled"}"?\n\n${note}`)) return;
    await fetch(`/api/blog/drafts/${d.id}`, { method: "DELETE" }).catch(() => {});
    journal.clear(d.id);
    if (selected?.id === d.id) setSelected(null);
    await loadList();
  }

  /**
   * Load the full draft for the editor.
   *
   * The list only carries a summary now (title, slug, sync columns) — sending every draft's body to
   * render a sidebar was 79% of a 92KB response. So opening one fetches it. `?live=0` skips the Strapi
   * round-trip, which the editor does not need to start editing.
   */
  const [opening, setOpening] = useState<string | null>(null);
  /**
   * Open a draft AND make the URL say so.
   *
   * `replace` rather than `push`: clicking through six drafts in the list should not bury the page
   * someone arrived from under six back-button presses. The URL is here to be copied and shared,
   * not to be a history trail.
   */
  async function openDraft(draftId: string) {
    router.replace(`/drafts/${draftId}`, { scroll: false });
    if (selected?.id === draftId) return;
    setOpening(draftId);
    try {
      const d = await fetch(`/api/blog/drafts/${draftId}?live=0`).then((r) => r.json());
      if (!d?.ok || !d.draft) { toast.error(d?.error ?? "Couldn't open that draft."); return; }
      setSelected(d.draft);
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't open that draft.");
    } finally { setOpening(null); }
  }

  // Origin is searchable by its LABEL and by the raw created_by, so both "atlas" and the full
  // address a person recognises will find the same rows.
  const q = query.trim().toLowerCase();
  const shown = !q ? drafts : drafts.filter((d) => {
    const src = sourceOf(d.created_by);
    return (
      (d.title ?? "").toLowerCase().includes(q) ||
      (d.slug ?? "").toLowerCase().includes(q) ||
      (d.created_by ?? "").toLowerCase().includes(q) ||
      (src?.label ?? "").toLowerCase().includes(q) ||
      (stampOf(d.created_at)?.terms ?? "").includes(q) ||
      (stampOf(d.updated_at)?.terms ?? "").includes(q)
    );
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader icon={Newspaper} title="Blogs" description="Drafts and published posts." />
      <div className="flex min-h-0 flex-1 gap-6">
      {/* List */}
      <div className="w-80 shrink-0 h-full min-h-0 flex flex-col overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-[64px] backdrop-saturate-[1.65] shadow-[var(--glass-shadow)]">
        <div className="p-3 border-b border-border space-y-2">
          <Button size="sm" className="w-full gap-1.5" onClick={newPost} disabled={creating}>
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} New draft
          </Button>
          <div className="flex gap-1 text-xs">
            {(["draft", "published"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={cn("flex-1 px-2 py-1 rounded-md capitalize",
                  tab === t ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50")}>
                {/* Not `{t}s` — that rendered "Publisheds". The plural of a past participle is the
                    word itself, so the label is spelled out rather than derived. */}
                {t === "draft" ? "Drafts" : "Published"}
              </button>
            ))}
          </div>
        </div>

        <div className="px-3 pb-3 -mt-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title, slug, source or date"
              className="h-7 w-full rounded-md border border-border/60 bg-transparent pl-7 pr-7 text-xs outline-none placeholder:text-muted-foreground focus:border-border"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {orphans.length > 0 && (
          <button
            onClick={() => { void openDraft(orphans[0].draftId); }}
            className="text-left px-3 py-2 bg-highlight-soft border-b border-highlight/40 text-xs flex items-start gap-1.5"
          >
            <AlertCircle className="h-3.5 w-3.5 text-highlight-ink shrink-0 mt-0.5" />
            <span>
              Unsaved changes kept on this device in {orphans.length} other{" "}
              {orphans.length === 1 ? "draft" : "drafts"}. Open to review.
            </span>
          </button>
        )}

        {loadError && (
          <LoadFailed nothing="your posts" detail={loadError} onRetry={() => void loadList()} className="mx-3 mt-3" />
        )}

        <div className="flex-1 overflow-y-auto">
          {loadingList ? (
            <div className="p-4 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-muted-foreground" /></div>
          ) : drafts.length === 0 && !loadError ? (
            <p className="p-4 text-xs text-muted-foreground text-center">No {tab} posts yet.</p>
          ) : shown.length === 0 ? (
            // Distinct from "none exist". A search that matches nothing is not an empty account,
            // and saying so is what stops someone concluding their drafts are gone.
            <p className="p-4 text-xs text-muted-foreground text-center">
              Nothing matches &ldquo;{query}&rdquo; in these {tab}s.
            </p>
          ) : (
            shown.map((d) => {
              const meta = SYNC_STATE_META[deriveSyncState(d)];
              const src = sourceOf(d.created_by);
              const stamp = stampOf(d.created_at);
              const upd = stampOf(d.updated_at);
              const edited = upd && d.updated_at && d.created_at
                && Date.parse(d.updated_at) - Date.parse(d.created_at) > 60_000 ? upd : null;
              // Computed with the SAME function the publish route gates on, so the list can never
              // say a draft is ready when publishing would refuse it. A row that looks finished and
              // then will not publish is the failure this exists to prevent.
              const blockers = publishReadiness(d);
              const status = live[d.id];
              // Where this row actually publishes, and whether its canonical contradicts that. Both
              // were invisible before: strapi_collection appeared in no UI at all, so a draft bound
              // for a different collection looked identical to an ordinary blog post.
              const dest = destinationOf(d);
              const conflict = canonicalConflict(d);
              return (
                <button key={d.id} onClick={() => openDraft(d.id)}
                  className={cn("w-full text-left px-3 py-2.5 border-b border-border/60 hover:bg-muted/40",
                    selected?.id === d.id && "bg-highlight-soft")}>
                  {/* truncate has to sit on the TEXT node, not on the flex row: text-overflow does
                      not apply to a flex container, so putting them together clipped titles
                      mid-character instead of ellipsising them. */}
                  <p className="flex items-center gap-1.5 min-w-0">
                    {opening === d.id && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
                    <span className="text-sm font-medium truncate">{d.title || "Untitled"}</span>
                  </p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5 font-mono">{d.slug}</p>
                  {/* Two lines, not one. Four items on a 320px rail wrapped mid-phrase — "Local
                      ahead of Strapi" broke across three lines and pushed the badges out of
                      alignment. Facts on top, labels underneath, nothing wraps. */}
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {stamp && (
                      <span title={`Created ${new Date(d.created_at!).toLocaleString()}`} className="shrink-0 tabular-nums">
                        {stamp.label}
                      </span>
                    )}
                    <span className="opacity-40">·</span>
                    {/* While a run is live its status REPLACES the sync state rather than sitting
                        beside it. "Local only · Writing 9/14" is two answers to one question, and
                        the column is narrow enough that the second one wraps. */}
                    {status ? (
                      <span className={cn("truncate",
                        status.state === "failed" || status.state === "stalled" ? "text-warning" : "text-highlight-ink")}>
                        {status.label}
                      </span>
                    ) : (
                      <span className="truncate">{meta.label}</span>
                    )}
                  </p>
                  {/* Edited is shown ONLY when it differs from created by more than a minute. Every
                      draft is "updated" the instant it is made, so printing both on a brand-new row
                      would be two identical timestamps and a reader learning to ignore one of them. */}
                  {edited && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <span title={`Last updated ${new Date(d.updated_at!).toLocaleString()}`} className="tabular-nums">
                        edited {edited.label}
                      </span>
                    </p>
                  )}
                  {/* Blockers are hidden while a run is in flight: a draft mid-write is SUPPOSED to
                      be missing its title and thumbnail, and flagging that as a problem every eight
                      seconds is exactly the crowding this column does not need. */}
                  {((blockers.length > 0 && !status) || src || !dest.isBlog || conflict) && (
                    <p className="mt-1 flex flex-wrap items-center gap-1.5">
                      {/* Destination is badged ONLY when it is not the blog, and that asymmetry is the
                          point. Every draft that sets nothing goes to the blog, so a "BLOG" pill on all
                          44 rows is a constant that teaches people to stop reading this line. A pill
                          that appears only when the answer is surprising is a pill that gets read. */}
                      {!dest.isBlog && (
                        <span
                          title={`Publishes into the "${dest.collection}" Strapi collection, not the blog`}
                          className="shrink-0 rounded bg-highlight/15 px-1 py-px text-xs uppercase tracking-wide text-highlight-ink"
                        >
                          {dest.label}
                        </span>
                      )}
                      {conflict && (
                        <span
                          title={conflict}
                          className="shrink-0 rounded bg-destructive/15 px-1 py-px text-xs uppercase tracking-wide text-destructive"
                        >
                          canonical
                        </span>
                      )}
                      {blockers.length > 0 && !status && (
                        <span
                          title={`Cannot publish yet:\n· ${blockers.join("\n· ")}`}
                          className="shrink-0 rounded bg-warning/15 px-1 py-px text-xs uppercase tracking-wide text-warning"
                        >
                          {blockers.length} blocker{blockers.length === 1 ? "" : "s"}
                        </span>
                      )}
                      {src && (
                        <span
                          title={`Created by ${d.created_by}`}
                          className={cn(
                            "shrink-0 rounded px-1 py-px text-xs uppercase tracking-wide",
                            src.atlas ? "bg-highlight/15 text-highlight-ink" : "bg-muted text-muted-foreground",
                          )}
                        >
                          {src.label}
                        </span>
                      )}
                    </p>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-y-auto pr-1">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            Pick a post on the left, or start a new one.
          </div>
        ) : (
          <DraftEditor
            key={selected.id}
            draft={selected}
            authors={authors}
            categories={categories}
            onDraftChanged={onDraftChanged}
            onDeleted={remove}
          />
        )}
      </div>
      </div>
    </div>
  );
}
