"use client";

// Summit Agent — the composer's textarea.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §11.2 (autosize), §11.3 (Enter/IME), §11.6 (focus).
//
// ══ The one rule (§11.1) ════════════════════════════════════════════════════════════════════════
//
// This component does not accept `disabled` and never sets it. Disabling a textarea rips focus out,
// collapses the caret, greys the placeholder, breaks an in-flight IME composition and throws away a
// half-typed draft — and then the user has to re-acquire focus by hand when the stream ends. The
// composer blocks *submission* with an early return instead (see Composer.tsx). If you are here to
// add a `disabled` prop because "the agent is running", read §11.1 first: D7 is exactly that bug.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type Ref } from "react";

import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";

import { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT } from "../constants";

export interface AutoResizeTextareaProps
  extends Omit<ComponentProps<"textarea">, "value" | "disabled" | "rows" | "style" | "onSubmit"> {
  /**
   * The CONTROLLED draft text. Required: the autosize effect is keyed on this, not on an input
   * event, so programmatic writes (starter chips, `?prompt=`, ask replies) resize too.
   */
  value: string;
  /** Fires on Enter without Shift, once the IME guard has cleared. */
  onSubmit: () => void;
  /**
   * Focus on mount and again whenever this flips true. Pass `!isMobile` (§11.6) — autofocusing on a
   * phone pops the software keyboard on load, collapses the viewport to a third of its height and
   * scrolls the transcript out of view.
   *
   * Deliberately NOT forwarded to the DOM: React's own `autoFocus` attribute would focus a second
   * time on mount and can scroll the element into view mid-hydration.
   */
  autoFocus?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function AutoResizeTextarea({
  value,
  onSubmit,
  autoFocus = false,
  className,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  ref,
  ...props
}: AutoResizeTextareaProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  // `isComposing` is state, not a ref: nothing renders off it, but React batches the
  // compositionend → keydown ordering more predictably through the state queue than through a ref
  // written in the same tick. The `nativeEvent.isComposing` check below is the real guard; this is
  // the belt to its braces.
  const [isComposing, setIsComposing] = useState(false);

  // Merge the caller's ref with ours. We need the node locally to measure and to focus, and the
  // Composer needs it to restore focus after a send.
  //
  // Legacy (null-on-unmount) form rather than React 19's cleanup-returning form: returning a
  // cleanup would stop React from calling a caller-supplied callback ref with `null`, which is the
  // detach signal most callers still expect. Returning nothing keeps both halves correct.
  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  // ── autosize (§11.2) ──────────────────────────────────────────────────────────────────────────
  //
  // Reset to the MINIMUM before measuring. `scrollHeight` of an already-tall textarea reports the
  // tall height, so without the reset the box can only ever grow and deleting lines never shrinks
  // it. Two writes in one effect body: the browser does not paint between them, so there is no
  // visible collapse-then-grow flicker.
  // A ZERO-WIDTH MEASUREMENT IS THE BUG THIS GUARD EXISTS FOR. On mount the effect can run before
  // the flex parent has resolved a width. At width 0 every character wraps to its own line, so a
  // 33-character placeholder reported scrollHeight 648px — the box locked to COMPOSER_MAX_HEIGHT
  // (250px) and stayed there, because the effect only re-ran on `value` and the value never
  // changed. Measured in the browser: an empty composer rendering as a ~380px void.
  //
  // Two fixes, both required: bail while unmeasurable, and re-measure when the width arrives
  // (a ResizeObserver, since no state change would otherwise retrigger this).
  const resize = useCallback(() => {
    const el = innerRef.current;
    if (!el || el.clientWidth === 0) return;
    // Reset to the MINIMUM before measuring. `scrollHeight` of an already-tall textarea reports the
    // tall height, so without the reset the box can only ever grow and deleting lines never shrinks
    // it. Two writes in one effect body: the browser does not paint between them, so there is no
    // visible collapse-then-grow flicker.
    el.style.height = `${COMPOSER_MIN_HEIGHT}px`;
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, []);

  // useLayoutEffect, not useEffect: the height is written before paint, so a multi-line draft never
  // shows a one-line box for a frame first.
  useLayoutEffect(() => {
    resize();
  }, [resize, value]);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Fires once when the real width lands (rescuing the zero-width mount above) and again whenever
    // the pane is resized, which changes how the same text wraps.
    const ro = new ResizeObserver(() => resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [resize]);

  // ── focus (§11.6) ─────────────────────────────────────────────────────────────────────────────
  //
  // Keyed on `[autoFocus]`, NOT `[]`. A tablet rotating across the breakpoint (or a first client
  // render that corrects an SSR "assume mobile" guess) picks up focus at the moment it becomes
  // appropriate, instead of never.
  useEffect(() => {
    if (!autoFocus) return;
    innerRef.current?.focus();
  }, [autoFocus]);

  return (
    <Textarea
      {...props}
      ref={setRefs}
      value={value}
      rows={1}
      // Bounds the browser's own scroll container during the frame before the autosize effect runs
      // — without it a pasted essay renders full-height for one frame and shoves the page.
      style={{ minHeight: COMPOSER_MIN_HEIGHT, maxHeight: COMPOSER_MAX_HEIGHT }}
      onCompositionStart={(e) => {
        setIsComposing(true);
        onCompositionStart?.(e);
      }}
      onCompositionEnd={(e) => {
        setIsComposing(false);
        onCompositionEnd?.(e);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.key !== "Enter" || e.shiftKey) return;
        // Both composition signals (§11.3). `nativeEvent.isComposing` is the standardised one and
        // covers Safari's keyCode-229 case where the composition events themselves can race the
        // keydown; the state flag covers engines that fire keydown before compositionstart. Miss
        // either and every Japanese/Chinese/Korean candidate commit sends a half-finished message.
        if (isComposing || e.nativeEvent.isComposing) return;
        // A nested handler (slash-command menu, mention popup) already claimed this Enter. A
        // boolean return or `stopPropagation` from a React synthetic handler does NOT work when
        // both handlers sit on the same element — `defaultPrevented` is the only hand-off.
        if (e.defaultPrevented) return;
        e.preventDefault();
        onSubmit();
      }}
      className={cn(
        // Strip the shadcn chrome: the CARD owns the border, the ring and the padding, or the
        // composer draws two nested outlines on focus (§11.2).
        // `bg-transparent!` is important-flagged deliberately. globals.css styles the bare element
        // selector `textarea` (and `.dark textarea`) with a fill, and an element selector inside a
        // class selector outranks a plain utility — so `bg-transparent` silently lost and the
        // composer rendered a filled box nested inside the card's own box. Specificity, not order.
        // `rounded-none!` is the fix for the clipped caret, and it is not cosmetic. The base
        // Textarea carries `rounded-lg` (16px in this theme) AND this element is `overflow-y-auto`
        // for the scroll-past-max case — and a scrollable box CLIPS ITS CONTENT to its border
        // radius. The caret sits at the very top-left of that content box, i.e. exactly inside the
        // corner curve, so it was being sliced by the field's own rounding. Padding on the card
        // could never fix it: the radius travels with the textarea, not with the card.
        // The card owns the shape; the field must have none.
        "field-sizing-fixed min-h-0 resize-none rounded-none! border-none bg-transparent! p-0 shadow-none backdrop-blur-none",
        "overflow-y-auto focus-visible:border-transparent focus-visible:ring-0",
        "dark:bg-transparent dark:disabled:bg-transparent",
        className,
      )}
    />
  );
}
