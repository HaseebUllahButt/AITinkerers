"use client";

// Summit Agent — the one context value the surface is allowed to have.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §5.1 hard rule 3 — "Nothing that changes at token frequency goes
// into React context. Context bypasses `memo` entirely. `runActive` is a PROP, not context. The
// only context value permitted is a `useMemo`'d bag of callbacks + config flags, whose dependency
// array lists every field explicitly."
//
// This is that bag, and nothing else may join it. Everything in here is stable for the lifetime of
// a session, so a context change cannot invalidate a memo'd row mid-turn:
//
//   transport   — memo'd by the page, keyed on sessionId
//   features    — resolveFeatures(mode, overrides), memo'd in ChatSurface
//   followRef   — a ref object; its identity never changes
//   onFeedback  — stable callback or undefined
//
// It exists because the leaf cards (`AskCard`, `ConfirmCard`, `MessageActions`) need the transport
// and the flags, and the only path to them runs through `MessageRow`, whose default memo comparator
// must keep seeing three primitives. Passing the transport down as a prop would work today and
// break the first time someone hands a row an inline object.

import { createContext, useContext } from "react";
import type { RefObject } from "react";

import type { AgentFeatureFlags, AgentTransport, FeedbackPayload } from "./types";

export interface AgentSurfaceValue {
  transport: AgentTransport;
  features: AgentFeatureFlags;
  /**
   * The follow-intent ref owned by `ChatSurface` (§5.1). `AskCard` reads it to decide whether an
   * arriving question may scroll itself into view (§9.9).
   */
  followRef: RefObject<boolean> | null;
  /** Absent until the feedback route exists (P1.5). The thumbs render disabled without it. */
  onFeedback?: (payload: FeedbackPayload) => Promise<void>;
  /**
   * Start a turn from inside the transcript, as if the human had typed it.
   *
   * Exists for cards whose "answer" is an ordinary message rather than an ask resolution — today
   * the picker, whose submit sends the ticked key values verbatim. Stable for the session's
   * lifetime, so it may sit in this memo'd bag without defeating the transcript's memoisation.
   */
  sendMessage: (message: string) => void;
}

const AgentSurfaceContext = createContext<AgentSurfaceValue | null>(null);

/** Deliberately the bare Provider — there is no render logic here and there must never be any. */
export const AgentSurfaceProvider = AgentSurfaceContext.Provider;

export function useAgentSurface(): AgentSurfaceValue {
  const value = useContext(AgentSurfaceContext);
  if (!value) {
    throw new Error("useAgentSurface must be used inside <ChatSurface>.");
  }
  return value;
}
