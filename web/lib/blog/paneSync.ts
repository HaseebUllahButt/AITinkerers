// Keeping the markdown pane and the live preview in step.
//
// Three behaviours, all built on the `data-md-start` / `data-md-end` offsets that MarkdownPreview
// stamps onto every rendered block:
//
//   1. Follow the caret. Move the cursor in the markdown and the preview scrolls to the matching
//      block. Type and it keeps up.
//   2. Cross-highlight. Select markdown and the rendered counterpart lights up; select in the
//      preview and the matching markdown gets selected.
//   3. Click to jump. Click a paragraph in the preview and the caret lands on that paragraph's
//      source.
//
// The pure geometry lives here, separate from the component, because "why does the pane jump" is a
// miserable thing to debug through React. The selfcheck asserts the two decision functions.

/** A preview block's source range, read back off the DOM. */
export interface MappedBlock { el: HTMLElement; start: number; end: number }

export function readBlocks(container: HTMLElement | null): MappedBlock[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>("[data-md-start]")).map((el) => ({
    el,
    start: Number(el.dataset.mdStart ?? 0),
    end: Number(el.dataset.mdEnd ?? 0),
  }));
}

/**
 * Which blocks does [selStart, selEnd] touch?
 *
 * A zero-width selection (a plain caret) matches the single block containing it. A range matches
 * every block it overlaps, so selecting across three paragraphs highlights three paragraphs.
 *
 * Blocks do not cover every character — blank lines between them belong to no block. A caret sitting
 * on a blank line therefore matches nothing, and rather than highlight the wrong thing we fall back
 * to the nearest block at or before the caret, which is where the writer is working.
 */
export function blocksInRange<T extends { start: number; end: number }>(
  blocks: T[], selStart: number, selEnd: number,
): T[] {
  if (!blocks.length) return [];
  const hit = blocks.filter((b) => b.start <= selEnd && b.end >= selStart);
  if (hit.length) return hit;

  let best: T | null = null;
  for (const b of blocks) if (b.start <= selStart && (!best || b.start > best.start)) best = b;
  return best ? [best] : [blocks[0]];
}

/**
 * How far to scroll a container so `target` is comfortably visible.
 *
 * Returns the new scrollTop, or null when no scroll is needed. Deliberately NOT
 * `Element.scrollIntoView`: that walks up the tree and scrolls ancestors too, which here means the
 * whole page lurches every time you move the cursor.
 *
 * `margin` keeps the target off the very edge. Anything already inside the comfortable band is left
 * alone, so typing inside a visible paragraph does not cause constant small scrolls.
 */
export function scrollTopFor(
  container: { scrollTop: number; clientHeight: number; scrollHeight: number },
  targetTop: number,     // target's top, relative to the container's scrollable content
  targetHeight: number,
  margin = 48,
): number | null {
  const viewTop = container.scrollTop;
  const viewBottom = viewTop + container.clientHeight;
  const visibleTop = viewTop + margin;
  const visibleBottom = viewBottom - margin;

  // Already comfortably in view, or too tall to fit and its top is on screen: leave it.
  if (targetTop >= visibleTop && targetTop + targetHeight <= visibleBottom) return null;
  if (targetHeight > container.clientHeight - margin * 2 && targetTop >= viewTop && targetTop <= visibleBottom) {
    return null;
  }

  const want = targetTop - margin;
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  const next = Math.max(0, Math.min(want, max));
  return Math.abs(next - container.scrollTop) < 2 ? null : next;
}

/** An element's top relative to a scrolling ancestor's content box. */
export function offsetWithin(el: HTMLElement, container: HTMLElement): number {
  return el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
}

/** Scroll `container` so `el` is comfortably visible, without disturbing any ancestor. */
export function revealIn(container: HTMLElement | null, el: HTMLElement | null, margin = 48): void {
  if (!container || !el) return;
  const next = scrollTopFor(container, offsetWithin(el, container), el.offsetHeight, margin);
  if (next !== null) container.scrollTop = next;
}

/**
 * Scroll a textarea so the character at `offset` is visible.
 *
 * A textarea gives no per-character geometry, so this counts newlines and multiplies by the computed
 * line height. That is exact for soft-wrap-free lines and approximate for wrapped ones, which is fine
 * for "put me roughly there" — and it is the only option short of mirroring the whole value into a
 * hidden div.
 */
