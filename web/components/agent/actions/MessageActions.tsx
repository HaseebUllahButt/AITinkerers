"use client";

// §10.1 — the end-of-turn action row.
//
// Deliberately NOT hover-revealed. It is always visible, but it only *exists* once the turn is
// finished. Unmounting during streaming (rather than greying) is what makes its arrival read as a
// deliberate reveal instead of a control flickering between states for thirty seconds.

import type { ReactNode, RefObject } from "react";

import { cn } from "@/lib/utils";

import type { AgentFeatureFlags, AgentNode, FeedbackPayload } from "../types";
import { CopyButton } from "./CopyButton";
import { FeedbackButtons, type FeedbackState } from "./FeedbackButtons";

export interface MessageActionsProps {
  node: AgentNode;
  /**
   * Read HIGH (one `useRunState()` near the surface root) and passed DOWN as a prop — §5.1. A
   * subscription here would put every message row on the run channel for no benefit.
   */
  runActive: boolean;
  /** The rendered OUTPUT element, for the dual-flavour copy. See CopyButton. */
  contentRef?: RefObject<HTMLElement | null>;
  features: AgentFeatureFlags;
  /**
   * True only for the run's LAST assistant node. Gates the thumbs, because the rating is anchored
   * to the run — eight signals per turn is garbage training data (§10.3).
   */
  isRunTail?: boolean;
  /** An unanswered ask hanging off this message. Suppresses copy: a pending question is not an answer. */
  askPending?: boolean;
  initialFeedback?: FeedbackState;
  /** See FeedbackButtons.onSubmit — TODO(P2): no server route yet. */
  onFeedback?: (payload: FeedbackPayload) => Promise<void>;
  /** Server-declared actions, rendered right of the thumbs. */
  actions?: ReactNode;
  className?: string;
}

export function MessageActions({
  node,
  runActive,
  contentRef,
  features,
  isRunTail = false,
  askPending = false,
  initialFeedback,
  onFeedback,
  actions,
  className,
}: MessageActionsProps) {
  // This component holds NO hooks, which is what makes these early returns legal. Keep it that
  // way: anything stateful belongs in CopyButton / FeedbackButtons, which mount unconditionally
  // relative to their own hooks.
  if (!node.output || node.streaming || runActive) return null;

  const showCopy = features.copy && !askPending;
  const showFeedback = features.feedback && isRunTail;
  if (!showCopy && !showFeedback && !actions) return null;

  return (
    <div
      data-slot="message-actions"
      // -ml-1.5 pulls the ghost buttons' internal padding back so the icons optically align with
      // the left edge of the message text above them, rather than sitting a padding-width inboard.
      // `relative` gives any absolutely-positioned descendant (CopyButton's sr-only status span) a
      // containing block HERE rather than at the scroll container, so a 1px a11y node can never
      // extend the transcript's scrollHeight. Belt-and-braces with the offsets on the span itself.
      className={cn("relative -ml-1.5 flex flex-wrap items-center", className)}
    >
      {showCopy ? <CopyButton text={node.output} contentRef={contentRef} /> : null}
      {showFeedback ? (
        <FeedbackButtons runId={node.runId} initial={initialFeedback} onSubmit={onFeedback} />
      ) : null}
      {actions}
    </div>
  );
}
