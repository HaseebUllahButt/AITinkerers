// The turn loop: one call to runTurn() handles one human message, but internally may round-trip
// with the model several times (tool call → tool result → next response) before it either produces
// plain text, hits a control-tool stop point (propose_outline), or exhausts its per-turn budget.
//
// Everything from prompt.ts's cache layout to tools.ts's provenance ledger exists to make this loop
// safe and cheap to run repeatedly. This file is where they're actually wired together.
import Anthropic from "@anthropic-ai/sdk";
import {
  getWriterSession, updateWriterSession, appendWriterMessage, listWriterMessages,
  accumulateWriterUsage, getBlogDraft,
  type WriterSession, type WriterVoice,
} from "@/lib/db/queries";
import { anthropicClient, baseWriterParams } from "./anthropic";
import { buildSystem, phaseDirective, toolChoiceFor, applyCacheBreakpoints, pendingToolUseIds, briefWasSupplied } from "./prompt";
import { WRITER_TOOLS, runTool, newLedger, type ResearchLedger } from "./tools";
import { CONTROL_TOOLS, runControlTool } from "./control";
import { humanTextFromBlocks, extractUrls, mergeRequiredSources } from "./userInput";

const ALL_TOOLS = [...WRITER_TOOLS, ...CONTROL_TOOLS];
const RESEARCH_TOOL_NAMES = new Set(WRITER_TOOLS.map((t) => t.name));

/** Internal round-trips per human message. A round-trip is one model call; the model itself is
 *  also capped at 4 tool calls per call (tools.ts), so this bounds total tool fan-out per turn. */
const MAX_INTERNAL_ROUNDS = 8;
const DEFAULT_MAX_TOKENS = 8000;
const RETRY_MAX_TOKENS = 20000;

import { describeToolCall } from "./steps";

export type WriterEvent =
  | { t: "phase"; phase: string }
  | { t: "thinking"; text: string }
  | { t: "text"; text: string }
  /** `label`/`detail` are human-readable. The UI should never show a raw tool name: "web_search" is
   *  an implementation detail, "Searching the web for …" is what the user needs. */
  | { t: "tool_start"; name: string; label: string; detail?: string }
  | { t: "tool_result"; name: string; label: string; is_error: boolean; detail?: string; preview: string }
  /** Progress after a section lands, so the UI can show 3/8 without re-deriving it. */
  | { t: "progress"; sections_written: number; sections_total: number; words: number; target_words?: number | null }
  | { t: "outline"; outline: unknown }
  | { t: "draft"; draft_id: string }
  | { t: "usage"; usage: Record<string, number> }
  | { t: "done"; phase: string }
  | { t: "error"; message: string };

function ledgerFromSession(session: WriterSession): ResearchLedger {
  const ledger = newLedger();
  const research = (session.research ?? {}) as Record<string, unknown>;
  ledger.sources = (research.sources as ResearchLedger["sources"]) ?? {};
  ledger.keyword_rows = (research.keyword_rows as ResearchLedger["keyword_rows"]) ?? [];
  ledger.paa = (research.paa as string[]) ?? [];
  ledger.related = (research.related as string[]) ?? [];
  return ledger;
}

async function persistLedger(sessionId: string, ledger: ResearchLedger): Promise<void> {
  // Dedupe the string lists: serp_analysis may be called for several keyword variants and the same
  // PAA question often comes back more than once.
  await updateWriterSession(sessionId, {
    research: {
      sources: ledger.sources,
      keyword_rows: ledger.keyword_rows,
      paa: [...new Set(ledger.paa)],
      related: [...new Set(ledger.related)],
    },
  });
}

/**
 * Is this an API failure that will probably succeed on a retry?
 *
 * ── Why this distinction has to exist ───────────────────────────────────────────────────────────
 *
 * Measured on the 18:00 autopilot run of 2026-08-24. The judge picked well, the cannibalization gate
 * cleared it, the session opened — and 37 seconds later the stream threw
 * `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`. The run was marked
 * `failed` with an empty body and the slug `untitled-6f97defb`, and four reviewers were told the run
 * "did not produce a reviewable draft".
 *
 * Nothing was wrong with the work. Anthropic was busy for a moment.
 *
 * The reason it was fatal is that the two catch blocks below RETURNED the session instead of throwing.
 * request.ts has retry machinery for exactly this — MAX_RUN_ATTEMPTS, a re-enqueue that preserves
 * section_cursor so no research is repeated — but it lives in a `catch`, so a failure that never throws
 * never reaches it. `brief.run_attempts` on that session is undefined: the retry did not decline to
 * run, it was never asked. And resumeStalledRuns deliberately skips `failed` sessions, so the one
 * backstop that could have rescued it was closed off by the same write.
 *
 * That is the same bug as the transient-throw fix earlier in this pipeline, on the other of the two
 * paths. That one was reached by throwing; this one returns.
 *
 * ── What is NOT transient ───────────────────────────────────────────────────────────────────────
 *
 * A refusal is a real outcome the model is entitled to have, and a 400 invalid_request_error means we
 * sent something malformed — retrying either just spends money to get the same answer. Both stay
 * terminal, which is why this is a predicate and not a blanket "retry everything".
 */
