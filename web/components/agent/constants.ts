// Summit Agent — the tuned constants.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §6.2, §7.4, §7.6, §7.8, §8.3, §9.2, §9.7, §10.2, §11.2, §11.7.
//
// Every number here was chosen against a specific failure mode and the reason is written next to
// it. If you are about to "clean this up" by rounding one of these, read the comment first — most
// of them are the difference between the surface feeling authored and feeling janky.
//
// Pure module: no DOM access at import time (the one function that touches `window` guards it), so
// this is safe to import anywhere.

import type { AgentElement, AgentFeatureFlags, AgentMode, NodeKind } from "./types";

// ─────────────────────────────────────────────────────────────── scroll (§6.2)

/**
 * px. How close to the bottom still counts as "at the bottom".
 *
 * Chainlit uses 10 — too tight; one trackpad flick detaches follow and the user has to chase the
 * stream. This MUST be the same constant at all three call sites (mount check, scroll handler,
 * settle evaluation); different values make the jump pill appear and immediately vanish.
 */
export const BOTTOM_EPSILON = 40;

/** px of breathing room under the last user message when the spacer is sized. */
export const SPACER_GAP = 32;

/** px from the viewport top that the newest user message lands on after a jump-to-top. */
export const TOP_OFFSET = 20;

/** ms between polls of the Safari settle fallback (no `scrollend` event there). */
export const SETTLE_POLL_MS = 100;

/**
 * ms. Hard bail on the programmatic-scroll guard.
 *
 * Non-optional: if a smooth scroll is interrupted (user grabs the scrollbar, tab backgrounded,
 * container unmounts) the settle callback may never fire, and the scroll handler stays dead for the
 * rest of the session — the user can never detach follow again.
 */
export const SETTLE_BAIL_MS = 1500;

/** ms. Opacity+translateY fade on the jump pill. */
export const JUMP_FADE_MS = 150;

// ─────────────────────────────────────────────────────────────── cursor & shimmer (§7.4, §7.5)

/**
 * Zero-width space. Appended to a streaming node's markdown source so the parser can emit a
 * `cursor` inline token exactly at the end of the current inline run.
 *
 * NEVER render the cursor as a sibling block after the markdown — a sibling lands on its own line
 * and reflows the paragraph every time the last word wraps.
 */
// Written as an escape on purpose: a literal U+200B is invisible in every editor and gets stripped
// by well-meaning "trim whitespace" tooling.
export const CURSOR = "\u200B";

/** ms. Cursor pulse period. Not a 500ms hard blink — that reads as a glitch and is a photosensitivity concern. */
export const CURSOR_PULSE_MS = 2000;
export const CURSOR_EASING = "cubic-bezier(0.4, 0, 0.6, 1)";

/** ms. Deliberately slower than the cursor's 2s so the two animations don't beat against each other. */
export const SHIMMER_MS = 4000;

// ─────────────────────────────────────────────────────────────── step duration (§7.6)

/**
 * ms. Below this, a running step shows no duration at all.
 *
 * Fast tools otherwise flash "0.1s" and the row twitches. The shimmer alone carries liveness.
 */
export const DURATION_GRACE_MS = 2000;

/**
 * ms. The period of the ONE global ticker shared by every StepDuration.
 *
 * Per-step setInterval + setState on a 20-step tree is 200 renders/sec and erases every
 * memoization win. The ticker unsubscribes when no step is running, so an idle tab has no timers.
 */
export const TICKER_INTERVAL_MS = 100;

// ─────────────────────────────────────────────────────────────── steps (§7.5, §7.8)

/** Beyond this depth, children collapse behind a single "N more steps" row. */
export const MAX_STEP_DEPTH = 3;

/**
 * Children of these kinds are HOISTED out of a step's accordion body to depth 0; everything else
 * nests inside it. The two predicates must be EXACTLY complementary — any overlap renders a step
 * twice (D6's cousin), any gap loses a node.
 */
export const USER_FACING_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "assistant",
  "table",
  "options",
  "confirm",
]);

/** ms. Accordion open/close. The ceiling before a disclosure feels sluggish across six steps. */
export const ACCORDION_MS = 200;

// ─────────────────────────────────────────────────────────────── elements (§8.2, §8.3, §8.6)

/** Absolute max-width in px for the SINGLE-image fast path (no grid). */
export const ELEMENT_SIZE_PX: Readonly<Record<NonNullable<AgentElement["size"]>, number>> = {
  small: 150,
  medium: 300,
  large: 600,
};

/** Column/row span in the multi-image grid. Cells stay square so a mixed batch mosaics cleanly. */
export const ELEMENT_SIZE_UNITS: Readonly<Record<NonNullable<AgentElement["size"]>, number>> = {
  small: 1,
  medium: 2,
  large: 4,
};

/** Span used when an element carries no `size`. */
export const ELEMENT_DEFAULT_UNITS = 2;

export const ELEMENT_GRID_COLS = 4;
export const ELEMENT_GRID_MAX_PX = 600;

/** ms. Opacity fade when an image finishes decoding. Instant pop-in from a placeholder reads as a glitch. */
export const IMAGE_FADE_MS = 200;

/**
 * Fixed bucket order. Arrival order over a stream is nondeterministic; without bucketing, two
 * images separated by a text element render as three separate grids and the layout reflows on
 * every arrival.
 */
