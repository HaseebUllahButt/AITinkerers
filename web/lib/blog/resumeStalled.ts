// Restart writer runs that died between steps.
//
// ── The failure this exists for, measured ────────────────────────────────────────────────────────
//
// The autopilot's 15:00 run on 2026-08-21 wrote a complete article — 14 of 14 sections, 14,807
// characters — and then went quiet. Session 2482926f: phase `writing`, error `null`, last touched
// 10:10:50, and it will stay that way forever. No thumbnail, no cover, no JSON-LD, no Slack.
//
// runBlogRequest DOES re-enqueue itself when it runs out of invocation budget, but only after
// writeOneArticle RETURNS. When the platform kills the function inside that call, the handoff never
// happens and nothing else is watching. liveStatus.ts already recognises the state and renders
// "Stalled while writing" — a label, and nothing that acts on it.
//
// The draft was eventually rescued only because ensureThumbnails runs hourly and independently, and
// happened to fill the one field that blocked publishing. That is luck, not recovery: it leaves the
// session stuck, the cover image missing, and the schema ungenerated.
//
// ── Why re-enqueuing is the whole fix ───────────────────────────────────────────────────────────
//
// runBlogRequest is already re-entrant, because the QStash handoff needs it to be:
//   phase === "done"        → returns immediately, so a finished run cannot be redone
//   section_cursor          → writeOneArticle continues from the section it reached
//   brief.assets_done_at    → images are never re-rendered, so a resume cannot re-bill a render
//   sync + announce         → both guarded, and the announcement claims slack_notified_at
// So the recovery is not new machinery. It is calling the existing entry point again.
import { supabaseAdmin } from "@/lib/db/supabase";
import { qstashPublish } from "@/lib/qstash";

/**
 * Idle for this long and a run is dead rather than slow. Matches liveStatus.ts's STALE_AFTER_MS so
 * the thing that SAYS "stalled" and the thing that FIXES it agree — two different thresholds would
 * mean a row labelled stalled that never gets resumed, or the reverse.
 */
const STALE_AFTER_MS = 12 * 60_000;

/**
 * Older than this and leave it alone.
 *
 * The same lesson liveStatus.ts learned: a session only flips to `done` if the run reaches its final
 * step, so every job that ever died leaves a phase behind forever — 27 of 38 drafts once showed a
 * status, almost all of them "Stalled while writing" on sessions weeks old. Resuming those would
 * spend real model and image budget rewriting articles nobody is waiting for, and would announce
 * them as new.
 */
const RESUMABLE_WINDOW_MS = 6 * 60 * 60_000;

/** Per run, so a backlog cannot fan out into dozens of concurrent article writes. */
const MAX_PER_RUN = 3;

/**
 * How many times one session may be resumed before it is left alone.
 *
 * Belt and braces behind the created_at fix above. A run that has been re-enqueued three times and is
 * still not finished has something wrong with it that resuming does not address — the live case was an
 * Anthropic spend cap with a four-day reset, which no number of retries clears. Without a counter the
 * only thing bounding the loop is a date comparison, and that is exactly what was already wrong.
 */
const MAX_RESUMES = 3;

export interface ResumeResult {
  /** Sessions that were idle long enough to count as stalled. */
  stalled: number;
  /** Re-enqueued this run. */
  resumed: number;
  /** Draft ids the caller should leave alone this tick — a resumed run owns them. */
  resumedDraftIds: string[];
  /** Too old to be worth resuming, and deliberately left. */
  tooOld: number;
  failures: Array<{ session: string; error: string }>;
  notes: string[];
}

