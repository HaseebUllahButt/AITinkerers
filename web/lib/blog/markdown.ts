// The pure half of the markdown preview: block parsing and URL vetting, no React.
//
// Split from markdownPreview.tsx because that file is "use client", and a "use client" module's
// exports cannot be CALLED from the server — only rendered as components. /api/blog/selfcheck runs
// on the server and needs to assert this logic, and TypeScript does not catch that boundary (it is a
// runtime error: "Attempted to call parseBlocks() from the server but parseBlocks is on the client").

/**
 * Vet a URL before it becomes an href or an img src.
 *
 * This is a security boundary, not a formatting nicety. Body markdown can come from a model, from a
 * fetched competitor page, or from a paste, and `href="javascript:…"` executes on click — React's
 * text escaping does NOT close that hole. Only http(s), protocol-relative, site-relative and
 * fragment URLs pass; anything else renders as inert text.
 */
export function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  // Site-relative links are legitimate: the internal-link plan produces "/ai-video-generator".
  if (url.startsWith("/") || url.startsWith("#")) return url;
  return null;
}

export type Inline =
  | { t: "text"; text: string }
  /**
   * The streaming-cursor sentinel: a zero-width space the chat surface appends to the markdown
   * SOURCE while a message is still arriving (see src/components/agent/constants.ts `CURSOR`).
   *
   * It is a parser token rather than a block-level sibling because a sibling lands on its own line
   * and reflows the paragraph every time the last word wraps. Emitting it here puts the cursor at
   * the exact end of the current inline run — inside the last list item, table cell or heading.
   * A ZWSP that reaches this parser from anything OTHER than the chat surface (a paste from a web
   * page) renders as a cursor too; that is the honest outcome, it is a real character in the text.
   */
  | { t: "cursor" }
  | { t: "code"; text: string }
  | { t: "img"; alt: string; src: string | null; raw: string }
  | { t: "link"; text: string; href: string | null }
  | { t: "strong"; text: string }
  | { t: "em"; text: string };

/**
 * An inline token plus where its RENDERED text starts in the source.
 *
 * `textStart` is not the token's start: for `**bold**` the token begins at the asterisks but the two
 * characters a reader sees begin two later. Recording the text start is what makes offset mapping
 * exact, so a selection of three words in the markdown highlights those same three words in the
 * preview instead of the whole paragraph.
 */
export type PositionedInline = Inline & { textStart: number };

/**
 * A markdown URL, allowing ONE level of nested parentheses.
 *
 * `[x](https://en.wikipedia.org/wiki/Bar_(disambiguation))` is a real link shape and sourced articles
 * hit it constantly. A naive `[^)]+` stops at the inner paren, so the href comes out truncated and a
 * stray ")" leaks into the prose — which is exactly what happened before this existed. The optional
 * trailing `"title"` is markdown's title syntax and must not end up inside the href.
 */
const URL_PART = '((?:[^()\\s]|\\([^()\\s]*\\))+)(?:\\s+"[^"]*")?';

/**
 * Split prose into inline tokens. Pure, so the selfcheck can assert link and image extraction,
 * including the URL scheme gate.
 *
 * `base` is the source offset `text` starts at. Pass it and every token's `textStart` comes back as
 * an absolute source offset, which is what the two-pane sync maps positions through.
 */
export function parseInline(text: string, base = 0): PositionedInline[] {
  const out: PositionedInline[] = [];
  const push = (tok: PositionedInline) => { if (tok.t !== "text" || tok.text) out.push(tok); };

  // One regex, alternating over every inline form, so a single left-to-right pass handles precedence
  // (code first, so `**bold**` inside a code span stays literal) without nested re-scanning.
  const RE = new RegExp(
    [
      "`([^`]+)`",                                     // 1: code
      `!\\[([^\\]]*)\\]\\(\\s*${URL_PART}\\s*\\)`,     // 2,3: image alt + src
      `\\[([^\\]]+)\\]\\(\\s*${URL_PART}\\s*\\)`,      // 4,5: link text + href
      "\\*\\*([^*]+)\\*\\*",                           // 6: bold
      "__([^_]+)__",                                   // 7: bold
      "\\*([^*\\n]+)\\*",                              // 8: italic
      "((?:https?://)(?:[^\\s<>()]|\\([^\\s()]*\\))+)", // 9: bare URL, same paren rule
      "(\\u200B)",                                     // 10: streaming-cursor sentinel (ZWSP)
    ].join("|"),
    "g",
  );

  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(text)) !== null) {
    if (m.index > last) push({ t: "text", text: text.slice(last, m.index), textStart: base + last });

    // textStart skips each form's opening delimiter, so it points at the first character a reader
    // actually sees. An image renders no text at all, so it gets the token's own start.
    const at = base + m.index;
    if (m[1] !== undefined) push({ t: "code", text: m[1], textStart: at + 1 });
    else if (m[3] !== undefined) push({ t: "img", alt: m[2] ?? "", src: safeUrl(m[3]), raw: m[3], textStart: at });
    else if (m[4] !== undefined) push({ t: "link", text: m[4], href: safeUrl(m[5] ?? ""), textStart: at + 1 });
    else if (m[6] !== undefined) push({ t: "strong", text: m[6], textStart: at + 2 });   // **bold**
    else if (m[7] !== undefined) push({ t: "strong", text: m[7], textStart: at + 2 });   // __bold__
    else if (m[8] !== undefined) push({ t: "em", text: m[8], textStart: at + 1 });       // *italic*
    else if (m[9] !== undefined) push({ t: "link", text: m[9], href: safeUrl(m[9]), textStart: at });
    // Zero rendered characters, so `textStart` is the token's own start and no offset shifts.
    else if (m[10] !== undefined) push({ t: "cursor", textStart: at });

    last = RE.lastIndex;
  }
  if (last < text.length) push({ t: "text", text: text.slice(last), textStart: base + last });
  return out;
}

