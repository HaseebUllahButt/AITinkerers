"use client";

// Assistant markdown.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §7.3 (rules), §7.4 (the cursor sentinel), §5.4 (the memo).
//
// This WRAPS Summit's existing zero-dependency renderer rather than replacing it: `parseBlocks` /
// `parseInline` / `safeUrl` come straight from src/lib/blog/markdown.ts, so the two surfaces share
// one parser, one URL scheme gate, and one selfcheck (/api/blog/selfcheck asserts that module).
// What is NOT shared is the element mapping — the blog preview renders `<p>` and the `.md-preview`
// stylesheet, and §7.3 requires the opposite for a streaming transcript:
//
//   • paragraphs are <div>, because a <div> (image card, table) landing inside a <p> is a hydration
//     error and mid-stream the parser sees exactly that shape constantly;
//   • explicit per-element classes INSTEAD of a prose wrapper, never both — they fight over margins
//     and `.md-preview`'s `> * + * { margin-top: 1em }` would double up with the classes here.
//
// SECURITY: like the renderer it wraps, this builds React elements and never touches
// dangerouslySetInnerHTML, and every href/src goes through `safeUrl` (href="javascript:…" executes
// on click; React's text escaping does NOT close that hole). Do not "optimise" either property away.

import { Fragment, memo, useState, type ReactNode } from "react";

import { CURSOR, ELEMENT_REF_RE, EMPTY_ELEMENTS } from "../constants";
import type { AgentElement, AgentNode } from "../types";
import { CodeBlock } from "./CodeBlock";
import { StreamCursor } from "./StreamCursor";
import { parseBlocks, parseInline, type Block, type PositionedInline } from "@/lib/blog/markdown";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────── inline

interface InlineCtx {
  elements: readonly AgentElement[];
  renderElementRef?: (id: string) => ReactNode;
}

/**
 * Turn one run of plain text into nodes, expanding the two sentinels that can appear inside it:
 * the streaming cursor (a zero-width space) and an inline element reference (`[[element:id]]`).
 */
function textRun(text: string, key: string, ctx: InlineCtx): ReactNode[] {
  const out: ReactNode[] = [];

  // ELEMENT_REF_RE carries the /g flag, so `.exec`/`.test` would drag `lastIndex` between calls and
  // silently skip every other marker. `split` ignores lastIndex, and with one capture group returns
  // [text, id, text, id, …] — odd slots are ids.
  const parts = text.split(ELEMENT_REF_RE);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 1) {
      const chip = renderRef(part, `${key}-r${i}`, ctx);
      // An unresolvable id renders as NOTHING, never as the raw `[[element:…]]` marker — leaking
      // the marker into prose is the failure the user actually notices.
      if (chip) out.push(chip);
      continue;
    }
    if (!part) continue;

    // The cursor sentinel. Splitting the string here is what keeps the dot INSIDE the inline run —
    // it inherits the line box and moves with the last word instead of sitting on its own line.
    const segments = part.split(CURSOR);
    for (let j = 0; j < segments.length; j++) {
      // Raw strings, not wrapped spans: React does not need keys for text children, and one span
      // per run would double the DOM of a long answer for nothing.
      if (segments[j]) out.push(segments[j]);
      if (j < segments.length - 1) out.push(<StreamCursor key={`${key}-c${i}-${j}`} />);
    }
  }
  return out;
}

function renderRef(id: string, key: string, ctx: InlineCtx): ReactNode {
  if (ctx.renderElementRef) return <span key={key}>{ctx.renderElementRef(id)}</span>;
  const el = ctx.elements.find((e) => e.id === id);
  if (!el) return null;
  // Inert fallback chip. The rich chip (P1.8, elements/ElementChip.tsx) arrives through
  // `renderElementRef` so this file needs no dependency on the elements group.
  return (
    <span
      key={key}
      className="mx-0.5 inline-flex items-center rounded-sm border border-border bg-muted px-1.5 py-0.5 align-baseline text-xs text-muted-foreground"
    >
      {el.name}
    </span>
  );
}

