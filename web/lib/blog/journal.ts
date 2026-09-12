// On-device journal of unsaved edits. Tier 1 of the save engine.
//
// The invariant the whole editor rests on: at every instant the user's text exists in at least two
// places, one of which needs no network. React state is tier 0, Postgres is tier 2, and this is the
// thing in between that makes tier 2 allowed to fail. If the tab crashes, the laptop sleeps, or the
// DB is unreachable, the text is still here on next load.
//
// Why localStorage and not IndexedDB: IDB is asynchronous, and its writes are not reliably flushed
// once the page starts unloading — which is precisely the moment this exists for. localStorage is
// synchronous, needs no dependency, and 5MB is roughly 50x a long blog post.
import type { BlogDraft } from "@/lib/db/queries";
import { editableSnapshot } from "./fields";

const PREFIX = "blogdraft:v1:";
/** Well under the ~5MB localStorage budget. Past this we refuse and warn loudly instead of
 *  throwing QuotaExceededError on every keystroke. */
const MAX_BYTES = 1_500_000;

export interface Journal {
  v: 1;
  draftId: string;
  /** The rev the edits were made against, so a stale journal can be detected. */
  baseRev: number;
  savedAt: number;
  fields: Partial<BlogDraft>;
}

function key(draftId: string): string {
  return `${PREFIX}${draftId}`;
}

/** Feature-detect rather than assume: Safari private mode throws on setItem, and some managed
 *  browsers disable storage entirely. Callers escalate the UI to red when this is false, because
 *  the two-places invariant no longer holds. */
export function available(): boolean {
  try {
    const probe = `${PREFIX}__probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export type WriteResult = "ok" | "unavailable" | "too_large";

export function write(draftId: string, baseRev: number, fields: Partial<BlogDraft>): WriteResult {
  const payload: Journal = { v: 1, draftId, baseRev, savedAt: Date.now(), fields: editableSnapshot(fields) };
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return "unavailable";
  }
  // A base64 image pasted straight into the body is the realistic way to blow the budget; the
  // editor intercepts those into the upload path, and this is the backstop.
  if (serialized.length > MAX_BYTES) return "too_large";
  try {
    localStorage.setItem(key(draftId), serialized);
    return "ok";
  } catch {
    return "unavailable";
  }
}

export function read(draftId: string): Journal | null {
  try {
    const raw = localStorage.getItem(key(draftId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Journal;
    if (parsed?.v !== 1 || parsed.draftId !== draftId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Drop the journal. Callers must only do this once the server has confirmed the same content —
 * never optimistically after firing a request, or a failed save would take the only remaining
 * off-network copy with it.
 */
export function clear(draftId: string): void {
  try {
    localStorage.removeItem(key(draftId));
  } catch {
    /* nothing useful to do */
  }
}

/** Every draft with a journal on this device, newest first. Powers a "you have unsaved work in
 *  2 other drafts" banner on the list pane, so recovery isn't dependent on remembering which
 *  post you were in when the tab died. */
export function listOrphans(): Journal[] {
  const out: Journal[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(k) ?? "") as Journal;
        if (parsed?.v === 1 && parsed.draftId) out.push(parsed);
      } catch {
        /* skip a corrupt entry rather than failing the whole scan */
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Is this journal newer than what the server has?
 *
 * Compared against `updated_at` rather than rev because a crash loses edits that never reached the
 * server at all, so rev would be identical on both sides. A 2s skew allowance stops the round trip
 * of our own successful save from looking like unsaved work.
 */
export function isAheadOfServer(j: Journal, serverUpdatedAt: string): boolean {
  const server = Date.parse(serverUpdatedAt);
  if (!Number.isFinite(server)) return true;
  return j.savedAt > server + 2000;
}
