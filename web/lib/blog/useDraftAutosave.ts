"use client";

// The save engine. Owns the debounce, the journal, retries, and conflict detection so the editor
// component only has to render state and call `onChange`.
//
// Guarantees, in order of importance:
//  1. Text is never lost. Every change lands in the localStorage journal within ~150ms, and the
//     journal is only cleared once the server has confirmed the same content.
//  2. A save never fails because a required Strapi field is blank — this talks to our Postgres
//     only. Pushing to Strapi is a separate explicit action.
//  3. Two tabs can't silently clobber each other: every write carries base_rev and a mismatch
//     surfaces as a conflict instead of an overwrite.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlogDraft } from "@/lib/db/queries";
import { changedFields } from "./fields";
import * as journal from "./journal";

/** Trailing debounce after the last edit. */
const DEBOUNCE_MS = 1200;
/** Hard ceiling: a continuous typist still checkpoints this often. */
const MAX_WAIT_MS = 5000;
const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

export type SaveState =
  | "saved"
  | "dirty"
  | "saving"
  | "just_saved"
  | "offline"
  | "retrying"
  | "conflict"
  | "no_local_backup";

export interface UseDraftAutosave {
  state: SaveState;
  /** Server row as of the last successful load or save. */
  server: BlogDraft | null;
  lastSavedAt: number | null;
  /** Seconds until the next retry, for the countdown in the status chip. */
  retryInSec: number | null;
  /** The other side's row when state === "conflict", for the resolution dialog. */
  conflictRow: BlogDraft | null;
  /** True when the journal is unusable (private mode / quota) — the two-places invariant is broken. */
  journalBlocked: boolean;
  /** A journal newer than the server, found on mount. Offer Restore / Discard; never auto-apply. */
  recovered: journal.Journal | null;
  dismissRecovered: () => void;
  /** Call on every edit with the full current form. */
  markDirty: (form: Partial<BlogDraft>) => void;
  /** Save now (Cmd+S, blur, draft switch). Resolves once the attempt settles. */
  flush: () => Promise<void>;
  retryNow: () => void;
  /** Force-overwrite the other side, after snapshotting it server-side. */
  resolveKeepMine: () => Promise<void>;
  /** Abandon local edits and adopt the server row. */
  resolveTakeTheirs: () => void;
}

interface Options {
  draftId: string | null;
  /** Server row this editor was seeded from. */
  initial: BlogDraft | null;
  /** Latest form values, read at save time so the debounce always sends the newest text. */
  formRef: React.RefObject<Partial<BlogDraft>>;
  /** Called when the server row changes, so the editor can reconcile (e.g. take theirs). */
  onServerRow?: (row: BlogDraft) => void;
}

