"use client";

// Summit Agent — starter chips.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §11.7.
//
// Lives under composer/ because a starter click IS a submit (§6.4 lists it as one of the exactly
// three places follow-intent is re-armed), but it RENDERS under the welcome heading, above the
// transcript. `<ChatSurface>` places it; the Composer does not own it.

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  SPRING_EASING,
  SPRING_MS,
  STARTER_INIT_DELAY_MS,
  STARTER_STAGGER_MS,
  prefersReducedMotion,
} from "../constants";
import { hasVisibleTurn } from "../store/selectors";
import { useAgentSelector } from "../store/hooks";
import type { Starter } from "../types";

export interface StartersProps {
  starters: readonly Starter[];
  /** Clicking a chip submits `starter.prompt`. The parent re-arms follow intent and sends. */
  onPick: (starter: Starter) => void;
  /** Mirrors the composer's `submitBlocked` — no session, no connection, blocking ask. */
  disabled?: boolean;
  className?: string;
}

export function Starters({ starters, onPick, disabled = false, className }: StartersProps) {
  // Gate on the recursive predicate, NOT `nodes.length === 0`. There is a window at the start of a
  // turn where only run scaffolding exists in the store — a length check is true then and the
  // welcome screen flashes back over the turn the user just submitted (§11.7).
  //
  // `useAgentSelector` walks the node map on every mutation, tokens included. That cost is bounded
  // here: the walk is over an all-but-empty store, and the component returns null (unsubscribing)
  // the instant the first user node lands.
  const started = useAgentSelector(hasVisibleTurn);

  // Hold everything at opacity-0 behind a 100ms gate. Without it the whole row visibly flashes in
  // on every mount (including the remount that a session switch causes), which is the single most
  // "unfinished" thing a chat surface can do on load.
  const [hasInitialized, setHasInitialized] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setHasInitialized(true), STARTER_INIT_DELAY_MS);
    return () => window.clearTimeout(t);
  }, []);

  if (started || starters.length === 0) return null;

  const reduced = prefersReducedMotion();

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {starters.map((starter, index) => {
        const Icon = starter.icon;
        return (
          <Button
            key={starter.id}
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onPick(starter)}
            className={cn(
              "max-w-full rounded-full text-left",
              // The press. `active:scale-…` down, then the release springs back through the >1
              // control point of SPRING_EASING — that overshoot is what makes the press read as
              // physical rather than as a colour change (§11.7).
              "transition-transform active:not-aria-[haspopup]:translate-y-0 active:scale-[0.97]",
              hasInitialized
                ? reduced
                  ? "opacity-100"
                  : "animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both"
                : "opacity-0",
            )}
            style={{
              transitionDuration: `${SPRING_MS}ms`,
              transitionTimingFunction: SPRING_EASING,
              // The stagger. Applied per index rather than via nth-child so the delay survives a
              // filtered/re-ordered list.
              animationDelay: hasInitialized && !reduced ? `${index * STARTER_STAGGER_MS}ms` : undefined,
              animationDuration: hasInitialized && !reduced ? `${SPRING_MS}ms` : undefined,
              animationTimingFunction: hasInitialized && !reduced ? SPRING_EASING : undefined,
            }}
          >
            {Icon ? <Icon aria-hidden="true" className="text-muted-foreground" /> : null}
            <span className="truncate">{starter.label}</span>
          </Button>
        );
      })}
    </div>
  );
}
