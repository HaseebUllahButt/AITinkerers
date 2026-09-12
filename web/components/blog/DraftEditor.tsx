"use client";

// The editor pane. Extracted out of src/app/blog/page.tsx (which is now just the list + shell) so
// the body editor can grow its own affordances without the file becoming unreadable.
//
// The save model, and why it looks like this:
//  - There is no Save button. Edits autosave to our Postgres, and the SaveStatus chip is the
//    feedback. Cmd/Ctrl+S still works for people who reflexively reach for it.
//  - Autosave NEVER touches Strapi. "Sync to Strapi" and "Publish" are separate explicit actions
//    on the SyncStatus chip. Previously a save pushed straight to live Strapi whenever the post had
//    been published, which made autosave impossible to add safely.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, Rocket, Trash2, Image as ImageIcon, Search, RotateCcw, Copy, Sparkles, Scissors, Wand2, Upload,
  Link2, ShieldCheck, TriangleAlert, CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { BlogDraft } from "@/lib/db/queries";
import type { LinkCheckReport } from "@/lib/blog/linkCheck";
import { publishReadiness } from "@/lib/strapi/mapDraft";
import { destinationOf, canonicalConflict } from "@/lib/blog/destination";
import { slugify, slugFromTitle } from "@/lib/blog/fields";
import { deriveSyncState } from "@/lib/blog/state";
import { useDraftAutosave } from "@/lib/blog/useDraftAutosave";
import { SaveStatus } from "./SaveStatus";
import { SyncStatus } from "./SyncStatus";
import { ConflictDialog } from "./ConflictDialog";
import { RevisionsPopover } from "./RevisionsPopover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MarkdownPreview } from "@/lib/blog/markdownPreview";
import { PathCombobox } from "@/components/ui/path-combobox";
import { GalleryPicker } from "./GalleryPicker";
import { useKnownPages } from "@/lib/hooks/useKnownPages";
import {
  readBlocks, blocksInRange, revealIn, revealOffsetInTextarea, sourceRangeFromPreviewSelection,
  paintSelection, clearSelectionPaint, caretRectFor, scrollTopFor,
} from "@/lib/blog/paneSync";

interface MetaOption { id: number; name?: string; title?: string; slug?: string }

interface Props {
  draft: BlogDraft;
  authors: MetaOption[];
  categories: MetaOption[];
  /** Bubble the fresh row up so the list pane's title/slug stay current. */
  onDraftChanged: (d: BlogDraft) => void;
  onDeleted: (d: BlogDraft) => void;
}

