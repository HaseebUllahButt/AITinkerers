"use client";

// Summit Agent — the jump pill.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §6.10, §13 (a11y).
//
// Positioning is deliberately NOT this component's job. It renders a static, self-sized pill; the
// non-scrolling `absolute` wrapper in `ScrollContainer` decides where it sits. Chainlit's file of
// the same name carries a `-top-4 -translate-y-full` contract for a different anchor and is dead
// code over there (§14) — do not copy it in.
//
// The component stays MOUNTED when hidden so the 150ms opacity+translateY fade has something to
// animate. It is made unreachable rather than removed: `pointer-events-none` for the mouse,
// `tabIndex={-1}` for the keyboard, `aria-hidden` for AT.

import { memo } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { JUMP_FADE_MS } from "../constants";

export interface ScrollDownButtonProps {
  /** Follow intent is off and the user is more than BOTTOM_EPSILON from the bottom. */
  visible: boolean;
  /** An ask is pending. The pill stops being a bare arrow and says what is waiting (§6.10). */
  pendingAsk?: boolean;
  onClick: () => void;
  className?: string;
}

function ScrollDownButtonImpl({ visible, pendingAsk = false, onClick, className }: ScrollDownButtonProps) {
  const label = pendingAsk ? "1 question waiting" : "Scroll to latest message";

  return (
    <Button
      type="button"
      variant="secondary"
      size={pendingAsk ? "sm" : "icon-sm"}
      aria-label={label}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      onClick={onClick}
      // The fade is safe only because the programmatic-scroll guard is in place; without it the
      // transition makes the pill's flicker more visible, not less.
      style={{ transitionDuration: `${JUMP_FADE_MS}ms` }}
      className={cn(
        // `--secondary` is 8–20% white; scrolling text would read straight through a floating
        // pill. `--popover` is the token Summit already uses for surfaces that sit ON TOP of
        // content, so the pill matches every menu and dialog in the app. The hover colour is
        // pinned too, or the variant's own hover swaps back to the translucent secondary.
        "rounded-full border-border/70 bg-popover/95 text-foreground shadow-[var(--glass-shadow)] backdrop-blur-md hover:bg-popover",
        "transition-[opacity,transform] motion-reduce:transition-none",
        visible
          ? "pointer-events-auto translate-y-0 opacity-100"
          : "pointer-events-none translate-y-1 opacity-0",
        pendingAsk && "gap-1.5 pr-2.5 pl-3.5",
        className,
      )}
    >
      {pendingAsk ? <span>{label}</span> : null}
      <ArrowDown aria-hidden="true" />
    </Button>
  );
}

/**
 * Memo'd: `ScrollContainer` re-renders at token frequency (it holds `useStreamRevision`), and the
 * pill's props change a handful of times per session.
 */
export const ScrollDownButton = memo(ScrollDownButtonImpl);
ScrollDownButton.displayName = "ScrollDownButton";
