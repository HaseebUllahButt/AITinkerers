"use client";

// SearchOps Agent — a sibling group of steps.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §7.5 (nesting, depth cap), §13 ("each sibling group uses one
// accordion, not one root per step, so arrow keys work").
//
// Why this is hand-rolled rather than a shadcn `<Accordion type="multiple">`: this design system
// has no accordion primitive (src/components/ui/ ships base-ui wrappers, and none of them is an
// accordion), and a step is not an accordion item anyway — it renders its own row PLUS its hoisted
// user-facing children as siblings outside the disclosure, which no Accordion.Root will accept as
// a child shape. What the group owes the user is the accordion KEYBOARD contract, and that is what
// this provides: Up/Down/Home/End roving focus across the triggers of this group only.
//
// Each step owns its own open state (§7.5's mount-time seed + userTouched machine), so there is no
// group-level value to control. That is a feature: a controlled `value: string[]` up here would
// re-render every sibling on every toggle.

import { memo, useRef, useState, type KeyboardEvent } from "react";
import { StepNode } from "./StepNode";
import { MAX_STEP_DEPTH } from "./constants";

export interface StepListProps {
  /**
   * Must be reference-stable between renders (it comes from `useChildIds`, or from a `useMemo`'d
   * partition). An inline `.filter()` here defeats this component's memo on every parent render.
   */
  ids: readonly string[];
  runActive: boolean;
  /** The depth the steps in this group render AT — i.e. the parent's depth + 1. */
  depth: number;
}

export const StepList = memo(function StepList({ ids, runActive, depth }: StepListProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  // The depth-cap expander. Local, so revealing one deep group does not touch its siblings.
  const [revealed, setRevealed] = useState(false);

  if (ids.length === 0) return null;

  // Chainlit has no cap and a looping agent produces an unreadable 40-level staircase. Beyond the
  // cap the whole group hides behind one row until the user asks for it.
  const capped = depth >= MAX_STEP_DEPTH && !revealed;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const root = groupRef.current;
    if (!root) return;
    // `:scope >` keeps the walk inside THIS group — a nested group's triggers belong to that
    // group's own roving order, exactly as a real accordion behaves.
    const triggers = Array.from(
      root.querySelectorAll<HTMLElement>(":scope > [data-step-row] > [data-step-trigger]"),
    );
    if (triggers.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const i = active ? triggers.indexOf(active) : -1;
    if (i === -1 && e.key !== "Home" && e.key !== "End") return;

    e.preventDefault();
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? triggers.length - 1
          : // Wrap, like the WAI-ARIA accordion pattern.
            (i + (e.key === "ArrowDown" ? 1 : triggers.length - 1)) % triggers.length;
    triggers[next]?.focus();
  };

  if (capped) {
    return (
      <button
        type="button"
        onClick={() => setRevealed(true)}
        className="flex w-full items-center justify-start gap-1.5 p-0 text-left text-sm text-muted-foreground transition-none hover:text-foreground hover:no-underline"
      >
        {ids.length} more step{ids.length === 1 ? "" : "s"}
      </button>
    );
  }

  return (
    <div ref={groupRef} onKeyDown={onKeyDown} className="flex flex-col gap-3">
      {ids.map((id) => (
        <StepNode key={id} id={id} runActive={runActive} depth={depth} />
      ))}
    </div>
  );
});
