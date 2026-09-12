// Grounding a pitch in what the prospect's article ACTUALLY says.
//
// The drafter used to hand the model only the article TITLE while the guidance demanded "a detail
// a skim would miss" — which is an instruction to fabricate: the model obligingly invented
// plausible specifics that were never checked against the page, and the piece's own author can
// tell. The SEO team read the result as "generic and robotic"; the old workflow generator was
// preferred precisely because its openers cited real scraped content (the articles table's
// readability_text_excerpt). These helpers give the backlink path the same grounding, with the
// load-honesty rule applied to prose: when the text could not be read, the opener must stay
// general — missing knowledge reads as absent, never as invented detail.
//
// Pure (no I/O) so the selfcheck route and a tsx smoke test can assert the contract.

/** How much readable text discovery/backfill stores on the article row. The workflow pipeline
 *  stores 1000 chars for its own surfaces; the backlink drafter wants enough for a specific,
 *  checkable citation, and the column is unbounded text. */
export const ARTICLE_TEXT_STORE_MAX = 4000;

/** How much of the stored text the opener prompt receives. */
export const OPENER_TEXT_BUDGET = 3500;

/** Normalize extracted text and clip it on a word boundary — a mid-word cut reads as corruption
 *  to the model and invites it to "complete" the missing half. */
export function clipArticleText(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.6 ? cut.slice(0, at) : cut).trim();
}

/** The opener prompt. `relation` states who the mail reaches and whether they wrote the piece
 *  (the drafter builds it); `articleText` is the extracted page text, possibly empty. The rules
 *  ride in the user message so they hold even for campaigns whose stored guidance predates them. */
export function openerPrompt(opts: { relation: string; title: string; articleText: string }): string {
  const grounding = opts.articleText
    ? `What the article actually says (extracted from the page, may be truncated):\n"""\n${opts.articleText}\n"""`
    : `No text could be read from the article page. You have ONLY the title — do not pretend otherwise.`;
  return `${opts.relation}
The article: "${opts.title}".

${grounding}

Write the opener now (1-2 sentences).

HARD RULES (follow ALL):
- Every specific must come from the extracted text above: name one concrete detail, angle or example that is ACTUALLY THERE — the kind of thing a skim would miss. If no text is given, stay general about the piece and NEVER invent a detail, example or claim about its contents.
- This is a first-ever COLD email: no greeting, no sign-off, no links, no questions. The template after your sentences handles the ask.
- Do not use the recipient's name in the sentences — the greeting before them already names them once.
- NEVER use bracketed placeholders like [topic]. NEVER use em-dashes or en-dashes.
- Sound like a person who read it: plain, warm, direct. Not fawning. Never open with "I hope this finds you well" or "I came across your article".`;
}

/** The relevance-gate prompt: before any pitch is drafted, would a link to the campaign's target
 *  page even make editorial sense in THIS article? Asked only when extracted text exists — with
 *  no text there is nothing to judge, and the honesty rule forbids judging from a title alone.
 *  Exists because measured sends included an AI image generator pitched into a DNS-tools roundup
 *  and a product-roadmap guide: openers grounded beautifully, then asked for the impossible —
 *  "include us in that piece" where no editor could. A confident NO holds the pitch; anything
 *  else (YES, garbled, model unavailable) lets drafting proceed — the gate fails open. */
export function relevancePrompt(opts: { targetUrl: string; title: string; articleText: string }): string {
  return `A company wants a link to its page ${opts.targetUrl} added to the article below — the page is the LINK TARGET, the article is where the link would live.

The article: "${opts.title}".

What the article actually says (extracted from the page, may be truncated):
"""
${opts.articleText}
"""

Would adding that link be an editorially plausible request for THIS article — is the target page the kind of tool or resource the piece is actually about, lists, or compares? A page only fits where its topic genuinely belongs: a tools-roundup gets a tool of that kind, not an unrelated product the author would have no reason to mention.

Answer on ONE line: YES or NO, then a dash and a reason of at most 12 words.`;
}

/** The canned line when the model call failed or timed out. The one it replaces asserted the
 *  piece was "a genuinely useful roundup" — a fabricated format; the fallback has to obey the
 *  same honesty rule as the model. Quotes the real title when there is one, claims nothing else. */
export function openerFallback(title: string | null | undefined, addressingOwner: boolean): string {
  const t = (title ?? "").trim();
  if (t) {
    return addressingOwner
      ? `I came across "${t}" on your site and wanted to reach out about it.`
      : `I really enjoyed your piece "${t}".`;
  }
  return addressingOwner
    ? `I came across a piece on your site and wanted to reach out about it.`
    : `I came across your piece and wanted to reach out about it.`;
}