export function revealOffsetInTextarea(ta: HTMLTextAreaElement | null, offset: number): void {
  if (!ta) return;
  const cs = getComputedStyle(ta);
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
  const line = ta.value.slice(0, offset).split("\n").length - 1;
  const next = scrollTopFor(ta, line * lineHeight, lineHeight, 64);
  if (next !== null) ta.scrollTop = next;
}

/**
 * Map a selection (or a click) inside the preview back to an exact source range.
 *
 * Character-level, using the same `data-i-start` token spans the forward direction uses. It used to
 * return the enclosing BLOCK's range, which meant clicking one word selected the entire paragraph in
 * the markdown — the reported "on preview entire paras get selected if i place cursor".
 *
 * Falls back to the enclosing block only when the selection lands somewhere with no token span at all
 * (between blocks, or on an `<hr>`), where a block range is the only answer available.
 */
export function sourceRangeFromPreviewSelection(container: HTMLElement | null): { start: number; end: number } | null {
  if (!container) return null;
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0) return null;
  if (!container.contains(sel.anchorNode) && !container.contains(sel.focusNode)) return null;

  /** Walk up to the nearest ancestor carrying an attribute, staying inside the container. */
  const climb = (node: Node | null, attr: "iStart" | "mdStart"): HTMLElement | null => {
    let n: Node | null = node;
    while (n && n !== container) {
      if (n instanceof HTMLElement && n.dataset[attr] !== undefined) return n;
      n = n.parentNode;
    }
    return null;
  };

  /** A DOM point → a source offset, by adding the offset within the token's text. */
  const sourceOffset = (node: Node | null, offsetInNode: number): number | null => {
    const span = climb(node, "iStart");
    if (!span) return null;
    const start = Number(span.dataset.iStart);
    const len = Number(span.dataset.iLen);
    if (!Number.isFinite(start)) return null;
    // When the anchor is the element rather than its text node, offsetInNode counts child nodes, not
    // characters — treat it as "the beginning".
    const within = node && node.nodeType === Node.TEXT_NODE
      ? Math.max(0, Math.min(offsetInNode, len || 0))
      : 0;
    return start + within;
  };

  const a = sourceOffset(sel.anchorNode, sel.anchorOffset);
  const b = sourceOffset(sel.focusNode, sel.focusOffset);

  if (a !== null && b !== null) return { start: Math.min(a, b), end: Math.max(a, b) };
  if (a !== null) return { start: a, end: a };
  if (b !== null) return { start: b, end: b };

  // No token span anywhere in the selection: fall back to the block.
  const blockA = climb(sel.anchorNode, "mdStart");
  const blockB = climb(sel.focusNode, "mdStart");
  if (!blockA && !blockB) return null;
  const els = [blockA, blockB].filter(Boolean) as HTMLElement[];
  return {
    start: Math.min(...els.map((el) => Number(el.dataset.mdStart))),
    end: Math.max(...els.map((el) => Number(el.dataset.mdEnd))),
  };
}


/* ─────────────────────────────────────────────────────────────────────────────────────────────────
   Exact offset mapping.

   MarkdownPreview wraps every token's rendered text in a span carrying `data-i-start` (the source
   offset that text begins at) and `data-i-len` (how many rendered characters it covers). Walking
   those spans converts a markdown caret or selection into a real DOM position — which is what lets
   the preview highlight the exact words you selected and show a caret where you are, instead of
   flooding the whole paragraph.
   ───────────────────────────────────────────────────────────────────────────────────────────────── */

interface Span { el: HTMLElement; start: number; len: number }

function readSpans(container: HTMLElement): Span[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-i-start]"))
    .map((el) => ({ el, start: Number(el.dataset.iStart), len: Number(el.dataset.iLen) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.len))
    .sort((a, b) => a.start - b.start);
}

