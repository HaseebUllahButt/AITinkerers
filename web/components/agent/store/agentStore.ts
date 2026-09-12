// Summit Agent — the transcript store.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §5.1, §5.2, §5.5.
//
// This is the fix for D1: "every streamed token re-renders the whole page". A mutable object graph
// living OUTSIDE React, with one listener set per node id, so a token append fires exactly one
// listener and re-renders exactly one component.
//
// Zero new dependencies, by design. This is a plain class + `useSyncExternalStore` (see hooks.ts).
//
// ══ The two rules that make this work ═══════════════════════════════════════════════════════════
//
// 1. STRUCTURAL SHARING. Every mutator keeps the PREVIOUS object identity when nothing actually
//    changed, and mints a new one only when something did. Skip the bail and every `memo` and every
//    reference-compare comparator downstream is silently dead — the code still works, it is just
//    slow again, which is the worst kind of regression because nothing looks broken.
//
// 2. STABLE SNAPSHOTS. Every `get*` must return a referentially stable value for an unchanged
//    store. Returning a fresh `[]` or `{...node}` makes React 19 loop with "The result of
//    getSnapshot should be cached on the store". That is why the empty cases return the frozen
//    module singletons from constants.ts and why missing nodes come from a memoized placeholder map.

import { EMPTY_ELEMENTS, EMPTY_IDS } from "../constants";
import type {
  AgentElement,
  AgentNode,
  AgentSnapshot,
  AskState,
  NodeKind,
  RunEndReason,
  RunState,
} from "../types";

type Listener = () => void;

/** Shape of the `node_start` event, minus the discriminant. What `upsertNode` consumes. */
export interface NodeStartInput {
  id: string;
  runId: string;
  parentId?: string;
  kind: NodeKind;
  name?: string;
  label?: string;
  detail?: string;
  input?: string;
  inputLang?: string;
  start: string;
  defaultOpen?: boolean;
  autoCollapse?: boolean;
  data?: AgentNode["data"];
}

const IDLE_RUN: RunState = Object.freeze({ runId: null, active: false, lastReason: null });

