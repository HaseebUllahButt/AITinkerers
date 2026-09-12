"use client";

// SearchOps Agent — the transcript.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §5.4 (memo boundaries), §7.7 (dead air).
//
// This component is deliberately almost empty, and that is the point. It subscribes to the ROOT ID
// LIST AND NOTHING ELSE, so a token append — which fires exactly one node's listener set — cannot
// reach it. It re-renders when a node is added or removed, i.e. a handful of times per turn, and
// never at token frequency. Anything you add here that reads node content re-introduces D1.
//
// Two structural rules that other files depend on:
//
//  1. NO per-turn wrapper div. The rows are emitted as a flat sibling list into the scroll
//     container's content wrapper, because the spacer maths in §6.5 walks `nextElementSibling`
//     from the last `[data-role="user"]` row to measure everything after it. A wrapper per turn
//     breaks that walk silently — the spacer stops shrinking and the jump-to-top lands wrong.
//
//  2. `runActive` arrives as a PROP, read high in ChatSurface via `useRunState()`. It is not
//     context and not read here: context bypasses memo, and reading the run state here would make
//     every run flip re-render the whole list.

import { memo } from "react";
import { DeadAirCursor } from "./DeadAirCursor";
import { MessageRow } from "./MessageRow";
import { useRootIds } from "./store/hooks";

export interface TranscriptProps {
  /** Read once, high up, with `useRunState().active`. Threaded down; never context. */
  runActive: boolean;
}

export const Transcript = memo(function Transcript({ runActive }: TranscriptProps) {
  const ids = useRootIds();

  return (
    <>
      {ids.map((id) => (
        <MessageRow key={id} id={id} runActive={runActive} depth={0} />
      ))}
      {/*
        Dead air lives here rather than in ChatSurface so it lands in document order after the last
        row — a cursor rendered outside the transcript flow would sit under the composer instead of
        where the answer is about to appear. It owns its own whole-store subscription, so its
        re-renders do not touch this component. Do NOT also render it from ChatSurface: two of them
        is the double-render bug §7.7 exists to prevent.
      */}
      <DeadAirCursor />
    </>
  );
});
