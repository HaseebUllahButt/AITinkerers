// SearchOps Agent — whole-tree predicates.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §7.5 (the running predicate), §7.7 (dead air), §11.7 (starters).
//
// Every function here is pure over an `AgentStore` and returns a PRIMITIVE. That is deliberate:
// they are meant to be fed to `useAgentSelector`, which bails out of the re-render when the value
// is `Object.is`-equal to the last one. A selector returning an object or an array would re-render
// on every token instead — an infinite-ish loop of the exact kind this whole design exists to kill.
//
// They are cheap: a Map walk over a few hundred nodes, once per store mutation, with early exit
// where possible. Cheaper than one React render of a single markdown paragraph.

import type { AgentNode } from "../types";
import type { AgentStore } from "./agentStore";

/**
 * The three-way AND from §7.5. Shared by `StepNode`, `StepDuration` and the dead-air predicates so
 * they cannot drift apart.
 *
 * `runActive` is in here on purpose: a dropped stream, an abort, or a missing `node_end` must never
 * leave an orphaned shimmer. `store.endRun()` flips the run flag and every open step settles to
 * "Used …" in the same frame. That is why Stop is safe without per-step done events.
 */
export function isNodeRunning(node: AgentNode, runActive: boolean): boolean {
  return runActive && !!node.start && !node.end && !node.isError;
}

/** Is a turn in flight? Convenience wrapper so callers do not reach into `RunState` themselves. */
export function isRunning(store: AgentStore): boolean {
  return store.getRun().active;
}

/**
 * Does the thread have any real content yet?
 *
 * Gate the welcome heading and the starter chips on THIS, not on `nodes.length === 0`. There is a
 * window at the start of a turn where only run scaffolding exists; a length check is true then and
 * the welcome screen flashes back over a turn the user just submitted (§11.7).
 */
export function hasVisibleTurn(store: AgentStore): boolean {
  return store.someNode(
    (n) => n.kind === "user" || n.kind === "assistant" || n.kind === "tool",
  );
}

/**
 * Is any tool or thinking step currently running?
 *
 * Note this does NOT include `runActive` — callers AND it in themselves (see `showDeadAir`), which
 * keeps the predicate meaningful for a settled transcript too.
 */
export function hasActiveStep(store: AgentStore): boolean {
  return store.someNode(
    (n) => (n.kind === "tool" || n.kind === "thinking") && !!n.start && !n.end && !n.isError,
  );
}

/**
 * Is assistant prose currently arriving?
 *
 * Requires non-empty output as well as `streaming`, because an assistant node that exists but has
 * produced nothing is exactly the dead-air case the cursor is for.
 */
export function hasStreamingText(store: AgentStore): boolean {
  return store.someNode((n) => n.kind === "assistant" && n.streaming && !!n.output);
}

/**
 * §7.7 — the gap between "request sent" and "first token", where a chat UI feels broken.
 *
 * Render a bare `<StreamCursor/>` when true. Nothing else: no "Working…" text, no spinner. A cursor
 * shown ALONGSIDE a running tool, or lingering after the first assistant token, reads as a
 * double-render bug — which is why both predicates are required, not just one.
 */
export function showDeadAir(store: AgentStore): boolean {
  return store.getRun().active && !hasActiveStep(store) && !hasStreamingText(store);
}

/** Count of confirmation cards awaiting a decision. For the "N proposals waiting" banner. */
export function pendingActionCount(store: AgentStore): number {
  return store.getPendingActionIds().length;
}

/**
 * Is `pickerId` the LIVE picker?
 *
 * The rule PR #26 established, preserved verbatim because it quietly covers two cases at once: the
 * newest picker in the transcript with no user message after it. A picker followed by a user turn is
 * stale — which is true both when the selection was already submitted (the submission IS a persisted
 * user message, so a rehydrated card renders read-only) and when a later picker superseded it.
 */
export function isLivePicker(store: AgentStore, pickerId: string): boolean {
  const ids = store.getRootIds();
  let lastPicker = -1;
  for (let i = 0; i < ids.length; i++) {
    if (store.getNode(ids[i])?.kind === "picker") lastPicker = i;
  }
  if (lastPicker < 0 || ids[lastPicker] !== pickerId) return false;
  for (let i = lastPicker + 1; i < ids.length; i++) {
    if (store.getNode(ids[i])?.kind === "user") return false;
  }
  return true;
}
