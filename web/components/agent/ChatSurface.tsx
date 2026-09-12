"use client";

// SearchOps Agent — the surface.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §2 (architecture + props), §3 (file tree), §5.1 (where state
// lives), §11.5 (composer placement), §12 (build order).
//
// This is the whole chat experience for both pages. `src/app/hermes/page.tsx` and
// `src/app/blog/writer/page.tsx` own their session rail, their routing and anything domain-specific
// rendered BESIDE the transcript (the writer's draft/outline/QA pane). Neither owns one byte of
// transcript state — no `messages`, no `live`, no `thinking`, no `steps`. That separation is the
// fix for D1, and it only holds if it is total.
//
// ══ The three things this file is responsible for ═══════════════════════════════════════════════
//
//  1. OWNERSHIP. One `AgentStore` per session, the follow-intent ref (§5.1: a ref, never state),
//     and the reader loop. Everything below reads them through `useSyncExternalStore` on a narrow
//     channel, so a token commits one `MessageRow` and nothing else.
//
//  2. LAYOUT. Scroll container (which owns the spacer and the jump pill) ABOVE, composer OUTSIDE
//     it (§11.5) — the composer's height changes with autosize and the banner, and that has to move
//     the container's `clientHeight` rather than scroll away with the transcript.
//
//  3. THE SEAM. Page-owned, session-stable values (transport, feature flags, follow ref) reach the
//     leaf cards through ONE memo'd context bag — §5.1's single permitted context value. Nothing
//     that changes at token frequency may join it; `runActive` is read once here and threaded DOWN
//     as a prop.
//
// ══ Deliberately NOT here ═══════════════════════════════════════════════════════════════════════
//
//  • No transcript refetch at end of turn. That is D5 — see the header of transport/useAgentStream.
//    `loadTranscript()` runs on session open and nowhere else.
//  • No token-usage footer, despite `features.usageFooter`. The only usage the surface can see is
//    what it streamed this page-load, whereas both pages already hold the server's cumulative,
//    cache-aware total for the session. A footer here would silently under-report after a reload,
//    so hermes renders its own in the page shell instead and passes `usageFooter: false`.
//    TODO(P1): give `AgentSnapshot` a usage field and move the footer in here where it belongs.
//  • No `role="log"` on the transcript. A polite log region containing streaming prose makes a
//    screen reader read the answer again on every token; `a11y/LiveRegion` announces the turn
//    boundaries instead, which is what §P0.16 is actually after.

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

import { LiveRegion } from "./a11y/LiveRegion";
import { Composer, type ComposerHandle } from "./composer/Composer";
import { Starters } from "./composer/Starters";
import { resolveFeatures } from "./constants";
import { ScrollContainer, type ScrollContainerHandle } from "./scroll/ScrollContainer";
import { createAgentStore, type AgentStore } from "./store/agentStore";
import { AgentStoreProvider, useAgentSelector, useAsk, useRunState } from "./store/hooks";
import { hasVisibleTurn } from "./store/selectors";
import { AgentSurfaceProvider, type AgentSurfaceValue } from "./surfaceContext";
import { Transcript } from "./Transcript";
import { useAgentStream, type AgentStreamApi, type SendOptions } from "./transport/useAgentStream";
import type { AskAnswer, ChatSurfaceProps, Starter } from "./types";

/**
 * The imperative escape hatch, for the two things a page legitimately drives.
 *
 * It is a `ref`, not a prop, so it stays off `ChatSurfaceProps` (§2.2 is the contract and does not
 * grow). Everything here is a verb the human just triggered somewhere else on the page — a rail
 * button, an approval gate — never a way to reach into transcript state.
 */
export interface ChatSurfaceHandle {
  /** Submit a turn as if the human had typed it. `display` overrides what the transcript shows. */
  send(message: string, opts?: SendOptions): void;
  /** Drive a machine turn: no human message, no user bubble (writer kickoff, post-approval write). */
  start(): void;
  /** Local-first stop, identical to pressing the stop button. */
  stop(): void;
  /**
   * Resolve a legacy `options` ask locally and send the chosen label as the next turn.
   *
   * Today's servers have no ask endpoint: `show_options` is answered by sending the option text
   * back as an ordinary message, exactly as the old hermes page did. The card would otherwise spin
   * forever waiting for an `ask_resolved` that this wire format cannot produce. Dies with
   * `legacyAdapter.ts` (P1.2).
   */
  answerLegacyAsk(askId: string, answer: AskAnswer): void;
  /** Put text in the composer (a retry, a quoted reply, a `?prompt=` deep link). */
  setDraft(text: string): void;
  focus(): void;
}

