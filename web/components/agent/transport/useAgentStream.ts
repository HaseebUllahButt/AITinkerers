"use client";

// Summit Agent — the reader loop.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §5.6, §6.7 (re-arming follow), §11.4 (Stop).
//
// ══ The two defects this file exists to not re-introduce ════════════════════════════════════════
//
// D5 — the flash of empty transcript. The old `finally` did:
//        setLive(""); setThinking(""); setSteps([]); await loadTranscript(sid);
//      i.e. tear the live overlays down, THEN go to the network to repopulate. The gap is one
//      round-trip of blank transcript at the exact moment the user is reading the answer.
//      ⇒ There is NO transcript fetch anywhere below. `loadTranscript()` is called on session open
//        and nowhere else. If you are about to add one here, the answer is no; if reconciliation is
//        genuinely needed, feed the payload through `store.hydrate()` (per-node upsert) from the
//        session-open path.
//
// D8 — Stop that feels broken. Hermes today POSTs to /stop and awaits it, so the caret keeps
//      blinking for a round trip.
//      ⇒ `stop()` mutates local state FIRST, then aborts the reader, then tells the server
//        fire-and-forget. The ordering is load-bearing.

import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { applyEvent } from "../store/reducer";
import { createLegacyAdapter, type LegacyAdapter } from "../store/legacyAdapter";
import type { AgentStore } from "../store/agentStore";
import type { AgentEvent, AgentTransport, RunEndReason } from "../types";
import { createSseParser, parseSsePayload } from "./parseSse";

/**
 * Read an SSE body as decoded JSON frames.
 *
 * Lives here rather than in parseSse.ts so that module can stay pure and unit-testable; this half
 * needs `TextDecoder` and a `ReadableStream` and cannot be tested without them.
 *
 * `{ stream: true }` on the decoder is not optional: a multi-byte UTF-8 character (any em dash, any
 * smart quote — both of which Summit's agents emit constantly) can straddle a chunk boundary, and
 * without it the two halves each decode to U+FFFD.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      const payloads = parser.push(decoder.decode(value, { stream: true }));
      for (let i = 0; i < payloads.length; i++) {
        const parsed = parseSsePayload(payloads[i]);
        if (parsed !== null) yield parsed;
      }
    }
    // Flush the decoder's own tail, then the parser's.
    const tail = parser.push(decoder.decode());
    for (let i = 0; i < tail.length; i++) {
      const parsed = parseSsePayload(tail[i]);
      if (parsed !== null) yield parsed;
    }
    for (const payload of parser.flush()) {
      const parsed = parseSsePayload(payload);
      if (parsed !== null) yield parsed;
    }
  } finally {
    // `return`/`throw` out of a `for await` runs this. Cancelling releases the connection instead
    // of leaving a half-read body pinned until GC.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    /* not JSON */
  }
  return `Turn failed (${res.status}).`;
}

/**
 * Abort detection across engines. Chrome/Firefox throw a `DOMException` named AbortError; older
 * Safari throws a plain `Error` with the same name; `DOMException` itself is undefined under SSR.
 * Name-checking covers all three without a `typeof` dance at every call site.
 */
function isAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

export interface UseAgentStreamOptions {
  store: AgentStore;
  /** Must be referentially stable per session. */
  transport: AgentTransport;
  /**
   * The follow-intent ref owned by `ChatSurface` (§5.1). Re-armed here on submit — one of the
   * exactly three places allowed to set it true (§6.7).
   */
  followRef: RefObject<boolean>;
  /** Side channel. Called from the reader loop, never from render. Must be stable. */
  onEvent?: (event: AgentEvent) => void;
  /** Fired once per turn after the stream closes. Must be stable. */
  onTurnEnd?: (reason: RunEndReason) => void;
}

export interface SendOptions {
  /**
   * What the TRANSCRIPT shows for this turn, when it must differ from what the model is sent.
   *
   * One caller today: the writer's "Ask it to fix these" button posts a machine-authored
   * `<repair_request>` block (the model needs the framing) and the transcript shows "sent the fix
   * list back". Rendering the raw directive as a user bubble is the exact defect
   * `stripDirectives()` exists to prevent server-side.
   */
  display?: string;
}

