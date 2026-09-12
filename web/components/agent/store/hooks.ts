"use client";

// SearchOps Agent — the React binding for AgentStore.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §5.1, §5.3.
//
// Every hook here is `useSyncExternalStore` over a NARROW subscription. That narrowness is the
// whole product: a token append fires one node's listener set, so one `MessageRow` re-renders and
// the other 200 nodes, the session rail, the confirm cards and the tables do not.
//
// ══ Two invariants ══════════════════════════════════════════════════════════════════════════════
//
//  1. `getSnapshot` MUST return a referentially stable value. Every read here goes to a store getter
//     that returns the same object until it genuinely changes; the empty cases return the frozen
//     singletons from constants.ts. Return a fresh `[]` and React 19 loops with "The result of
//     getSnapshot should be cached on the store".
//
//  2. `subscribe` MUST be referentially stable across renders, or React tears down and re-attaches
//     the subscription on every commit. Hence the `useCallback` on every one of them.
//
// The store INSTANCE travels through context. That is the one context value permitted here (§5.1):
// it never changes identity, so it cannot defeat a `memo`. Nothing that changes at token frequency
// may go into context — `runActive` is a PROP.

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { AgentElement, AgentNode, AskState, RunState } from "../types";
import type { AgentStore } from "./agentStore";

const AgentStoreContext = createContext<AgentStore | null>(null);

/**
 * Provider. Deliberately NOT a component file — it is one line of context and keeping it next to
 * the hooks stops anyone from adding render logic to it.
 */
export const AgentStoreProvider = AgentStoreContext.Provider;

export function useAgentStoreInstance(): AgentStore {
  const store = useContext(AgentStoreContext);
  if (!store) {
    throw new Error("useAgentStoreInstance must be used inside <AgentStoreProvider>.");
  }
  return store;
}

// ─────────────────────────────────────────────────────────────── structure

/**
 * The root-level node id list.
 *
 * `Transcript` subscribes to THIS AND NOTHING ELSE, so it re-renders when a node is added and never
 * on a token. Keep it that way.
 */
export function useRootIds(): readonly string[] {
  const store = useAgentStoreInstance();
  const getSnapshot = useCallback(() => store.getRootIds(), [store]);
  return useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribeRootIds(fn), [store]),
    getSnapshot,
    getSnapshot,
  );
}

/** Child ids of one node. Powers `StepList`'s sibling group and the hoist/nest partition (§7.5). */
export function useChildIds(id: string): readonly string[] {
  const store = useAgentStoreInstance();
  const getSnapshot = useCallback(() => store.getChildIds(id), [store, id]);
  return useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribeChildIds(id, fn), [store, id]),
    getSnapshot,
    getSnapshot,
  );
}

/**
 * One node, by id.
 *
 * Returns a stable placeholder rather than `undefined` for an unknown id, so `MessageRow` never has
 * to null-check and getSnapshot never returns a fresh object. A placeholder has
 * `runId === "" && streaming === false`; if you need to distinguish it, use `useNodeOrNull`.
 */
export function useNode(id: string): AgentNode {
  const store = useAgentStoreInstance();
  const getSnapshot = useCallback(() => store.getNodeOrPlaceholder(id), [store, id]);
  return useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribeNode(id, fn), [store, id]),
    getSnapshot,
    getSnapshot,
  );
}

export function useNodeOrNull(id: string): AgentNode | undefined {
  const store = useAgentStoreInstance();
  const getSnapshot = useCallback(() => store.getNode(id), [store, id]);
  return useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribeNode(id, fn), [store, id]),
    getSnapshot,
    getSnapshot,
  );
}

// ─────────────────────────────────────────────────────────────── run / ask / actions

/** `{ runId, active, lastReason }`. Changes twice per turn. Read it high and pass `active` DOWN as a prop. */
export function useRunState(): RunState {
  const store = useAgentStoreInstance();
  const getSnapshot = useCallback(() => store.getRun(), [store]);
  return useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribeRun(fn), [store]),
    getSnapshot,
    getSnapshot,
  );
}

export function useAsk(): AskState | null {
  const store = useAgentStoreInstance();
  const getSnapshot = useCallback(() => store.getAsk(), [store]);
  return useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribeAsk(fn), [store]),
    getSnapshot,
    getSnapshot,
  );
}

/**
 * Node ids of confirmation cards still awaiting a decision. Powers hermes' "N proposals waiting"
 * banner. Returns the frozen empty array when there are none, so `.length` is safe and the
 * reference is stable.
 */
export function usePendingActions(): readonly string[] {
  const store = useAgentStoreInstance();
  const getSnapshot = useCallback(() => store.getPendingActionIds(), [store]);
  return useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribePendingActions(fn), [store]),
    getSnapshot,
    getSnapshot,
  );
}

// ─────────────────────────────────────────────────────────────── elements

/**
 * The elements hanging off one node, in arrival order.
 *
 * The returned array is reference-stable until an element for THIS node actually changes, which is
 * what makes `a.elements === b.elements` a valid memo comparison in `Markdown.tsx`. Pass
 * `EMPTY_ELEMENTS` — never an inline `[]` — where there are none.
 */
export function useElementsFor(nodeId: string): readonly AgentElement[] {
  const store = useAgentStoreInstance();
  const getSnapshot = useCallback(() => store.getElementsFor(nodeId), [store, nodeId]);
  return useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribeElements(nodeId, fn), [store, nodeId]),
    getSnapshot,
    getSnapshot,
  );
}

// ─────────────────────────────────────────────────────────────── whole-store reads (use sparingly)

/**
 * A counter bumped on EVERY store mutation, including every token. This is the
 * `streamRevision` of §6.4 — the dependency of the stick-to-bottom `useLayoutEffect`.
 *
 * ⚠ Whoever calls this re-renders at token frequency. That is acceptable for exactly one component:
 * `ScrollContainer`, whose entire output is `props.children` (React bails on reconciling children
 * it received as the same element references, so the subtree is untouched). Calling it anywhere
 * that renders real content re-introduces D1.
 */
export function useStreamRevision(): number {
  const store = useAgentStoreInstance();
  const getSnapshot = useCallback(() => store.getRevision(), [store]);
  return useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribeAny(fn), [store]),
    getSnapshot,
    getSnapshot,
  );
}

/**
 * Derive a PRIMITIVE from the whole store, re-evaluated on every mutation.
 *
 * Intended for the dead-air predicates of §7.7 (`runActive && !hasActiveStep && !hasStreamingText`),
 * which genuinely have to look at the whole tree. React bails out of the re-render when the value
 * is `Object.is`-equal to the last one, so a boolean selector costs a predicate walk per token and
 * zero renders — but only if it returns a primitive. Return an object or an array and you have
 * built an infinite render loop.
 *
 * @param select MUST be stable (wrap in useCallback or hoist to module scope) and MUST return a
 *   primitive.
 */
export function useAgentSelector<T extends string | number | boolean | null | undefined>(
  select: (store: AgentStore) => T,
): T {
  const store = useAgentStoreInstance();
  const getSnapshot = useCallback(() => select(store), [store, select]);
  return useSyncExternalStore(
    useCallback((fn: () => void) => store.subscribeAny(fn), [store]),
    getSnapshot,
    getSnapshot,
  );
}

// Re-exported so consumers get the singletons from the same module as the hooks and cannot
// accidentally hand an inline `[]` to a reference-compare comparator.
export { EMPTY_ELEMENTS, EMPTY_IDS } from "../constants";
