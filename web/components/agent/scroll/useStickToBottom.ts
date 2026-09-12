"use client";

// SearchOps Agent — stick-to-bottom.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §6.1–§6.8. This is the fix for D2.
//
// ══ What was broken ═════════════════════════════════════════════════════════════════════════════
//
// Both old surfaces did `bottomRef.scrollIntoView({ behavior: "smooth" })` from a `useEffect` keyed
// on the whole transcript. `behavior:"smooth"` is a ~300ms browser-owned ANIMATION; at 30 tok/s you
// enqueue a new one every ~33ms against an already-stale target, so the text permanently outruns
// the viewport. The writer's variant wrapped it in `setTimeout(…, 80)`, which at token rate simply
// never fires to completion.
//
// ══ The three behaviours (§6.1) ═════════════════════════════════════════════════════════════════
//
//   user submits      → SMOOTH scroll so the newest user message sits TOP_OFFSET from the top
//   assistant streams → `el.scrollTop = el.scrollHeight`, instant, every commit, no rAF/debounce
//   user scrolls up   → follow intent off for the rest of the turn, jump pill appears
//
// ══ The four non-obvious pieces ═════════════════════════════════════════════════════════════════
//
//  1. Follow intent is a REF, never state (§5.1). As state, every scroll event during a drag
//     re-renders the transcript at 60Hz and every token re-renders whatever reads the flag.
//  2. The write happens in `useLayoutEffect` — before paint, so the token and the scroll adjustment
//     land in the same frame. `useEffect` costs one painted frame per token in which the new text
//     sits below the fold; at 30 tok/s that reads as a continuous shimmer at the bottom edge.
//  3. `programmaticRef` gates the scroll handler off for the whole duration of OUR OWN smooth
//     scrolls. A smooth scroll fires a `scroll` event at every intermediate position and
//     `atBottom()` is false at each of them — without the guard our own animation flashes the pill
//     and silently clears the user's follow intent (shipped as a real regression in Chainlit
//     PR #1975).
//  4. The spacer keeps `scrollHeight` CONSTANT while the answer grows, so nothing jitters (§6.5).
//
// ══ Codebase audit required by §6.9 ═════════════════════════════════════════════════════════════
//
// Grepped for a global smooth-scroll rule that would silently turn every imperative
// `el.scrollTop = n` here into an animation. Result: the only hit in the repo is a local
// `scroll-smooth` class on the log pane in `src/components/pipeline/PipelineProgress.tsx:348`.
// Nothing on `html`/`body`, no `scroll-behavior` in `globals.css`. This surface is clean.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  BOTTOM_EPSILON,
  SETTLE_BAIL_MS,
  SETTLE_POLL_MS,
  SPACER_GAP,
  TOP_OFFSET,
  prefersReducedMotion,
} from "../constants";

export interface UseStickToBottomOptions {
  /** `features.followStream`. False disables the automatic writes; manual scrolling still works. */
  enabled: boolean;
  /** `features.jumpToTop`. False zeroes the spacer and skips the new-turn smooth jump entirely. */
  jumpToTop: boolean;
  /**
   * The store revision counter (`useStreamRevision`). Bumped on EVERY mutation including every
   * token — this is the dependency that drives the per-commit follow write (§6.4).
   */
  revision: number;
  /** `store.getRootIds().length`. Drives the "force the spacer to zero on an empty thread" rule. */
  rootIdCount: number;
  /**
   * The follow-intent ref owned by `ChatSurface` and shared with `useAgentStream`, which re-arms it
   * on submit (§6.7). Omit and the hook keeps its own — useful in isolation/tests, but then a
   * submit will not re-arm follow.
   */
  followRef?: RefObject<boolean>;
  /**
   * The wrapper around the transcript rows. Observed with a `ResizeObserver` so growth that never
   * produces a store update — image decode, font swap, code highlight, accordion open — still pins
   * and still re-sizes the spacer (§6.8 layer 2).
   */
  contentRef?: RefObject<HTMLElement | null>;
}