export function isTransientApiError(e: unknown): boolean {
  const err = e as { status?: number; error?: { error?: { type?: string } }; message?: string; name?: string } | null;
  // The SDK surfaces HTTP status directly on its error types.
  const status = typeof err?.status === "number" ? err.status : 0;
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true;
  // A 4xx that is not one of the above is our fault and will not fix itself.
  if (status >= 400) return false;

  const apiType = err?.error?.error?.type ?? "";
  if (/overloaded_error|rate_limit_error|api_error|timeout_error/i.test(apiType)) return true;

  // No status and no typed body: a socket died, or the stream was cut mid-flight. Matched on text
  // because that is all these arrive with.
  const text = `${err?.name ?? ""} ${err?.message ?? ""}`;
  return /overloaded|rate.?limit|econnreset|epipe|etimedout|socket hang up|premature close|terminated|fetch failed|network|aborterror|timeout/i.test(text);
}

/**
 * Run one human turn to completion (which may be several model↔tool round-trips) and stream
 * progress via `onEvent`. Never throws for a model-side failure (refusal, truncation) — those are
 * reported as `{t:"error"}` events and the session is marked `failed`; throwing is reserved for
 * configuration errors (no API key, session/voice not found) the caller should 4xx on.
 */
export async function runTurn(
  sessionId: string,
  userText: string | undefined,
  onEvent: (e: WriterEvent) => void,
): Promise<WriterSession> {
  const client = anthropicClient();
  if (!client) throw new Error("Writer is not configured (ANTHROPIC_API_KEY not set).");

  let session = await getWriterSession(sessionId);
  if (!session) throw new Error("Session not found.");
  if (!session.voice_id) throw new Error("Session has no voice attached.");

  const { getWriterVoice } = await import("@/lib/db/queries");
  const voice: WriterVoice | null = await getWriterVoice(session.voice_id);
  if (!voice) throw new Error("The voice attached to this session no longer exists.");

  if (session.phase === "done" || session.phase === "failed" || session.phase === "validating") {
    throw new Error(`This session is in phase "${session.phase}" and cannot take another turn.`);
  }

  const history = await listWriterMessages(sessionId);
  const isFirstTurn = history.length === 0;
  const messages: Anthropic.MessageParam[] = history.map((h) => ({
    role: h.role, content: h.blocks as Anthropic.ContentBlockParam[],
  }));

  // Self-heal an interrupted turn.
  //
  // If history ends on an assistant message carrying tool_use blocks, the turn that made them died
  // before their results were persisted — the Vercel ceiling, a crash, a deploy mid-stream. The API
  // then rejects EVERY later request on this session ("tool_use ids were found without tool_result
  // blocks immediately after"), so the session is bricked permanently rather than merely interrupted.
  //
  // Hermes has had this guard since it hit the same wall; the writer never got it, and an unattended
  // article is far more exposed than a person chatting, because the run hands off at 200s by design
  // and nobody is watching to start a fresh session. Observed in the wild: an API-requested article
  // died at messages.26 and every retry returned the same 400.
  //
  // Synthesising the missing results costs one tool call. Losing the session costs the article.
  const last = history[history.length - 1];
  if (last?.role === "assistant") {
    const dangling = pendingToolUseIds(last.blocks as unknown[]);
    if (dangling.length) {
      const repairs: Anthropic.ContentBlockParam[] = dangling.map((id) => ({
        type: "tool_result", tool_use_id: id, is_error: true,
        content: "Interrupted: the turn ended before this tool finished. Its underlying job may still have completed — check before assuming it did not, and do not simply repeat it.",
      }));
      messages.push({ role: "user", content: repairs });
      await appendWriterMessage(sessionId, "user", repairs);
    }
  }

  const ledger = ledgerFromSession(session);

  // Everything the person has typed across this session, directive-stripped. Passed to the control
  // tools so save_brief can fall back to their actual words when the model summarises instead of
  // capturing, rather than recording nothing at all.
  const humanText = [
    ...history.filter((h) => h.role === "user").map((h) => humanTextFromBlocks(h.blocks)),
    userText?.trim() ?? "",
  ].filter(Boolean).join("\n\n");

  // Any URL the person pastes becomes required reading, on every turn and without the model's
  // involvement. save_brief only ever captured links the model chose to forward, and only at the
  // moment the brief was saved, so "read this one too" sent mid-research reached nothing. Once a URL
  // lands in required_sources the existing machinery takes over: phaseDirective restates it while it
  // is unread, and propose_outline refuses to run until it has actually been fetched.
  {
    const merged = mergeRequiredSources(session.required_sources, extractUrls(userText ?? ""));
    if (merged) {
      session = await updateWriterSession(sessionId, {
        required_sources: merged,
      } as Parameters<typeof updateWriterSession>[1]);
    }
  }

  const userBlocks: Anthropic.ContentBlockParam[] = [
    { type: "text", text: phaseDirective(session, isFirstTurn) },
  ];
  if (userText?.trim()) userBlocks.push({ type: "text", text: userText.trim() });
  messages.push({ role: "user", content: userBlocks });
  await appendWriterMessage(sessionId, "user", userBlocks);

  const system = buildSystem(voice);
  let triedHigherBudget = false;

  for (let round = 0; round < MAX_INTERNAL_ROUNDS; round++) {
    ledger.callsThisTurn = 0;
    const toolChoice = toolChoiceFor(session.phase, isFirstTurn, briefWasSupplied(session));
    const maxTokens = triedHigherBudget ? RETRY_MAX_TOKENS : DEFAULT_MAX_TOKENS;

    let stream: ReturnType<Anthropic["messages"]["stream"]>;
    try {
      stream = client.messages.stream({
        ...baseWriterParams(session.phase === "researching" ? "high" : "medium"),
        max_tokens: maxTokens,
        system,
        messages: applyCacheBreakpoints(messages),
        tools: ALL_TOOLS,
        tool_choice: toolChoice,
      });
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? "Request failed to start.";
      onEvent({ t: "error", message: msg });
      // Transient: leave the phase alone and THROW, so request.ts's retry resumes this session with its
      // research and section_cursor intact. Marking it `failed` here is what made a moment of API
      // congestion permanent.
      if (isTransientApiError(e)) throw new Error(`the writer could not start a request: ${msg}`);
      session = await updateWriterSession(sessionId, { phase: "failed", error: msg });
      return session;
    }

    try {
      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") onEvent({ t: "text", text: event.delta.text });
          else if (event.delta.type === "thinking_delta") onEvent({ t: "thinking", text: event.delta.thinking });
        } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          // The input hasn't streamed yet at block_start, so only the name is known here. The
          // specific query/URL arrives with the tool_result event below.
          const { label } = describeToolCall(event.content_block.name, {}, session.outline?.sections);
          onEvent({ t: "tool_start", name: event.content_block.name, label });
        }
      }
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? "Stream interrupted.";
      onEvent({ t: "error", message: msg });
      // Same as above. This is the site that killed the 18:00 run of 2026-08-24 on an `overloaded_error`.
      if (isTransientApiError(e)) throw new Error(`the writer's stream was interrupted: ${msg}`);
      session = await updateWriterSession(sessionId, { phase: "failed", error: msg });
      return session;
    }

    const final = await stream.finalMessage();
    await accumulateWriterUsage(sessionId, {
      input_tokens: final.usage.input_tokens,
      output_tokens: final.usage.output_tokens,
      cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: final.usage.cache_read_input_tokens ?? 0,
    });
    onEvent({ t: "usage", usage: final.usage as unknown as Record<string, number> });

    // Never read final.content unconditionally — a refusal can arrive with empty content, and a
    // safety classifier decline is a real, expected outcome for the model to have, not a bug.
    if (final.stop_reason === "refusal") {
      onEvent({ t: "error", message: "The model declined this request (safety classifier)." });
      messages.push({ role: "assistant", content: final.content });
      await appendWriterMessage(sessionId, "assistant", final.content);
      session = await updateWriterSession(sessionId, { phase: "failed", error: "refusal" });
      return session;
    }

    const toolUses = final.content.filter(
      (b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // A truncated response with no tool call: don't commit the partial, retry once with a larger
    // budget instead. (A truncated tool_use input is a different, rarer failure — the SDK cannot
    // parse it as JSON, so it wouldn't appear in toolUses at all; that case falls through to the
    // "no tool calls" branch below and gets the same retry, which is the correct response anyway.)
    if (final.stop_reason === "max_tokens" && toolUses.length === 0 && !triedHigherBudget) {
      triedHigherBudget = true;
      onEvent({ t: "text", text: "" }); // no-op keepalive; real signal is the retry itself
      continue;
    }

    messages.push({ role: "assistant", content: final.content });
    await appendWriterMessage(sessionId, "assistant", final.content);

    if (toolUses.length === 0) {
      // Plain end_turn (or a second max_tokens with no recovery left) — this human turn is done.
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let endTurnSignal = false;
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      let content: string;
      let isError = false;

      if (RESEARCH_TOOL_NAMES.has(tu.name)) {
        const r = await runTool(tu.name, input, { ledger });
        content = r.content; isError = !!r.is_error;
      } else {
        const r = await runControlTool(tu.name, input, { session, voice, ledger, humanText });
        content = r.content; isError = !!r.is_error;
        if (r.endTurn) endTurnSignal = true;
        // Control tools write directly to the session row; reload so phase/outline/draft reflect it.
        session = (await getWriterSession(sessionId)) ?? session;
      }

      const { label, detail } = describeToolCall(tu.name, input, session.outline?.sections);
      onEvent({ t: "tool_result", name: tu.name, label, detail, is_error: isError, preview: content.slice(0, 200) });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content, is_error: isError });

      // Emit progress as each section lands, so a long writing turn visibly advances instead of
      // sitting on a spinner for several minutes.
      if (tu.name === "submit_section" && !isError) {
        const total = session.outline?.sections.length ?? 0;
        const written = Object.keys(session.sections ?? {}).length;
        const draft = session.draft_id ? await getBlogDraft(session.draft_id).catch(() => null) : null;
        onEvent({
          t: "progress",
          sections_written: written,
          sections_total: total,
          words: draft?.body ? draft.body.trim().split(/\s+/).filter(Boolean).length : 0,
          target_words: session.brief?.word_count ?? null,
        });
      }
    }

    await persistLedger(sessionId, ledger);
    if (session.phase === "outline_pending") onEvent({ t: "outline", outline: session.outline });
    if (session.draft_id) onEvent({ t: "draft", draft_id: session.draft_id });

    messages.push({ role: "user", content: toolResults });
    await appendWriterMessage(sessionId, "user", toolResults);

    if (endTurnSignal) break;
    triedHigherBudget = false; // a fresh round gets its own retry budget
  }

  onEvent({ t: "phase", phase: session.phase });
  onEvent({ t: "done", phase: session.phase });
  return session;
}