/** Where a block came from in the source: character offsets into the markdown string. This is what
 *  lets the editor keep the two panes in step — scroll the preview to follow the caret, highlight the
 *  rendered counterpart of a selection, and map a click in the preview back to a source position. */
export interface SourceRange {
  start: number;
  end: number;
  /** Source offset where this block's inline TEXT begins — past "## " on a heading, past "- " on a
   *  list item. Inline tokens are parsed with this as their base, so their offsets are absolute. */
  textStart: number;
}

export type Block = SourceRange & (
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "ul" | "ol"; items: Array<{ text: string; textStart: number }> }
  | { t: "quote"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "hr" }
  | { t: "table"; head: string[]; rows: string[][] }
);

/** Split markdown into blocks. Block boundaries are where a hand-rolled renderer goes wrong, and
 *  getting them wrong is invisible until an image lands inside a code fence, so the selfcheck pins
 *  every case below. */
export function parseBlocks(md: string): Block[] {
  // Newlines are normalised, which would shift offsets on a CRLF source. In practice the only input
  // is a textarea's `value`, and the HTML spec already normalises that to LF, so offsets line up with
  // what the editor sees. Anything else feeding this (a probe, a paste handler) must normalise first.
  const lines = (md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  // Character offset of the start of each line, so a consumed line range becomes a source range.
  const lineStart: number[] = new Array(lines.length);
  {
    let at = 0;
    for (let n = 0; n < lines.length; n++) { lineStart[n] = at; at += lines[n].length + 1; }
  }
  /** Offsets covering lines [from, to] inclusive. `to` may exceed the last line when a fence is
   *  unterminated, so it is clamped. */
  const range = (from: number, to: number, textStart?: number): SourceRange => {
    const last = Math.min(Math.max(to, from), lines.length - 1);
    const start = lineStart[from] ?? 0;
    return { start, end: (lineStart[last] ?? 0) + (lines[last]?.length ?? 0), textStart: textStart ?? start };
  };
  let from = 0;   // set at the top of each iteration, read by every push below

  const isTableRow = (s: string) => /^\s*\|.*\|\s*$/.test(s);
  const cells = (s: string) => s.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  while (i < lines.length) {
    from = i;
    const line = lines[i];

    // Fenced code first: everything inside is literal, including things that look like headings.
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*(\S*)/);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      const lang = fence[2] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) buf.push(lines[i++]);
      i++;                                              // consume the closing fence if present
      blocks.push({ t: "code", lang, text: buf.join("\n"), ...range(from, i - 1) });
      continue;
    }

    if (!line.trim()) { i++; continue; }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { blocks.push({ t: "hr", ...range(from, i) }); i++; continue; }

    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      const textStart = (lineStart[i] ?? 0) + (line.length - h[2].length);
      blocks.push({ t: "h", level: h[1].length, text: h[2].trim(), ...range(from, i, textStart) });
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ t: "quote", text: buf.join(" "), ...range(from, i - 1) });
      continue;
    }

    // Table: a header row followed by a |---|---| separator. Anything less is just paragraphs.
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ t: "table", head, rows, ...range(from, i - 1) });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const number = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || number) {
      const kind = bullet ? "ul" : "ol";
      const items: Array<{ text: string; textStart: number }> = [];
      while (i < lines.length) {
        const b = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        const n = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
        const hit = kind === "ul" ? b : n;
        if (!hit) break;
        items.push({ text: hit[1], textStart: (lineStart[i] ?? 0) + (lines[i].length - hit[1].length) });
        i++;
      }
      blocks.push({ t: kind, items, ...range(from, i - 1, items[0]?.textStart) });
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim()
      && !/^\s*(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|`{3,}|~{3,}|(?:---+|\*\*\*+|___+)\s*$)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    if (buf.length) blocks.push({ t: "p", text: buf.join("\n"), ...range(from, i - 1) });
    else i++;                                            // safety: never loop without consuming
  }

  return blocks;
}