export async function resumeStalledRuns(opts: { dryRun?: boolean } = {}): Promise<ResumeResult> {
  const out: ResumeResult = { stalled: 0, resumed: 0, resumedDraftIds: [], tooOld: 0, failures: [], notes: [] };

  const now = Date.now();
  const staleBefore = new Date(now - STALE_AFTER_MS).toISOString();
  const oldestWorth = new Date(now - RESUMABLE_WINDOW_MS).toISOString();

  // Bounded in SQL, not in JS. `sections` holds the whole article and this table is on the same
  // shared-CPU Postgres everything else uses — the drafts page already had to learn not to haul
  // megabytes of article text to compute a label (see liveStatus.ts).
  const { data, error } = await supabaseAdmin
    .from("writer_sessions")
    .select("id, draft_id, phase, updated_at, created_at, brief")
    .not("draft_id", "is", null)
    .not("phase", "in", '("done","failed")')
    .lt("updated_at", staleBefore)
    // AGE is measured from created_at, not updated_at. This was `.gt("updated_at", …)` and it made the
    // window self-renewing: every resume attempt bumps updated_at, so a session that can NEVER finish —
    // one blocked on an API spend cap, say — stayed inside the six-hour window forever and was
    // re-enqueued once an hour indefinitely. Measured on two sessions still being resumed nine hours
    // after they were created, each time announcing the same draft again.
    //
    // The two clocks answer different questions and must read different columns: updated_at says "is it
    // idle", created_at says "is it still worth finishing".
    .gt("created_at", oldestWorth)
    .order("updated_at", { ascending: true })
    .limit(50);
  if (error) {
    out.notes.push(`Could not read writer sessions: ${error.message}`);
    return out;
  }

  const rows = data ?? [];
  out.stalled = rows.length;
  if (!rows.length) return out;

  // Anything outside the window was already excluded in SQL; this only reports the count so a
  // silently-skipped backlog is visible rather than implied.
  const { count: ancient } = await supabaseAdmin
    .from("writer_sessions")
    .select("id", { count: "exact", head: true })
    .not("draft_id", "is", null)
    .not("phase", "in", '("done","failed")')
    .lt("created_at", oldestWorth);
  out.tooOld = ancient ?? 0;
  if (out.tooOld) {
    out.notes.push(
      `${out.tooOld} session(s) are stalled but older than ${RESUMABLE_WINDOW_MS / 3_600_000}h and were left alone — ` +
        "resuming those would rewrite articles nobody is waiting for and announce them as new.",
    );
  }

  const batch = rows.slice(0, MAX_PER_RUN);
  if (rows.length > batch.length) {
    out.notes.push(`${rows.length - batch.length} more are stalled; capped at ${MAX_PER_RUN} this run.`);
  }

  for (const s of batch) {
    const idleMin = Math.round((now - Date.parse(s.updated_at)) / 60_000);
    const brief = (s.brief ?? {}) as Record<string, unknown>;
    const tries = Number(brief.resume_attempts ?? 0);
    // Its repair budget is spent and the article is written. Resuming re-runs finalize plus two more
    // repair rounds against violations two rounds already failed to fix — spend with no path to a
    // different outcome.
    if ((s.brief as { repairs_exhausted_at?: string } | null)?.repairs_exhausted_at) {
      out.notes.push(`${s.id} is written but flagged; its repair rounds are spent, so it was left alone.`);
      continue;
    }
    if (tries >= MAX_RESUMES) {
      out.notes.push(`${s.id} has been resumed ${tries} times already and was left alone.`);
      continue;
    }
    if (opts.dryRun) {
      out.resumed++;
      out.resumedDraftIds.push(s.draft_id as string);
      out.notes.push(`would resume ${s.id} (draft ${s.draft_id}, phase ${s.phase}, idle ${idleMin}m)`);
      continue;
    }
    const queued = await qstashPublish("/api/blog/request/run", { session_id: s.id });
    if (queued) {
      // Count it BEFORE the run gets a chance to finish or fail. A counter written afterwards would
      // never be written at all for the case it exists to bound — a run that keeps dying.
      //
      // The existing brief is spread rather than replaced: it holds the topic, the keyword, the
      // section cursor's companions and run_attempts, and writing `{ resume_attempts }` alone would
      // silently discard the brief the resumed run is about to read.
      await supabaseAdmin.from("writer_sessions")
        .update({ brief: { ...brief, resume_attempts: tries + 1 } })
        .eq("id", s.id)
        .then(() => {}, () => {});
      out.resumed++;
      out.resumedDraftIds.push(s.draft_id as string);
      out.notes.push(`resumed ${s.id} (phase ${s.phase}, idle ${idleMin}m, attempt ${tries + 1} of ${MAX_RESUMES})`);
    } else {
      // A missing queue is the one case this cannot work around, and saying so matters: without it
      // the sweep looks like it ran and fixed nothing.
      out.failures.push({ session: s.id, error: "QStash is not configured, so the run could not be re-enqueued." });
    }
  }

  return out;
}
