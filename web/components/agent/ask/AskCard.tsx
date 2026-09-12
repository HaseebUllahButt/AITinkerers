"use client";

// Summit Agent — the blocking question card.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §9.2 (protocol), §9.3 (the card), §9.4 (three phases),
// §9.7 (countdown), §9.9 (scroll).
//
// This is the feature the whole surface exists for: the agent pauses mid-turn, asks, the user
// answers inline, and the choices then LOCK showing what was picked. Everything subtle about it is
// in one of these five rules:
//
//  1. The card is gated on `ask.stepId === node.id`, NEVER on "is the last message". Once a tool
//     emits anything after the question, a last-message check staples the buttons to the wrong
//     bubble.
//  2. Nothing here disables on `runActive`. The reducer sets the run inactive on `ask` precisely
//     because a human is the bottleneck; if the buttons disabled while "running" the user could
//     not answer their own question — a total deadlock (§9.2).
//  3. The click re-verifies the ask against the STORE, not against the props it rendered with. A
//     card from turn 2 is still mounted and clickable in turn 7.
//  4. The card stays MOUNTED from click until the server's `ask_resolved`. Unmounting when the POST
//     resolves leaves a 50–500ms hole where the question has vanished and the answer has not
//     arrived — D5 in miniature.
//  5. Four terminal renders, never a blank: `Selected: X` / `Skipped` / `No answer — timed out` /
//     the error.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { CircleHelp, Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { ASK_COUNTDOWN_MS, ASK_COUNTDOWN_TICK_MS, prefersReducedMotion } from "../constants";
import { useAgentStoreInstance, useAsk } from "../store/hooks";
import { AskConflictError, type AgentTransport, type AskAnswer, type AskState } from "../types";
import { AskForm } from "./AskForm";
import { ChoiceButtons } from "./ChoiceButtons";
import { ImageChoiceGrid, isImageChoiceSet } from "./ImageChoiceGrid";

export interface AskCardProps {
  /**
   * The live ask. The CALLER gates on `ask.stepId === node.id` (§9.3) — or uses `<AskSlot/>`
   * below, which does it for you.
   */
  ask: AskState;
  transport: AgentTransport;
  /**
   * The scroll container's "user is pinned to the bottom" flag (the same ref handed to
   * `useAgentStream`). §9.9: an ask card appearing changes scroll height by 60–200px in one frame,
   * so if the user was already at the bottom we do ONE `scrollIntoView` on mount — not through the
   * streaming follow path. If they had scrolled away we do NOT yank them; the jump pill badges
   * instead. Omit the prop and the card never scrolls anything, which is the safe default.
   */
  followRef?: RefObject<boolean> | null;
  className?: string;
}

/**
 * The terminal line. Never returns empty — a resolved question that renders blank reads as a
 * crash, which is exactly what §9.4 forbids.
 */
function terminalText(ask: AskState): string {
  if (ask.summary && ask.summary.trim() !== "") return ask.summary;
  switch (ask.status) {
    case "cancelled":
      return "Skipped";
    case "timeout":
      return "No answer — timed out";
    default: {
      const picked = ask.choices?.find((c) => c.id === ask.chosenId)?.label;
      return picked ? `Selected: ${picked}` : "Answered";
    }
  }
}

/**
 * Fraction of the countdown window still left, or `null` when there is nothing to draw.
 *
 * §9.7: render a countdown ONLY inside the last 60s. Above that it is pure noise, and a visible
 * ticking number on a question is stressful — hence a thin bar and no digits.
 *
 * Everything is computed from the ABSOLUTE deadline (§9.2). A duration-based countdown drifts and
 * then lies outright after a tab suspend, which is the one moment it actually matters.
 */
function useCountdownFraction(deadlineIso: string, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const deadline = Date.parse(deadlineIso);
    if (!Number.isFinite(deadline)) return;

    let interval: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), ASK_COUNTDOWN_TICK_MS);
    };

    // Sleep until the window actually opens rather than ticking for the whole 5-minute deadline:
    // 300 wasted re-renders per question, and the bar would be invisible for 240s of them.
    const untilWindow = deadline - ASK_COUNTDOWN_MS - Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (untilWindow > 0) timeout = setTimeout(start, untilWindow);
    else start();

    return () => {
      if (timeout) clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [deadlineIso, active]);

  if (!active) return null;
  const deadline = Date.parse(deadlineIso);
  if (!Number.isFinite(deadline)) return null;
  const remaining = deadline - now;
  if (remaining > ASK_COUNTDOWN_MS) return null;
  return Math.max(0, Math.min(1, remaining / ASK_COUNTDOWN_MS));
}

