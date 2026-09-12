"use client";

// Summit Agent — the scrolling viewport.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §6.5, §6.9, §6.10, §13.
//
// Three DOM layers, and the nesting is load-bearing:
//
//   <div relative>                 ← does NOT scroll. Anchors the jump pill.
//     <div ref=container>          ← the scroller
//       <div ref=content>…</div>   ← the flat transcript; watched by a ResizeObserver
//       <div ref=spacer/>          ← LAST child of the scroller, sized imperatively
//     </div>
//     <div absolute bottom-4>      ← the pill, outside the scroller
//   </div>
//
// The pill must live outside the scrolling element: inside it, `position:absolute` anchors to the
// CONTENT, so the pill scrolls away with the transcript (§6.10).
//
// ══ Why it is safe for this component to re-render per token ════════════════════════════════════
//
// `useStreamRevision()` fires on every store mutation, so this function body runs at token rate.
// That is fine here and nowhere else: everything it renders is either `props.children` — the same
// element references React received from the parent, so reconciliation bails on the whole subtree —
// or the memo'd pill. No transcript node re-renders because the scroller measured something.

import { useCallback, useImperativeHandle, useMemo, useRef } from "react";
import type { ReactNode, Ref, RefObject } from "react";
import { cn } from "@/lib/utils";
import { useAgentSelector, useStreamRevision } from "../store/hooks";
import type { AgentStore } from "../store/agentStore";
import { ScrollDownButton } from "./ScrollDownButton";
import { useStickToBottom } from "./useStickToBottom";

/** Module scope: `useAgentSelector` requires a stable selector, and this one returns a primitive. */
const selectRootIdCount = (store: AgentStore) => store.getRootIds().length;

export interface ScrollContainerHandle {
  /** The live follow-intent ref (§5.1). Pass it to `useAgentStream`; never render off it. */
  followRef: RefObject<boolean>;
  /** Re-arm follow intent — ask-choice and starter clicks (§6.7 site 2 of 3). */
  armFollow: () => void;
  /** Re-arm and smooth-scroll to the bottom. */
  jumpToBottom: () => void;
  /** Force a spacer recompute after something outside the scroller changed height (§11.7). */
  recomputeSpacer: () => void;
  /** Suppress the follow write while a step accordion animates (§7.8). */
  suppressFollow: (ms: number) => void;
  /** The scrolling element, for the rare consumer that needs to measure it. */
  readonly element: HTMLDivElement | null;
}

export interface ScrollContainerProps {
  children: ReactNode;
  /**
   * The follow-intent ref owned by `ChatSurface`, so the same ref reaches `useAgentStream` (which
   * re-arms it on submit). Omit and the hook keeps a private one — then submits will not re-arm.
   */
  followRef?: RefObject<boolean>;
  /** `features.followStream`. Default true. */
  followStream?: boolean;
  /** `features.jumpToTop`. Default true. */
  jumpToTop?: boolean;
  /** An ask is pending — changes the pill's label (§6.10). */
  pendingAsk?: boolean;
  /** On the outer, non-scrolling wrapper. */
  className?: string;
  /** On the content wrapper — this is where the transcript's max-width and padding belong. */
  contentClassName?: string;
  ref?: Ref<ScrollContainerHandle>;
}

export function ScrollContainer({
  children,
  followRef: externalFollowRef,
  followStream = true,
  jumpToTop = true,
  pendingAsk = false,
  className,
  contentClassName,
  ref,
}: ScrollContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);

  const revision = useStreamRevision();
  const rootIdCount = useAgentSelector(selectRootIdCount);

  const stick = useStickToBottom(containerRef, spacerRef, {
    enabled: followStream,
    jumpToTop,
    revision,
    rootIdCount,
    followRef: externalFollowRef,
    contentRef,
  });

  const { followRef, showJump, armFollow, jumpToBottom, recomputeSpacer, suppressFollow } = stick;

  const handleJumpClick = useCallback(() => {
    jumpToBottom();
    // §13: clicking the pill moves focus to the newest message, so a keyboard user lands on the
    // content they just asked to see rather than back at the top of the tab order. `preventScroll`
    // matters — focusing an off-screen node otherwise scrolls it into view and fights the smooth
    // animation we just started. The row is made programmatically focusable only; it never enters
    // the tab order.
    const content = contentRef.current;
    const last = content?.lastElementChild as HTMLElement | null;
    if (!last) {
      containerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!last.hasAttribute("tabindex")) last.setAttribute("tabindex", "-1");
    last.focus({ preventScroll: true });
  }, [jumpToBottom]);

  useImperativeHandle(
    ref,
    (): ScrollContainerHandle => ({
      followRef,
      armFollow,
      jumpToBottom,
      recomputeSpacer,
      suppressFollow,
      get element() {
        return containerRef.current;
      },
    }),
    [armFollow, followRef, jumpToBottom, recomputeSpacer, suppressFollow],
  );

  // `overflow-anchor` has no Tailwind utility and this surface owns no CSS file, so it goes inline.
  // Without it the browser runs its own scroll-anchoring heuristic on top of ours and the two fight
  // during streaming. `overscroll-contain` stops the transcript's bottom edge from chain-scrolling
  // the app shell.
  const scrollerStyle = useMemo(() => ({ overflowAnchor: "none" as const }), []);

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div
        ref={containerRef}
        // §13: without an explicit tabIndex, PageUp/PageDown/Home/End do nothing in Firefox and
        // Safari because the scroller can never take focus.
        tabIndex={0}
        aria-label="Conversation transcript"
        style={scrollerStyle}
        className="h-full overflow-y-auto overscroll-contain outline-none focus-visible:ring-1 focus-visible:ring-ring/40 focus-visible:ring-inset"
      >
        {/*
          ONE wrapper around the whole transcript, never one per turn. Every row stays a sibling of
          every other row, which is what the spacer's `nextElementSibling` walk measures (§6.5). The
          spacer is deliberately OUTSIDE this wrapper: inside it, writing the spacer's height would
          resize the observed element and re-enter the ResizeObserver.
        */}
        <div ref={contentRef} className={contentClassName}>
          {children}
        </div>
        <div ref={spacerRef} aria-hidden="true" data-agent-spacer="" style={{ height: 0 }} />
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
        <ScrollDownButton visible={showJump} pendingAsk={pendingAsk} onClick={handleJumpClick} />
      </div>
    </div>
  );
}
