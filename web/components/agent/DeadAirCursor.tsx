"use client";

// Summit Agent — dead air.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §7.7.
//
// The gap between "request sent" and "first token" is where a chat UI feels broken. This fills it
// with a bare cursor — nothing else. No "Working…", no spinner: the whole design bet of §7.5 is
// that liveness is carried by text, and a spinner here would contradict every step row below it.
//
// Both predicates in `showDeadAir` recurse the tree and both are required. A cursor shown ALONGSIDE
// a running tool, or lingering after the first assistant token, reads as a double-render bug. With
// summarized thinking rendered as a real step, this state should be rare — which is the point.

import { memo } from "react";
import { StreamCursor } from "./content/StreamCursor";
import { useAgentSelector } from "./store/hooks";
import { showDeadAir } from "./store/selectors";

export const DeadAirCursor = memo(function DeadAirCursor() {
  // `showDeadAir` is a module-scope function, so the selector reference is stable and the
  // subscription is never torn down. It returns a boolean, so React bails out of the re-render on
  // every token that does not flip it: whole-tree walk per token, zero renders.
  const show = useAgentSelector(showDeadAir);
  if (!show) return null;

  return (
    <div data-role="dead-air" className="flex gap-4">
      {/*
        A spacer with the avatar's exact geometry. The cursor has to appear in the text column, at
        the precise x the first token will occupy — otherwise the character visibly jumps sideways
        the instant the real assistant row mounts, which is the one frame this component exists to
        make feel calm.
      */}
      <span aria-hidden className="mt-[3px] size-5 shrink-0" />
      <StreamCursor />
    </div>
  );
});
