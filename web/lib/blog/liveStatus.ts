// What Summit is doing to a draft RIGHT NOW.
//
// ── Why this is derived, not stored ─────────────────────────────────────────────────────────────
//
// A `status` column would need writing at every step of a long, interruptible, re-entrant job — and
// the one thing that job reliably does is die between steps, which is exactly when the column would
// be left lying. `writer_sessions` already records phase, the outline, and which sections exist;
// reading those answers the question without anything new to keep in sync.
//
// ── Why "active" needs a heartbeat, not just a phase ────────────────────────────────────────────
//
// A session killed mid-run keeps its phase forever. `writing` on a row nobody has touched for an
// hour is not "writing", it is abandoned — and a spinner that never stops is worse than no spinner,
// because it teaches people the indicator is decorative. So a session only reads as live if it has
// moved recently.
import { supabaseAdmin } from "@/lib/db/supabase";

/** Past this with no update and a run is stalled, not working. Generous: an image render alone can
 *  take minutes, and a chunk handoff can leave a gap while QStash re-enqueues. */
const STALE_AFTER_MS = 12 * 60_000;

/**
 * Past this and it is not a status at all — it is history, and it does not belong on the list.
 *
 * Measured before this existed: 27 of 38 drafts showed a status, and almost every one read
 * "Stalled while writing" on a session last touched SIXTEEN DAYS ago, for a draft that is finished
 * and synced. A session only ever flips to `done` if the run reaches its final step, so every job
 * that died — or simply predates that step — leaves a phase behind forever.
 *
 * A live indicator that is mostly wrong is worse than none: it trains people to stop reading it,
 * and then the one row genuinely mid-write looks like all the others.
 */
const FORGET_AFTER_MS = 2 * 60 * 60_000;

export interface LiveStatus {
  draft_id: string;
  /** researching | writing | validating | illustrating | stalled | failed */
  state: string;
  /** One short line for a UI that has no room for two. */
  label: string;
  sections_written: number;
  sections_planned: number;
  updated_at: string;
  error: string | null;
}

interface SessionRow {
  draft_id: string | null;
  phase: string | null;
  error: string | null;
  updated_at: string;
  outline: { sections?: unknown[] } | null;
  sections: Record<string, unknown> | null;
  brief: Record<string, unknown> | null;
}

function describe(s: SessionRow): LiveStatus | null {
  if (!s.draft_id) return null;
  const written = Object.keys(s.sections ?? {}).length;
  const planned = Array.isArray(s.outline?.sections) ? s.outline!.sections!.length : 0;
  const idleMs = Date.now() - Date.parse(s.updated_at);
  const base = { draft_id: s.draft_id, sections_written: written, sections_planned: planned, updated_at: s.updated_at, error: s.error };

  if (s.phase === "failed") {
    // Same forgetting rule: a failure from last week is not news, and the draft itself shows what
    // state it is in. Only a RECENT failure is worth a line on the list.
    if (idleMs > FORGET_AFTER_MS) return null;
    return { ...base, state: "failed", label: s.error ? `Failed — ${s.error.slice(0, 48)}` : "Failed" };
  }
  // `done` is not a status worth showing: the draft itself is the outcome, and a permanent green
  // tick on every finished row is noise.
  if (s.phase === "done") return null;

  // Old enough that nobody is waiting on it. Silence, not a stale label.
  if (idleMs > FORGET_AFTER_MS) return null;

  // Finished, but the repair loop ran out of rounds. Not stalled — it is done trying, and the
  // article is readable. Saying "stalled" here sends someone looking for a dead run and teaches
  // them the indicator lies.
  if (s.brief?.repairs_exhausted_at) {
    return { ...base, state: "flagged", label: "Flagged — written, needs a read" };
  }

  if (idleMs > STALE_AFTER_MS) {
    return { ...base, state: "stalled", label: `Stalled while ${s.phase ?? "running"}` };
  }

  // Images come after the last section, so "all sections written and still going" IS the image step
  // — and that is the part that takes minutes and most needs saying out loud.
  if (planned > 0 && written >= planned && !s.brief?.assets_done_at) {
    return { ...base, state: "illustrating", label: "Generating images" };
  }
  if (s.phase === "writing") {
    return { ...base, state: "writing", label: planned ? `Writing ${written}/${planned}` : "Writing" };
  }
  if (s.phase === "researching" || s.phase === "gathering") {
    return { ...base, state: "researching", label: "Researching" };
  }
  if (s.phase === "validating") return { ...base, state: "validating", label: "Checking the draft" };
  if (s.phase === "outline_pending") return { ...base, state: "validating", label: "Outline waiting for approval" };
  return { ...base, state: String(s.phase ?? "running"), label: `Running (${s.phase ?? "?"})` };
}

/**
 * Live status for every draft that has one, keyed by draft id.
 *
 * One query for the whole list rather than one per row: the drafts page renders forty of these and
 * forty round trips to answer "is anything happening" would cost more than the page.
 */
export async function liveStatuses(): Promise<Record<string, LiveStatus>> {
  // The forgetting window is applied in SQL, not just in describe().
  //
  // `sections` holds the whole written article, section by section, and `outline` and `brief` are
  // sizeable too — yet all describe() needs from them is a KEY COUNT, an array length, and one
  // timestamp. Selecting them for 200 rows and then discarding everything older than two hours in JS
  // meant the drafts page hauled megabytes of article text on every poll to compute a handful of
  // labels. queries.ts already learned this lesson once: select("*") for the drafts sidebar measured
  // 92KB for 11 rows and was cut down for exactly this reason.
  //
  // It matters more than it looks. This is a POLLED endpoint on a shared-CPU Postgres, and it shares
  // that database with everything else in the app — the instance was found at 97% CPU and 99% disk IO,
  // returning 504s. One WHERE clause turns the common case (nothing running) into an empty read.
  const cutoff = new Date(Date.now() - FORGET_AFTER_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("writer_sessions")
    .select("draft_id, phase, error, updated_at, outline, sections, brief")
    .not("draft_id", "is", null)
    .neq("phase", "done")
    .gt("updated_at", cutoff)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) return {};

  const out: Record<string, LiveStatus> = {};
  for (const row of (data ?? []) as SessionRow[]) {
    // Newest first, so the first session seen for a draft is its current one. A draft re-run after a
    // failure has two sessions, and the old one's "failed" must not outrank the new one's progress.
    if (row.draft_id && !out[row.draft_id]) {
      const s = describe(row);
      if (s) out[row.draft_id] = s;
    }
  }
  return out;
}