/** A DOM position (text node + offset) for a source offset, or null if it maps to no rendered text. */
function domPoint(spans: Span[], offset: number): { node: Node; offset: number } | null {
  // The span whose text range covers the offset, else the last one that starts before it (so a caret
  // sitting on markdown syntax — inside "**" — lands at the nearest visible character).
  let hit: Span | null = null;
  for (const s of spans) {
    if (offset >= s.start && offset <= s.start + s.len) { hit = s; break; }
    if (s.start <= offset) hit = s;
  }
  // Before any rendered text — the caret is sitting on the document's first "## " or on a blank
  // leading line. Anchor to the start of the first span rather than reporting nothing, so the caret
  // is always visible somewhere sensible.
  if (!hit) hit = spans[0] ?? null;
  if (!hit) return null;

  const text = hit.el.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) {
    // An image has no text node; anchor to the element itself.
    return { node: hit.el, offset: 0 };
  }
  const within = Math.max(0, Math.min(offset - hit.start, (text.textContent ?? "").length));
  return { node: text, offset: within };
}

/** Build a DOM Range spanning the rendered text between two source offsets. */
export function rangeForSource(container: HTMLElement | null, from: number, to: number): Range | null {
  if (!container || typeof document === "undefined") return null;
  const spans = readSpans(container);
  if (!spans.length) return null;
  const a = domPoint(spans, from);
  const b = domPoint(spans, to);
  if (!a || !b) return null;
  try {
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    if (r.collapsed && to > from) return null;
    return r;
  } catch {
    return null;   // nodes reordered between read and use (a re-render mid-flight)
  }
}

const HIGHLIGHT_NAME = "md-selection";

/**
 * Register the ::highlight() style at runtime, once.
 *
 * It cannot live in globals.css: Next's CSS pipeline does not recognise the ::highlight() pseudo-element
 * and a parse failure there aborts the whole stylesheet transform — which broke client hydration across
 * every page while each one still returned HTTP 200, so nothing in a status check caught it. The browser
 * parses it fine when handed to it directly, and this is the one place that knows the API exists at all.
 */
let highlightStyleInjected = false;
function ensureHighlightStyle(): void {
  if (highlightStyleInjected || typeof document === "undefined") return;
  highlightStyleInjected = true;
  const el = document.createElement("style");
  el.dataset.mdHighlight = "true";
  el.textContent = `::highlight(${HIGHLIGHT_NAME}){background-color:color-mix(in srgb, var(--primary) 28%, transparent);color:inherit}`;
  document.head.appendChild(el);
}

/**
 * Paint the rendered counterpart of a markdown selection.
 *
 * Uses the CSS Custom Highlight API: no DOM mutation, so nothing reflows, React never fights it, and
 * the highlight follows the text exactly the way a native selection does. Wrapping nodes in <mark>
 * elements would do the same job while invalidating React's tree on every keystroke.
 *
 * Returns false when the API is unavailable, so the caller can decide what to do rather than getting
 * a silent no-op.
 */
export function paintSelection(container: HTMLElement | null, from: number, to: number): boolean {
  const CSSAny = typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: Map<string, unknown> }) : undefined;
  if (!CSSAny?.highlights || typeof (globalThis as any).Highlight !== "function") return false;
  ensureHighlightStyle();

  CSSAny.highlights.delete(HIGHLIGHT_NAME);
  if (to <= from) return true;                       // a bare caret paints nothing
  const range = rangeForSource(container, from, to);
  if (!range) return true;
  CSSAny.highlights.set(HIGHLIGHT_NAME, new (globalThis as any).Highlight(range));
  return true;
}

export function clearSelectionPaint(): void {
  const CSSAny = typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: Map<string, unknown> }) : undefined;
  CSSAny?.highlights?.delete(HIGHLIGHT_NAME);
}

/**
 * Where to draw the preview's caret: a rect relative to the container's scrollable content.
 *
 * A collapsed Range reports a zero-width rect, and in some positions no rect at all, so this falls
 * back to a one-character range and then to the enclosing element.
 */
export function caretRectFor(
  container: HTMLElement | null, offset: number,
): { top: number; left: number; height: number } | null {
  if (!container) return null;
  const r = rangeForSource(container, offset, offset) ?? rangeForSource(container, offset, offset + 1);
  if (!r) return null;

  let rect = r.getBoundingClientRect();
  if (!rect || (rect.height === 0 && rect.width === 0)) {
    const rects = r.getClientRects();
    if (!rects.length) return null;
    rect = rects[0];
  }
  const cRect = container.getBoundingClientRect();
  return {
    top: rect.top - cRect.top + container.scrollTop,
    left: rect.left - cRect.left + container.scrollLeft,
    height: rect.height || 20,
  };
}
