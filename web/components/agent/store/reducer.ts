// Summit Agent — the event reducer.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §5.5.
//
// One pure-ish function: `applyEvent(store, event)`. It is the ONLY place that translates the wire
// contract into store mutations. Keeping it separate from the store means the store can be unit
// tested without events and the reducer can be unit tested without React.
//
// Three rules restated here because they are the ones people undo:
//
//  1. UPSERT, never append. `node_start` for a known id patches in place. That is D6.
//  2. NEVER rebuild the tree at end of turn. `run_end` settles the open nodes and nothing else.
//     `loadTranscript()` belongs on session open, never in a `finally`. That is D5.
//  3. Out-of-band events (`usage`, `phase`, `progress`, `continuing`, `stalled`, `email`, `draft`)
//     mutate NOTHING. They are forwarded to the page via `onEvent` by the stream loop.

import type { AgentEvent, AgentEventType, AskState } from "../types";
import type { AgentStore } from "./agentStore";

/**
 * Events the surface never renders. Listed explicitly rather than derived, so adding a new event
 * type is a deliberate decision about which side of this line it falls on.
 */
export const OUT_OF_BAND: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  "usage",
  "phase",
  "progress",
  "continuing",
  "stalled",
  "email",
  "draft",
]);

export function isOutOfBand(e: AgentEvent): boolean {
  return OUT_OF_BAND.has(e.t);
}

export function applyEvent(store: AgentStore, e: AgentEvent): void {
  switch (e.t) {
    // ── run framing ───────────────────────────────────────────────────────────────────────────
    case "run_start":
      // The stream loop has usually already opened the run optimistically (so the composer flips
      // to Stop before the first byte). Re-issuing with the server's id keeps them in sync.
      if (store.getRun().runId !== e.runId || !store.getRun().active) store.beginRun(e.runId);
      return;

    case "run_end":
      store.endRun(e.reason);
      return;

    // ── nodes ─────────────────────────────────────────────────────────────────────────────────
    case "node_start":
      store.upsertNode(e);
      return;

    case "token":
      store.appendToken(e.id, e.text, e.target ?? "output");
      return;

    case "node_end":
      store.patchNode(e.id, {
        end: e.end,
        output: e.output,
        isError: e.isError,
        streaming: false,
      });
      return;

    // ── elements ──────────────────────────────────────────────────────────────────────────────
    case "element":
      store.upsertElement(e.element);
      return;

    case "element_removed":
      store.removeElement(e.id);
      return;

    // ── asks ──────────────────────────────────────────────────────────────────────────────────
    case "ask": {
      const ask: AskState = {
        askId: e.askId,
        stepId: e.stepId,
        runId: e.runId,
        askKind: e.askKind,
        prompt: e.prompt,
        choices: e.choices,
        form: e.form,
        allowText: e.allowText,
        cancel: e.cancel,
        deadline: e.deadline,
        status: "pending",
      };
      store.setAsk(ask);
      // §9.2 — the run is genuinely blocked on a human, so stop claiming it is active. A spinner
      // while a human is the bottleneck is a lie, and if this were left true the choice buttons
      // would render disabled and the user could not answer their own question: a total deadlock.
      //
      // The SSE response stays open throughout. `AskCard` must call `store.resumeRun()` just before
      // POSTing the answer, or the composer keeps showing Send while the reply streams in.
      if (store.getRun().active) store.endRun("complete");
      return;
    }

    case "ask_resolved":
      store.patchAsk(e.askId, { status: "resolved", summary: e.summary });
      return;

    case "ask_timeout":
      store.patchAsk(e.askId, { status: "timeout", summary: "No answer — timed out" });
      return;

    case "ask_cancelled":
      store.patchAsk(e.askId, { status: "cancelled", summary: "Skipped" });
      return;

    // ── confirmation cards ────────────────────────────────────────────────────────────────────
    case "confirm": {
      // Keyed on actionId so the card is a real transcript node in turn order, not an entry in a
      // separate `actions` array rendered after everything (which is why a turn-2 proposal used to
      // float below turn 7's answer).
      const id = `confirm:${e.actionId}`;
      const existing = store.getNode(id);
      // A reconnect replays the whole run. Re-asserting `status: 'proposed'` over an already
      // decided card would resurrect a dead button, so a known card is left exactly as it is.
      if (existing) return;
      const ts = new Date().toISOString();
      store.upsertNode({
        id,
        runId: e.runId,
        kind: "confirm",
        name: e.kind,
        start: ts,
        data: {
          kind: "confirm",
          actionId: e.actionId,
          actionKind: e.kind,
          summary: e.summary,
          params: e.params,
          status: "proposed",
        },
      });
      store.patchNode(id, { end: ts, streaming: false });
      return;
    }

    case "confirm_resolved": {
      const id = store.findConfirmNodeId(e.actionId);
      if (!id) return; // resolution for a card we never saw — drop, never invent the card
      const node = store.getNode(id);
      if (!node || node.data?.kind !== "confirm") return;
      store.patchNode(id, {
        data: { ...node.data, status: e.status, outcome: e.outcome, detail: e.detail },
        isError: e.status === "failed",
      });
      return;
    }

    // ── feedback echo ─────────────────────────────────────────────────────────────────────────
    case "feedback":
      // The server confirming a write. Feedback UI state is owned by FeedbackButtons (it is
      // per-run, not per-node), so there is nothing to mutate in the transcript. Forwarded via
      // onEvent like the other side-channel events.
      return;

    // ── terminal ──────────────────────────────────────────────────────────────────────────────
    case "error":
      if (e.nodeId) {
        store.patchNode(e.nodeId, { isError: true, streaming: false, end: new Date().toISOString() });
        return;
      }
      // No node to attach to: put it in the transcript rather than only in a toast, so the failure
      // is still there after the toast times out.
      store.pushErrorNode(e.message);
      return;

    case "done":
      // The stream loop owns run teardown (it must run in `finally` whether or not `done` arrived).
      // `needsContinuation` is read there too. Nothing to do here.
      return;

    // ── out of band ───────────────────────────────────────────────────────────────────────────
    case "usage":
    case "phase":
    case "progress":
    case "continuing":
    case "stalled":
    case "email":
    case "draft":
      return;

    default: {
      // Exhaustiveness guard: adding a member to AgentEvent without handling it fails the build
      // here rather than silently dropping it at runtime.
      const _never: never = e;
      void _never;
      return;
    }
  }
}
