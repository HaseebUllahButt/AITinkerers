// Tell the writers when a blog draft is ready to publish.
//
// ── Why a schedule and not a hook on save ───────────────────────────────────────────────────────
//
// A draft becomes "ready" by degrees: somebody writes the body, then adds a description, then a hero
// CTA, then a thumbnail lands from an asset run. There is no single moment to hang an event on, and
// hooking every save would post the instant a draft crossed the line mid-edit — while the person was
// still typing, several times, as fields came and went.
//
// A sweep asks the honest question — "which drafts are ready and have never been announced" — and
// the per-draft `slack_notified_at` means it can answer that after a partial run, a crash, or a
// redeploy. See scripts/078 for why the marker is per-draft rather than one shared timestamp.
//
// ── Claim BEFORE posting, not after ─────────────────────────────────────────────────────────────
//
// This loop used to post to Slack and then stamp `slack_notified_at`. Between those two statements is
// a window where the function can die, and if it does the draft stays unclaimed and is announced again
// on the next tick — forever, once an hour, until something happens to close the window.
//
// It is not a theoretical window. This route runs three passes inside one 120s function, and the pass
// before this one (ensureThumbnails) starts up to four fal renders, which "routinely take minutes" at
// 2K. So the notifier regularly begins with most of the budget already spent, posts, and is killed
// before the stamp lands. Measured: "Wan 2.6 prompts for multi-shot video with dialogue" and "How to
// animate a character photo from a reference video" were both announced at 10:03 and again at 11:03,
// and their stamps read 11:03 — the second announcement is the one that managed to record itself.
//
// Claiming first inverts which failure is possible. A crash after the claim loses one notification;
// a crash after the post repeats it every hour. The module already prefers the former explicitly —
// see the note on stamping through a Slack failure — so posting first never bought anything.
//
// The claim is also CONDITIONAL on the row still being unclaimed, which makes two overlapping runs
// safe: the second one gets no row back and skips.
//
// ── The first-run guard ─────────────────────────────────────────────────────────────────────────
//
// Every existing draft has slack_notified_at = null, so the first run would announce the entire
// backlog at once — 44 drafts on the day this shipped. So a draft older than the grace window is
// marked notified WITHOUT posting: it is not news, and nobody wants a Slack channel replaying
// months of history to prove a notifier works.
import { supabaseAdmin } from "@/lib/db/supabase";
import { publishReadiness } from "@/lib/strapi/mapDraft";
import { deriveSyncState } from "@/lib/blog/state";
import { slackPost } from "@/lib/slack/post";
import { tagFor } from "@/lib/slack/tags";
import { linkOr } from "@/lib/appUrl";
import { attributionFor } from "@/lib/blog/origin";
import type { BlogDraft } from "@/lib/db/queries";

/** Older than this and a newly-seen draft is backfilled silently rather than announced. */
const NEWS_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Per run, so one enormous batch cannot flood the channel even if the guard is wrong. */
const MAX_PER_RUN = 8;

export interface NotifyResult {
  ready: number;
  posted: number;
  backfilled: number;
  skipped: number;
  failures: { draft: string; error: string }[];
  notes: string[];
}

/** One notification. Deliberately plain: no emoji, and it says what to do rather than celebrating. */
export function composeReadyMessage(d: BlogDraft, tag: string): string {
  const state = deriveSyncState(d);
  return [
    `${tag} — a blog draft is ready to publish.`,
    "",
    `*${d.title || "Untitled"}*`,
    `Slug: \`${d.slug}\``,
    attributionFor(d.created_by) ? `Written by: ${attributionFor(d.created_by)}` : null,
    `Status: ${state === "published" ? "published" : state === "synced" ? "in Strapi as a draft" : "in Summit only"}`,
    linkOr(`/drafts/${d.id}`, "Open it:"),
    "",
    "Nothing is published automatically. Read it, then publish.",
  ].filter((l): l is string => l !== null).join("\n");
}

/**
 * Find ready-and-unannounced drafts and announce them.
 *
 * `slack_notified_at` is stamped even when the POST fails, and that is deliberate: a Slack outage
 * would otherwise make every subsequent run retry the same draft forever, and the notification is
 * worth much less than the channel staying readable. The failure is reported in the result so it is
 * discoverable rather than silent.
 */
