// The Hermes turn loop: one call to runHermesTurn() handles one human message, round-tripping with
// the model (tool call → tool result → next response) until it produces plain text or exhausts its
// budget. A structural sibling of src/lib/writer/agent.ts — same streaming, same raw-block
// persistence, same "never throw for a model-side failure" contract — with two differences: there
// is no phase machine (a chat is not a pipeline), and tool results can carry UI payloads (tables,
// option chips, confirmation cards) that the loop re-emits as events.
import Anthropic from "@anthropic-ai/sdk";
import {
  getHermesSession, updateHermesSession, appendHermesMessage, listHermesMessages,
  accumulateHermesUsage, listPendingHermesActions, listResolvedHermesActionsSince,
  operationsOverview, listStandingRules, recentAgentCorrections,
  type HermesSession,
} from "@/lib/db/queries";
import { anthropicClient, baseWriterParams, resolveChatModel } from "@/lib/writer/anthropic";
import { isAdminEmail } from "@/lib/auth/admin";
import { buildHermesSystem, opsDirective, actionResultDirective, applyCacheBreakpoints, pendingToolUseIds } from "./prompt";
import { isHermesStopRequested, clearHermesStop } from "./stop";
import { HERMES_TOOLS, runHermesTool, MAX_TOOL_CALLS_PER_TURN, type HermesToolResult } from "./tools";
import { describeHermesTool } from "./steps";
import { attachmentBlocks, type StoredAttachment } from "./attachments";

/** Internal round-trips per human message. Higher than the writer's 8: an operator request like
 *  "check every campaign and draft what's missing" legitimately chains more steps. */
const MAX_INTERNAL_ROUNDS = 10;
const DEFAULT_MAX_TOKENS = 8000;
const RETRY_MAX_TOKENS = 20000;

/**
 * Wall clock for one turn, and the reason it exists is Vercel: the turn route's function dies at
 * 300s, and a death mid-tool leaves a tool_use with no tool_result in history (see
 * pendingToolUseIds). 240s of tool time + streaming margin keeps every tool_result persisted
 * before the platform can kill us. On a persistent server this is just a generous per-turn cap.
 */
const TURN_BUDGET_MS = 240_000;
/** Never start a tool with less than this left; below it, report "out of time" instead. */
const TOOL_MIN_REMAINING_MS = 10_000;

/** Run a tool against the remaining turn budget. On timeout the tool's promise is abandoned (its
 *  underlying work — usually a self-called endpoint — continues server-side) and the model gets an
 *  honest error result it can relay, instead of the function dying mid-round. */
