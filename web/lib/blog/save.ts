// Server-side save, shared by PATCH /api/blog/drafts/[id] and the sendBeacon flush route so the
// revision policy and conflict handling can't drift between the two.
//
// Hard rule: this function NEVER contacts Strapi. The old PUT handler pushed to live Strapi on
// every save whenever strapi_id was set, which meant a debounced autosave would have been editing
// production content on every keystroke batch. Pushing is now only ever an explicit user action.
import {
  getBlogDraft, updateBlogDraftGuarded, createBlogDraftRevision, trimBlogDraftRevisions,
  lastBlogDraftRevisionAt,
  type BlogDraft, type BlogDraftRevision,
} from "@/lib/db/queries";
import { sanitizePatch, editableSnapshot } from "./fields";

/** Snapshot at most this often for routine autosaves. Explicit reasons ignore the limit. */
const AUTOSAVE_SNAPSHOT_INTERVAL_MS = 2 * 60 * 1000;
/** …unless the body moved this much, in which case a snapshot is worth it regardless. */
const BODY_DIVERGENCE_CHARS = 500;
const REVISIONS_KEPT = 20;

export type SaveResult =
  | { ok: true; draft: BlogDraft; rejected: string[]; snapshotted: boolean }
  | { ok: false; conflict: BlogDraft | null };

interface SaveOptions {
  /** The rev the client believed it was editing. Omit to force (last-write-wins). */
  baseRev?: number | null;
  editedBy?: string | null;
  /** Why we're snapshotting. Anything other than "autosave" bypasses the rate limit. */
  reason?: BlogDraftRevision["reason"];
}

/**
 * Decide whether this write deserves a revision snapshot.
 * Cheap for the common case: only the explicit reasons and a genuinely large body change hit the
 * extra query, so a fast typist doesn't generate a row every 1.2 seconds.
 */
async function shouldSnapshot(
  current: BlogDraft,
  patch: Partial<BlogDraft>,
  reason: BlogDraftRevision["reason"],
): Promise<boolean> {
  if (reason !== "autosave") return true;                       // pre_sync / pre_publish / etc.
  if (current.rev === 0) return true;                           // baseline for a fresh draft
  if (typeof patch.body === "string") {
    const delta = Math.abs(patch.body.length - (current.body?.length ?? 0));
    if (delta >= BODY_DIVERGENCE_CHARS) return true;
  }
  const last = await lastBlogDraftRevisionAt(current.id);
  if (!last) return true;
  return Date.now() - Date.parse(last) >= AUTOSAVE_SNAPSHOT_INTERVAL_MS;
}

/**
 * Apply an allow-listed patch to a draft under optimistic concurrency.
 *
 * Returns `{ok: false, conflict}` when someone else advanced `rev` — the caller answers 409 and
 * the client resolves it. Nothing is written in that case, and the client still holds the text in
 * React state and in its localStorage journal, so no work is at risk.
 */
export async function applyDraftPatch(
  id: string,
  body: unknown,
  opts: SaveOptions = {},
): Promise<SaveResult | null> {
  const current = await getBlogDraft(id);
  if (!current) return null;

  const { patch, rejected } = sanitizePatch(body);
  const reason = opts.reason ?? "autosave";

  // Nothing to write (a flush after the last real save, or a body that only contained
  // server-owned keys). Report success so the client can clear its journal.
  if (Object.keys(patch).length === 0) {
    return { ok: true, draft: current, rejected, snapshotted: false };
  }

  // Snapshot the state we're about to replace, BEFORE the update, so a bad paste or a conflict
  // overwrite is always recoverable.
  let snapshotted = false;
  if (await shouldSnapshot(current, patch, reason)) {
    await createBlogDraftRevision(id, current.rev, reason, editableSnapshot(current), current.last_edited_by)
      .then(() => { snapshotted = true; })
      // A failed snapshot must never block the actual save — losing history is bad, losing the
      // user's text is worse.
      .catch(() => {});
    if (snapshotted) await trimBlogDraftRevisions(id, REVISIONS_KEPT).catch(() => {});
  }

  const baseRev = typeof opts.baseRev === "number" ? opts.baseRev : current.rev;
  const res = await updateBlogDraftGuarded(id, patch, baseRev, opts.editedBy);
  if ("conflict" in res) return { ok: false, conflict: res.conflict };
  return { ok: true, draft: res.row, rejected, snapshotted };
}