export type ChatSurfaceComponentProps = ChatSurfaceProps & { ref?: Ref<ChatSurfaceHandle> };

export function ChatSurface({
  mode,
  sessionId,
  transport,
  heading,
  starters,
  onRequireSession,
  emptyState,
  placeholder,
  composerSlot,
  onAttach,
  attachmentSlot,
  banner,
  onEvent,
  onTurnEnd,
  features: featureOverrides,
  className,
  ref,
}: ChatSurfaceComponentProps) {
  // One store per session. A session switch mints a fresh one rather than resetting the old one:
  // an in-flight turn's `finally` can still be holding the previous store, and letting it write
  // into a discarded object is strictly safer than letting it write into the new session.
  //
  // NOT `useMemo`. React explicitly reserves the right to discard a memo cache — and if it did,
  // every node of a live transcript would vanish mid-turn while the reader loop kept writing into
  // an orphan. This is React's documented "adjust state when a prop changes" pattern: the setState
  // during render re-runs THIS component before anything commits, which is cheaper than the effect
  // it replaces and, unlike `useMemo`, is a guarantee.
  const [held, setHeld] = useState<{ key: string | null; store: AgentStore }>(() => ({
    key: sessionId,
    store: createAgentStore(),
  }));
  if (held.key !== sessionId) setHeld({ key: sessionId, store: createAgentStore() });
  const store: AgentStore = held.store;

  /**
   * Follow intent (§5.1). A ref, never state: as state, every scroll event during a drag would
   * re-render the transcript at 60Hz. It is created HERE, once, and the same object is handed to
   * both the reader loop (which re-arms it on submit) and the scroll container (which clears it
   * when the user scrolls away).
   */
  const followRef = useRef(true);

  const composerRef = useRef<ComposerHandle>(null);

  const features = useMemo(
    () => resolveFeatures(mode, featureOverrides),
    [mode, featureOverrides],
  );

  const stream = useAgentStream({ store, transport, followRef, onEvent, onTurnEnd });

  // Session open — the ONE place a transcript is fetched (§5.6 / D5). Never at end of turn.
  useEffect(() => {
    if (!sessionId) return;
    // A session switch is a fresh mount, not a scroll interaction: whatever the reader did in the
    // last thread must not leave the new one refusing to follow its first answer. This is a write
    // to a ref in an effect, deliberately — the render path never reads it.
    followRef.current = true;

    let live = true;
    void (async () => {
      try {
        const snapshot = await transport.loadTranscript();
        // Late arrival after a switch: the store is per-session, so a stale hydrate would land in
        // an orphan anyway, but bailing keeps it from costing a render.
        if (live) store.hydrate(snapshot);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't load that conversation.");
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId, store, transport]);

  const surface = useMemo<AgentSurfaceValue>(
    // §5.1 rule 3: a memo'd bag of callbacks and config, every field listed in the deps. Everything
    // in it is stable for the session, so a context change can never invalidate a memo'd row.
    () => ({
      transport,
      features,
      followRef,
      onFeedback: undefined,
      // Cards whose answer is an ordinary user message (the picker) send through here rather than
      // reaching for the stream themselves. No armFollow: `stream.send` re-arms follow intent
      // itself, and the scroll handle lives in SurfaceBody, below this provider.
      sendMessage: (message: string) => void stream.send(message),
    }),
    [transport, features, stream],
  );

  useImperativeHandle(
    ref,
    (): ChatSurfaceHandle => ({
      send: (message, opts) => void stream.send(message, opts),
      start: () => void stream.start(),
      stop: () => stream.stop(),
      answerLegacyAsk: (askId, answer) => answerLegacyAsk(store, stream, askId, answer),
      setDraft: (text) => composerRef.current?.setDraft(text),
      focus: () => composerRef.current?.focus(),
    }),
    [store, stream],
  );

  return (
    <AgentStoreProvider value={store}>
      <AgentSurfaceProvider value={surface}>
        <SurfaceBody
          // Remount everything on a session switch. The store is already new; this throws away the
          // composer draft, the scroll position and every open accordion with it, which is what
          // "opened a different conversation" should mean.
          key={sessionId ?? "__no-session__"}
          mode={mode}
          sessionId={sessionId}
          stream={stream}
          composerRef={composerRef}
          followRef={followRef}
          features={features}
          heading={heading}
          starters={starters}
          onRequireSession={onRequireSession}
          emptyState={emptyState}
          placeholder={placeholder}
          composerSlot={composerSlot}
          onAttach={onAttach}
          attachmentSlot={attachmentSlot}
          banner={banner}
          className={className}
        />
      </AgentSurfaceProvider>
    </AgentStoreProvider>
  );
}

// ─────────────────────────────────────────────────────────────── the body

interface SurfaceBodyProps
  extends Pick<
    ChatSurfaceProps,
    | "mode"
    | "sessionId"
    | "heading"
    | "starters"
    | "onRequireSession"
    | "emptyState"
    | "placeholder"
    | "composerSlot"
    | "onAttach"
    | "attachmentSlot"
    | "banner"
    | "className"
  > {
  stream: AgentStreamApi;
  composerRef: Ref<ComposerHandle>;
  followRef: RefObject<boolean>;
  features: ReturnType<typeof resolveFeatures>;
}

/**
 * Everything visual. Split from `ChatSurface` for one reason: it must run INSIDE the providers so
 * it can use the narrow subscription hooks. It re-renders on the run flag (twice a turn), on the
 * ask (at most twice a turn) and on the has-any-turn-yet edge (once per thread) — never on a token.
 */
function SurfaceBody({
  mode,
  sessionId,
  stream,
  composerRef,
  followRef,
  features,
  heading,
  starters,
  onRequireSession,
  emptyState,
  placeholder,
  composerSlot,
  onAttach,
  attachmentSlot,
  banner,
  className,
}: SurfaceBodyProps) {
  const scrollRef = useRef<ScrollContainerHandle>(null);

  // Read the run state HIGH, exactly once, and thread `active` DOWN as a prop (§5.1). Every
  // component below that needs it — Transcript, StepNode, MessageActions, Composer — gets it from
  // its parent. A second subscription anywhere in the tree is a bug, not an optimisation.
  const run = useRunState();
  const ask = useAsk();

  // Whole-tree predicate, NOT `nodes.length === 0` (§11.7): there is a window at the start of a
  // turn where only run scaffolding exists, and a length check flashes the welcome screen back over
  // the turn the user just submitted. `useAgentSelector` walks the store per mutation but returns a
  // boolean, so React bails out of the re-render on every token that does not flip it.
  const started = useAgentSelector(hasVisibleTurn);

  const pendingAsk = !!ask && ask.status === "pending";

  const handleSubmit = useCallback(
    (message: string) => {
      // Typing and pressing enter is a request to start talking. If there is no thread yet, opening
      // one is our job, not a precondition the human has to satisfy first — being told "start a
      // session to send a message" while holding a finished sentence is a dead end.
      if (!sessionId && onRequireSession) {
        onRequireSession(message);
        return;
      }
      void stream.send(message);
    },
    [stream, sessionId, onRequireSession],
  );

  const handleStop = useCallback(() => {
    stream.stop();
  }, [stream]);

  const handleStarter = useCallback(
    (starter: Starter) => {
      // With no thread open, a starter cannot send — there is nothing to send INTO. Previously the
      // chips were simply disabled here, which made the most inviting thing on an empty screen inert
      // and left no hint why. Hand the prompt to the page instead: it opens a session and replays it.
      if (!sessionId && onRequireSession) {
        onRequireSession(starter.prompt);
        return;
      }
      // §6.7 site 2 of 3: a starter click is a submit, so follow intent is re-armed before the
      // first token can arrive. `useAgentStream.send` re-arms it too; doing it here as well costs
      // one boolean write and covers the case where the send is queued behind a running turn.
      scrollRef.current?.armFollow();
      void stream.send(starter.prompt);
    },
    [stream, sessionId, onRequireSession],
  );

  // The empty state owns the whole area when there is no thread; the welcome block belongs to an
  // OPEN thread that has not been used yet. Rendering both stacks two hero paragraphs on hermes.
  const showEmpty = sessionId === null && emptyState != null;
  const showWelcome = !showEmpty && !started && (heading != null || (starters?.length ?? 0) > 0);
  // Either flavour of "nothing has happened yet" gets the centred treatment.
  const showZeroState = showEmpty || showWelcome;

  return (
    // `flex-1 min-h-0`, never `h-full`: both pages stack page chrome (a status strip, a usage
    // footer) in the same flex column, and `h-full` would resolve to the WHOLE column and push the
    // composer off the bottom by exactly the height of that chrome.
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3",
        // ZERO STATE: centre the greeting + composer + starters as one group, the way a
        // general-purpose assistant does, instead of stranding an empty composer at the bottom of a
        // tall blank page. Once a turn exists the composer returns to the bottom edge and the
        // transcript takes the space — so this is a layout mode, not a different component, and the
        // Composer never unmounts (a remount would drop focus and any typed draft).
        // Centring here is done with AUTO MARGINS (mt-auto on the first child, mb-auto on the
        // spacer after the last), not `justify-center`. They look identical when the content fits
        // and behave completely differently when it does not: `justify-center` overflows in both
        // directions and the top becomes unreachable even with `overflow-y-auto` — measured, the
        // greeting was cut off above the scroll origin. Auto margins collapse to 0 under overflow,
        // so the group simply starts at the top and scrolls.
        showZeroState && "overflow-y-auto",
        className,
      )}
    >
      <ScrollContainer
        ref={scrollRef}
        // `flex-none` collapses the scroller to its content in the zero state so the centred group
        // reads as one block. Without it the scroller still claims all the free space and
        // `justify-center` has nothing to centre.
        className={showZeroState ? "flex-none mt-auto" : undefined}
        followRef={followRef}
        followStream={features.followStream}
        jumpToTop={features.jumpToTop}
        pendingAsk={pendingAsk}
        // The transcript's own measure. `flex flex-col` keeps every row a direct child (the flat
        // DOM the spacer walk in §6.5 depends on) while still giving them rhythm.
        contentClassName="mx-auto flex w-full max-w-3xl flex-col gap-6 px-1 pt-2 pb-4"
      >
        {showEmpty ? (
          <div className="flex min-h-[50vh] flex-col items-center justify-center">{emptyState}</div>
        ) : null}

        {/* Heading only. The starter chips render UNDER the composer (below), because that is the
            order a general-purpose assistant uses: greeting, the thing you type into, then the
            suggestions. Chips above the input read as navigation; chips below read as prompts. */}
        {showWelcome ? <div className="flex flex-col gap-3 pt-4">{heading}</div> : null}

        <Transcript runActive={run.active} />
      </ScrollContainer>

      {/* OUTSIDE the scroller (§11.5). The banner rides with it rather than with the transcript so
          that "N proposals waiting" cannot scroll out of view while the proposals are on screen. */}
      <Composer
        ref={composerRef}
        sessionId={sessionId}
        canOpenSession={!!onRequireSession}
        runActive={run.active}
        onSubmit={handleSubmit}
        onStop={handleStop}
        placeholder={placeholder}
        banner={banner}
        composerSlot={composerSlot}
        onAttach={onAttach}
        attachmentSlot={attachmentSlot}
      />

      {/* Suggestions sit under the input, and only in the zero state — once there is a transcript
          they would compete with the conversation for the eye. */}
      {showZeroState && starters && starters.length > 0 ? (
        <Starters
          starters={starters}
          onPick={handleStarter}
          // Mirrors the composer's own block: no thread, or a question waiting that does not
          // take free text.
          // Not gated on `sessionId` when the page can open one on demand — see handleStarter.
          disabled={
            (!sessionId && !onRequireSession) ||
            (pendingAsk && !ask?.allowText && ask?.askKind !== "text")
          }
        />
      ) : null}

      {/* The bottom half of the auto-margin pair. Collapses to zero the moment the group overflows,
          which is exactly the behaviour `justify-center` lacks. */}
      {showZeroState ? <div className="mb-auto" aria-hidden /> : null}

      <LiveRegion startMessage="Summer is working…" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── legacy ask bridge

/**
 * Answer a legacy `options` ask without a server round trip.
 *
 * The adapter synthesises an `ask` for every `options` frame so the rich card works against today's
 * wire (§4.4), but there is no `/answer` endpoint behind it — the agent is waiting for the choice to
 * arrive as an ordinary user message, which is exactly what the old page's option buttons did.
 *
 * Order matters. The card is patched terminal BEFORE the turn starts, because `AskCard` leaves it
 * in `submitting` until something else resolves it, and because the next turn's first token must
 * not paint underneath a still-spinning question.
 */
function answerLegacyAsk(
  store: AgentStore,
  stream: AgentStreamApi,
  askId: string,
  answer: AskAnswer,
): void {
  const ask = store.getAsk();
  if (!ask || ask.askId !== askId) return;

  const text =
    answer.type === "choice"
      ? (ask.choices?.find((c) => c.id === answer.choiceId)?.label ?? "")
      : answer.type === "text"
        ? answer.text.trim()
        : "";

  if (!text) {
    // Cancelled. `AskCard` optimistically resumed the run before calling us (§9.2), and nothing is
    // going to arrive, so put it back — a spinner while the human is the bottleneck is a lie.
    store.patchAsk(askId, { status: "resolved", summary: "Skipped" });
    store.endRun("complete");
    return;
  }

  store.patchAsk(askId, { status: "resolved", summary: `Selected: ${text}` });
  // Not awaited: `AskCard` awaits `answerAsk`, and awaiting the whole turn here would leave the
  // card spinning for the entire answer.
  void stream.send(text);
}

export default ChatSurface;