export function DraftEditor({ draft, authors, categories, onDraftChanged, onDeleted }: Props) {
  const [form, setForm] = useState<Partial<BlogDraft>>(draft);
  const [slugTouched, setSlugTouched] = useState(true);
  const [uploading, setUploading] = useState<"cover" | "thumbnail" | "inline" | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  // Populated only from a blocked publish attempt (see strapiAction) — there is no separate
  // "check links" action. Reusing the existing publish-blocker banner below to show it means this
  // needed no new button or card, just a truthier error than the one-line toast already gave.
  const [linkCheck, setLinkCheck] = useState<LinkCheckReport | null>(null);
  const [fillBusy, setFillBusy] = useState(false);
  const [fillReport, setFillReport] = useState<{
    filled: Array<{ field: string; source: string; note?: string }>;
    skipped: Array<{ field: string; why: string }>;
    notes: string[];
  } | null>(null);
  const [viewMode, setViewMode] = useState<"write" | "split" | "preview">("split");
  const [dragging, setDragging] = useState(false);
  /** The live selection in the body, mirrored into state so the toolbar can show its word count.
   *  Kept as offsets, not text, so it stays correct if the body changes underneath. */
  const [sel, setSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [shortenOpen, setShortenOpen] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [shortenTarget, setShortenTarget] = useState(0);
  const [rewritePrompt, setRewritePrompt] = useState("");
  const [reviseBusy, setReviseBusy] = useState<"shorten" | "rewrite" | null>(null);
  /** The body as it was before the last AI edit. Present means an Undo button is showing. A
   *  textarea's native undo stack does not survive a programmatic value change, so we keep our own. */
  const [undoBody, setUndoBody] = useState<string | null>(null);
  /** Where to draw the preview's caret bar, in the preview's scroll coordinates. */
  const [caret, setCaret] = useState<{ top: number; left: number; height: number } | null>(null);
  /** Which pane caused the current selection. A change that came FROM the preview must not scroll the
   *  preview back — the user is already looking at the right place, and moving it under their cursor
   *  feels like the page fighting them. */
  const syncOrigin = useRef<"md" | "preview">("md");
  /** Every real page on the site, for the canonical picker. Cached server-side, so this is cheap. */
  const knownPages = useKnownPages();
  /** Which image slot the gallery picker is currently filling, or null when it is closed. */
  const [picking, setPicking] = useState<"cover" | "thumbnail" | "inline" | null>(null);
  /** Which conflict the user already dismissed, keyed by the other side's rev — so "Decide later"
   *  hides this one but a genuinely new conflict still opens the dialog. Derived rather than an
   *  effect that mirrors autosave.state into local state. */
  const [dismissedConflictRev, setDismissedConflictRev] = useState<number | null>(null);

  const formRef = useRef<Partial<BlogDraft>>(form);
  useEffect(() => { formRef.current = form; }, [form]);

  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const thumbInputRef = useRef<HTMLInputElement>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);
  /** The scrolling preview container. Needed as a ref, not a query, so the sync effect never has to
   *  guess which element scrolls. */
  const previewRef = useRef<HTMLDivElement>(null);

  // Adopt a server row wholesale (a restore, or "load theirs" in a conflict).
  const adopt = useCallback((row: BlogDraft) => {
    setForm(row);
    formRef.current = row;
    onDraftChanged(row);
  }, [onDraftChanged]);

  const autosave = useDraftAutosave({
    draftId: draft.id,
    initial: draft,
    formRef,
    onServerRow: onDraftChanged,
  });

  // No re-seed effect for a draft switch: page.tsx renders this with key={draft.id}, so switching
  // drafts remounts the component and useState(draft) does the seeding.
  const conflictOpen = autosave.state === "conflict"
    && (autosave.conflictRow?.rev ?? -1) !== dismissedConflictRev;

  function set<K extends keyof BlogDraft>(key: K, value: BlogDraft[K]) {
    setForm((f) => {
      const next: Partial<BlogDraft> = { ...f, [key]: value };
      // The subject, not the whole title — see slugFromTitle. Typing in the slug box below still
      // goes through plain slugify, because an edited slug is a decision, not a title to reinterpret.
      if (key === "title" && !slugTouched) next.slug = slugFromTitle(String(value));
      formRef.current = next;
      autosave.markDirty(next);
      return next;
    });
  }

  // ── Uploads ──
  async function upload(kind: "cover" | "thumbnail" | "inline", file: File) {
    setUploading(kind);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("alt", kind === "inline" ? file.name : form.title || kind);
      const d = await fetch("/api/blog/upload", { method: "POST", body: fd }).then((r) => r.json());
      if (!d?.ok) { toast.error(d?.error ?? "Upload failed."); return; }
      if (kind === "cover") {
        set("cover_media_id", d.media[0].id);
        set("cover_media_url", d.url);
      } else if (kind === "thumbnail") {
        set("thumbnail_media_id", d.media[0].id);
        set("thumbnail_media_url", d.url);
      } else {
        const ta = bodyRef.current;
        const md = d.markdown as string;
        const cur = form.body ?? "";
        const pos = ta?.selectionStart ?? cur.length;
        const next = `${cur.slice(0, pos)}\n${md}\n${cur.slice(pos)}`;
        set("body", next);
        if (ta) requestAnimationFrame(() => {
          ta.focus();
          ta.selectionStart = ta.selectionEnd = pos + md.length + 2;
        });
      }
      toast.success("Image uploaded.");
    } catch (e: any) {
      toast.error(e?.message ?? "Upload failed.");
    } finally {
      setUploading(null);
    }
  }

  /**
   * Place an image chosen from the gallery. Same three destinations as an upload — the difference is
   * only where the bytes came from.
   */
  function placeFromGallery(slot: "cover" | "thumbnail" | "inline", img: { url: string; alt: string }) {
    if (slot === "cover") {
      set("cover_media_url", img.url);
    } else if (slot === "thumbnail") {
      set("thumbnail_media_url", img.url);
    } else {
      const ta = bodyRef.current;
      const md = `![${img.alt}](${img.url})`;
      const cur = form.body ?? "";
      const pos = ta?.selectionStart ?? cur.length;
      const next = `${cur.slice(0, pos)}\n${md}\n${cur.slice(pos)}`;
      set("body", next);
      if (ta) requestAnimationFrame(() => {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = pos + md.length + 2;
      });
    }
    // A gallery asset has no Strapi media id until it is promoted, so cover/thumbnail keep the URL
    // only. publishReadiness still requires a real thumbnail_media_id, which is the correct gate.
    toast.success(slot === "inline" ? "Image inserted." : `Set as the ${slot}.`);
  }

  /** We block publish on a thumbnail (it's the social/preview card), and it's usually the same
   *  asset as the cover — so offer a one-click copy rather than a second upload. */
  function useCoverAsThumbnail() {
    if (!form.cover_media_id) return;
    set("thumbnail_media_id", form.cover_media_id);
    set("thumbnail_media_url", form.cover_media_url ?? null);
  }

  /**
   * Fill everything left blank: title, description, SEO, tags, slug, CTA, thumbnail, author,
   * category. Only blanks — anything already typed is untouchable, which is what makes this safe to
   * press on a draft you have been editing.
   *
   * Flushes the pending autosave first. The server reads the DB row, not this form, so without the
   * flush it would judge fields as "empty" that were typed seconds ago and overwrite them.
   */
  async function fillBlanks() {
    await autosave.flush();
    setFillBusy(true);
    try {
      const d = await fetch(`/api/blog/drafts/${draft.id}/autofill`, { method: "POST" }).then((r) => r.json());
      if (!d?.ok) { toast.error(d?.error ?? "Autofill failed."); return; }
      if (d.draft) adopt(d.draft);
      setFillReport({ filled: d.filled ?? [], skipped: d.skipped ?? [], notes: d.notes ?? [] });
      const n = (d.filled ?? []).length;
      if (n === 0) toast.success("Nothing left to fill.");
      else toast.success(`Filled ${n} field${n === 1 ? "" : "s"}. Undo from the revisions menu.`);
    } catch (e: any) {
      toast.error(e?.message ?? "Autofill failed.");
    } finally {
      setFillBusy(false);
    }
  }

  // ── Selection-scoped AI edits ──

  /** Mirror the textarea's selection into state on every event that can change it. */
  function syncSelection() {
    const ta = bodyRef.current;
    if (!ta) return;
    syncOrigin.current = "md";
    setSel((prev) => (prev.start === ta.selectionStart && prev.end === ta.selectionEnd
      ? prev                                     // same selection: don't re-render
      : { start: ta.selectionStart, end: ta.selectionEnd }));
  }

  const body = form.body ?? "";
  const selText = body.slice(sel.start, sel.end);
  const selWords = selText.trim() ? selText.trim().split(/\s+/).filter(Boolean).length : 0;

  /**
   * Keep the two panes in step.
   *
   * Two separate things, deliberately: the SELECTION is painted on the exact characters (via the CSS
   * Custom Highlight API, so no DOM is mutated and React never fights it), and the CARET is drawn as a
   * thin blinking bar at the mapped position. An earlier version highlighted whole blocks with a left
   * rule, which flooded a whole paragraph for a three-word selection and left a hard line sitting on
   * the text — both wrong. Nothing is painted for a bare caret, so one click clears a selection.
   *
   * Runs on selection change and on body change, since re-rendering replaces the nodes any range was
   * built over.
   */
  useEffect(() => {
    if (viewMode === "write") return;
    const container = previewRef.current;
    if (!container) return;

    paintSelection(container, sel.start, sel.end);

    // Caret bar. Measured after paint so the geometry reflects the current layout.
    const rect = caretRectFor(container, sel.start);
    setCaret(rect);

    // Follow the caret, but only when it is out of a comfortable band, so typing inside a visible
    // paragraph does not cause constant small scrolls. Skipped when the selection came from the
    // preview itself.
    if (syncOrigin.current === "md") {
      if (rect) {
        const next = scrollTopFor(container, rect.top, rect.height, 64);
        if (next !== null) container.scrollTop = next;
      } else {
        const hits = blocksInRange(readBlocks(container), sel.start, sel.end);
        if (hits[0]) revealIn(container, hits[0].el);
      }
    }
    syncOrigin.current = "md";
  }, [sel, form.body, viewMode]);

  // The paint is global (CSS.highlights is document-scoped), so it has to go when this editor does.
  useEffect(() => () => clearSelectionPaint(), []);

  /**
   * The reverse direction: click or select in the PREVIEW and the markdown pane follows — it scrolls
   * to the same place and selects the same characters, so the native textarea selection is the
   * highlight. Character-level, not whole-block.
   *
   * The textarea is focused so that selection is actually visible; an unfocused textarea shows no
   * selection in most browsers. Doing it on mouseup means a drag across several paragraphs completes
   * before focus moves.
   */
  function syncFromPreview() {
    const range = sourceRangeFromPreviewSelection(previewRef.current);
    const ta = bodyRef.current;
    if (!range || !ta) return;
    const text = ta.value;
    const start = Math.max(0, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));

    syncOrigin.current = "preview";
    setSel({ start, end });
    revealOffsetInTextarea(ta, start);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(start, end);
  }

  // Keep the shorten target in step with the selection, unless the user has typed their own.
  const lastSuggestedRef = useRef(0);
  useEffect(() => {
    const suggested = selWords > 12 ? Math.max(10, Math.round((selWords * 0.75) / 5) * 5)
      : Math.max(5, selWords - 2);
    if (shortenTarget === 0 || shortenTarget === lastSuggestedRef.current) setShortenTarget(suggested);
    lastSuggestedRef.current = suggested;
  }, [selWords]);   // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Shorten or rewrite. Operates on the selection, or the whole body when nothing is selected.
   *
   * The replacement is spliced in client-side and then autosaved like any other edit, so it shows up
   * in the preview immediately and is undoable both from the Undo button and from History.
   */
  async function revise(mode: "shorten" | "rewrite", opts: { target_words?: number; instruction?: string }) {
    const whole = selWords === 0;
    const target = whole ? body : selText;
    if (!target.trim()) { toast.error("Nothing to change."); return; }

    setReviseBusy(mode);
    try {
      const d = await fetch(`/api/blog/drafts/${draft.id}/revise`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode, text: target, ...opts,
          before: whole ? "" : body.slice(Math.max(0, sel.start - 1200), sel.start),
          after: whole ? "" : body.slice(sel.end, sel.end + 1200),
        }),
      }).then((r) => r.json());

      if (!d?.ok) { toast.error(d?.error ?? "That edit failed."); return; }

      setUndoBody(body);
      const next = whole ? d.text : body.slice(0, sel.start) + d.text + body.slice(sel.end);
      set("body", next);
      // Re-select the new text so a second pass (shorten again, then rewrite) needs no re-selecting.
      if (!whole) {
        const end = sel.start + d.text.length;
        setSel({ start: sel.start, end });
        requestAnimationFrame(() => {
          const ta = bodyRef.current;
          if (ta) { ta.focus(); ta.setSelectionRange(sel.start, end); }
        });
      }
      setRewritePrompt("");

      const fixes = (d.fixes ?? []) as string[];
      toast.success(
        `${d.words_before} → ${d.words_after} words.${fixes.length ? ` ${fixes.join(" ")}` : ""}`,
      );
    } catch (e: any) {
      toast.error(e?.message ?? "That edit failed.");
    } finally {
      setReviseBusy(null);
    }
  }

  function undoRevise() {
    if (undoBody === null) return;
    set("body", undoBody);
    setUndoBody(null);
    toast.success("Reverted.");
  }

  // ── Strapi actions. Each flushes the local save first so we never push stale content. ──
  async function strapiAction(path: "sync" | "publish" | "unpublish", force = false) {
    await autosave.flush();
    setSyncBusy(true);
    try {
      const d = await fetch(`/api/blog/drafts/${draft.id}/${path}`, {
        method: "POST",
        headers: force ? { "Content-Type": "application/json" } : undefined,
        body: force ? JSON.stringify({ force: true }) : undefined,
      }).then((r) => r.json());
      if (d?.ok) {
        adopt(d.draft);
        setLinkCheck(null); // whatever was blocking is gone now — the stale report would look wrong
        toast.success(
          path === "sync" ? "Synced — it's a draft in Strapi, not live."
          : path === "publish" ? `Published to ${d.host ?? "Strapi"}.`
          : "Unpublished — it's a Strapi draft again.",
        );
      } else {
        if (d?.draft) adopt(d.draft);
        // The publish route's link gate ships its full report in the failure body specifically so
        // the UI isn't limited to the one-line error string. Route it into the same card the on-demand
        // checker renders, so a blocked publish and a manual check produce identical, familiar output
        // rather than a toast that can't show which link or offer the suggested fix.
        if (d?.linkCheck) setLinkCheck(d.linkCheck);
        toast.error(d?.error ?? `${path} failed.`);
      }
    } catch (e: any) {
      toast.error(e?.message ?? `${path} failed.`);
    } finally {
      setSyncBusy(false);
    }
  }

  /** Last-resort export: works even if Postgres and localStorage are both unavailable. */
  function downloadMarkdown() {
    const name = (form.slug || "draft").replace(/[^a-z0-9-]/gi, "-");
    const blob = new Blob([`# ${form.title ?? ""}\n\n${form.body ?? ""}`], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** True when a drag carries an image, so we only light up the drop zone for something we can use
   *  (dragging selected text inside the textarea must not look like an upload). */
  function hasImage(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    return Array.from(dt.items ?? []).some((i) => i.kind === "file" && i.type.startsWith("image/"))
      || Array.from(dt.types ?? []).includes("Files");
  }

  const titleLen = (form.title ?? "").length;
  const descLen = (form.description ?? "").length;
  // Single source of truth — the same function the publish route enforces, so the UI can never
  // disagree with the server about what's blocking a publish.
  const problems = useMemo(() => publishReadiness(form), [form]);
  // Destination and canonical are recomputed from the live form, not the saved row, so editing the
  // canonical field shows the conflict appear or clear as you type rather than after a save.
  const destination = useMemo(() => destinationOf(form), [form]);
  const conflict = useMemo(() => canonicalConflict(form), [form]);
  const row = autosave.server ?? draft;
  const syncState = deriveSyncState(row);
  const wordCount = (form.body ?? "").trim().split(/\s+/).filter(Boolean).length;

  return (
    <div className="space-y-5 pb-10">
      {/* Sticky header: both chips, always visible while scrolling a long post.
          Full width on purpose. When it was capped at max-w-3xl the wider body panes scrolled
          past its blurred backdrop and showed through as ghost boxes beside it. The controls
          inside stay at a readable measure. */}
      <div className="sticky top-0 z-10 mb-3 rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bar)] px-3 py-2.5 backdrop-blur-[24px] space-y-2">
        <div className="max-w-3xl flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1">
            <SaveStatus
              state={autosave.state}
              lastSavedAt={autosave.lastSavedAt}
              retryInSec={autosave.retryInSec}
              onRetry={autosave.retryNow}
              onResolveConflict={() => setDismissedConflictRev(null)}
              onDownload={downloadMarkdown}
            />
            <RevisionsPopover draftId={draft.id} onRestored={adopt} />
          </div>
          <div className="flex items-center gap-1">
            <Button size="xs" variant="outline" className="gap-1.5" disabled={fillBusy}
              title="Fill title, description, SEO, tags, CTA, thumbnail, author and category — only where you left them empty"
              onClick={fillBlanks}>
              {fillBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              Fill the blanks
            </Button>
            <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive gap-1"
              onClick={() => onDeleted(draft)}>
              <Trash2 className="h-3 w-3" /> Delete
            </Button>
          </div>
        </div>
        <div className="max-w-3xl"><SyncStatus
          state={syncState}
          adminUrl={row.strapi_url}
          syncError={row.sync_error}
          busy={syncBusy}
          publishProblems={problems}
          onSync={() => strapiAction("sync")}
          onPublish={() => strapiAction("publish")}
          onUnpublish={() => strapiAction("unpublish")}
        /></div>
      </div>

      {/* Recovery: a journal newer than the server means the last session ended badly. Never
          auto-applied — auto-applying is how you resurrect something deliberately deleted. */}
      {autosave.recovered && (
        <div className="rounded-lg border border-highlight/40 bg-highlight-soft px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs">
            Unsaved changes from {new Date(autosave.recovered.savedAt).toLocaleString()} were found
            on this device.
          </p>
          <div className="flex gap-2">
            <Button size="xs" variant="ghost" onClick={autosave.dismissRecovered}>Discard</Button>
            <Button size="xs" className="gap-1" onClick={() => {
              const fields = autosave.recovered!.fields;
              const next = { ...form, ...fields };
              setForm(next);
              formRef.current = next;
              autosave.markDirty(next);
              autosave.dismissRecovered();
            }}>
              <RotateCcw className="h-3 w-3" /> Restore
            </Button>
          </div>
        </div>
      )}

      {/* WHERE this publishes, stated outright and always — not only when it is unusual.
          The drafts LIST badges the destination only when it is surprising, because a constant on 44
          rows stops being read. An editor shows one draft, so the same line is pure signal here, and
          the question it answers ("is this a blog post or a landing page?") was previously
          unanswerable from this screen: strapi_collection appeared in no UI at all. */}
      <div className="text-xs text-muted-foreground bg-muted/40 border border-border/60 rounded-md px-3 py-2">
        <span className="font-medium text-foreground">Publishes to:</span>{" "}
        {destination.isBlog ? "the blog" : `the "${destination.collection}" collection`}
        {destination.pathPrefix && form.slug ? (
          <span className="font-mono"> · {destination.pathPrefix}{form.slug}</span>
        ) : null}
        {!destination.isBlog && (
          // Deliberately not a guessed path. A cluster page's live URL depends on its `category`
          // enum, which the imagine-web route folders gate on and this app cannot see from here.
          <span> · the live path comes from the entry&apos;s category, not from this slug</span>
        )}
      </div>

      {conflict && (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          <span className="font-medium">Canonical conflict:</span> {conflict}
        </div>
      )}

      {problems.length > 0 && (
        <div className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-md px-3 py-2">
          <span className="font-medium">Before publishing:</span> {problems.join(" · ")}
        </div>
      )}

      {/* Populated only when Publish was actually blocked on a dead link (see strapiAction) — this
          is the SAME check the server just ran, rendered in full instead of the one-line toast. No
          separate "check my links" control exists; the publish button already runs it every time. */}
      {linkCheck && linkCheck.broken.length > 0 && (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2 space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">
              {linkCheck.broken.length} link{linkCheck.broken.length === 1 ? "" : "s"} {linkCheck.broken.length === 1 ? "doesn't" : "don't"} resolve:
            </span>
            {/* An override, not a bypass: it re-sends the exact same publish action with force:true,
                so it goes through the identical readiness checks and revision history — only the
                link gate is skipped, and only because a human looked at the list above it and chose to. */}
            <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive shrink-0"
              disabled={syncBusy} onClick={() => strapiAction("publish", true)}>
              Publish anyway
            </Button>
          </div>
          <ul className="space-y-1">
            {linkCheck.broken.map((b, i) => (
              <li key={i} className="break-words">
                <span className="font-mono">{b.url}</span>
                {b.anchor && <span className="text-muted-foreground"> ("{b.anchor}")</span>}
                {b.suggestions[0] && (
                  <span className="text-muted-foreground"> — try <span className="font-mono">{b.suggestions[0]}</span></span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* What autofill did, and — just as important — what it refused to decide for you. */}
      {fillReport && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 space-y-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-highlight-ink" />
              {fillReport.filled.length
                ? `Filled ${fillReport.filled.length} field${fillReport.filled.length === 1 ? "" : "s"}`
                : "Nothing to fill"}
            </p>
            <Button size="xs" variant="ghost" onClick={() => setFillReport(null)}>Dismiss</Button>
          </div>
          {fillReport.filled.length > 0 && (
            <ul className="space-y-0.5">
              {fillReport.filled.map((f) => (
                <li key={f.field} className="text-muted-foreground">
                  <span className="text-foreground">{FIELD_LABEL[f.field] ?? f.field}</span>
                  {" — "}{f.source}{f.note ? ` (${f.note})` : ""}
                </li>
              ))}
            </ul>
          )}
          {fillReport.skipped.length > 0 && (
            <>
              <p className="font-medium text-muted-foreground pt-1">Left for you to decide</p>
              <ul className="space-y-0.5">
                {fillReport.skipped.map((s) => (
                  <li key={s.field} className="text-muted-foreground">
                    <span className="text-foreground">{FIELD_LABEL[s.field] ?? s.field}</span> — {s.why}
                  </li>
                ))}
              </ul>
            </>
          )}
          {fillReport.notes.length > 0 && (
            <ul className="space-y-0.5 pt-1 text-warning/90">
              {fillReport.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Title + slug */}
      <div className="max-w-3xl space-y-1.5">
        <Label htmlFor="title" className="flex items-center justify-between">
          <span>Title</span>
          <span className={cn("text-xs", titleLen < 35 ? "text-warning" : "text-muted-foreground")}>{titleLen}/35 min</span>
        </Label>
        <Input id="title" value={form.title ?? ""} onChange={(e) => set("title", e.target.value)}
          placeholder="A compelling, keyword-rich title" />
      </div>
      <div className="max-w-3xl space-y-1.5">
        <Label htmlFor="slug">Slug <span className="text-muted-foreground font-normal">(must be unique across the whole blog)</span></Label>
        <Input id="slug" value={form.slug ?? ""} className="font-mono text-sm"
          onChange={(e) => { setSlugTouched(true); set("slug", slugify(e.target.value)); }} />
      </div>

      {/* Cover + thumbnail. Thumbnail is REQUIRED by Strapi and was missing from this app
          entirely, which is why publishing could never succeed. */}
      <div className="max-w-3xl grid grid-cols-2 gap-4">
        {([
          { kind: "cover" as const, label: "Cover image", urlKey: "cover_media_url" as const, ref: coverInputRef, required: false },
          { kind: "thumbnail" as const, label: "Thumbnail", urlKey: "thumbnail_media_url" as const, ref: thumbInputRef, required: true },
        ]).map(({ kind, label, urlKey, ref, required }) => (
          <div key={kind} className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              {label}
              {required && <span className="text-xs text-warning font-normal">needed to publish</span>}
            </Label>
            <div className="flex items-center gap-2">
              {/* The thumbnail itself is the button. An empty dotted box that looks like a drop
                  target and does nothing when clicked is a dead affordance — everyone tries it
                  first, and the actual control is a separate button beside it. */}
              <button
                type="button"
                onClick={() => setPicking(kind)}
                title={form[urlKey] ? "Change this image" : "Add an image — generate, pick from the gallery, or upload"}
                className="group rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {form[urlKey] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={form[urlKey] as string} alt={label}
                    className="h-16 w-24 rounded-md border border-border object-cover transition-opacity group-hover:opacity-80" />
                ) : (
                  <span className={cn(
                    "flex h-16 w-24 flex-col items-center justify-center gap-0.5 rounded-md border border-dashed text-muted-foreground transition-colors",
                    "group-hover:border-highlight/60 group-hover:text-foreground",
                    required && !form[urlKey] ? "border-warning/50" : "border-border",
                  )}>
                    <ImageIcon className="h-4 w-4" />
                    <span className="text-xs">Add</span>
                  </span>
                )}
              </button>
              <div className="flex flex-col gap-1">
                <input ref={ref} type="file" accept="image/*" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(kind, f); e.target.value = ""; }} />
                {/* Opens the picker rather than a file dialog. These two slots used to jump straight
                    to the filesystem, which meant the gallery and the generator were unreachable
                    from the cover and the thumbnail — the two images every post actually needs.
                    The picker still offers upload, so nothing is lost. */}
                <Button size="xs" variant="outline" disabled={uploading === kind}
                  onClick={() => setPicking(kind)}>
                  {uploading === kind ? <Loader2 className="h-3 w-3 animate-spin" /> : <ImageIcon className="h-3 w-3" />}
                  {form[urlKey] ? "Change" : "Add"}
                </Button>
                {kind === "thumbnail" && form.cover_media_id && form.thumbnail_media_id !== form.cover_media_id && (
                  <Button size="xs" variant="ghost" className="text-xs h-10 gap-1" onClick={useCoverAsThumbnail}>
                    <Copy className="h-3 w-3" /> Use cover
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Body: toolbar, then the editor and the live preview side by side. */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Label htmlFor="body">Body (markdown)</Label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{wordCount} words</span>
            {/* Write / Split / Preview. Split is the default on a wide screen because seeing the
                rendered page beside the markdown is the whole point of having a preview. */}
            <div className="flex rounded-lg border border-border overflow-hidden">
              {(["write", "split", "preview"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setViewMode(m)}
                  className={cn("px-3 h-9 text-xs capitalize transition-colors",
                    viewMode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>
                  {m}
                </button>
              ))}
            </div>
            <input ref={inlineInputRef} type="file" accept="image/*" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload("inline", f); e.target.value = ""; }} />
            {/* Was a ghost text link and got missed. It is the most-used action in this editor, so
                it gets a solid button, an icon and a real touch target. */}
            {/* Gallery first: an asset made for one post is usually right for the next, and going
                straight to a file dialog hides everything already generated. */}
            <Button size="sm" className="gap-1.5" onClick={() => setPicking("inline")}>
              <ImageIcon className="h-4 w-4" /> Insert image
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5"
              disabled={uploading === "inline"} onClick={() => inlineInputRef.current?.click()}
              title="Upload straight from this computer">
              {uploading === "inline" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* Selection actions. Always present so nothing shifts as you select, but it lights up and
            reports the selection size the moment there is one. */}
        <div className={cn(
          "flex items-center gap-2 flex-wrap rounded-lg border px-2.5 py-1.5 transition-colors",
          selWords > 0 ? "border-highlight/40 bg-highlight-soft" : "border-border bg-muted/20",
        )}>
          <span className={cn("text-xs", selWords > 0 ? "text-highlight-ink" : "text-muted-foreground")}>
            {selWords > 0
              ? `${selWords.toLocaleString()} word${selWords === 1 ? "" : "s"} selected`
              : "Select part of the body to shorten or rewrite just that part"}
          </span>

          <div className="ml-auto flex items-center gap-1.5">
            <Popover open={shortenOpen} onOpenChange={setShortenOpen}>
              <PopoverTrigger
                render={(props) => (
                  <Button {...props} size="xs" variant="outline" className="gap-1.5"
                    disabled={selWords < 5 || reviseBusy !== null}
                    title={selWords < 5 ? "Select at least a few words" : `Shorten ${selWords} words`}>
                    {reviseBusy === "shorten" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Scissors className="h-3 w-3" />}
                    Shorten
                  </Button>
                )}
              />
              <PopoverContent className="w-72 p-3 space-y-2.5">
                <p className="text-xs font-medium">Shorten {selWords.toLocaleString()} words to</p>
                <div className="flex items-center gap-2">
                  <Input type="number" min={5} max={Math.max(5, selWords - 1)} value={shortenTarget}
                    onChange={(e) => setShortenTarget(Number(e.target.value))} className="h-9 w-24" />
                  <span className="text-xs text-muted-foreground">
                    words ({selWords > 0 ? Math.round((1 - shortenTarget / selWords) * 100) : 0}% shorter)
                  </span>
                </div>
                <div className="flex gap-1.5">
                  {[0.75, 0.5, 0.25].map((f) => (
                    <Button key={f} size="xs" variant="outline"
                      onClick={() => setShortenTarget(Math.max(5, Math.round(selWords * f)))}>
                      -{Math.round((1 - f) * 100)}%
                    </Button>
                  ))}
                </div>
                <Button size="sm" className="w-full gap-1.5"
                  disabled={reviseBusy !== null || shortenTarget >= selWords || shortenTarget < 5}
                  onClick={() => { setShortenOpen(false); void revise("shorten", { target_words: shortenTarget }); }}>
                  <Scissors className="h-3.5 w-3.5" /> Shorten it
                </Button>
              </PopoverContent>
            </Popover>

            <Popover open={rewriteOpen} onOpenChange={setRewriteOpen}>
              <PopoverTrigger
                render={(props) => (
                  <Button {...props} size="xs" variant="outline" className="gap-1.5" disabled={reviseBusy !== null}>
                    {reviseBusy === "rewrite" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
                    {selWords > 0 ? "Rewrite selection" : "Rewrite whole post"}
                  </Button>
                )}
              />
              <PopoverContent className="w-80 p-3 space-y-2.5">
                <p className="text-xs font-medium">
                  {selWords > 0
                    ? `Rewrite the selected ${selWords.toLocaleString()} words`
                    : `Rewrite the whole post (${wordCount.toLocaleString()} words)`}
                </p>
                <Textarea value={rewritePrompt} onChange={(e) => setRewritePrompt(e.target.value)}
                  className="min-h-[72px] text-sm"
                  placeholder="Make it more concrete. Lead with the benefit. Drop the hedging." />
                <p className="text-xs text-muted-foreground">
                  It keeps your links and adds no new facts, so nothing arrives unsourced.
                </p>
                <Button size="sm" className="w-full gap-1.5"
                  disabled={reviseBusy !== null || !rewritePrompt.trim()}
                  onClick={() => { setRewriteOpen(false); void revise("rewrite", { instruction: rewritePrompt }); }}>
                  <Wand2 className="h-3.5 w-3.5" /> Rewrite
                </Button>
              </PopoverContent>
            </Popover>

            {undoBody !== null && (
              <Button size="xs" variant="ghost" className="gap-1.5 text-highlight-ink" onClick={undoRevise}>
                <RotateCcw className="h-3 w-3" /> Undo
              </Button>
            )}
          </div>
        </div>

        {/* Both panes get the SAME explicit height and scroll internally, rather than growing the
            page. Two reasons this is not just cosmetic:
             - the Textarea primitive sets `field-sizing-content`, so it auto-grows to fit its value;
               on a 2,000-word body that made the markdown pane thousands of pixels tall with no
               internal scroll at all, and the whole page scrolled instead.
             - a split view only works if the two sides scroll independently. Matched heights mean
               you can keep the markdown and the rendered output side by side while moving through a
               long post. */}
        {/* Viewport math is legitimate here — unlike the page-level containers, this sits deep inside a
            scrolling form, so there is no definite ancestor height for h-full to resolve against.
            18rem not 17rem: the floating-pane shell added 16px of chrome above (gutter + header gap)
            versus the old flush header. `svh` rather than `vh` so a mobile URL bar doesn't clip it.
            min-h keeps it usable if the window is short. */}
        <div className={cn(
          "grid gap-3 h-[calc(100svh-18rem)] min-h-[420px]",
          viewMode === "split" && "lg:grid-cols-2",
        )}>
          {viewMode !== "preview" && (
            /* Drag an image anywhere onto the editor. This is the path most people reach for first,
               so it must work without opening anything. */
            <div className="relative h-full"
              onDragOver={(e) => { if (hasImage(e.dataTransfer)) { e.preventDefault(); setDragging(true); } }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith("image/"));
                if (!f) return;
                e.preventDefault();
                setDragging(false);
                void upload("inline", f);
              }}>
              <Textarea ref={bodyRef} id="body" value={form.body ?? ""}
                onChange={(e) => set("body", e.target.value)}
                onSelect={syncSelection}
                onKeyUp={syncSelection}
                onMouseUp={syncSelection}
                onPaste={(e) => {
                  // A pasted screenshot should just land, not require a save-then-upload detour.
                  const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith("image/"));
                  if (f) { e.preventDefault(); void upload("inline", f); }
                }}
                // field-sizing-fixed overrides the primitive's field-sizing-content: without it the
                // textarea grows to fit the whole article and never scrolls.
                className={cn("h-full field-sizing-fixed resize-none overflow-auto font-mono text-sm leading-relaxed",
                  dragging && "border-highlight ring-3 ring-ring/40")}
                placeholder="Write in markdown. Drag or paste an image straight in." />
              {dragging && (
                <div className="absolute inset-0 rounded-lg bg-highlight-soft border-2 border-dashed border-highlight flex items-center justify-center pointer-events-none">
                  <p className="text-sm font-medium text-highlight-ink flex items-center gap-2">
                    <ImageIcon className="h-4 w-4" /> Drop to upload and insert at the cursor
                  </p>
                </div>
              )}
            </div>
          )}
          {viewMode !== "write" && (
            <div ref={previewRef}
              // Clicking or selecting here jumps the markdown pane to the same place. mouseUp rather
              // than click, so dragging a selection across paragraphs maps the whole range.
              onMouseUp={syncFromPreview}
              className="relative rounded-xl border border-border bg-[var(--glass-bg)] backdrop-blur-[20px] overflow-y-auto h-full px-6 py-5">
              <MarkdownPreview markdown={form.body ?? ""} />
              {/* Where your cursor is, in the rendered page. Absolute inside the scroll container, so
                  it travels with the content rather than floating over it. */}
              {caret && (
                <span className="md-caret" aria-hidden="true"
                  style={{ top: caret.top, left: caret.left, height: caret.height }} />
              )}
            </div>
          )}
        </div>
      </div>

      <div className="max-w-3xl space-y-1.5">
        <Label htmlFor="description" className="flex items-center justify-between">
          <span>Description (meta)</span>
          <span className={cn("text-xs", descLen < 120 ? "text-warning" : "text-muted-foreground")}>{descLen}/120 min</span>
        </Label>
        <Textarea id="description" value={form.description ?? ""} className="min-h-[80px]"
          onChange={(e) => set("description", e.target.value)} />
      </div>

      <div className="max-w-3xl grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="tags">Tags</Label>
          <Input id="tags" value={form.tags ?? ""} onChange={(e) => set("tags", e.target.value)} placeholder="comma, separated" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="canonical">
            Canonical URL <span className="text-muted-foreground font-normal">(leave empty unless this duplicates another page)</span>
          </Label>
          {/* A combobox over the real sitemap inventory, not free text. A canonical is the one field
              where a typo is actively harmful: it points Google at a page instead of this one, so a
              path that does not exist de-indexes this article for nothing. Typing is still allowed for
              a page that is not in the sitemap yet. */}
          <PathCombobox id="canonical" value={form.canonical_tag ?? ""}
            onChange={(v) => set("canonical_tag", v)} options={knownPages}
            placeholder="Empty means this page is its own canonical" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="author">Author</Label>
          <select id="author" className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={form.author_id ?? ""} onChange={(e) => set("author_id", e.target.value ? Number(e.target.value) : null)}>
            <option value="">—</option>
            {authors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="category">Category</Label>
          <select id="category" className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={form.category_id ?? ""} onChange={(e) => set("category_id", e.target.value ? Number(e.target.value) : null)}>
            <option value="">—</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="youtube">YouTube video ID <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input id="youtube" value={form.youtube_video_id ?? ""} onChange={(e) => set("youtube_video_id", e.target.value)} />
        </div>
        <div className="flex items-center gap-6 pt-6">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={!!form.is_featured} onCheckedChange={(v: boolean) => set("is_featured", v)} /> Featured
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.should_index !== false} onCheckedChange={(v: boolean) => set("should_index", v)} /> Index (SEO)
          </label>
        </div>
      </div>

      <div className="max-w-3xl rounded-lg border border-border p-4 space-y-3">
        <Label className="flex items-center gap-1.5">
          <Rocket className="h-3.5 w-3.5" /> Hero CTA
          <span className="text-muted-foreground font-normal">(required to publish)</span>
        </Label>
        <div className="grid grid-cols-2 gap-3">
          <Input placeholder="Button text, e.g. Try it free" value={form.hero_cta_text ?? ""}
            onChange={(e) => set("hero_cta_text", e.target.value)} />
          <Input placeholder="https://northwind.example/..." value={form.hero_cta_url ?? ""}
            onChange={(e) => set("hero_cta_url", e.target.value)} />
        </div>
      </div>

      <div className="max-w-3xl rounded-lg border border-border p-4 space-y-3">
        <Label className="flex items-center gap-1.5">
          <Search className="h-3.5 w-3.5" /> SEO overrides
          <span className="text-muted-foreground font-normal">(optional — falls back to title/description)</span>
        </Label>
        <Input placeholder="SEO title" value={form.seo_title ?? ""} onChange={(e) => set("seo_title", e.target.value)} />
        <Textarea placeholder="SEO description" value={form.seo_description ?? ""} className="min-h-[60px]"
          onChange={(e) => set("seo_description", e.target.value)} />
        <Input placeholder="Keywords, comma separated" value={form.seo_keywords ?? ""}
          onChange={(e) => set("seo_keywords", e.target.value)} />
      </div>

      {/* JSON-LD. Sits next to the SEO overrides here and next to blogsMetaData in Strapi, so the two
          surfaces group the same fields together even where the exact order differs.

          Deliberately free-text with validation as ADVICE, not enforcement: it saves whatever is typed
          (half-finished graphs included, which is why the column is text and not jsonb) and the sync
          layer drops it if it will not parse. Blocking the field on invalid JSON would fight the
          local-first save engine, which exists so nobody loses work mid-keystroke. */}
      <div className="max-w-3xl rounded-lg border border-border p-4 space-y-3">
        <Label htmlFor="markup-schema" className="flex items-center gap-1.5">
          <Search className="h-3.5 w-3.5" /> Schema markup
          <span className="text-muted-foreground font-normal">
            (optional JSON-LD — publishes to markupSchema)
          </span>
        </Label>
        <Textarea
          id="markup-schema"
          className="min-h-[120px] font-mono text-xs"
          placeholder='{"@context":"https://schema.org","@type":"Article", ...}'
          value={form.markup_schema ?? ""}
          onChange={(e) => set("markup_schema", e.target.value)}
        />
        {(() => {
          const raw = (form.markup_schema ?? "").trim();
          if (!raw) return null;
          try {
            const parsed = JSON.parse(raw);
            const t = Array.isArray(parsed?.["@graph"])
              ? `@graph with ${parsed["@graph"].length} node(s)`
              : (parsed?.["@type"] ?? "no @type");
            return <p className="text-xs text-success">Valid JSON · {String(t)}</p>;
          } catch {
            return (
              <p className="text-xs text-warning">
                Not valid JSON yet. It still saves, but it will be left off the published entry until it parses.
              </p>
            );
          }
        })()}
      </div>

      <GalleryPicker
        open={picking !== null}
        role={picking === "inline" ? "inline" : picking === "thumbnail" ? "thumbnail" : "hero"}
        onClose={() => setPicking(null)}
        onPick={(img) => { if (picking) placeFromGallery(picking, img); }}
        uploading={uploading !== null}
        onUpload={(f) => { if (picking) void upload(picking === "inline" ? "inline" : picking, f); }}
        // The generator starts from what the page is already about, rather than an empty box on a
        // draft that has had a title since the moment it was created.
        subject={form.title || undefined}
        draftId={draft.id}
      />

      <ConflictDialog
        open={conflictOpen}
        onOpenChange={(v) => { if (!v) setDismissedConflictRev(autosave.conflictRow?.rev ?? -1); }}
        mine={form}
        theirs={autosave.conflictRow}
        onKeepMine={() => { void autosave.resolveKeepMine(); }}
        onTakeTheirs={() => {
          if (autosave.conflictRow) adopt(autosave.conflictRow);
          autosave.resolveTakeTheirs();
        }}
      />
    </div>
  );
}

/** Column names are not field names. The autofill report is read by humans, so show what they see
 *  on the form rather than the Postgres identifier. */
const FIELD_LABEL: Record<string, string> = {
  title: "Title",
  slug: "Slug",
  description: "Description",
  seo_title: "SEO title",
  seo_description: "SEO description",
  seo_keywords: "SEO keywords",
  markup_schema: "Schema markup",
  tags: "Tags",
  hero_cta_text: "Hero CTA text",
  hero_cta_url: "Hero CTA link",
  thumbnail: "Thumbnail",
  thumbnail_media_id: "Thumbnail",
  thumbnail_media_url: "Thumbnail",
  author: "Author",
  author_id: "Author",
  category: "Category",
  category_id: "Category",
  canonical_tag: "Canonical URL",
  should_index: "Indexing",
};