function shallowEqualElement(a: AgentElement, b: AgentElement): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i] as keyof AgentElement;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** RFC4122 where available; the fallback only has to be unique within one tab. */
function uuid(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class AgentStore {
  // ── data ──────────────────────────────────────────────────────────────────────────────────────
  private nodes = new Map<string, AgentNode>();
  private rootIds: readonly string[] = EMPTY_IDS;
  private childIds = new Map<string, readonly string[]>();
  private elements: readonly AgentElement[] = EMPTY_ELEMENTS;
  private elementsByFor = new Map<string, readonly AgentElement[]>();
  private run: RunState = IDLE_RUN;
  private ask: AskState | null = null;
  private pendingActionIds: readonly string[] = EMPTY_IDS;

  /**
   * Nodes whose `parentId` has not arrived yet, keyed by that parent id, flushed when it does.
   *
   * Chainlit drops orphans silently and children vanish with no error. Over a real network,
   * out-of-order delivery is not hypothetical.
   */
  private pendingOrphans = new Map<string, AgentNode[]>();

  /** Tokens that arrived before their `node_start`. Same reasoning as `pendingOrphans`. */
  private pendingTokens = new Map<string, { output: string; input: string }>();

  /**
   * Stable placeholders for ids that are not (yet) in the map. `useNode` must return a
   * referentially stable object even for a miss, or React 19 loops on getSnapshot.
   */
  private missingNodes = new Map<string, AgentNode>();

  // ── listeners ─────────────────────────────────────────────────────────────────────────────────
  private nodeListeners = new Map<string, Set<Listener>>();
  private childListeners = new Map<string, Set<Listener>>();
  private elementListeners = new Map<string, Set<Listener>>();
  private listListeners = new Set<Listener>();
  private runListeners = new Set<Listener>();
  private askListeners = new Set<Listener>();
  private actionListeners = new Set<Listener>();
  /**
   * Fired on EVERY mutation including each token. Two consumers only:
   *   - the scroll layer's `streamRevision` counter (§6.4)
   *   - `useAgentSelector`, for primitive-valued whole-tree predicates (dead air)
   * Anything else subscribing here has re-introduced D1.
   */
  private anyListeners = new Set<Listener>();
  private revision = 0;

  // ── subscription plumbing ─────────────────────────────────────────────────────────────────────

  private static sub(map: Map<string, Set<Listener>>, key: string, fn: Listener): () => void {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(fn);
    return () => {
      const s = map.get(key);
      if (!s) return;
      s.delete(fn);
      // Drop the bucket when it empties. A long thread otherwise accumulates one empty Set per
      // node id per remount, which is a slow leak in a session that stays open all day.
      if (s.size === 0) map.delete(key);
    };
  }

  private static fire(map: Map<string, Set<Listener>>, key: string): void {
    const set = map.get(key);
    if (!set) return;
    // Copy before iterating: a listener may unsubscribe itself during the notification.
    const fns = Array.from(set);
    for (let i = 0; i < fns.length; i++) fns[i]();
  }

  private static fireSet(set: Set<Listener>): void {
    const fns = Array.from(set);
    for (let i = 0; i < fns.length; i++) fns[i]();
  }

  /** Bump the global revision and notify the two global consumers. Called by every mutator. */
  private touch(): void {
    this.revision++;
    AgentStore.fireSet(this.anyListeners);
  }

  subscribeNode(id: string, fn: Listener): () => void {
    return AgentStore.sub(this.nodeListeners, id, fn);
  }
  subscribeChildIds(id: string, fn: Listener): () => void {
    return AgentStore.sub(this.childListeners, id, fn);
  }
  subscribeElements(forId: string, fn: Listener): () => void {
    return AgentStore.sub(this.elementListeners, forId, fn);
  }
  subscribeRootIds(fn: Listener): () => void {
    this.listListeners.add(fn);
    return () => this.listListeners.delete(fn);
  }
  subscribeRun(fn: Listener): () => void {
    this.runListeners.add(fn);
    return () => this.runListeners.delete(fn);
  }
  subscribeAsk(fn: Listener): () => void {
    this.askListeners.add(fn);
    return () => this.askListeners.delete(fn);
  }
  subscribePendingActions(fn: Listener): () => void {
    this.actionListeners.add(fn);
    return () => this.actionListeners.delete(fn);
  }
  subscribeAny(fn: Listener): () => void {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }

  // ── reads (all referentially stable) ──────────────────────────────────────────────────────────

  getNode(id: string): AgentNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Never-undefined read for `useNode`. A miss returns a frozen placeholder that is memoized per
   * id, so repeated getSnapshot calls compare equal.
   */
  getNodeOrPlaceholder(id: string): AgentNode {
    const hit = this.nodes.get(id);
    if (hit) return hit;
    let ph = this.missingNodes.get(id);
    if (!ph) {
      ph = Object.freeze({ id, runId: "", kind: "assistant" as NodeKind, streaming: false });
      this.missingNodes.set(id, ph);
    }
    return ph;
  }

  getRootIds(): readonly string[] {
    return this.rootIds;
  }

  getChildIds(id: string): readonly string[] {
    return this.childIds.get(id) ?? EMPTY_IDS;
  }

  getElementsFor(forId: string): readonly AgentElement[] {
    return this.elementsByFor.get(forId) ?? EMPTY_ELEMENTS;
  }

  getAllElements(): readonly AgentElement[] {
    return this.elements;
  }

  getRun(): RunState {
    return this.run;
  }

  getAsk(): AskState | null {
    return this.ask;
  }

  /** Node ids of `confirm` nodes still awaiting a decision. Powers the pending-confirmation banner. */
  getPendingActionIds(): readonly string[] {
    return this.pendingActionIds;
  }

  getRevision(): number {
    return this.revision;
  }

  getNodeCount(): number {
    return this.nodes.size;
  }

  /** Iteration for selectors.ts. Do not call from render for anything but a primitive result. */
  forEachNode(fn: (node: AgentNode) => void): void {
    this.nodes.forEach(fn);
  }

  /** Early-exit iteration — cheaper than forEachNode for `some`-style predicates. */
  someNode(fn: (node: AgentNode) => boolean): boolean {
    for (const node of this.nodes.values()) if (fn(node)) return true;
    return false;
  }

  // ── node mutators ─────────────────────────────────────────────────────────────────────────────

  /**
   * UPSERT, never append. This alone fixes D6: a replayed `tool_start` for a known id patches in
   * place instead of appending a twin.
   */
  upsertNode(e: NodeStartInput): void {
    const existing = this.nodes.get(e.id);
    if (existing) {
      this.patchNode(e.id, {
        runId: e.runId,
        parentId: e.parentId ?? existing.parentId,
        kind: e.kind,
        name: e.name ?? existing.name,
        label: e.label ?? existing.label,
        detail: e.detail ?? existing.detail,
        input: e.input ?? existing.input,
        inputLang: e.inputLang ?? existing.inputLang,
        start: e.start,
        data: e.data ?? existing.data,
        // defaultOpen/autoCollapse are deliberately NOT re-applied: they are mount-time seeds and
        // re-asserting them mid-turn would slam an accordion the user is reading (§7.5).
      });
      return;
    }

    const node: AgentNode = {
      id: e.id,
      runId: e.runId,
      parentId: e.parentId,
      kind: e.kind,
      name: e.name,
      label: e.label,
      detail: e.detail,
      input: e.input,
      inputLang: e.inputLang,
      start: e.start,
      streaming: true,
      defaultOpen: e.defaultOpen,
      autoCollapse: e.autoCollapse,
      data: e.data,
    };
    this.insertNode(node);
  }

  private insertNode(node: AgentNode): void {
    // A node id that was previously missed now exists; drop its placeholder so a later miss for a
    // genuinely different id can't collide with a stale frozen object.
    this.missingNodes.delete(node.id);

    const buffered = this.pendingTokens.get(node.id);
    if (buffered) {
      this.pendingTokens.delete(node.id);
      if (buffered.output) node = { ...node, output: (node.output ?? "") + buffered.output };
      if (buffered.input) node = { ...node, input: (node.input ?? "") + buffered.input };
    }

    if (node.parentId !== undefined && !this.nodes.has(node.parentId)) {
      // Orphan. Buffer rather than drop — the parent may simply be later in the same chunk.
      let bucket = this.pendingOrphans.get(node.parentId);
      if (!bucket) {
        bucket = [];
        this.pendingOrphans.set(node.parentId, bucket);
      }
      bucket.push(node);
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[agent] node ${node.id} arrived before parent ${node.parentId}; buffered.`);
      }
      return;
    }

    this.nodes.set(node.id, node);

    if (node.parentId === undefined) {
      this.rootIds = [...this.rootIds, node.id];
      AgentStore.fireSet(this.listListeners);
    } else {
      const prev = this.childIds.get(node.parentId) ?? EMPTY_IDS;
      this.childIds.set(node.parentId, [...prev, node.id]);
      AgentStore.fire(this.childListeners, node.parentId);
    }

    if (node.kind === "confirm") this.recomputePendingActions();

    // Flush anything that was waiting on this node as its parent.
    const waiting = this.pendingOrphans.get(node.id);
    if (waiting) {
      this.pendingOrphans.delete(node.id);
      for (let i = 0; i < waiting.length; i++) this.insertNode(waiting[i]);
    }

    this.touch();
  }

  /**
   * Shallow-merge patch with the structural-sharing bail.
   *
   * The `changed` loop is the whole point: without it every patch mints a new object, every
   * `memo` comparator sees a new reference, and the per-node subscription buys nothing.
   */
  patchNode(id: string, patch: Partial<AgentNode>): void {
    const prev = this.nodes.get(id);
    if (!prev) return; // orphan patch — nothing to merge onto
    let changed = false;
    for (const k in patch) {
      const key = k as keyof AgentNode;
      if (patch[key] === undefined) continue; // `undefined` means "leave alone", not "clear"
      if (prev[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return; // ← the bail. Skip it and every memo is dead.

    const next: AgentNode = { ...prev };
    for (const k in patch) {
      const key = k as keyof AgentNode;
      if (patch[key] === undefined) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (next as any)[key] = patch[key];
    }
    this.nodes.set(id, next);
    AgentStore.fire(this.nodeListeners, id);
    if (next.kind === "confirm") this.recomputePendingActions();
    this.touch();
  }

  /**
   * The hot path. One map write, one listener set fired, one component re-rendered.
   *
   * Empty text is a no-op: the writer emits `{t:"text", text:""}` as a keepalive and turning that
   * into a store write would fire every scroll consumer for nothing.
   */
  appendToken(id: string, text: string, target: "output" | "input" = "output"): void {
    if (!text) return;
    const prev = this.nodes.get(id);
    if (!prev) {
      // Token before node_start. Buffer; `insertNode` replays it.
      const buf = this.pendingTokens.get(id) ?? { output: "", input: "" };
      buf[target] += text;
      this.pendingTokens.set(id, buf);
      return;
    }
    const next: AgentNode = { ...prev, streaming: true };
    if (target === "input") next.input = (prev.input ?? "") + text;
    else next.output = (prev.output ?? "") + text;
    this.nodes.set(id, next);
    AgentStore.fire(this.nodeListeners, id);
    this.touch();
  }

  /** Append a user turn optimistically, before any network. Returns the node id. */
  appendUserNode(text: string): string {
    const id = `${this.run.runId ?? "local"}:user`;
    this.insertNode({
      id,
      runId: this.run.runId ?? "",
      kind: "user",
      output: text,
      start: nowIso(),
      end: nowIso(),
      streaming: false,
    });
    return id;
  }

  /** Surface a transport-level failure in the transcript rather than only in a toast. */
  pushErrorNode(message: string): string {
    const id = `${this.run.runId ?? "local"}:error:${this.nodes.size}`;
    this.insertNode({
      id,
      runId: this.run.runId ?? "",
      kind: "assistant",
      output: message,
      isError: true,
      start: nowIso(),
      end: nowIso(),
      streaming: false,
    });
    return id;
  }

  // ── element mutators ──────────────────────────────────────────────────────────────────────────

  /**
   * Upsert by id, MERGE not replace — a re-emit carrying only `url` must not wipe width/height,
   * which is what reserved the box in the first place (§6.8).
   */
  upsertElement(next: AgentElement): void {
    const i = this.elements.findIndex((e) => e.id === next.id);
    if (i === -1) {
      this.elements = [...this.elements, next];
      this.reindexFor(next.forId);
      AgentStore.fire(this.elementListeners, next.forId);
      this.touch();
      return;
    }
    const prev = this.elements[i];
    const merged: AgentElement = { ...prev, ...next };
    if (shallowEqualElement(merged, prev)) return; // ← bail; keeps the reference-compare memo alive
    this.elements = [...this.elements.slice(0, i), merged, ...this.elements.slice(i + 1)];

    // Targeted reindex only. The spec sketch rebuilds the whole byFor map, which mints a new array
    // for every OTHER node too and defeats `a.elements === b.elements` in the Markdown comparator.
    this.reindexFor(merged.forId);
    AgentStore.fire(this.elementListeners, merged.forId);
    if (prev.forId !== merged.forId) {
      this.reindexFor(prev.forId);
      AgentStore.fire(this.elementListeners, prev.forId);
    }
    this.touch();
  }

  removeElement(id: string): void {
    const i = this.elements.findIndex((e) => e.id === id);
    if (i === -1) return;
    const forId = this.elements[i].forId;
    this.elements = [...this.elements.slice(0, i), ...this.elements.slice(i + 1)];
    this.reindexFor(forId);
    AgentStore.fire(this.elementListeners, forId);
    this.touch();
  }

  private reindexFor(forId: string): void {
    const bucket = this.elements.filter((e) => e.forId === forId);
    if (bucket.length === 0) this.elementsByFor.set(forId, EMPTY_ELEMENTS);
    else this.elementsByFor.set(forId, bucket);
  }

  // ── run mutators ──────────────────────────────────────────────────────────────────────────────

  /** Opens a run. Returns the runId so the caller can seed the legacy adapter with it. */
  beginRun(runId?: string): string {
    const id = runId ?? uuid();
    this.run = { runId: id, active: true, lastReason: null };
    AgentStore.fireSet(this.runListeners);
    this.touch();
    return id;
  }

  /**
   * Closes a run. ALWAYS called, from the stream loop's `finally` — never leaves a shimmer stuck.
   *
   * Per §5.5 this sets `streaming:false` on the open nodes and NOTHING else. It does not synthesise
   * an `end` timestamp (a fabricated duration is worse than no duration) and it never rebuilds the
   * tree. `runActive` going false is what makes the `running` predicate on every open step flip at
   * once, which is why Stop is safe without per-step done events.
   */
  endRun(reason: RunEndReason): void {
    this.nodes.forEach((node, id) => {
      if (node.streaming) this.patchNode(id, { streaming: false });
    });
    const prev = this.run;
    this.run = { runId: prev.runId, active: false, lastReason: reason };
    AgentStore.fireSet(this.runListeners);
    this.touch();
  }

  /**
   * Re-open the run that a pending ask paused (§9.2).
   *
   * The SSE response stays open the whole time a human is answering — the agent is genuinely
   * blocked inside its loop — so this is a resume, not a new run. `AskCard` must call it right
   * before POSTing the answer, otherwise the composer keeps showing Send while tokens stream in.
   */
  resumeRun(): void {
    const prev = this.run;
    if (prev.active || !prev.runId) return;
    this.run = { runId: prev.runId, active: true, lastReason: null };
    AgentStore.fireSet(this.runListeners);
    this.touch();
  }

  // ── ask mutators ──────────────────────────────────────────────────────────────────────────────

  /**
   * Set (or clear) the pending ask.
   *
   * §9.2: on `ask` the client sets `runActive = false` immediately. A spinner while a human is the
   * bottleneck is a lie, and — critically — if `runActive` stayed true the choice buttons would
   * render disabled and the user could not answer their own question. That flip is done by the
   * reducer, not here, so this stays a pure setter.
   */
  setAsk(ask: AskState | null): void {
    if (this.ask === ask) return;
    this.ask = ask;
    AgentStore.fireSet(this.askListeners);
    this.touch();
  }

  /** Patch the live ask, matched on askId so a stale card can never mutate a newer question. */
  patchAsk(askId: string, patch: Partial<AskState>): void {
    const prev = this.ask;
    if (!prev || prev.askId !== askId) return;
    let changed = false;
    for (const k in patch) {
      const key = k as keyof AskState;
      if (patch[key] === undefined) continue;
      if (prev[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.ask = { ...prev, ...patch };
    AgentStore.fireSet(this.askListeners);
    this.touch();
  }

  // ── confirm cards ─────────────────────────────────────────────────────────────────────────────

  /** Locate the transcript node holding a given actionId. O(n) but only on a decision. */
  findConfirmNodeId(actionId: string): string | undefined {
    for (const node of this.nodes.values()) {
      if (node.kind === "confirm" && node.data?.kind === "confirm" && node.data.actionId === actionId) {
        return node.id;
      }
    }
    return undefined;
  }

  private recomputePendingActions(): void {
    const next: string[] = [];
    this.nodes.forEach((node) => {
      if (node.kind === "confirm" && node.data?.kind === "confirm" && node.data.status === "proposed") {
        next.push(node.id);
      }
    });
    const prev = this.pendingActionIds;
    if (prev.length === next.length && prev.every((id, i) => id === next[i])) return; // bail
    this.pendingActionIds = next.length === 0 ? EMPTY_IDS : next;
    AgentStore.fireSet(this.actionListeners);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Rehydrate a thread. Called on SESSION OPEN ONLY — never from a `finally`, never at end of turn.
   * That is D5: tearing the live overlays down and refetching leaves one network round-trip of
   * blank transcript.
   *
   * Feeds every node through the same insert/patch path as the stream, so an already-rendered node
   * is patched in place rather than remounted.
   */
  hydrate(snapshot: AgentSnapshot): void {
    for (const node of snapshot.nodes) {
      const existing = this.nodes.get(node.id);
      if (existing) this.patchNode(node.id, node);
      else this.insertNode({ ...node, streaming: false });
    }
    if (snapshot.elements) for (const el of snapshot.elements) this.upsertElement(el);
    if (snapshot.ask !== undefined) this.setAsk(snapshot.ask);
  }

  /** Full teardown. Call when the session id changes — a new thread is a new store, conceptually. */
  reset(): void {
    this.nodes.clear();
    this.childIds.clear();
    this.elementsByFor.clear();
    this.pendingOrphans.clear();
    this.pendingTokens.clear();
    this.missingNodes.clear();
    this.rootIds = EMPTY_IDS;
    this.elements = EMPTY_ELEMENTS;
    this.pendingActionIds = EMPTY_IDS;
    this.run = IDLE_RUN;
    this.ask = null;

    // Notify everyone: their ids are gone and they must re-read.
    AgentStore.fireSet(this.listListeners);
    AgentStore.fireSet(this.runListeners);
    AgentStore.fireSet(this.askListeners);
    AgentStore.fireSet(this.actionListeners);
    this.nodeListeners.forEach((set) => AgentStore.fireSet(set));
    this.childListeners.forEach((set) => AgentStore.fireSet(set));
    this.elementListeners.forEach((set) => AgentStore.fireSet(set));
    this.touch();
  }
}

/** Convenience for pages/tests that want a store without a provider. */
export function createAgentStore(): AgentStore {
  return new AgentStore();
}
