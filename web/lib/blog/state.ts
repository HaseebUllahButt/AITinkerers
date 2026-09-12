// Where a draft stands across the two systems (our Postgres, and Strapi).
//
// `sync_state` on the row stores only the four COMMITTED states. Staleness is derived here from
// rev vs synced_rev rather than stored, because a stored flag would need updating on every
// autosave and would eventually disagree with reality. Shared by the API routes and the UI so
// there is exactly one definition.
import type { BlogDraft } from "@/lib/db/queries";

export type DerivedSyncState =
  | "local_only"        // never pushed to Strapi
  | "synced"            // exists in Strapi as an unpublished draft, and matches what we have
  | "synced_stale"      // exists as a Strapi draft, but we've edited since
  | "published"         // live in Strapi, and matches what we have
  | "published_stale"   // live in Strapi, but we've edited since — needs a push
  | "sync_failed";      // last attempt errored; sync_error holds why

export function deriveSyncState(d: Pick<BlogDraft,
  "strapi_id" | "sync_state" | "rev" | "synced_rev" | "strapi_published_at">): DerivedSyncState {
  if (d.sync_state === "sync_failed") return "sync_failed";
  if (!d.strapi_id) return "local_only";
  const stale = (d.synced_rev ?? -1) !== d.rev;
  if (d.strapi_published_at) return stale ? "published_stale" : "published";
  return stale ? "synced_stale" : "synced";
}

interface StateMeta {
  label: string;
  /** Tailwind text colour. Only genuine problems get red — see SaveStatus for the reasoning. */
  tone: "muted" | "brand" | "emerald" | "amber" | "red";
  help: string;
  /** The primary action available from this state, if any. */
  action?: "sync" | "push" | "retry";
}

export const SYNC_STATE_META: Record<DerivedSyncState, StateMeta> = {
  local_only: {
    label: "Local only",
    tone: "muted",
    help: "Saved here. Nothing has been sent to Strapi yet.",
    action: "sync",
  },
  synced: {
    label: "In Strapi (draft)",
    tone: "brand",
    help: "A teammate can open and edit this in the Strapi admin. It is not live.",
  },
  synced_stale: {
    label: "Local ahead of Strapi",
    tone: "brand",
    help: "You've edited since the last sync. Sync again to update the Strapi draft.",
    action: "sync",
  },
  published: {
    label: "Published",
    tone: "emerald",
    help: "Live in Strapi and matching what's here.",
  },
  published_stale: {
    label: "Published · local ahead",
    tone: "amber",
    help: "This post is live, but your local edits haven't been pushed to it yet.",
    action: "push",
  },
  sync_failed: {
    label: "Sync failed",
    tone: "red",
    help: "Strapi rejected the last push. Your local copy is untouched.",
    action: "retry",
  },
};

/** True when the draft is live in Strapi — the point at which a push edits production content. */
export function isLive(d: Pick<BlogDraft, "strapi_published_at">): boolean {
  return !!d.strapi_published_at;
}
