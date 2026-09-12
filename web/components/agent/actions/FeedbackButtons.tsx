"use client";

// §10.3 — the human-quality signal.
//
// This is not decoration. It is the only input a self-optimising copy loop can learn from, so the
// rating is anchored to the RUN, not to a message: a turn with five tool steps and three text
// chunks must produce ONE labelled example carrying the whole trajectory, not eight scalars.
//
// Persistence is optimistic-AFTER-confirm. Local state moves only inside the resolved branch. A
// thumb that lights up and then silently reverts on a network failure destroys trust in every
// other control on the surface, so we would rather be 200ms late than briefly wrong.

import { MessageCircleIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { TOOLTIP_DELAY_MS } from "../constants";
import type { FeedbackPayload } from "../types";
import { FeedbackDialog } from "./FeedbackDialog";

/** The persisted signal for one run. `value: null` means "no rating". */
export interface FeedbackState {
  value: 0 | 1 | null;
  comment?: string;
}

const NO_FEEDBACK: FeedbackState = Object.freeze({ value: null });

export interface FeedbackButtonsProps {
  /** The run this rating is anchored to. Also the primary key of `agent_feedback`. */
  runId: string;
  /**
   * Seed only. This component owns the value after mount, so mount it on the run's last assistant
   * node (which is unique per run) rather than trying to drive it from above.
   */
  initial?: FeedbackState;
  /**
   * Persist the rating. Resolve = written, reject = not written (the thumb will not move).
   *
   * TODO(P2): no server route exists yet. The shape it needs to write is the `agent_feedback`
   * row from §10.3 — run_id, value, comment, plus the full step trajectory (tool names, args,
   * outputs), model and prompt version, which the caller assembles from the store. Until a page
   * passes this prop the buttons render disabled with an explanatory tooltip rather than
   * pretending to work.
   */
  onSubmit?: (payload: FeedbackPayload) => Promise<void>;
  /** Externally force the row inert (e.g. a read-only replay of someone else's session). */
  disabled?: boolean;
  className?: string;
}

export function FeedbackButtons({
  runId,
  initial,
  onSubmit,
  disabled = false,
  className,
}: FeedbackButtonsProps) {
  // NOTE: every hook in this component runs unconditionally. The Chainlit original early-returns
  // on its feature flag ABOVE these hooks — a real Rules-of-Hooks violation that only survives
  // because the flag never toggles at runtime. Gate this component from its PARENT instead.
  const [state, setState] = useState<FeedbackState>(() => initial ?? NO_FEEDBACK);
  // Non-null ⇒ dialog open, holding the score that is about to be committed. A click never
  // commits on its own (§10.3).
  const [dialogValue, setDialogValue] = useState<0 | 1 | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Focus returns to whichever control opened the dialog. One mutable ref beats two element refs
  // because Base UI reads `finalFocus` at close time, not at render time.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // The POST outlives the component if the transcript virtualizes mid-flight.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const persist = useCallback(
    async (next: FeedbackState): Promise<boolean> => {
      if (!onSubmit) return false;
      const removing = next.value === null;
      const promise = onSubmit({ runId, value: next.value, comment: next.comment });
      // toast.promise attaches its own handlers, so the extra await below cannot produce an
      // unhandled rejection.
      toast.promise(promise, {
        loading: removing ? "Removing rating…" : "Saving rating…",
        success: removing ? "Rating removed." : "Thanks — rating saved.",
        error: (e: unknown) =>
          (e instanceof Error && e.message) || "Could not save that rating.",
      });
      setSubmitting(true);
      try {
        await promise;
        if (alive.current) setState(next); // ← the ONLY place local state moves
        return true;
      } catch {
        return false; // the toast already said so; leaving state untouched is the point
      } finally {
        if (alive.current) setSubmitting(false);
      }
    },
    [onSubmit, runId],
  );

  const onThumb = (value: 0 | 1, e: MouseEvent<HTMLButtonElement>) => {
    returnFocusRef.current = e.currentTarget;
    if (submitting) return;
    if (state.value === value) {
      // Clicking the already-set value deletes it. A mis-click is one click to undo, and it does
      // not deserve a dialog.
      void persist({ value: null });
      return;
    }
    setDialogValue(value);
  };

  const onEditComment = (e: MouseEvent<HTMLButtonElement>) => {
    returnFocusRef.current = e.currentTarget;
    if (state.value === null) return;
    setDialogValue(state.value);
  };

  const onDialogSubmit = async (comment: string) => {
    if (dialogValue === null) return;
    const trimmed = comment.trim();
    const ok = await persist({ value: dialogValue, comment: trimmed || undefined });
    // Keep the dialog open on failure so the typed comment is not thrown away.
    if (ok && alive.current) setDialogValue(null);
  };

  const inert = disabled || !onSubmit || submitting;
  const inertTip = !onSubmit
    ? "Rating isn't wired up on this surface yet"
    : submitting
      ? "Saving…"
      : "Rating unavailable";

  return (
    <>
      <div className={cn("flex items-center", className)} data-slot="feedback-buttons">
        <IconAction
          label={state.value === 1 ? "Remove positive rating" : "Good response"}
          tip={inert ? inertTip : state.value === 1 ? "Remove rating" : "Good response"}
          pressed={state.value === 1}
          inert={inert}
          onClick={(e) => onThumb(1, e)}
        >
          {/*
            Fill, not colour. Chainlit signals the set state with green/red alone, which is
            invisible to non-sighted users and unreliable for colour-vision-deficient ones. The
            filled-vs-outline glyph plus aria-pressed carries the state on its own.
          */}
          <ThumbsUpIcon aria-hidden fill={state.value === 1 ? "currentColor" : "none"} />
        </IconAction>

        <IconAction
          label={state.value === 0 ? "Remove negative rating" : "Bad response"}
          tip={inert ? inertTip : state.value === 0 ? "Remove rating" : "Bad response"}
          pressed={state.value === 0}
          inert={inert}
          onClick={(e) => onThumb(0, e)}
        >
          <ThumbsDownIcon aria-hidden fill={state.value === 0 ? "currentColor" : "none"} />
        </IconAction>

        {/* Third button only once a comment exists — it is the affordance to reopen and edit it. */}
        {state.comment ? (
          <IconAction
            label="Edit feedback comment"
            tip={inert ? inertTip : "Edit comment"}
            inert={inert}
            onClick={onEditComment}
          >
            <MessageCircleIcon aria-hidden />
          </IconAction>
        ) : null}
      </div>

      {dialogValue !== null ? (
        <FeedbackDialog
          open
          onOpenChange={(next) => {
            if (!next && !submitting) setDialogValue(null);
          }}
          value={dialogValue}
          initialComment={state.value === dialogValue ? state.comment : undefined}
          submitting={submitting}
          onSubmit={(comment) => void onDialogSubmit(comment)}
          returnFocusRef={returnFocusRef}
        />
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────── icon button

interface IconActionProps {
  /** Explicit aria-label. Required IN ADDITION to the tooltip — tooltip association is not a name. */
  label: string;
  tip: string;
  pressed?: boolean;
  inert?: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}

/**
 * No hooks in here on purpose: it is called conditionally (the comment button appears and
 * disappears) and must stay safe to mount and unmount mid-row.
 */
function IconAction({ label, tip, pressed, inert, onClick, children }: IconActionProps) {
  if (inert) {
    // shadcn/Base UI buttons carry `disabled:pointer-events-none`, so a disabled trigger swallows
    // its own tooltip and the user gets a greyed control with no explanation. Hang the tooltip on
    // a focusable wrapper instead, and take the real button out of the tab order.
    return (
      <Tooltip>
        <TooltipTrigger
          delay={TOOLTIP_DELAY_MS}
          render={<span />}
          className="inline-flex rounded-[min(var(--radius-md),10px)] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          tabIndex={0}
          role="button"
          aria-disabled
          aria-pressed={pressed}
          aria-label={label}
        >
          <Button
            variant="ghost"
            size="icon-xs"
            disabled
            tabIndex={-1}
            aria-hidden
            className="text-muted-foreground"
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        delay={TOOLTIP_DELAY_MS}
        render={<Button variant="ghost" size="icon-xs" />}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(
          "text-muted-foreground hover:text-foreground",
          pressed && "text-foreground",
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