export interface StickToBottomApi {
  /** The live follow-intent ref. Never render off this; it changes at scroll-event frequency. */
  followRef: RefObject<boolean>;
  /** Jump-pill visibility. Written only on an actual change, so a drag cannot fire 60 setStates/s. */
  showJump: boolean;
  /**
   * Re-arm follow intent. §6.7 permits exactly three callers: composer submit, ask-choice/starter
   * click, jump-pill click. NOT on new content, NOT on SSE reconnect, NOT on `tool_start`. A user
   * who scrolled up to re-read something must not be yanked back by the next token.
   */
  armFollow: () => void;
  /** Jump-pill click: re-arm follow and smooth-scroll to the bottom. */
  jumpToBottom: () => void;
  /** Force a spacer recompute — e.g. the composer changed height, so `clientHeight` changed (§11.7). */
  recomputeSpacer: () => void;
  /**
   * Suppress the follow write for `ms`. For the step accordion (§7.8): a height animation firing
   * into an autoscroll loop produces visible fighting.
   */
  suppressFollow: (ms: number) => void;
}

export function useStickToBottom(
  containerRef: RefObject<HTMLDivElement | null>,
  spacerRef: RefObject<HTMLDivElement | null>,
  options: UseStickToBottomOptions,
): StickToBottomApi {
  const { enabled, jumpToTop, revision, rootIdCount, followRef: externalFollowRef, contentRef } =
    options;

  const internalFollowRef = useRef(true);
  const followRef = externalFollowRef ?? internalFollowRef;

  const programmaticRef = useRef(false);
  const [showJump, setShowJump] = useState(false);

  // The scroll listener and the ResizeObserver are created ONCE and must read today's flags, not
  // the ones that existed at mount. Written during render on purpose: a `useEffect` sync would
  // leave the observer one commit stale, and the observer can fire before effects flush.
  const optsRef = useRef({ enabled, jumpToTop, rootIdCount });
  optsRef.current = { enabled, jumpToTop, rootIdCount };

  // ───────────────────────────────────────────────────────────── at-bottom test

  /**
   * The SAME epsilon at all three call sites (mount check, scroll handler, settle evaluation).
   * Different values there make the pill appear and immediately vanish.
   */
  const atBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_EPSILON;
  }, [containerRef]);

  // ───────────────────────────────────────────────────────────── programmatic guard + settle (§6.6)

  const bailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detachScrollEndRef = useRef<(() => void) | null>(null);
  /**
   * Incremented by every new programmatic scroll. A watcher captures the value it started with and
   * refuses to settle if it no longer matches — otherwise a jump-pill click landing mid-jump-to-top
   * lets the OLD watcher clear `programmaticRef` while the NEW animation is still running, and the
   * intermediate scroll events of that animation read as the user detaching.
   */
  const settleTokenRef = useRef(0);

  const clearSettleWatchers = useCallback(() => {
    if (bailTimerRef.current !== null) {
      clearTimeout(bailTimerRef.current);
      bailTimerRef.current = null;
    }
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    detachScrollEndRef.current?.();
    detachScrollEndRef.current = null;
  }, []);

  const settle = useCallback(() => {
    clearSettleWatchers();
    programmaticRef.current = false;
    setShowJump(!atBottom());
  }, [atBottom, clearSettleWatchers]);

  /**
   * Named function expression so the Safari branch can re-arm itself without a self-referencing
   * `useCallback` (which would have to go through a ref and lose its stable identity).
   */
  const waitForScrollEnd = useCallback(
    function wait() {
      const el = containerRef.current;
      if (!el) {
        programmaticRef.current = false;
        return;
      }

      const token = settleTokenRef.current;
      const finish = () => {
        if (token !== settleTokenRef.current) return; // superseded by a newer programmatic scroll
        settle();
      };

      // The hard bail is NON-OPTIONAL. If a smooth scroll is interrupted — user grabs the
      // scrollbar, tab backgrounded, container unmounts — the settle callback may never fire and
      // the scroll handler stays dead for the rest of the session: the user can never detach.
      bailTimerRef.current = setTimeout(finish, SETTLE_BAIL_MS);

      if ("onscrollend" in window) {
        const onEnd = () => {
          detachScrollEndRef.current = null;
          finish();
        };
        el.addEventListener("scrollend", onEnd, { once: true });
        detachScrollEndRef.current = () => el.removeEventListener("scrollend", onEnd);
      } else {
        // Safari has no `scrollend`. Two equal samples 100ms apart. Never a fixed
        // `setTimeout(500)`: smooth-scroll duration is browser-controlled and distance-dependent,
        // so a fixed timer either clears mid-animation or leaves the guard stuck.
        const prev = el.scrollTop;
        pollTimerRef.current = setTimeout(() => {
          pollTimerRef.current = null;
          if (token !== settleTokenRef.current) return;
          const now = containerRef.current;
          if (!now) {
            settle();
            return;
          }
          if (now.scrollTop === prev) {
            finish();
          } else {
            if (bailTimerRef.current !== null) {
              clearTimeout(bailTimerRef.current);
              bailTimerRef.current = null;
            }
            wait();
          }
        }, SETTLE_POLL_MS);
      }
    },
    [containerRef, settle],
  );

  const smoothScrollTo = useCallback(
    (top: number) => {
      const el = containerRef.current;
      if (!el) return;
      clearSettleWatchers();
      settleTokenRef.current += 1;
      programmaticRef.current = true;
      // Functional form so this is a genuine no-op (no re-render) when the pill is already hidden —
      // this can run from inside the ResizeObserver, where a stray render risks the
      // observe→render→resize→observe loop.
      setShowJump((prev) => (prev ? false : prev));
      el.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      waitForScrollEnd();
    },
    [clearSettleWatchers, containerRef, waitForScrollEnd],
  );

  // ───────────────────────────────────────────────────────────── the follow write (§6.4)

  const suppressUntilRef = useRef(0);

  const followToBottom = useCallback(() => {
    if (programmaticRef.current) return; // our own animation owns the scroll position right now
    if (!followRef.current || !optsRef.current.enabled) return;
    if (typeof performance !== "undefined" && performance.now() < suppressUntilRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    // Bare assignment. No rAF, no debounce, no throttle, no `behavior:'smooth'` — see the header.
    el.scrollTop = el.scrollHeight;
  }, [containerRef, followRef]);

  const suppressFollow = useCallback((ms: number) => {
    if (typeof performance === "undefined") return;
    suppressUntilRef.current = Math.max(suppressUntilRef.current, performance.now() + ms);
  }, []);

  // ───────────────────────────────────────────────────────────── the spacer (§6.5)

  /**
   * The anchor we have already jumped to. The spec's snippet fires `smoothScrollTo` whenever
   * `after === 0`, but `recomputeSpacer` also runs from the ResizeObserver — so between the submit
   * and the first assistant node the same jump would be re-enqueued several times, each one
   * restarting the settle watcher. One jump per anchor; a new user message is a new anchor.
   */
  const jumpedAnchorRef = useRef<Element | null>(null);

  /**
   * Memoised anchor lookup, keyed on the root-node count.
   *
   * `recomputeSpacer` runs on EVERY commit, i.e. every token. A bare
   * `querySelectorAll('[data-role="user"]')` there is an O(nodes) tree walk 30× a second on a
   * transcript that can be hundreds of rows deep. The last user row cannot change while the root
   * count is unchanged — rows are appended, never removed mid-stream — so one lookup per new node
   * is exact, not an approximation. `isConnected` covers the hydrate/reset case where the whole
   * subtree is swapped without the count changing.
   */
  const anchorCacheRef = useRef<{ count: number; el: HTMLElement | null }>({ count: -1, el: null });

  const findAnchor = useCallback(
    (el: HTMLDivElement, count: number): HTMLElement | null => {
      const cached = anchorCacheRef.current;
      if (cached.count === count && cached.el?.isConnected) return cached.el;
      const anchors = el.querySelectorAll<HTMLElement>('[data-role="user"]');
      const found = anchors.length > 0 ? anchors[anchors.length - 1] : null;
      anchorCacheRef.current = { count, el: found };
      return found;
    },
    [],
  );

  const recomputeSpacer = useCallback(() => {
    const el = containerRef.current;
    const sp = spacerRef.current;
    if (!el || !sp) return;

    const { jumpToTop: wantJump, rootIdCount: count } = optsRef.current;

    // Zero on empty. Non-optional — a spacer on an empty thread pushes the heading and the starter
    // chips off the top of the viewport. Also zero when jump-to-top is off: the spacer exists only
    // to make "newest user message at the top" and "scrolled to the bottom" the same position.
    if (count === 0 || !wantJump) {
      sp.style.height = "0px";
      jumpedAnchorRef.current = null;
      followToBottom();
      return;
    }

    // Found by DOM query, not by ref, precisely so `MessageRow` can stay memo'd and never re-render
    // just because the scroller wants to measure it (§6.5).
    const anchor = findAnchor(el, count);
    if (!anchor) {
      sp.style.height = "0px";
      jumpedAnchorRef.current = null;
      followToBottom();
      return;
    }

    // The transcript DOM is FLAT: every row is a sibling. A per-turn wrapper would make this walk
    // measure nothing, `after` would stay 0, the spacer would never shrink and the smooth
    // jump-to-top would re-fire forever. If per-turn styling is ever needed, switch to
    // getBoundingClientRect() deltas — do not add a wrapper.
    let after = 0;
    for (let n = anchor.nextElementSibling; n && n !== sp; n = n.nextElementSibling) {
      after += (n as HTMLElement).offsetHeight;
    }

    // As the answer grows, the spacer shrinks 1:1 — total scrollHeight stays constant and nothing
    // jitters. Only once the answer exceeds a viewport does this clamp at 0 and ordinary
    // bottom-following take over.
    sp.style.height = `${Math.max(0, el.clientHeight - anchor.offsetHeight - after - SPACER_GAP)}px`;

    if (after === 0) {
      // Turn just started: put the user's message TOP_OFFSET from the top.
      if (jumpedAnchorRef.current !== anchor) {
        jumpedAnchorRef.current = anchor;
        // The spec writes `anchor.offsetTop - TOP_OFFSET`. Same number, but measured against the
        // container instead of `offsetParent`: `offsetTop` silently switches origin the moment any
        // ancestor row picks up `position: relative` (badges, hover affordances, code-block
        // headers all want it), and the jump then lands in the wrong place with no clue why.
        const top =
          el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - TOP_OFFSET;
        smoothScrollTo(top);
      }
    } else {
      // Streaming: this is §6.8's explicit `el.scrollTop = el.scrollHeight`, folded into the one
      // branch where it cannot fight the jump-to-top animation.
      followToBottom();
    }
  }, [containerRef, findAnchor, followToBottom, smoothScrollTo, spacerRef]);

  // ───────────────────────────────────────────────────────────── the scroll listener (§6.3)

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => {
      if (programmaticRef.current) return; // our own animation is not user intent
      const b = atBottom();
      // Scrolling back to the bottom by hand IS user intent, so it re-attaches. This is the same
      // gesture as the jump pill, not a content-driven re-arm.
      followRef.current = b;
      setShowJump((prev) => (prev === !b ? prev : !b)); // only re-render on an actual change
    };

    // Attached natively with `{ passive: true }` — NOT the React `onScroll` prop, which routes
    // every frame of a drag through React's synthetic event system.
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [atBottom, containerRef, followRef]);

  // ───────────────────────────────────────────────────────────── the per-commit write (§6.4)

  useLayoutEffect(() => {
    // `recomputeSpacer` owns the write: it sizes the spacer first (so scrollHeight is final) and
    // then either jumps to the top of a brand-new turn or pins to the bottom.
    recomputeSpacer();
  }, [recomputeSpacer, revision, rootIdCount, enabled, jumpToTop]);

  // ───────────────────────────────────────────────────────────── growth that never hits the store (§6.8)

  useEffect(() => {
    const el = containerRef.current;
    const content = contentRef?.current ?? null;
    if (!el || typeof ResizeObserver === "undefined") return;

    // NEVER call setState from in here: observe→render→resize→observe, and Chrome reports
    // "ResizeObserver loop completed with undelivered notifications". `recomputeSpacer` is
    // imperative; the one setState it can reach is the no-op-guarded `setShowJump(false)`.
    const ro = new ResizeObserver(() => {
      recomputeSpacer();
    });

    // The content wrapper catches image decode, font swap, code highlight, table reflow and
    // accordion open. The container itself catches `clientHeight` changes — the composer growing
    // to ten lines, a banner appearing — which the content wrapper cannot see.
    if (content) ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef, contentRef, recomputeSpacer]);

  // ───────────────────────────────────────────────────────────── initial at-bottom evaluation (§13)

  /** Latches once the initial evaluation has actually completed, so it runs exactly one time. */
  const initialDoneRef = useRef(false);
  const initialRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (initialDoneRef.current || rootIdCount === 0) return;
    if (!containerRef.current) return;

    // Not a bare `setTimeout(500)`: at first paint the markdown, images and code blocks of a
    // rehydrated thread are still settling, so a single measurement lands on a height that is
    // about to change. Wait for `scrollHeight` to repeat across two frames instead.
    const start = typeof performance !== "undefined" ? performance.now() : 0;
    let last = -1;

    const step = () => {
      initialRafRef.current = null;
      const node = containerRef.current;
      if (!node) return;
      const h = node.scrollHeight;
      const elapsed = (typeof performance !== "undefined" ? performance.now() : 0) - start;
      if (h !== last && elapsed < SETTLE_BAIL_MS) {
        last = h;
        initialRafRef.current = requestAnimationFrame(step);
        return;
      }
      initialDoneRef.current = true;

      // A programmatic scroll in flight means this is not a thread being opened — it is the very
      // first submit, and `recomputeSpacer` has already started the jump-to-top. Writing
      // `scrollTop = scrollHeight` here would kill that animation mid-flight; `settle()` will do
      // the `showJump` evaluation when it lands.
      if (programmaticRef.current) return;

      // Open a thread pinned to its newest message, exactly where the user left it.
      if (followRef.current) node.scrollTop = node.scrollHeight;
      recomputeSpacer();
      setShowJump(!atBottom());
    };

    initialRafRef.current = requestAnimationFrame(step);

    return () => {
      if (initialRafRef.current !== null) {
        cancelAnimationFrame(initialRafRef.current);
        initialRafRef.current = null;
      }
    };
  }, [atBottom, containerRef, followRef, recomputeSpacer, rootIdCount]);

  // ───────────────────────────────────────────────────────────── teardown

  useEffect(
    () => () => {
      clearSettleWatchers();
      if (initialRafRef.current !== null) cancelAnimationFrame(initialRafRef.current);
    },
    [clearSettleWatchers],
  );

  // ───────────────────────────────────────────────────────────── imperative API

  const armFollow = useCallback(() => {
    followRef.current = true;
    setShowJump((prev) => (prev ? false : prev));
  }, [followRef]);

  const jumpToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    followRef.current = true; // §6.7 site 3 of 3
    smoothScrollTo(el.scrollHeight);
  }, [containerRef, followRef, smoothScrollTo]);

  return { followRef, showJump, armFollow, jumpToBottom, recomputeSpacer, suppressFollow };
}