export const ELEMENT_TYPE_ORDER: readonly AgentElement["type"][] = ["image", "table", "text", "file"];

/** px. Caps a table so a large result cannot push the composer off-screen. */
export const TABLE_MAX_HEIGHT_PX = 450;

/** px. The file card. */
export const FILE_CARD_HEIGHT_PX = 58;

/**
 * Inline element reference marker the agent emits in prose: `[[element:abc123]]`.
 * Deliberately NOT Chainlit's element-*name* substitution (§14) — names are not unique and a name
 * that happens to appear in prose gets silently rewritten into a chip.
 */
export const ELEMENT_REF_RE = /\[\[element:([A-Za-z0-9_-]+)\]\]/g;

// ─────────────────────────────────────────────────────────────── asks (§9.2, §9.7)

/**
 * ms. Default ask deadline synthesised by the legacy adapter. Server-owned once P1.2 lands.
 * Chainlit's 90s is demo-tuned and too short for real SEO work.
 */
export const ASK_DEADLINE_MS = 300_000;

/** ms. Render a countdown ONLY inside this window. Above it, a visible countdown is pure noise. */
export const ASK_COUNTDOWN_MS = 60_000;

/** ms. Countdown repaint period — 1Hz, computed from the absolute deadline so a tab suspend can't drift it. */
export const ASK_COUNTDOWN_TICK_MS = 1000;

// ─────────────────────────────────────────────────────────────── actions (§10)

/** ms. How long the copy button stays in its confirmed state. Restart on rapid re-click. */
export const COPY_RESET_MS = 2000;

/** ms. Tooltip delay. The shadcn/Radix default of 700ms means the tooltip never appears on a dense icon row. */
export const TOOLTIP_DELAY_MS = 100;

// ─────────────────────────────────────────────────────────────── composer (§11)

/** px. The reset height written BEFORE measuring scrollHeight, so the textarea can shrink. */
export const COMPOSER_MIN_HEIGHT = 40;

/** px (~10 lines). Also applied as an inline maxHeight so the frame before the effect runs is bounded. */
export const COMPOSER_MAX_HEIGHT = 250;

/** px. Send and Stop share one fixed round slot — identical geometry, zero layout shift. */
export const SUBMIT_SLOT_PX = 32;

/** ms. Gate before starter chips reveal, so the row doesn't visibly flash in on every mount. */
export const STARTER_INIT_DELAY_MS = 100;

/** ms. Per-index reveal stagger for starter chips. */
export const STARTER_STAGGER_MS = 50;

/**
 * The surface's one motion personality. The >1 control point is what makes a press feel physical.
 * Reuse this easing for every composer animation.
 */
export const SPRING_EASING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
export const SPRING_MS = 300;

// ─────────────────────────────────────────────────────────────── continuation (§5.6)

/**
 * Cap on machine-driven continuation segments per submit. Mirrors MAX_SEGMENTS in
 * src/app/api/blog/writer/[id]/turn/route.ts — the server already bounds itself, this is the
 * client's backstop against a server that keeps saying `needs_continuation`.
 */
export const MAX_CONTINUATIONS = 6;

// ─────────────────────────────────────────────────────────────── stable empties (§5.3)

// `getSnapshot` must return a referentially stable value. Returning a fresh literal (`[]`) makes
// React 19 loop with "The result of getSnapshot should be cached on the store". These are the
// module-level singletons every empty case must return.

export const EMPTY_IDS: readonly string[] = Object.freeze([]);
export const EMPTY_ELEMENTS: readonly AgentElement[] = Object.freeze([]);

// ─────────────────────────────────────────────────────────────── feature flags (§2.3)

export const BASE_FEATURES: AgentFeatureFlags = Object.freeze({
  jumpToTop: true,
  followStream: true,
  feedback: true,
  copy: true,
  elements: true,
  usageFooter: true,
});

const HERMES_FEATURES: AgentFeatureFlags = Object.freeze({ ...BASE_FEATURES, usageFooter: true });
const WRITER_FEATURES: AgentFeatureFlags = Object.freeze({ ...BASE_FEATURES, usageFooter: false });

/** The per-mode defaults. Frozen singletons, so `resolveFeatures(m, undefined)` is reference-stable. */
export function defaultFeatures(mode: AgentMode): AgentFeatureFlags {
  return mode === "writer" ? WRITER_FEATURES : HERMES_FEATURES;
}

/**
 * Merge a page's partial overrides onto the mode defaults.
 *
 * Returns the frozen default object unchanged when there are no overrides, so a caller that does
 * NOT memoize still gets a stable reference in the common case. Callers should still wrap this in
 * `useMemo` — the flags bag is passed down through memo'd components.
 */
export function resolveFeatures(
  mode: AgentMode,
  overrides?: Partial<AgentFeatureFlags>,
): AgentFeatureFlags {
  const base = defaultFeatures(mode);
  if (!overrides) return base;
  return { ...base, ...overrides };
}

// ─────────────────────────────────────────────────────────────── motion preference

/**
 * SSR-safe reduced-motion check.
 *
 * Read at call time rather than cached, because the OS setting can change while the tab is open and
 * every consumer here is on a user-initiated path (a scroll, a click) where one matchMedia call is
 * free.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
