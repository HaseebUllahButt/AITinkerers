"use client";

// A small markdown renderer for the editor's live preview. ~200 lines, zero dependencies.
//
// Why not react-markdown / tiptap / lexical: Strapi stores plain markdown, and the job here is
// answering "is my image in the right place, are my headings right, does this read as a page" while
// typing. That does not need a parser with full CommonMark coverage, and a rich-text editor would
// mean owning a markdown <-> document round-trip, which is exactly where content silently mutates
// (smart quotes, list re-indentation, reference links flattened). If this ever proves too lossy,
// drop in react-markdown + remark-gfm behind the same component boundary and delete this file; no
// call site changes.
//
// The pure parsing and URL vetting live in ./markdown (a server-callable module, so the selfcheck
// can assert them). This file is only the rendering.
//
// SECURITY: this builds React elements and never touches dangerouslySetInnerHTML, so there is no
// HTML-injection path even though the input is arbitrary text that may have come from a model or a
// fetched page. Do not "optimise" it into an innerHTML string builder. Link and image URLs are
// additionally scheme-checked, because href="javascript:…" is a script execution path that React's
// escaping does NOT close.
import type { ReactNode } from "react";
import { parseBlocks, parseInline, type PositionedInline } from "./markdown";
import { StreamCursor } from "@/components/agent/content/StreamCursor";

/**
 * Render the inline tokens. All parsing (and the URL scheme gate) lives in ./markdown.
 *
 * Every token's rendered text is wrapped in a span carrying the source offset it starts at and how
 * many rendered characters it covers. paneSync walks these to convert a markdown caret or selection
 * into a DOM position, which is what makes the highlight land on the exact words rather than on the
 * whole paragraph.
 */
function inline(tokens: PositionedInline[], keyPrefix: string): ReactNode[] {
  return tokens.map((tok, i) => {
    const key = `${keyPrefix}-i${i}`;
    const pos = (len: number) => ({ "data-i-start": tok.textStart, "data-i-len": len });
    switch (tok.t) {
      case "text": return <span key={key} {...pos(tok.text.length)}>{tok.text}</span>;
      case "code": return <code key={key} className="md-code" {...pos(tok.text.length)}>{tok.text}</code>;
      case "img":
        // The whole point of the preview: see whether the image actually resolves. A broken CDN URL
        // shows as a broken image, which is the honest outcome, not a silent omission. A URL we
        // refused (wrong scheme, or relative like "x.png") shows as a visible inert chip.
        return tok.src
          ? <img key={key} src={tok.src} alt={tok.alt} className="md-img" loading="lazy" {...pos(0)} />
          : <span key={key} className="md-broken" {...pos(0)}>[image: {tok.alt || tok.raw}]</span>;
      case "link":
        return tok.href
          ? <a key={key} href={tok.href} target="_blank" rel="noreferrer noopener" {...pos(tok.text.length)}>{tok.text}</a>
          : <span key={key} {...pos(tok.text.length)}>{tok.text}</span>;
      // The streaming cursor. Zero rendered characters, so it carries no `pos()` span — a
      // zero-length offset marker would make paneSync map a caret onto the dot.
      case "cursor": return <StreamCursor key={key} />;
      case "strong": return <strong key={key} {...pos(tok.text.length)}>{tok.text}</strong>;
      case "em": return <em key={key} {...pos(tok.text.length)}>{tok.text}</em>;
    }
  });
}

export function MarkdownPreview({ markdown, className }: { markdown: string; className?: string }) {
  const blocks = parseBlocks(markdown ?? "");
  return (
    <div className={`md-preview ${className ?? ""}`}>
      {blocks.length === 0 && <p className="md-empty">Nothing to preview yet.</p>}
      {blocks.map((b, i) => {
        const key = `b${i}`;
        // Every rendered block carries the source offsets it came from. The editor reads these to
        // follow the caret, highlight the counterpart of a selection, and map a click back to the
        // markdown. Keep them on the OUTERMOST element of each case.
        const src = { "data-md-start": b.start, "data-md-end": b.end };
        switch (b.t) {
          case "h": {
            const Tag = (`h${Math.min(b.level, 6)}`) as "h1";
            return <Tag key={key} {...src}>{inline(parseInline(b.text, b.textStart), key)}</Tag>;
          }
          case "p": return <p key={key} {...src}>{inline(parseInline(b.text, b.textStart), key)}</p>;
          case "ul": return <ul key={key} {...src}>{b.items.map((it, j) => <li key={j}>{inline(parseInline(it.text, it.textStart), `${key}-${j}`)}</li>)}</ul>;
          case "ol": return <ol key={key} {...src}>{b.items.map((it, j) => <li key={j}>{inline(parseInline(it.text, it.textStart), `${key}-${j}`)}</li>)}</ol>;
          case "quote": return <blockquote key={key} {...src}>{inline(parseInline(b.text, b.textStart), key)}</blockquote>;
          case "code": return <pre key={key} {...src} data-lang={b.lang || undefined}><code>{b.text}</code></pre>;
          case "hr": return <hr key={key} {...src} />;
          case "table": return (
            <div key={key} {...src} className="md-table-wrap">
              <table>
                <thead><tr>{b.head.map((c, j) => <th key={j}>{inline(parseInline(c, b.textStart), `${key}-h${j}`)}</th>)}</tr></thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>{r.map((c, l) => <td key={l}>{inline(parseInline(c, b.textStart), `${key}-${j}-${l}`)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
      })}
    </div>
  );
}
