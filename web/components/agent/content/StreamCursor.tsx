"use client";

// The streaming cursor.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §7.4. A 0.875rem circle pulsing opacity 1 → 0.4 → 1 over 2s on
// cubic-bezier(0.4, 0, 0.6, 1), infinite. NOT a 500ms hard blink: next to text arriving at ~30 tok/s
// a hard blink reads as a glitch, and it is a photosensitivity concern.
//
// It is rendered INLINE, in place of the zero-width-space sentinel inside the markdown source (see
// Markdown.tsx), never as a block-level sibling after the rendered markdown. A sibling lands on its
// own line and makes the paragraph reflow every time the last word wraps; a ZWSP flows to the exact
// end of the current inline run — inside the last list item, table cell, blockquote or heading —
// inherits the line box, and moves with the text.

import { useEffect, useRef } from "react";

import { CURSOR_EASING, CURSOR_PULSE_MS, prefersReducedMotion } from "../constants";
import { cn } from "@/lib/utils";

export interface StreamCursorProps {
  className?: string;
}

/**
 * The pulsing dot. Inherits its colour from the surrounding text (`bg-current`), so it is muted
 * inside a muted step body and full contrast inside an assistant answer.
 */
export function StreamCursor({ className }: StreamCursorProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reduced motion: the dot still renders (it is the "still thinking" signal) — it just holds
    // still. Every infinite animation on this surface has to honour the preference.
    if (prefersReducedMotion()) return;
    if (typeof el.animate !== "function") return;

    // WAAPI rather than a CSS class, deliberately:
    //   - the exact spec triple (2s / cubic-bezier(0.4,0,0.6,1) / 1→0.4→1) lives next to the
    //     constants that define it, instead of drifting in a stylesheet another file owns;
    //   - Tailwind's `animate-pulse` is the same easing and period but dips to 0.5, not 0.4;
    //   - it is opacity-only, so it stays on the compositor and never invalidates layout mid-stream,
    //     which matters because the scroll-follow loop is running beside it.
    const animation = el.animate(
      [{ opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }],
      { duration: CURSOR_PULSE_MS, easing: CURSOR_EASING, iterations: Infinity },
    );
    return () => animation.cancel();
  }, []);

  return (
    <span
      ref={ref}
      // Decorative: the assistant text itself is the content, and a screen reader announcing a
      // pulsing dot on every paragraph would be noise. Turn liveness is announced once, by the
      // a11y live region.
      aria-hidden="true"
      data-agent-cursor=""
      className={cn(
        // 0.875rem circle. `align-[-0.125em]` drops it onto the text baseline the way a lowercase
        // glyph sits; the small left margin keeps it off the final character rather than colliding
        // with its right sidebearing.
        "ml-[0.2em] inline-block size-[0.875rem] shrink-0 rounded-full bg-current align-[-0.125em]",
        className,
      )}
    />
  );
}

export default StreamCursor;