/**
 * Is this session waiting on the MACHINE, or on the human?
 *
 * `MAX_INTERNAL_ROUNDS` bounds model round-trips per message, which is necessary — but when a turn
 * hits that ceiling mid-research it simply falls out of the loop and reports `done` with the phase
 * still `researching`. To the user that is indistinguishable from the agent giving up: the transcript
 * shows a wall of tool calls, no conclusion, and an idle composer. One real session fetched 49 sources
 * and stopped exactly this way.
 *
 * Research and section-writing have nothing for a human to contribute, so the turn route keeps going
 * on its own while this returns true. `gathering` and `outline_pending` are the two phases that
 * genuinely need a person, and they must never auto-continue — `outline_pending` in particular is the
 * approval gate, and continuing through it would defeat the entire point.
 */
export function needsMachineContinuation(session: WriterSession): boolean {
  switch (session.phase) {
    case "researching":
      return true;                                    // must end at propose_outline
    case "approved":
      return true;                                    // section 0 not written yet
    case "writing":
      return !isWritingComplete(session);
    default:
      return false;                                   // gathering, outline_pending, validating, done, failed
  }
}

/** True once every outline section has a corresponding submit_section call. The turn route uses
 *  this to decide whether the NEXT human-triggered turn should move phase writing → validating
 *  instead of asking for another section. */
export function isWritingComplete(session: WriterSession): boolean {
  const total = session.outline?.sections.length ?? 0;
  return total > 0 && session.section_cursor >= total;
}

export { getBlogDraft };
