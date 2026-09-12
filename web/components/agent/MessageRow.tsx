"use client";

// Summit Agent — the row router.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §5.4 (memo boundaries), §7 (per-kind rendering).
//
// One memo'd component per node, subscribed to that node by id. This is the boundary that makes a
// 2000-token answer commit ONE component per token: `Transcript` holds the id list, each row holds
// its own node, and nothing in between reads content.
//
// The default memo comparator is correct here on purpose — the props are `{id, runActive, depth}`,
// three primitives — so do not hand-write one. Add an object or a closure prop to this component
// and every row re-renders on every parent render; if a row genuinely needs a callback, it comes
// from the (stable, useMemo'd) callbacks context, not from props.
//
// This file must NOT wrap its output in a div. The transcript DOM is flat (§6.5) and each kind's
// component supplies its own root element, carrying the `data-role` the scroll layer queries.

import { memo } from "react";

import { PickerCard } from "./ask/PickerCard";
import { isLivePicker } from "./store/selectors";
import { AssistantMessage } from "./AssistantMessage";
import { StepNode } from "./StepNode";
import { UserMessage } from "./UserMessage";
import { AskCard } from "./ask/AskCard";
import { ConfirmCard } from "./ask/ConfirmCard";
import { TABLE_MAX_HEIGHT_PX } from "./constants";
import { useAgentSelector, useAsk, useNode } from "./store/hooks";
import { useAgentSurface } from "./surfaceContext";
import type { AgentNode } from "./types";

export interface MessageRowProps {
  id: string;
  runActive: boolean;
  /** 0 for a root row. Only ever used to suppress the avatar and release max-width (§7.5). */
  depth: number;
}

export const MessageRow = memo(function MessageRow({ id, runActive, depth }: MessageRowProps) {
  const node = useNode(id);

  switch (node.kind) {
    case "user":
      return <UserMessage node={node} />;

    case "assistant":
      return <AssistantMessage node={node} runActive={runActive} depth={depth} />;

    case "thinking":
    case "tool":
      return <StepNode id={id} runActive={runActive} depth={depth} />;

    case "table":
      return <LegacyTable node={node} />;

    case "options":
      // The legacy adapter emits THREE events for one `options` frame: this anchor node, its
      // `node_end`, and an `ask` whose `stepId` is this node's id. So this renderer draws the
      // question only — `AskCard` owns the buttons. Drawing the choices here too double-draws them.
      return (
        <>
          <OptionsQuestion node={node} />
          <AskSlot nodeId={id} />
        </>
      );

    case "confirm":
      return <ConfirmRow node={node} runActive={runActive} />;

    case "picker":
      return <PickerRow node={node} id={id} runActive={runActive} />;

    default: {
      // Exhaustiveness guard: adding a NodeKind without a renderer must fail the build, not render
      // nothing at runtime.
      const never: never = node.kind;
      void never;
      return null;
    }
  }
});

/**
 * The pending-ask slot for non-assistant anchors.
 *
 * Gated on `ask.stepId === nodeId` — NEVER on "is this the last row". Once a tool emits anything
 * after the question, a last-row check attaches the buttons to the wrong node (§9.3).
 *
 * `AssistantMessage` deliberately re-implements this three-line gate rather than importing it:
 * there the card must land INSIDE the content column, between the prose and the action strip, and
 * importing it from here would make MessageRow ⇄ AssistantMessage a module cycle for no gain.
 */
const AskSlot = memo(function AskSlot({ nodeId }: { nodeId: string }) {
  const ask = useAsk();
  // Assembly seam: the transport and the follow ref belong to the page and the surface root, and
  // they reach the leaves through the one permitted context bag (§5.1 rule 3) rather than as props
  // on MessageRow — whose comparator must keep seeing three primitives.
  const { transport, followRef } = useAgentSurface();
  if (!ask || ask.stepId !== nodeId) return null;
  return <AskCard ask={ask} transport={transport} followRef={followRef} />;
});

/** Same seam for the confirmation card. `runActive` stays a prop; only the transport is context. */
const ConfirmRow = memo(function ConfirmRow({
  node,
  runActive,
}: {
  node: AgentNode;
  runActive: boolean;
}) {
  const { transport } = useAgentSurface();
  return <ConfirmCard node={node} transport={transport} runActive={runActive} />;
});

/**
 * The legacy `table` node.
 *
 * Kept local and deliberately dumb. This node kind exists only because today's wire format emits a
 * bare table frame; in P1 tables arrive as elements and render through `elements/TableElement.tsx`
 * (sortable headers, pagination, lazy chunk). This dies with `legacyAdapter.ts` — do not grow
 * features on it.
 */
function LegacyTable({ node }: { node: AgentNode }) {
  const data = node.data?.kind === "table" ? node.data : null;
  if (!data) return null;

  return (
    <div data-role="table" data-node-id={node.id} className="overflow-hidden rounded-lg border">
      {data.title ? <p className="px-3 pt-2.5 pb-1 text-sm font-medium">{data.title}</p> : null}
      {/*
        Capped height + its own scroller: an unbounded 400-row result pushes the composer off-screen
        and makes `scrollHeight` jump by thousands of pixels mid-stream, which the follow write then
        chases (§8.6).
      */}
      <div className="overflow-auto" style={{ maxHeight: TABLE_MAX_HEIGHT_PX }}>
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-card">
            <tr>
              {data.columns.map((col) => (
                <th key={col} className="border-b px-3 py-2 text-left font-medium whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 ? (
              // Fixed-height colSpan row, so a zero-result table has the same shape as a populated
              // one and the transcript does not reflow when one arrives empty (§8.6).
              <tr>
                <td
                  colSpan={Math.max(1, data.columns.length)}
                  className="h-24 text-center text-muted-foreground"
                >
                  No rows.
                </td>
              </tr>
            ) : (
              data.rows.map((row, r) => (
                // Row identity is positional here because the legacy frame carries no row ids and
                // the table is immutable once emitted — it never re-orders, so the index is stable.
                <tr key={r} className="border-b last:border-b-0">
                  {row.map((cell, c) => (
                    <td key={c} className="px-3 py-1.5 align-top">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The question line of a legacy `options` frame. The buttons belong to `AskCard`. */
function OptionsQuestion({ node }: { node: AgentNode }) {
  const question = node.data?.kind === "options" ? node.data.question : node.output;
  if (!question) return null;
  return (
    <p data-role="options" data-node-id={node.id} className="text-sm leading-7">
      {question}
    </p>
  );
}

/**
 * The competitor-backlink finalize card.
 *
 * Liveness is computed from the transcript rather than stored on the node, so it stays correct
 * after a reload with no extra persistence: see `isLivePicker`.
 */
function PickerRow({ node, id, runActive }: { node: AgentNode; id: string; runActive: boolean }) {
  const { sendMessage } = useAgentSurface();
  const active = useAgentSelector((s) => isLivePicker(s, id));
  const data = node.data?.kind === "picker" ? node.data : null;
  if (!data) return null;
  return (
    <PickerCard
      data={data}
      active={active}
      disabled={runActive}
      // The chosen keys go back as an ordinary user turn — the same path the old page used, and
      // the reason nothing the model writes sits between the click and the harvest.
      onSubmit={sendMessage}
    />
  );
}
