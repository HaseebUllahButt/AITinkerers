"use client";

// Summit Agent — the step duration.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §7.6.
//
// Chainlit ships `start`/`end` on every step and renders neither, so there is no prior art to copy
// here — only the server-authoritative timestamp contract. Three properties make this cheap enough
// to run on a 20-step tree:
//
//  1. ONE shared 100ms ticker (content/ticker.ts), not one interval per step.
//  2. The tick path writes `textContent` directly. No setState, no render, no reconciliation.
//  3. The ticker unsubscribes when nothing is running, so an idle tab has no timers.
//
// Per-step `setInterval` + `setState` on a 20-step tree is 200 renders/sec and erases every
// memoization win in this directory.

import { useEffect, useMemo, useRef } from "react";
import { subscribeToTicker } from "./content/ticker";
import { DURATION_GRACE_MS } from "./constants";
import type { AgentNode } from "./types";
import { cn } from "@/lib/utils";

export interface StepDurationProps {
  node: AgentNode;
  /** The shared three-way AND from `selectors.isNodeRunning` — passed in, never recomputed here. */
  running: boolean;
}

export function StepDuration({ node, running }: StepDurationProps) {
  const ref = useRef<HTMLSpanElement>(null);

  const startMs = useMemo(() => (node.start ? Date.parse(node.start) : undefined), [node.start]);
  const endMs = useMemo(() => (node.end ? Date.parse(node.end) : undefined), [node.end]);

  useEffect(() => {
    if (!running || startMs === undefined) return;
    const paint = () => {
      const el = ref.current;
      if (!el) return;
      // Math.max because clock skew between server `start` and the client clock produces negatives
      // on sub-second tools, and "-42ms" is the kind of detail that makes a whole surface look
      // unfinished.
      const ms = Math.max(0, Date.now() - startMs);
      // Below the grace window, show nothing at all: fast tools otherwise flash "0.1s" and the row
      // twitches. The shimmer alone carries liveness.
      el.textContent = ms < DURATION_GRACE_MS ? "" : fmt(ms);
    };
    paint(); // paint once immediately so a rehydrated running step is not blank for up to 100ms
    return subscribeToTicker(paint);
  }, [running, startMs]);

  // Settled value comes from the server's `start`/`end`, not from when the ticker stopped, so a
  // rehydrated thread shows real durations rather than zeroes.
  //
  // When a run is aborted there is no `end`, so this stays "" and React — which only patches text
  // it sees change — leaves the last ticked value in the DOM. That is deliberate: the elapsed time
  // at the moment of the abort is the honest number, and blanking it would look like a reset.
  const settled =
    !running && startMs != null && endMs != null ? fmt(Math.max(0, endMs - startMs)) : "";

  return (
    <span
      ref={ref}
      // While ticking, the text is mutated outside React and changes 10×/s — announcing that is
      // pure noise. Only the settled value is exposed.
      aria-hidden={running}
      className={cn(
        // `ml-auto` here, NOT `justify-between` on the trigger: with `justify-between` the chevron
        // drifts to the far edge on short tool names and stops reading as part of the label.
        // `tabular-nums` is mandatory — proportional digits make a ticking counter jitter
        // horizontally, which is the single most visible cheapness tell in a step list.
        "ml-auto pl-3 text-xs font-normal tabular-nums",
        // An errored step keeps its duration; it is diagnostic.
        node.isError ? "text-destructive/60" : "text-muted-foreground/70",
      )}
    >
      {settled}
    </span>
  );
}

/**
 * Duration formatter. Precision drops as the magnitude rises, so the string width stays roughly
 * constant and the row does not resize as a tool runs from 900ms to 90s.
 */
const fmt = (ms: number) =>
  ms < 1000
    ? `${Math.round(ms)}ms`
    : ms < 10000
      ? `${(ms / 1000).toFixed(1)}s`
      : ms < 60000
        ? `${Math.round(ms / 1000)}s`
        : `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`;
