"use client";

// ONE polite live region for the whole surface, announcing TURN BOUNDARIES only.
//
// The transcript itself is `role="log" aria-live="polite" aria-relevant="additions"`, so the
// prose is already reachable. What a screen-reader user cannot otherwise tell is *when the agent
// started and stopped* — that is this region's entire job.
//
// It deliberately subscribes to run state (2 notifications per turn) and NEVER to
// `useStreamRevision()`. Announcing tokens turns a screen reader into an unusable stutter machine.

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { useRunState } from "../store/hooks";
import type { RunEndReason } from "../types";

export interface LiveRegionProps {
  /**
   * Polite one-off announcement from elsewhere on the surface (e.g. "Reconnected"). Changing this
   * string queues it; setting it back to null/"" queues nothing. Assertive announcements — an
   * arriving ask — belong to their own component, not here.
   */
  message?: string | null;
  /** Announced when a run starts. Override per mode ("Summit is writing…"). */
  startMessage?: string;
  className?: string;
}

const END_MESSAGE: Record<Exclude<RunEndReason, "continue">, string> = {
  complete: "Response complete.",
  stopped: "Response stopped.",
  error: "Response failed.",
};

export function LiveRegion({
  message,
  startMessage = "Summit is working…",
  className,
}: LiveRegionProps) {
  const run = useRunState();
  const [text, setText] = useState("");

  // Screen readers only speak a live region when its text CHANGES. Two consecutive turns both
  // ending "Response complete." would announce once. Alternating an invisible trailing nbsp makes
  // every announcement a distinct string without changing what is read aloud.
  const flip = useRef(false);
  const announce = useCallback((next: string) => {
    flip.current = !flip.current;
    setText(flip.current ? next : `${next} `);
  }, []);

  // Previous run snapshot. A ref, not state — it exists to detect edges, never to render.
  const prevActive = useRef(run.active);

  useEffect(() => {
    const was = prevActive.current;
    prevActive.current = run.active;
    if (run.active === was) return;

    if (run.active) {
      announce(startMessage);
      return;
    }
    // `continue` is a mid-turn segment boundary in the writer's continuation loop, not the end of
    // anything the user asked for. Announcing it would fire "Response complete." up to six times
    // in one turn.
    if (run.lastReason === null || run.lastReason === "continue") return;
    announce(END_MESSAGE[run.lastReason]);
  }, [announce, run.active, run.lastReason, startMessage]);

  useEffect(() => {
    if (message) announce(message);
  }, [announce, message]);

  return (
    <div
      data-slot="agent-live-region"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn("sr-only", className)}
    >
      {text}
    </div>
  );
}