export function AskCard({ ask, transport, followRef, className }: AskCardProps) {
  const store = useAgentStoreInstance();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");

  const { askId, stepId, status } = ask;
  const pending = status === "pending";
  const submitting = status === "submitting";
  const terminal = !pending && !submitting;
  const fraction = useCountdownFraction(ask.deadline, pending);

  // §9.9 — one scroll, on mount, only if the user was already pinned. Deliberately NOT wired to
  // the streaming follow path: this is a single layout jump, not a stream.
  useLayoutEffect(() => {
    if (!followRef?.current) return;
    cardRef.current?.scrollIntoView({
      block: "end",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    // Mount-per-ask only. Re-running on status would re-scroll the user on every phase change.
  }, [askId, followRef]);

  // The store holds exactly ONE ask, so this card's terminal chip vanishes the moment the next
  // question arrives. Mirror the outcome onto the anchor node so the transcript keeps a permanent
  // record of what was picked (§9.4). No-ops when the node is gone, and the store's structural
  // bail makes a repeat write free.
  useEffect(() => {
    if (!terminal) return;
    store.patchNode(stepId, { detail: terminalText(ask) });
  }, [store, stepId, terminal, ask]);

  const submit = useCallback(
    async (answer: AskAnswer, chosenId?: string) => {
      // §9.4 stale-form guard. Re-verify against the STORE at CLICK time, not just at render: the
      // pending ask can change between paint and click, and a form from turn 2 is still clickable
      // in turn 7. `getAsk()` is synchronous, so this doubles as the double-click guard — the
      // second click sees `submitting` and bails.
      const live = store.getAsk();
      if (!live || live.askId !== askId || live.stepId !== stepId || live.status !== "pending") {
        toast.error("That question is no longer waiting for an answer.");
        return;
      }

      // Phase 1 — immediate, before any await. All choices disable, the picked one spins.
      store.patchAsk(askId, { status: "submitting", chosenId });

      // The SSE response never closed: the agent is parked inside its loop awaiting this POST
      // (§9.2). Flip the run back to active BEFORE the request, or the composer keeps offering
      // Send while the reply streams in behind it.
      store.resumeRun();

      // Phase 2 — the POST. Phase 3 is the server's `ask_resolved`, which swaps the prompt for the
      // summary; the card stays mounted until then.
      try {
        await transport.answerAsk({ askId, answer });
      } catch (err) {
        if (err instanceof AskConflictError) {
          // 409 — answered in another tab, or a replayed click. The agent is already moving on, so
          // take the card terminal and leave the run resumed rather than resurrecting a dead
          // button. Silently swallowing this is what makes a button read as broken (§9.2).
          toast.error(err.message);
          store.patchAsk(askId, { status: "resolved", summary: "Answered elsewhere" });
          return;
        }
        // A question that eats a failed click and stays dead is the worst outcome of all (§9.4).
        toast.error(err instanceof Error ? err.message : "That answer did not go through.");
        store.patchAsk(askId, { status: "pending", chosenId: undefined });
        // Undo the optimistic resume: the agent is still blocked on us, and a spinner while a
        // human is the bottleneck is a lie (§9.2).
        store.endRun("complete");
      }
    },
    [store, transport, askId, stepId],
  );

  const choose = useCallback(
    (choiceId: string) => void submit({ type: "choice", choiceId }, choiceId),
    [submit],
  );

  // Cancel always answers `{ submitted: false }`, whatever the ask kind. That flag is the union's
  // only "the user declined" discriminator (§9.6); the agent reads its absence as "never answered".
  const cancel = useCallback(
    () => void submit({ type: "form", values: {}, submitted: false }),
    [submit],
  );

  const sendText = useCallback(() => {
    const value = text.trim();
    if (value === "") return;
    void submit({ type: "text", text: value });
  }, [submit, text]);

  const promptId = `ask-prompt-${askId}`;
  const hasChoices = !!ask.choices && ask.choices.length > 0;
  // The `!hasChoices` arm is a dead-end guard, not a feature: an `action` ask that arrives with an
  // empty choice list would otherwise render a question with nothing to click and park the agent
  // until its 300s timeout.
  const showText =
    !terminal &&
    ask.askKind !== "form" &&
    (ask.askKind === "text" || ask.allowText === true || !hasChoices);

  return (
    <div
      ref={cardRef}
      data-slot="ask-card"
      data-ask-id={askId}
      className={cn(
        "rounded-xl border p-3.5 space-y-3",
        // The blocking species gets a live accent; a settled one drops back to the transcript's
        // own weight so an answered question stops shouting (§9.1).
        terminal ? "border-border bg-muted/30" : "border-primary/30 bg-primary/[0.04]",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <CircleHelp
          aria-hidden
          className={cn("mt-0.5 size-4 shrink-0", terminal ? "text-muted-foreground" : "text-primary")}
        />
        <p id={promptId} className="text-sm leading-relaxed">
          {ask.prompt}
        </p>
      </div>

      {/* One labelled group around every control, whatever the ask kind, so a screen reader reads
          the question before the buttons (§9.3). */}
      <div role="group" aria-labelledby={promptId} className="space-y-2.5">
        {terminal ? (
          <p className="text-xs text-muted-foreground">{terminalText(ask)}</p>
        ) : (
          <>
            {ask.askKind === "form" && ask.form && (
              <AskForm
                key={askId}
                askId={askId}
                form={ask.form}
                status={status}
                onSubmit={(values) => void submit({ type: "form", values, submitted: true })}
                onCancel={cancel}
              />
            )}

            {ask.askKind !== "form" &&
              hasChoices &&
              ask.choices &&
              (isImageChoiceSet(ask.choices) ? (
                <ImageChoiceGrid
                  askId={askId}
                  choices={ask.choices}
                  status={status}
                  chosenId={ask.chosenId}
                  onChoose={choose}
                />
              ) : (
                <ChoiceButtons
                  askId={askId}
                  choices={ask.choices}
                  status={status}
                  chosenId={ask.chosenId}
                  onChoose={choose}
                />
              ))}

            {showText && (
              // Not a <form>: the transcript sits next to the composer's own form and nesting or
              // neighbouring a second one makes Enter ambiguous. Enter is handled explicitly.
              <div className="flex items-center gap-2">
                <Input
                  value={text}
                  placeholder="Type your answer…"
                  aria-labelledby={promptId}
                  disabled={!pending}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendText();
                    }
                  }}
                />
                <Button
                  size="icon"
                  aria-label="Send answer"
                  disabled={!pending || text.trim() === ""}
                  onClick={sendText}
                >
                  {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send />}
                </Button>
              </div>
            )}

            {/* The form renders its own Cancel next to Submit (§9.6); everything else gets it here,
                as the non-blocking species so it cannot be mistaken for an answer. */}
            {ask.askKind !== "form" && ask.cancel && (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                disabled={!pending}
                onClick={cancel}
              >
                {ask.cancel.label}
              </Button>
            )}
          </>
        )}
      </div>

      {fraction !== null && (
        // A thin bar, no digits (§9.7). It only exists inside the last 60 seconds.
        <Progress
          value={fraction * 100}
          aria-label="Time left to answer"
          className="gap-0 pt-0.5"
        />
      )}
    </div>
  );
}

export interface AskSlotProps {
  /** The node this slot hangs under. */
  nodeId: string;
  transport: AgentTransport;
  followRef?: RefObject<boolean> | null;
  className?: string;
}

/**
 * Drop-in for `MessageRow`: renders the card only when the live ask targets THIS node.
 *
 * The `ask.stepId === nodeId` gate is the §9.3 rule made unmissable — a "is this the last message"
 * check attaches the buttons to the wrong bubble the moment a tool emits after the question.
 *
 * Cost: every row using this subscribes to the ask, which changes at most twice per turn (§5's
 * state table). That is nowhere near token frequency, so it does not re-open D1. If you already
 * have the ask in hand, render `<AskCard/>` directly instead.
 */
export function AskSlot({ nodeId, transport, followRef, className }: AskSlotProps) {
  const ask = useAsk();
  if (!ask || ask.stepId !== nodeId) return null;
  // Keyed on askId so a second question on the same node remounts with clean local state (the
  // free-text draft and the form draft) instead of inheriting the previous answer.
  return (
    <AskCard
      key={ask.askId}
      ask={ask}
      transport={transport}
      followRef={followRef}
      className={className}
    />
  );
}