export async function notifyReadyDrafts(
  opts: { dryRun?: boolean; skipDraftIds?: readonly string[] } = {},
): Promise<NotifyResult> {
  const out: NotifyResult = { ready: 0, posted: 0, backfilled: 0, skipped: 0, failures: [], notes: [] };

  // Named columns, not `*`. publishReadiness needs six fields and composeReadyMessage needs five;
  // `*` pulled every draft's full `body` for up to 200 rows, which is megabytes of article text
  // fetched only to be discarded — on a route that is already short of time.
  const { data, error } = await supabaseAdmin
    .from("blog_drafts")
    .select(
      "id, title, slug, description, thumbnail_media_id, hero_cta_text, hero_cta_url, "
      + "created_at, created_by, sync_state, strapi_id, strapi_url, strapi_published_at, published_at",
    )
    .is("slack_notified_at", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    out.notes.push(`Could not read drafts: ${error.message}`);
    return out;
  }

  // A draft a resumed run owns this tick announces itself when that run finishes, with its images
  // attached. Announcing it here would either beat the images or duplicate the message.
  const skip = new Set(opts.skipDraftIds ?? []);
  const drafts = ((data ?? []) as Partial<BlogDraft>[]).filter((d) => !skip.has(d.id!));
  const cutoff = Date.now() - NEWS_WINDOW_MS;
  const toPost: Partial<BlogDraft>[] = [];
  const toBackfill: Partial<BlogDraft>[] = [];

  for (const d of drafts) {
    // Not ready is not "skip forever" — it stays unnotified and is re-checked next run, which is
    // exactly what should happen to a draft somebody is still filling in.
    if (publishReadiness(d).length > 0) { out.skipped++; continue; }
    out.ready++;
    const age = Date.parse(d.created_at ?? "");
    if (Number.isFinite(age) && age < cutoff) toBackfill.push(d);
    else toPost.push(d);
  }

  if (toBackfill.length) {
    out.backfilled = toBackfill.length;
    out.notes.push(
      `${toBackfill.length} ready draft(s) older than 48h were marked notified WITHOUT posting — ` +
        "backlog, not news. They will not be announced later.",
    );
    if (!opts.dryRun) {
      const { error: bfErr } = await supabaseAdmin.from("blog_drafts")
        .update({ slack_notified_at: new Date().toISOString() })
        .in("id", toBackfill.map((d) => d.id));
      // Silently ignored before. A failed backfill means the whole backlog is re-evaluated next tick,
      // which is the one path that could still flood the channel.
      if (bfErr) out.failures.push({ draft: `${toBackfill.length} backfilled drafts`, error: bfErr.message });
    }
  }

  const batch = toPost.slice(0, MAX_PER_RUN);
  if (toPost.length > batch.length) {
    out.notes.push(`${toPost.length - batch.length} more are ready; capped at ${MAX_PER_RUN} this run.`);
  }

  const tag = tagFor("blog");
  for (const d of batch) {
    if (opts.dryRun) { out.posted++; continue; }

    const label = d.title || d.slug || d.id || "unknown draft";
    // Claim it first, and only if nobody else has. `.is(...)` makes this a compare-and-set: the
    // returned rows tell us whether WE claimed it or lost the race, which a blind update cannot.
    const claim = await supabaseAdmin.from("blog_drafts")
      .update({ slack_notified_at: new Date().toISOString() })
      .eq("id", d.id)
      .is("slack_notified_at", null)
      .select("id");
    if (claim.error) {
      // Unclaimed, so it will be retried next tick — which is correct, because nothing was posted.
      out.failures.push({ draft: label, error: `could not claim: ${claim.error.message}` });
      continue;
    }
    if (!claim.data?.length) { out.skipped++; continue; }

    const res = await slackPost(composeReadyMessage(d as BlogDraft, tag));
    if (res.ok) out.posted++;
    else out.failures.push({ draft: label, error: res.error ?? "post failed" });
  }

  return out;
}
