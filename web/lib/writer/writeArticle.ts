// Drive one article from wherever it is to done or failed.
//
// Extracted from the cluster runner when clusters were removed. The blog autopilot
// (src/lib/blog/request.ts) is the only caller, and it was always the load-bearing one: this is the
// loop that turns an approved outline into finished sections, validates it, and applies the repair
// rounds.
//
// Resumability has two levels, both necessary. Article index survives an invocation boundary; section
// index (`section_cursor`, inside the session) survives one WITHIN an article. A single generation
// cannot be resumed once it is streaming, so the resumable unit has to be smaller than one
// invocation. Pattern copied from src/lib/enrich/run.ts.
import { getWriterSession, updateWriterSession } from "@/lib/db/queries";
import { runTurn } from "./agent";
import { finalizeSession } from "./finalize";

/** Writing turns per article before giving up on it. Generous because the first one or two go on
 *  research and the outline, not on sections. */
const MAX_WRITE_TURNS = 8;
/** Automatic repair rounds per unattended article. Matches the interactive cap. */
const MAX_REPAIR_ROUNDS = 2;

/**
 * Drive one article from wherever it is to done or failed.
 *
 * The auto-approve check sits INSIDE the loop, not before it. An article often needs two turns to
 * produce an outline (research, then propose), and a single pre-loop check ran while the phase was
 * still `researching` — so the outline arrived afterwards, was never approved, and the article looped
 * six times writing nothing and finished at 0 sections. Re-checking each iteration makes the loop
 * indifferent to how many turns the outline takes.
 */
export async function writeOneArticle(
  sessionId: string,
  /**
   * Wall-clock ceiling for THIS invocation. Past it, the function returns "incomplete" between turns
   * so the caller can hand off, instead of being killed mid-turn.
   *
   * ── Why this parameter exists, measured ───────────────────────────────────────────────────────
   *
   * This loop had no clock at all. It is bounded by TURN COUNT (8 write turns plus 2 repair rounds),
   * and each turn is a whole model call — so a long article simply runs until it finishes or the
   * platform kills the function at 300s. Both callers check their budget only AFTER this returns, so
   * when the kill lands inside here the handoff never happens and nothing re-enqueues the run.
   *
   * Measured on the autopilot's 15:00 run on 2026-08-21: 14 of 14 sections written, 14,807
   * characters, and then silence — session phase stuck at `writing`, no images, no announcement. It
   * only completed 45 minutes later when a QStash delivery retry happened to resume it from
   * `section_cursor`. Eight sessions were sitting in that state going back to 2026-08-13, so this
   * predates anything unattended; the autopilot only made it frequent and visible.
   *
   * The resumability was already built — the file header notes that `section_cursor` survives within
   * an article. Nothing ever triggered it mid-article. This is that trigger.
   *
   * Omitted (the default) keeps the old unbounded behaviour, for the interactive path where a person
   * is watching and there is no function ceiling to respect.
   */
  deadlineAt?: number,
): Promise<"done" | "flagged" | "failed" | "incomplete"> {
  const noop = () => {};
  let session = await getWriterSession(sessionId);
  if (!session) return "failed";

  /** Checked BETWEEN turns only. A turn already in flight is left to finish — aborting it would
   *  waste the model call that was already paid for. */
  const outOfTime = () => deadlineAt !== undefined && Date.now() > deadlineAt;

  for (let i = 0; i < MAX_WRITE_TURNS; i++) {
    session = (await getWriterSession(sessionId)) ?? session;
    if (session.phase === "failed") return "failed";
    // Stop before starting another section. The phase stays whatever it was, which is exactly what a
    // resumed run needs to pick up from.
    if (outOfTime()) return "incomplete";

    // Auto-approve: an unattended run has nobody to press "approve", and the brief the autopilot
    // judged and claimed IS that approval. This is the only legitimate auto-approval in the system.
    if (session.phase === "outline_pending") {
      session = await updateWriterSession(sessionId, {
        phase: "approved",
        outline_approved_at: new Date().toISOString(),
        outline_approved_by: "blog-autopilot-brief",
      });
    }

    const total = session.outline?.sections.length ?? 0;
    const written = Object.keys(session.sections ?? {}).length;
    if (total > 0 && written >= total) break;

    const nudge = session.phase === "researching" || session.phase === "gathering"
      ? "Research this and propose the outline."
      : undefined;
    session = await runTurn(sessionId, nudge, noop);
  }

  // Still no outline after every allowed turn: the article genuinely did not get made.
  const finalSession = (await getWriterSession(sessionId)) ?? session;
  if (Object.keys(finalSession.sections ?? {}).length === 0) {
    await updateWriterSession(sessionId, { phase: "failed", error: "no sections were written" });
    return "failed";
  }

  // Validation and the repair rounds are model calls too, and they are what most often push a long
  // article past the ceiling — the sections can all be written and the run still die in here.
  if (outOfTime()) return "incomplete";

  let fin = await finalizeSession(sessionId);
  if (!fin.ok) return "failed";

  // Unattended articles get the repair loop applied automatically. In the chat UI a human presses
  // "Ask it to fix these"; in an unattended run nobody can press it, so a flagged article would
  // otherwise just stay flagged. Bounded by the same 2-round cap the interactive path uses.
  for (let round = 0; round < MAX_REPAIR_ROUNDS && fin.repair_prompt; round++) {
    // A flagged-but-written article is a usable outcome; being killed here is not. So the repair loop
    // yields rather than starting a round it may not survive.
    if (outOfTime()) break;
    await runTurn(sessionId, fin.repair_prompt, noop).catch(() => {});
    const next = await finalizeSession(sessionId);
    if (!next.ok) break;
    const before = (fin.violations ?? []).filter((v) => v.severity === "repair").length;
    const after = (next.violations ?? []).filter((v) => v.severity === "repair").length;
    fin = next;
    // No improvement means another round is unlikely to help and will just burn tokens.
    if (after >= before) break;
  }

  // ── Record that the repair budget is SPENT ────────────────────────────────────────────────────
  //
  // finalizeSession leaves the phase as `writing` whenever repairable violations remain, because
  // `writing` is the phase a repair turn runs in. That is right for the interactive path, where a
  // human presses "Ask it to fix these". Unattended, it means a finished-but-imperfect article sits
  // at `writing` forever with nothing left to try — and two things then treat it as a live run:
  // liveStatus calls it "Stalled while writing", and resumeStalled re-enqueues it up to three more
  // times, each attempt re-running finalize plus two repair rounds on violations the loop already
  // failed to fix twice. That is pure spend on a job that has correctly given up.
  //
  // WriterPhase has no terminal "flagged" value and adding one touches every phase switch, so the
  // fact is recorded on the brief instead and the two consumers read it.
  if (fin.verdict !== "failed" && fin.repair_prompt) {
    const s2 = await getWriterSession(sessionId);
    await updateWriterSession(sessionId, {
      brief: { ...(s2?.brief ?? {}), repairs_exhausted_at: new Date().toISOString() },
    } as never).catch(() => { /* a lost marker costs one wasted resume, not the article */ });
  }

  return fin.verdict === "failed" ? "failed" : fin.verdict === "ok" ? "done" : "flagged";
}