export function useDraftAutosave({ draftId, initial, formRef, onServerRow }: Options): UseDraftAutosave {
  const [state, setState] = useState<SaveState>("saved");
  const [server, setServer] = useState<BlogDraft | null>(initial);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [retryInSec, setRetryInSec] = useState<number | null>(null);
  const [conflictRow, setConflictRow] = useState<BlogDraft | null>(null);
  const [journalBlocked, setJournalBlocked] = useState(false);
  const [recovered, setRecovered] = useState<journal.Journal | null>(null);

  // Refs, not state: the timers and the unload handler must read the newest values without
  // re-subscribing, and re-rendering on every keystroke would defeat the point.
  const serverRef = useRef<BlogDraft | null>(initial);
  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ceilingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptRef = useRef(0);
  const journalOkRef = useRef(true);
  // `save` reschedules itself (retry backoff, and draining a queued edit). Referencing the
  // useCallback from inside its own body is a use-before-declare that the React compiler rejects,
  // so the recursion goes through this ref instead. Kept current by the effect below.
  const saveRef = useRef<(opts?: { force?: boolean }) => Promise<void>>(async () => {});

  useEffect(() => { serverRef.current = server; }, [server]);

  const clearTimers = useCallback(() => {
    for (const r of [debounceRef, ceilingRef, retryRef]) {
      if (r.current) { clearTimeout(r.current); r.current = null; }
    }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    setRetryInSec(null);
  }, []);

  // ── Load: reset per-draft state, then check for a newer journal ──
  // This is setState-in-an-effect on purpose, and it can't be a render-time derivation: it reads
  // localStorage, which is a browser side effect and would risk a hydration mismatch if done during
  // render. (react-hooks/set-state-in-effect flags it; the repo has ~27 instances of the same
  // fetch/read-on-mount shape.)
  useEffect(() => {
    clearTimers();
    dirtyRef.current = false;
    inFlightRef.current = false;
    queuedRef.current = false;
    attemptRef.current = 0;
    setConflictRow(null);
    setRecovered(null);
    setServer(initial);
    setLastSavedAt(null);

    const ok = journal.available();
    journalOkRef.current = ok;
    setJournalBlocked(!ok);
    setState(ok ? "saved" : "no_local_backup");

    if (!ok || !draftId || !initial) return;
    const j = journal.read(draftId);
    // Only offer recovery when the on-device copy is genuinely ahead. Never auto-apply in either
    // direction — auto-applying is how you resurrect something the user deliberately deleted.
    if (j && journal.isAheadOfServer(j, initial.updated_at)) setRecovered(j);
    else if (j) journal.clear(draftId);
  }, [draftId, initial, clearTimers]);

  // ── The actual write ──
  const save = useCallback(async (opts: { force?: boolean } = {}): Promise<void> => {
    const id = draftId;
    const base = serverRef.current;
    if (!id || !base) return;

    // One request per draft at a time. An in-flight save is never aborted to start a newer one:
    // an aborted request may still have committed server-side, which would desync `rev` and cause
    // a phantom conflict on the next write.
    if (inFlightRef.current) { queuedRef.current = true; return; }

    const patch = changedFields(base, formRef.current ?? {});
    if (Object.keys(patch).length === 0) {
      dirtyRef.current = false;
      if (journalOkRef.current) journal.clear(id);
      setState((s) => (s === "conflict" ? s : "saved"));
      return;
    }

    // Don't burn a retry slot on a request that cannot succeed.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setState("offline");
      return;
    }

    inFlightRef.current = true;
    clearTimers();
    setState((s) => (s === "conflict" ? s : "saving"));
    try {
      const res = await fetch(`/api/blog/drafts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...patch, base_rev: base.rev, ...(opts.force ? { force: true } : {}) }),
      });

      if (res.status === 409) {
        const d = await res.json().catch(() => null);
        setConflictRow(d?.draft ?? null);
        setState("conflict");
        return; // journal deliberately kept — it holds the only copy of our branch
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const d = await res.json();
      if (!d?.ok || !d.draft) throw new Error(d?.error ?? "save failed");

      const row = d.draft as BlogDraft;
      setServer(row);
      serverRef.current = row;
      onServerRow?.(row);
      attemptRef.current = 0;
      setLastSavedAt(Date.now());
      setConflictRow(null);

      // Clear the journal only if the server now holds what we last wrote. If the user typed
      // during the request, stay dirty and keep the journal — a later save will catch up.
      const stillDirty = Object.keys(changedFields(row, formRef.current ?? {})).length > 0;
      dirtyRef.current = stillDirty;
      if (!stillDirty && journalOkRef.current) journal.clear(id);
      setState(stillDirty ? "dirty" : "just_saved");
      if (!stillDirty) setTimeout(() => setState((s) => (s === "just_saved" ? "saved" : s)), 2000);
    } catch {
      // The text is safe in state and in the journal, so this is amber-and-retrying, not an error.
      const attempt = Math.min(attemptRef.current, RETRY_BACKOFF_MS.length - 1);
      const delay = RETRY_BACKOFF_MS[attempt];
      attemptRef.current = attempt + 1;
      setState("retrying");
      setRetryInSec(Math.ceil(delay / 1000));
      countdownRef.current = setInterval(
        () => setRetryInSec((s) => (s === null ? null : Math.max(0, s - 1))),
        1000,
      );
      retryRef.current = setTimeout(() => { void saveRef.current(); }, delay);
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void saveRef.current();
      }
    }
  }, [draftId, formRef, onServerRow, clearTimers]);

  useEffect(() => { saveRef.current = save; }, [save]);

  // ── Public: called on every edit ──
  const markDirty = useCallback((form: Partial<BlogDraft>) => {
    const id = draftId;
    if (!id) return;
    dirtyRef.current = true;
    setState((s) => (s === "conflict" || s === "no_local_backup" ? s : "dirty"));

    if (journalOkRef.current) {
      const r = journal.write(id, serverRef.current?.rev ?? 0, form);
      if (r !== "ok") {
        journalOkRef.current = false;
        setJournalBlocked(true);
        setState("no_local_backup");
      }
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void save(); }, DEBOUNCE_MS);
    // Ceiling: a continuous typist would otherwise never hit the trailing debounce.
    if (!ceilingRef.current) {
      ceilingRef.current = setTimeout(() => {
        ceilingRef.current = null;
        void save();
      }, MAX_WAIT_MS);
    }
  }, [draftId, save]);

  const flush = useCallback(async () => {
    clearTimers();
    if (!dirtyRef.current) return;
    await save();
  }, [save, clearTimers]);

  const retryNow = useCallback(() => { clearTimers(); attemptRef.current = 0; void save(); }, [save, clearTimers]);

  const resolveKeepMine = useCallback(async () => {
    setConflictRow(null);
    // Adopt their rev so the forced write is accepted; the server snapshots the row it replaces
    // as "pre_conflict_overwrite", so their branch stays recoverable.
    if (conflictRow) { setServer(conflictRow); serverRef.current = conflictRow; }
    await save({ force: true });
  }, [conflictRow, save]);

  const resolveTakeTheirs = useCallback(() => {
    if (!conflictRow || !draftId) return;
    setServer(conflictRow);
    serverRef.current = conflictRow;
    onServerRow?.(conflictRow);
    setConflictRow(null);
    dirtyRef.current = false;
    journal.clear(draftId);
    setState("saved");
  }, [conflictRow, draftId, onServerRow]);

  const dismissRecovered = useCallback(() => {
    if (draftId) journal.clear(draftId);
    setRecovered(null);
  }, [draftId]);

  // ── Unload, tab-hide, and reconnect ──
  useEffect(() => {
    if (!draftId) return;
    // Captured once so the cleanup below reads the same ref object rather than a value that has
    // since changed (the exhaustive-deps ref-in-cleanup warning). We WANT the live .current at
    // teardown time, which is exactly what holding the ref object gives us.
    const liveForm = formRef;

    const onPageHide = () => {
      if (!dirtyRef.current) return;
      const base = serverRef.current;
      const form = liveForm.current ?? {};
      // Synchronous journal write first — this is the copy we can actually rely on.
      if (journalOkRef.current) journal.write(draftId, base?.rev ?? 0, form);
      const patch = changedFields(base, form);
      if (!Object.keys(patch).length) return;
      // sendBeacon is the only send the browser commits to completing during unload; a normal
      // fetch is cancelled. It can only POST, hence the dedicated /flush route.
      try {
        const blob = new Blob([JSON.stringify(patch)], { type: "application/json" });
        navigator.sendBeacon(`/api/blog/drafts/${draftId}/flush`, blob);
      } catch {
        /* the journal already has it */
      }
    };

    const onVisibility = () => { if (document.visibilityState === "hidden") { void flush(); } };
    const onOnline = () => { attemptRef.current = 0; if (dirtyRef.current) { clearTimers(); void save(); } };
    const onOffline = () => { if (dirtyRef.current) setState("offline"); };

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Only nag when the work is genuinely at risk. Blocking every time there are unsaved
      // changes — while they sit safely in localStorage — just teaches people to ignore the
      // dialog, so this fires only when the journal is unavailable.
      if (dirtyRef.current && !journalOkRef.current) { e.preventDefault(); }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flush();
      }
    };

    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("keydown", onKeyDown);
      // Unmount (draft switch / navigation): journal synchronously, then let the save race the
      // teardown. The journal is what makes losing that race harmless.
      if (dirtyRef.current) {
        if (journalOkRef.current) journal.write(draftId, serverRef.current?.rev ?? 0, liveForm.current ?? {});
        void saveRef.current();
      }
      clearTimers();
    };
    // `save` is deliberately not a dependency: it changes identity whenever the server row does,
    // and re-running this effect would tear down and re-add the unload/online listeners on every
    // save. The recursion goes through saveRef.current instead, which is always current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, flush, formRef, clearTimers]);

  // Reflect a dirty tab in the document title, so unsaved work is visible from a background tab.
  useEffect(() => {
    const dirty = state === "dirty" || state === "retrying" || state === "offline";
    const base = document.title.replace(/^• /, "");
    document.title = dirty ? `• ${base}` : base;
    return () => { document.title = document.title.replace(/^• /, ""); };
  }, [state]);

  return useMemo(() => ({
    state, server, lastSavedAt, retryInSec, conflictRow, journalBlocked, recovered,
    dismissRecovered, markDirty, flush, retryNow, resolveKeepMine, resolveTakeTheirs,
  }), [
    state, server, lastSavedAt, retryInSec, conflictRow, journalBlocked, recovered,
    dismissRecovered, markDirty, flush, retryNow, resolveKeepMine, resolveTakeTheirs,
  ]);
}