function inline(tokens: PositionedInline[], keyPrefix: string, ctx: InlineCtx): ReactNode[] {
  return tokens.map((tok, i) => {
    const key = `${keyPrefix}-i${i}`;
    switch (tok.t) {
      case "text":
        // Fragment, not a span: prose is the bulk of a long answer and one wrapper element per text
        // run is pure DOM weight. (The blog preview wraps them for pane-sync offsets; nothing here
        // needs those.)
        return <Fragment key={key}>{textRun(tok.text, key, ctx)}</Fragment>;
      case "code":
        return (
          <code
            key={key}
            className="rounded bg-muted px-[0.35em] py-[0.15em] font-mono text-[0.85em] break-words"
          >
            {textRun(tok.text, key, ctx)}
          </code>
        );
      case "img":
        return tok.src ? (
          <MarkdownMedia key={key} src={tok.src} alt={tok.alt} />
        ) : (
          // A URL we refused (wrong scheme, or a bare relative filename) stays visible and inert
          // rather than vanishing — a silently dropped image is a bug report we never get.
          <span
            key={key}
            className="inline-block rounded-sm border border-dashed border-border px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            [image: {tok.alt || tok.raw}]
          </span>
        );
      case "link":
        return tok.href ? (
          <a
            key={key}
            href={tok.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 break-words hover:brightness-110"
          >
            {textRun(tok.text, key, ctx)}
          </a>
        ) : (
          <span key={key}>{textRun(tok.text, key, ctx)}</span>
        );
      // Real <strong>/<em>, not styled spans (§16): downgrading them destroys semantics for screen
      // readers and DOM scrapers.
      case "strong":
        return (
          <strong key={key} className="font-semibold">
            {textRun(tok.text, key, ctx)}
          </strong>
        );
      case "em":
        return <em key={key}>{textRun(tok.text, key, ctx)}</em>;
      // The sentinel now has a parser token of its own (§7.4, src/lib/blog/markdown.ts), so a ZWSP
      // in ordinary prose arrives here rather than inside a text run. `textRun`'s split still runs
      // and is still required: the parser does not tokenise INSIDE a code span, so a cursor landing
      // mid-`code` is only caught there.
      case "cursor":
        return <StreamCursor key={key} />;
    }
  });
}

// ─────────────────────────────────────────────────────────────── media

const VIDEO_EXT_RE = /\.(?:mp4|webm|ogv|mov|m4v)$/i;

/**
 * Strip the query and fragment BEFORE sniffing the extension. Signed asset URLs always carry
 * `?X-Amz-…`, so a naive `endsWith('.mp4')` fails on every presigned link.
 */
function isVideoUrl(url: string): boolean {
  const bare = url.split(/[?#]/, 1)[0];
  return VIDEO_EXT_RE.test(bare);
}

function MarkdownMedia({ src, alt }: { src: string; alt: string }) {
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  // Every wrapper here is a <span class="block">, not a <div>: markdown images turn up inside list
  // items, table cells and headings, and a block element in those positions is either invalid or a
  // hydration mismatch waiting to happen.
  if (failed) {
    return (
      <span className="my-4 block rounded-lg border border-dashed border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
        Could not load {alt || "image"}
      </span>
    );
  }

  if (isVideoUrl(src)) {
    return (
      <span className="my-4 block max-w-full overflow-hidden rounded-lg border border-border bg-muted sm:max-w-sm md:max-w-md">
        {/* No <track>: these are generated assets with no caption file to point at. The alt text
            from the markdown becomes the accessible name instead. */}
        <video
          src={src}
          controls
          preload="metadata"
          aria-label={alt || "video"}
          className="block aspect-video h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      className="my-4 block max-w-full overflow-hidden rounded-lg border border-border bg-muted sm:max-w-sm md:max-w-md"
      // The box is reserved BEFORE the bytes arrive, so an image landing mid-stream cannot shove
      // the transcript (and the scroll-follow loop) down. 16/9 is the placeholder guess; once the
      // real ratio is known the box adopts it, so a portrait shot stops letterboxing.
      style={{ aspectRatio: ratio ?? 16 / 9 }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary remote hosts; next/image
          would need every model-emitted CDN whitelisted in next.config. */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        // `contain`, not `cover`: a portrait image letterboxes rather than being cropped.
        className="h-full w-full object-contain"
        onLoad={(e) => {
          const el = e.currentTarget;
          if (el.naturalWidth > 0 && el.naturalHeight > 0) {
            setRatio(el.naturalWidth / el.naturalHeight);
          }
        }}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────── blocks

// `first:mt-0` on every heading is not cosmetic: answers very often OPEN with a heading, and without
// it there is a dead 32px gap under the avatar which destroys §7.2's mt-[3px] baseline alignment.
const HEADING_CLASS: Readonly<Record<number, string>> = {
  1: "mt-8 first:mt-0 scroll-m-20 text-2xl font-semibold tracking-tight",
  2: "mt-8 first:mt-0 scroll-m-20 text-xl font-semibold tracking-tight",
  3: "mt-6 first:mt-0 scroll-m-20 text-lg font-semibold tracking-tight",
  4: "mt-6 first:mt-0 scroll-m-20 text-base font-semibold tracking-tight",
  5: "mt-6 first:mt-0 scroll-m-20 text-base font-semibold tracking-tight",
  6: "mt-6 first:mt-0 scroll-m-20 text-base font-semibold tracking-tight",
};

function renderBlock(b: Block, key: string, ctx: InlineCtx): ReactNode {
  switch (b.t) {
    case "h": {
      const level = Math.min(Math.max(b.level, 1), 6);
      const Tag = `h${level}` as "h1";
      return (
        <Tag key={key} className={HEADING_CLASS[level]}>
          {inline(parseInline(b.text, b.textStart), key, ctx)}
        </Tag>
      );
    }
    case "p":
      // A <div>, never a <p>: mid-stream the parser regularly hands back a paragraph that will grow
      // an image or a table inside it, and a <div> inside a <p> is a hydration error.
      // `whitespace-pre-wrap` keeps the single newlines LLMs emit inside a paragraph; `break-words`
      // stops a long URL blowing out the transcript width.
      return (
        <div
          key={key}
          className="leading-7 break-words whitespace-pre-wrap [&:not(:first-child)]:mt-4"
        >
          {inline(parseInline(b.text, b.textStart), key, ctx)}
        </div>
      );
    case "ul":
      return (
        <ul key={key} className="ml-6 list-disc leading-7 [&:not(:first-child)]:mt-4 [&>li]:mt-2">
          {b.items.map((it, j) => (
            <li key={j}>{inline(parseInline(it.text, it.textStart), `${key}-${j}`, ctx)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} className="ml-6 list-decimal leading-7 [&:not(:first-child)]:mt-4 [&>li]:mt-2">
          {b.items.map((it, j) => (
            <li key={j}>{inline(parseInline(it.text, it.textStart), `${key}-${j}`, ctx)}</li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <blockquote
          key={key}
          className="border-l-2 border-primary pl-4 leading-7 text-muted-foreground italic [&:not(:first-child)]:mt-4"
        >
          {inline(parseInline(b.text, b.textStart), key, ctx)}
        </blockquote>
      );
    case "code": {
      // The sentinel lives at the very end of the source, so a fence that CONTAINS it is the fence
      // still being written. Gating per block (rather than on `node.streaming`) means an earlier,
      // already-closed fence highlights immediately instead of waiting for the whole turn.
      const streaming = b.text.includes(CURSOR);
      const code = streaming ? b.text.split(CURSOR).join("") : b.text;
      return <CodeBlock key={key} code={code} lang={b.lang} streaming={streaming} />;
    }
    case "hr":
      return <hr key={key} className="my-6 border-t border-border" />;
    case "table":
      return (
        // Own horizontal scroll container: a wide result must scroll inside the answer, not widen
        // the transcript. Pairs with the `w-0` on the step root (§7.5).
        <div key={key} className="w-full overflow-x-auto [&:not(:first-child)]:mt-4">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th
                    key={j}
                    className="border border-border bg-muted px-2.5 py-1.5 text-left font-semibold"
                  >
                    {inline(parseInline(c, b.textStart), `${key}-h${j}`, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, l) => (
                    <td key={l} className="border border-border px-2.5 py-1.5 align-top">
                      {inline(parseInline(c, b.textStart), `${key}-${j}-${l}`, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

// ─────────────────────────────────────────────────────────────── public API

export interface MarkdownProps {
  /**
   * The markdown source. Append `CURSOR` (the ZWSP sentinel) to the end while streaming and the dot
   * renders at the end of the current inline run — see `MarkdownContent`, which does this for you.
   */
  source: string;
  /** Elements owned by this node. Only read to resolve `[[element:id]]` references. */
  elements?: readonly AgentElement[];
  /**
   * Renderer for an inline `[[element:id]]` reference. MUST be referentially stable (module-level or
   * `useCallback`) — `MarkdownContent`'s comparator compares it by identity, so a fresh arrow per
   * render defeats the memo.
   */
  renderElementRef?: (id: string) => ReactNode;
  /** Colours the whole block destructive. */
  isError?: boolean;
  className?: string;
}

/**
 * Render a markdown string. Stateless — use this for step input/output and anywhere you have a
 * source string rather than a node.
 */
export function Markdown({
  source,
  elements = EMPTY_ELEMENTS,
  renderElementRef,
  isError,
  className,
}: MarkdownProps) {
  // No useMemo around the parse: the ONLY thing that changes it is `source`, and when `source`
  // changes the parse has to run anyway. `MarkdownContent`'s comparator is what stops everything
  // else (a feedback write, a usage tick, an element arriving) from reaching this at all.
  const blocks = parseBlocks(source ?? "");
  if (blocks.length === 0) return null;

  const ctx: InlineCtx = { elements, renderElementRef };
  return (
    // `min-w-0` so a wide code block or table inside a flex column cannot set the column's
    // min-content width and blow the transcript out horizontally.
    <div className={cn("min-w-0 break-words", isError && "text-destructive", className)}>
      {blocks.map((b, i) => renderBlock(b, `b${i}`, ctx))}
    </div>
  );
}

export interface MarkdownContentProps {
  node: AgentNode;
  /**
   * Pass `EMPTY_ELEMENTS` (the module constant) where there are none. An inline `[]` is a fresh
   * reference every render and silently defeats the comparator below.
   */
  elements?: readonly AgentElement[];
  renderElementRef?: (id: string) => ReactNode;
  className?: string;
}

function MarkdownContentInner({
  node,
  elements = EMPTY_ELEMENTS,
  renderElementRef,
  className,
}: MarkdownContentProps) {
  // §7.4. Gate on `output` being non-empty: an empty streaming node must not show a lone floating
  // cursor — that case belongs to DeadAirCursor, which knows the whole tree is quiet (§7.7).
  const source = node.streaming && node.output ? node.output + CURSOR : (node.output ?? "");
  return (
    <Markdown
      source={source}
      elements={elements}
      renderElementRef={renderElementRef}
      isError={node.isError}
      className={className}
    />
  );
}

/** The narrow projection the comparator compares. Everything else on the node is irrelevant here. */
const projection = (p: MarkdownContentProps) => ({
  id: p.node.id,
  output: p.node.output,
  streaming: p.node.streaming,
  isError: p.node.isError,
  className: p.className,
});

function shallowEqual<T extends Record<string, unknown>>(a: T, b: T): boolean {
  for (const k in a) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * The memo (§5.4).
 *
 * A custom comparator over a narrow projection, plus `elements` compared BY REFERENCE — which only
 * works because the element reducer mints a new array when an element actually changed and returns
 * the same one when nothing did (§5.2). This is what stops a feedback write, a usage tick or a
 * sibling element arriving from re-parsing the markdown of a finished answer.
 */
export const MarkdownContent = memo(
  MarkdownContentInner,
  (a, b) =>
    shallowEqual(projection(a), projection(b)) &&
    a.elements === b.elements &&
    a.renderElementRef === b.renderElementRef,
);

export default MarkdownContent;