async function withDeadline(run: Promise<HermesToolResult>, remainingMs: number): Promise<HermesToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HermesToolResult>((resolve) => {
    timer = setTimeout(() => resolve({
      content: "This tool ran out of time in this turn. If it started a background job, the job may still be running — re-check with a read tool (overview, backlink_funnel, email_queue_status) rather than assuming either outcome.",
      is_error: true,
    }), Math.max(0, remainingMs));
  });
  try { return await Promise.race([run, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

export type HermesEvent =
  | { t: "thinking"; text: string }
  | { t: "text"; text: string }
  | { t: "tool_start"; name: string; label: string; detail?: string }
  | { t: "tool_result"; name: string; label: string; is_error: boolean; detail?: string; preview: string }
  | { t: "table"; title: string; columns: string[]; rows: string[][] }
  | { t: "options"; question: string; options: string[] }
  | { t: "picker"; title: string; columns: string[]; rows: string[][]; key_col: number }
  | { t: "confirm"; action_id: string; kind: string; summary: string }
  /** Media a tool produced, one event per item. Emitted alongside the tool_result so the transcript
   *  can render it inline — `generate_assets` was otherwise silently invisible in chat. */
  | {
      t: "element";
      id: string;
      element_type: "image";
      url: string;
      alt: string;
      mime?: string;
      width?: number;
      height?: number;
    }
  | { t: "usage"; usage: Record<string, number> }
  /**
   * `needsContinuation` asks the CLIENT to run another segment with no new human message.
   *
   * Set only for a clean cutoff — the round budget filled, or the turn deadline passed — never for a
   * user Stop and never for an error. Those two are decisions, and resuming past a decision is how an
   * agent ignores being told to stop.
   */
  | { t: "done"; needsContinuation?: boolean }
  | { t: "error"; message: string };

/**
 * Run one human turn to completion and stream progress via `onEvent`. Model-side failures
 * (refusal, truncation, stream errors) are reported as events; throwing is reserved for
 * configuration errors the route should 4xx on (no API key, session not found).
 */
export async function runHermesTurn(
  sessionId: string,
  userText: string,
  onEvent: (e: HermesEvent) => void,
  /** Files the person attached to THIS message, already stored (see lib/hermes/attachments). */
  attachments: StoredAttachment[] = [],
  /** `continuation: true` when the CLIENT is resuming a turn this function asked to have resumed
   *  (see the `done.needsContinuation` note below). No human typed anything, so the turn must not
   *  record a message as if one had. */
  opts: { continuation?: boolean } = {},
): Promise<HermesSession> {
  const client = anthropicClient();
  if (!client) throw new Error("Hermes is not configured (ANTHROPIC_API_KEY not set).");

  let session = await getHermesSession(sessionId);
  if (!session) throw new Error("Session not found.");
  if (session.status === "failed") throw new Error("This session failed and cannot take another turn. Start a new one.");

  const history = await listHermesMessages(sessionId);
  const messages: Anthropic.MessageParam[] = history.map((h) => ({
    role: h.role, content: h.blocks as Anthropic.ContentBlockParam[],
  }));

  // ── Repair the whole history, not just its tail ───────────────────────────────────────────────
  //
  // The API requires every tool_result to sit in the message IMMEDIATELY AFTER the tool_use it
  // answers. Two things break that, and both are permanent once written:
  //
  //   1. A turn dies mid-tool (Vercel's 300s ceiling, a crash, a deploy) leaving a tool_use with no
  //      result. Only ever affects the LAST message, which is all this used to check.
  //   2. TWO TURNS RUN AT ONCE on one session and interleave their appends. Measured on a real
  //      73-message session: seq 62 was an assistant tool_use for toolu_01DLzPe, seq 63 was a
  //      tool_result for a DIFFERENT id, and DLzPe's own result landed at seq 66 — 111 seconds and
  //      three messages downstream of the tool_use it belonged to. Every subsequent turn replayed
  //      that and got the same 400, so the session was dead. `acquireLock` in the turn route now
  //      prevents new cases; this repairs the ones already stored.
  //
  // Sanitising in MEMORY rather than rewriting rows: the stored transcript is what the person reads,
  // and silently deleting message rows to satisfy an API constraint would edit their history behind
  // their back. Orphans are dropped from what is SENT and left on disk.
  const sanitised: Anthropic.MessageParam[] = [];
  let orphansDropped = 0;
  let repairsAdded = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const blocks = Array.isArray(m.content) ? (m.content as Anthropic.ContentBlockParam[]) : null;

    if (m.role === "user" && blocks) {
      // Which tool_use ids may this message legally answer? Only the immediately preceding
      // assistant message's, which is exactly the rule the API enforces.
      const prev = sanitised[sanitised.length - 1];
      const allowed = new Set(
        prev?.role === "assistant" && Array.isArray(prev.content)
          ? (prev.content as Anthropic.ContentBlockParam[])
              .filter((b) => b.type === "tool_use")
              .map((b) => (b as Anthropic.ToolUseBlockParam).id)
          : [],
      );
      const kept = blocks.filter((b) => {
        if (b.type !== "tool_result") return true;
        const ok = allowed.has((b as Anthropic.ToolResultBlockParam).tool_use_id);
        if (!ok) orphansDropped++;
        return ok;
      });
      // A message that was ONLY orphaned results has nothing left to say; dropping it entirely is
      // correct, and keeping an empty content array would be its own API error.
      if (kept.length) sanitised.push({ ...m, content: kept });
      continue;
    }

    sanitised.push(m);

    // An assistant tool_use whose results do not follow it must be answered before the next turn, or
    // the API refuses the whole request. Synthesised here for ANY position, not only the last.
    if (m.role === "assistant" && blocks) {
      const dangling = pendingToolUseIds(blocks);
      if (!dangling.length) continue;
      const next = messages[i + 1];
      const answered = new Set(
        next?.role === "user" && Array.isArray(next.content)
          ? (next.content as Anthropic.ContentBlockParam[])
              .filter((b) => b.type === "tool_result")
              .map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id)
          : [],
      );
      const unanswered = dangling.filter((id) => !answered.has(id));
      if (!unanswered.length) continue;
      repairsAdded += unanswered.length;
      const repairs: Anthropic.ContentBlockParam[] = unanswered.map((id) => ({
        type: "tool_result", tool_use_id: id, is_error: true,
        content: "Interrupted: the turn ended before this tool finished, or its result was lost to a concurrent turn. Its underlying job may still have completed — verify with a read tool rather than assuming.",
      }));
      sanitised.push({ role: "user", content: repairs });
    }
  }
  if (orphansDropped || repairsAdded) {
    messages.length = 0;
    messages.push(...sanitised);
  }

  // Only the TAIL repair is persisted. A dangling tool_use at the end is a real, permanent hole that
  // the next turn would otherwise re-synthesise every time; mid-history fixes stay in memory because
  // the rows around them are still the honest record of what happened.
  const last = history[history.length - 1];
  if (last?.role === "assistant") {
    const dangling = pendingToolUseIds(last.blocks);
    if (dangling.length) {
      const repairs: Anthropic.ContentBlockParam[] = dangling.map((id) => ({
        type: "tool_result", tool_use_id: id, is_error: true,
        content: "Interrupted: the turn ended before this tool finished. Its underlying job may still have completed — verify with a read tool rather than assuming.",
      }));
      await appendHermesMessage(sessionId, "user", repairs);
    }
  }

  // The live snapshot rides in the user turn (the system prompt is frozen — see prompt.ts). All
  // three reads are best-effort: a turn must be able to start when a count query cannot.
  const lastMessageAt = history.length ? history[history.length - 1].created_at : session.created_at;
  const [overview, pending, resolved, standingRules, corrections] = await Promise.all([
    operationsOverview().catch(() => null),
    listPendingHermesActions(sessionId).catch(() => [] as Awaited<ReturnType<typeof listPendingHermesActions>>),
    listResolvedHermesActionsSince(sessionId, lastMessageAt).catch(() => [] as Awaited<ReturnType<typeof listResolvedHermesActionsSince>>),
    // Best-effort like the rest: a turn must be able to start when this read fails. Losing a rule
    // for one turn is recoverable; refusing to answer is not.
    listStandingRules().catch(() => [] as Awaited<ReturnType<typeof listStandingRules>>),
    // Same best-effort contract: losing the corrections list for one turn is recoverable, refusing
    // to answer because a rating could not be read is not.
    recentAgentCorrections(12).catch(() => [] as Awaited<ReturnType<typeof recentAgentCorrections>>),
  ]);
  const userBlocks: Anthropic.ContentBlockParam[] = [
    { type: "text", text: opsDirective({ userEmail: session.user_email, isAdmin: isAdminEmail(session.user_email), overview, pendingActions: pending, standingRules, corrections }) },
    // What a human clicked since the last message: proposals confirmed/declined between turns
    // surface here, so the model reports real outcomes instead of assuming its proposal executed.
    ...resolved.map((a): Anthropic.ContentBlockParam => ({ type: "text", text: actionResultDirective(a) })),
    // Attachments before the message. A person writes "what's wrong with this?" and the image is
    // the subject of that sentence — putting it after would ask the question about nothing.
    // Persisted with the turn, so a reloaded transcript still holds the image and a later turn in
    // the same thread can still refer back to it.
    ...attachmentBlocks(attachments),
    // On a continuation there is no human message. Writing "(empty message)" here — which is what
    // happened before this branch existed — puts a literal "(empty message)" in the transcript and
    // asks the model to respond to it. Say what is actually true instead: this is the same turn,
    // carrying on, and the work already done is in the history above.
    {
      type: "text",
      text: opts.continuation
        ? "CONTINUATION — the previous segment of this same turn ran out of its round budget or its "
          + "time budget. Nobody has typed anything new. Carry on from exactly where you stopped, using "
          + "the history above; do not restart, re-plan, or re-do work that already landed. If a tool "
          + "came back saying it ran out of time, check with a read tool whether it landed before "
          + "running it again."
        : userText.trim() || "(empty message)",
    },
  ];
  messages.push({ role: "user", content: userBlocks });
  await appendHermesMessage(sessionId, "user", userBlocks);

  // First message titles the session, so the rail shows something better than "Untitled".
  if (!session.title && userText.trim()) {
    const title = userText.trim().slice(0, 80);
    session = (await updateHermesSession(sessionId, { title }).catch(() => null)) ?? session;
  }

  const system = buildHermesSystem();
  const turnDeadline = Date.now() + TURN_BUDGET_MS;
  // Handed to every tool so a long one can stop before withDeadline() below kills it. See
  // HermesToolCtx.deadlineAt for why that difference matters.
  const ctx = { sessionId, userEmail: session.user_email, deadlineAt: turnDeadline };
  let toolCallsThisTurn = 0;
  let triedHigherBudget = false;
  await clearHermesStop(sessionId).catch(() => {});

  /**
   * Why the loop stopped, so the end of a turn can say so.
   *
   * "rounds" is the case that was silent, and silence is the whole problem: a landing-page run spends a
   * round per tool — banner, draft, status, schema, copy — and ten goes quickly. The turn then ended
   * mid-job with no closing message, which reads as the chat having crashed. The person's only clue was
   * that nothing more arrived, and the only recovery they could guess at was typing "go on".
   *
   * The deadline branch below has always announced itself. Exhausting the round budget never did.
   */
  let ended: "finished" | "stopped" | "deadline" | "rounds" = "rounds";
  /**
   * A tool was refused for a budget reason, so the model's closing text is a progress report rather
   * than an answer.
   *
   * Without this, exhausting the TOOL budget mid-job looked exactly like finishing. The refusal below
   * hands the model an error saying "summarise what you have"; the model does, with no further tool
   * call, and the loop reads that as `ended = "finished"` and reports needsContinuation: false. The run
   * then stops dead and the only way onward is a person typing "go on" — the precise failure the
   * "rounds" branch was added to remove, arriving through a different door.
   *
   * Observed on a landing-page fill: twelve calls went on reading the page and discovering a component's
   * real field shape, the budget ran out one call before the media batch, and the turn ended looking
   * complete with 24 required fields still empty.
   */
  let cutShortByBudget = false;

  for (let round = 0; round < MAX_INTERNAL_ROUNDS; round++) {
    // A stop lands at the round boundary: the current model call finishes, the next never starts.
    if (await isHermesStopRequested(sessionId).catch(() => false)) {
      ended = "stopped";
      onEvent({ t: "error", message: "Stopped." });
      break;
    }
    if (Date.now() > turnDeadline) {
      // No error event. This used to render a red "send another message to continue" block, which was
      // honest when continuing was the person's job and became wrong the moment the client started
      // doing it for them — the run had not failed and there was nothing for them to do.
      ended = "deadline";
      break;
    }
    const maxTokens = triedHigherBudget ? RETRY_MAX_TOKENS : DEFAULT_MAX_TOKENS;

    let stream: ReturnType<Anthropic["messages"]["stream"]>;
    try {
      // Same stack as the writer (adaptive thinking, summarized display) — see baseWriterParams for
      // why each of those is load-bearing. Effort medium: chat turns are operator work, not
      // authoring.
      //
      // The session's model is read fresh from `session` on every round, so a switch made between
      // turns takes effect on the next one. Resolved through resolveChatModel, NOT resolveModel:
      // both fall back rather than error, but the chat's fallback is CHAT_MODEL (Sonnet) — so a
      // null model, a retired id, and specifically a session pinned to "claude-opus-5" before Opus
      // left the picker all land on the cheap default instead of the writer's Opus.
      stream = client.messages.stream({
        ...baseWriterParams("medium", resolveChatModel(session.model)),
        max_tokens: maxTokens,
        system,
        messages: applyCacheBreakpoints(messages),
        tools: HERMES_TOOLS,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Request failed to start.";
      onEvent({ t: "error", message });
      return session;
    }

    try {
      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") onEvent({ t: "text", text: event.delta.text });
          else if (event.delta.type === "thinking_delta") onEvent({ t: "thinking", text: event.delta.thinking });
        } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          // Input hasn't streamed yet at block_start; the specific detail arrives with tool_result.
          const { label } = describeHermesTool(event.content_block.name, {});
          onEvent({ t: "tool_start", name: event.content_block.name, label });
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Stream interrupted.";
      onEvent({ t: "error", message });
      return session;
    }

    const final = await stream.finalMessage();
    await accumulateHermesUsage(sessionId, {
      input_tokens: final.usage.input_tokens,
      output_tokens: final.usage.output_tokens,
      cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: final.usage.cache_read_input_tokens ?? 0,
    });
    onEvent({ t: "usage", usage: final.usage as unknown as Record<string, number> });

    // A refusal can arrive with empty content — an expected model outcome, not a bug (writer rule).
    if (final.stop_reason === "refusal") {
      onEvent({ t: "error", message: "The model declined this request (safety classifier)." });
      messages.push({ role: "assistant", content: final.content });
      await appendHermesMessage(sessionId, "assistant", final.content);
      return session;
    }

    const toolUses = final.content.filter(
      (b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // Truncated with no tool call: retry once with a larger budget instead of committing a stub.
    if (final.stop_reason === "max_tokens" && toolUses.length === 0 && !triedHigherBudget) {
      triedHigherBudget = true;
      continue;
    }

    messages.push({ role: "assistant", content: final.content });
    await appendHermesMessage(sessionId, "assistant", final.content);

    if (toolUses.length === 0) { ended = "finished"; break; } // plain end_turn — this human turn is done

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      const remaining = turnDeadline - Date.now();
      let r: HermesToolResult;
      if (toolCallsThisTurn >= MAX_TOOL_CALLS_PER_TURN) {
        cutShortByBudget = true;
        r = { content: `Tool budget for this turn is exhausted (${MAX_TOOL_CALLS_PER_TURN} calls). Summarise what you have; the work will carry on in the next segment, so say what is left rather than treating this as finished.`, is_error: true };
      } else if (remaining < TOOL_MIN_REMAINING_MS) {
        cutShortByBudget = true;
        r = { content: "Out of time this turn — this tool was not run. Say what remains; the work will carry on in the next segment.", is_error: true };
      } else {
        toolCallsThisTurn++;
        // Raced against the remaining budget (minus a margin to persist results and close the
        // stream) so a slow tool degrades to an honest error instead of the platform killing the
        // function mid-round.
        r = await withDeadline(runHermesTool(tu.name, input, ctx), remaining - 5_000);
      }

      const { label, detail } = describeHermesTool(tu.name, input);
      onEvent({ t: "tool_result", name: tu.name, label, detail, is_error: !!r.is_error, preview: r.content.slice(0, 200) });
      if (r.ui?.type === "table") onEvent({ t: "table", title: r.ui.title, columns: r.ui.columns, rows: r.ui.rows });
      if (r.ui?.type === "options") onEvent({ t: "options", question: r.ui.question, options: r.ui.options });
      if (r.ui?.type === "picker") onEvent({ t: "picker", title: r.ui.title, columns: r.ui.columns, rows: r.ui.rows, key_col: r.ui.key_col });
      if (r.ui?.type === "confirm") onEvent({ t: "confirm", action_id: r.ui.action_id, kind: r.ui.kind, summary: r.ui.summary });
      // One event per asset rather than one array event: the client upserts elements by id, so a
      // partially-failed batch still renders the images that did land.
      if (r.ui?.type === "elements") {
        for (const el of r.ui.elements) {
          onEvent({
            t: "element",
            id: el.id,
            element_type: "image",
            url: el.url,
            alt: el.alt,
            mime: el.mime,
            width: el.width,
            height: el.height,
          });
        }
      }

      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: !!r.is_error });
    }

    // All tool results as ONE user message — splitting them is an API 400 (agent_loop.py rule #2).
    messages.push({ role: "user", content: toolResults });
    await appendHermesMessage(sessionId, "user", toolResults);
    triedHigherBudget = false;
  }

  session = (await updateHermesSession(sessionId, {}).catch(() => null)) ?? session; // bump updated_at
  // A turn that filled its round budget or ran past its deadline is UNFINISHED, not failed: the model
  // was mid-job and the next segment picks up from the saved history. Saying so here is what lets the
  // client carry on without the person typing "go on" at a screen that looks broken.
  // `finished` after a budget refusal is not finished — see cutShortByBudget. A user Stop still never
  // continues, because that is a decision and resuming past it would be ignoring it.
  onEvent({
    t: "done",
    needsContinuation:
      ended === "rounds" || ended === "deadline" || (ended === "finished" && cutShortByBudget),
  });
  return session;
}
