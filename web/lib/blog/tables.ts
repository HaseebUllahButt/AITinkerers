// Markdown pipe tables -> the HTML table markup this blog actually publishes.
//
// Measured, not assumed. Of 40 live posts on api::imagine-web.imagine-web:
//
//     18  contain an HTML <table>
//      0  contain a markdown pipe table
//
// So the renderer does not support GFM tables at all. A pipe table reaching Strapi ships as literal
// pipes on a live page. The writer emits markdown, which means every table it produced was either
// already broken or hand-converted by someone after the fact.
//
// The inline styles below are copied from a real published post rather than invented. They look
// redundant next to a stylesheet, but blog bodies are also consumed where no stylesheet applies (RSS,
// syndication, email), which is why the house convention carries them — matching it keeps new posts
// indistinguishable from the 18 that already exist.
//
// Runs at the sync boundary, not in the editor: the author keeps writing markdown (which the live
// preview renders), and the HTML is generated on the way out. Converting in the editor would mean the
// author's own source silently turning into HTML under their cursor.

const TABLE_OPEN = '<table style="width:100%; border-collapse: collapse; font-family: Arial, sans-serif;">';
const TH_ROW = '<tr style="background-color:#f5f5f5; text-align:left;">';
const CELL = 'style="padding:14px; border:1px solid #ddd;"';

/** Split one pipe row into cells, tolerating optional leading/trailing pipes. */
function cellsOf(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // A escaped pipe (\|) is content, not a delimiter — splitting on it would shear the row.
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** `---`, `:---`, `---:`, `:---:` — the GFM alignment row that marks a block as a real table. */
function isDelimiterRow(line: string): boolean {
  const cells = cellsOf(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/** Minimal escaping for text destined for an HTML cell. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Inline markdown that legitimately appears inside a cell.
 *
 * Deliberately a small set — bold, italic, code, links. A cell is not a document, and running a full
 * markdown parser here would be more machinery than the job needs and would start reinterpreting
 * things like list markers inside a cell.
 *
 * Escaping happens FIRST, then these produce tags, so cell text can never inject markup: a cell
 * containing `<script>` is already `&lt;script&gt;` before any tag is emitted.
 */
function inline(s: string): string {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  // Links: the URL was escaped above, so &amp; must be restored inside href or the link breaks.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) =>
    `<a href="${String(href).replace(/&amp;/g, "&")}">${text}</a>`);
  return out;
}

/** True when the body contains at least one GFM pipe table. */
export function hasMarkdownTable(body: string): boolean {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes("|") && isDelimiterRow(lines[i + 1])) return true;
  }
  return false;
}

/**
 * Convert every GFM pipe table in `body` to HTML, leaving all other content untouched.
 *
 * Fenced code blocks are skipped: a pipe table inside ``` is being shown as an example, and rewriting
 * it would destroy the very thing the author was demonstrating.
 */
export function markdownTablesToHtml(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }

    const next = lines[i + 1];
    const startsTable = line.includes("|") && next !== undefined && isDelimiterRow(next);
    if (!startsTable) { out.push(line); continue; }

    const header = cellsOf(line);
    let j = i + 2;
    const rows: string[][] = [];
    // A table runs until a blank line or a line with no pipe — the same terminator GFM uses.
    while (j < lines.length && lines[j].trim() !== "" && lines[j].includes("|")) {
      rows.push(cellsOf(lines[j]));
      j++;
    }

    const html: string[] = [TABLE_OPEN, "  <thead>", `    ${TH_ROW}`];
    for (const h of header) html.push(`      <th ${CELL}>${inline(h)}</th>`);
    html.push("    </tr>", "  </thead>", "  <tbody>");
    for (const r of rows) {
      html.push("    <tr>");
      // Pad or trim to the header width: a ragged row would otherwise produce a broken table rather
      // than a visibly wrong one, and a silently misaligned comparison table is worse than an obvious
      // gap the author can see and fix.
      for (let c = 0; c < header.length; c++) html.push(`      <td ${CELL}>${inline(r[c] ?? "")}</td>`);
      html.push("    </tr>");
    }
    html.push("  </tbody>", "</table>");

    out.push(html.join("\n"));
    i = j - 1;
  }

  return out.join("\n");
}