export interface AgentStreamApi {
  /** Submit a human turn. Safe to call while a turn is running — see the queue note below. */
  send: (message: string, opts?: SendOptions) => Promise<void>;
  /**
   * Drive a MACHINE turn: no human message, no user bubble.
   *
   * The writer needs this twice — a brand-new session must land the user on the agent's first
   * question rather than an empty box, and pressing Approve starts the write phase — and both post
   * a body with no `message` key at all, which is what `continuation: true` means to the transport.
   * A no-op while a turn is already running; it is a kickoff, not a queued follow-up.
   */
  start: () => Promise<void>;
  /** User-initiated Stop. Synchronous by design: the UI must change within one frame. */
  stop: () => void;
  /**
   * Rehydrate from the server. Call on SESSION OPEN ONLY. Never at end of turn — that is D5.
   */
  reload: () => Promise<void>;
}

export function useAgentStream(opts: UseAgentStreamOptions): AgentStreamApi {
  const { store, transport, followRef, onEvent, onTurnEnd } = opts;

  const abortRef = useRef<AbortController | null>(null);

  /**
   * Turn generation counter. Every `send` captures its own value; the `finally` only touches shared
   * state if it is still the current turn.
   *
   * Without it: user hits Stop, then immediately submits a follow-up. The aborted turn's `finally`
   * runs a tick later and calls `endRun` on the turn that just started — the composer flips back to
   * Send mid-stream and every open step settles to "Used …" while tokens are still arriving.
   */
  const genRef = useRef(0);

  /**
   * Single-slot queue for a follow-up typed while the agent is still streaming.
   *
   * §11.1 deliberately keeps `runActive` out of `submitBlocked` — you may queue a follow-up. Firing
   * a second POST concurrently would run two agent turns against one session, so the message waits
   * here and goes out when the current turn closes. One slot, not a list: a user who types three
   * follow-ups means the last one, and a growing backlog of stale prompts is worse than dropping.
   */
  const queuedRef = useRef<{ text: string; display: string } | null>(null);
  const runningRef = useRef(false);

  // Keep the latest callbacks in refs so `send` can stay referentially stable for the whole session
  // — it is handed to memo'd children (Composer, Starters, AskCard) as a prop.
  const onEventRef = useRef(onEvent);
  const onTurnEndRef = useRef(onTurnEnd);
  const transportRef = useRef(transport);
  useEffect(() => {
    onEventRef.current = onEvent;
    onTurnEndRef.current = onTurnEnd;
    transportRef.current = transport;
  }, [onEvent, onTurnEnd, transport]);

  /** Abort any in-flight turn when the surface unmounts or the session changes. */
  useEffect(() => {
    return () => {
      // Reading the ref in cleanup is the point, not a mistake: we want whatever generation is
      // current AT TEARDOWN to be invalidated, so a still-running turn's `finally` becomes a no-op
      // instead of writing to a store the surface no longer owns. `genRef` is a plain counter, not
      // a DOM node, so the rule's usual hazard does not apply.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      genRef.current++;
      abortRef.current?.abort();
      abortRef.current = null;
      queuedRef.current = null;
      runningRef.current = false;
    };
  }, [store, transport]);

  /**
   * @param display What the transcript shows for this turn, or `null` for a machine turn that
   *   contributes no user bubble at all. `null` also forces `continuation: true` on the FIRST
   *   segment, which is how a transport knows to omit the `message` key entirely.
   */
  const drive = useCallback(
    async (message: string, display: string | null): Promise<void> => {
      const myGen = ++genRef.current;
      const ctl = new AbortController();
      abortRef.current = ctl;
      runningRef.current = true;

      // §6.7 — submit is one of the exactly three places follow intent may be re-armed.
      followRef.current = true;

      const runId = store.beginRun();
      const adapter: LegacyAdapter = createLegacyAdapter(runId);
      // Optimistic, before any network. A machine turn (`display === null`) adds nothing: there is
      // no human turn to echo, and an empty bubble is worse than no bubble.
      if (display !== null) store.appendUserNode(display);

      let reason: RunEndReason = "complete";
      try {
        let segment = 0;
        let needsContinuation = false;
        // A separate flag rather than testing `reason` in the loop condition: `reason` is narrowed to
        // its initialiser there, so the comparison never compiled.
        let sawError = false;

        do {
          // A continuation is the machine driving itself: no human message, and the writer's route
          // expects the `message` key to be ABSENT rather than empty.
          const res = await transportRef.current.startTurn({
            message: segment === 0 && display !== null ? message : "",
            signal: ctl.signal,
            continuation: segment > 0 || display === null,
          });
          if (!res.ok || !res.body) throw new Error(await errorText(res));

          needsContinuation = false;
          // Did this segment DO anything? A cutoff that keeps arriving with no work between the
          // segments is a hang, not a long job, and continuing it forever would bill for silence.
          // This is the loop's only stopping condition now that the count cap is gone, so it has to
          // measure work rather than time: `done` and `usage` arrive on every segment regardless.
          let progressed = false;
          for await (const raw of readSse(res.body, ctl.signal)) {
            for (const ev of adapter.adapt(raw)) {
              applyEvent(store, ev);
              onEventRef.current?.(ev);
              if (ev.t !== "done" && ev.t !== "usage") progressed = true;
              if (ev.t === "done" && ev.needsContinuation) needsContinuation = true;
              if (ev.t === "error") { reason = "error"; sawError = true; }
            }
          }
          segment++;
          if (needsContinuation && !progressed) {
            // Say so, because this is the one case where the person does have to step in.
            store.pushErrorNode(
              "This turn keeps running out of time without getting anywhere. Nothing more was written. "
              + "Tell me what to change, or ask for a smaller step.",
            );
            reason = "continue";
            break;
          }
          // No count limit, by instruction: a landing-page fill legitimately spans several segments —
          // twenty-one image renders is twenty-one minutes — and stopping at six meant the person had
          // to sit and click "go on" through work that needed no decision from them. An erroneous stop
          // and a user Stop both still end the loop below; only a clean cutoff resumes.
        } while (needsContinuation && !sawError && !ctl.signal.aborted);
      } catch (err) {
        if (ctl.signal.aborted || isAbort(err)) {
          // An abort is a user Stop, not a failure. No error node, no toast — the transcript
          // simply stops where it stopped.
          reason = "stopped";
        } else {
          reason = "error";
          store.pushErrorNode(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (genRef.current === myGen) {
          if (ctl.signal.aborted) reason = "stopped";
          // Settle whatever the adapter still has open, THEN close the run. Both are local and
          // synchronous, so the transcript never blanks. NOTHING is refetched here — see D5 at the
          // top of this file.
          for (const ev of adapter.finish(reason)) applyEvent(store, ev);
          store.endRun(reason);
          abortRef.current = null;
          runningRef.current = false;
          onTurnEndRef.current?.(reason);
        }
      }
    },
    [followRef, store],
  );

  const send = useCallback(
    async (message: string, opts?: SendOptions): Promise<void> => {
      const text = message.trim();
      if (!text) return;
      const display = opts?.display ?? text;
      if (runningRef.current) {
        queuedRef.current = { text, display };
        return;
      }
      await drive(text, display);
      // Drain the queue after the turn closes. A loop, not recursion, so a user who keeps typing
      // cannot grow the stack.
      let next = queuedRef.current;
      while (next) {
        queuedRef.current = null;
        await drive(next.text, next.display);
        next = queuedRef.current;
      }
    },
    [drive],
  );

  const start = useCallback(async (): Promise<void> => {
    // Deliberately NOT queued. A kickoff belongs to a session that has just opened or a gate the
    // human just passed; replaying it after an unrelated turn would run the agent twice.
    if (runningRef.current) return;
    await drive("", null);
  }, [drive]);

  const stop = useCallback(() => {
    // Ordering is load-bearing (§5.6).
    // 1. Local state first — the UI stops within one frame. `endRun` flips `runActive` false, which
    //    makes the `running` predicate on every open step go false at once, so no per-step done
    //    events are needed from a killed stream.
    store.endRun("stopped");
    // 2. Kill the reader.
    queuedRef.current = null;
    abortRef.current?.abort();
    // 3. Tell the server, fire-and-forget. Awaiting this is D8: the caret keeps blinking for a
    //    round trip and the button feels broken.
    void transportRef.current.stopTurn().catch(() => {
      /* best effort — the local stop already happened */
    });
  }, [store]);

  const reload = useCallback(async () => {
    const snapshot = await transportRef.current.loadTranscript();
    store.hydrate(snapshot);
  }, [store]);

  return { send, start, stop, reload };
}
