// Shared personalization primitives for every outreach drafting path.
//
// Before this module there were THREE token systems for the same job: the backlink drafter had
// three hardcoded .replace() calls and no leftover-token stripper (an unknown {{token}} shipped
// literally to a publisher), the workflow email generator had its own fillTemplate/dropLineIfEmpty
// pair, and the LinkedIn generator carried a third copy — plus five scattered copies of the
// first-name idiom, one of which filled a token NAMED author_name with only the first word.
//
// The SEO team's actual complaint ("it should pick the recipient name and add it in the greeting,
// and add the article URL in the body — like the old tool did") is answered by construction, not
// by prompt luck: ensurePersonalized() guarantees both after every fill.

/** First word of a person's name, for greetings. "there" when we have nobody to greet — including
 *  pseudo-authors ("CNET Editorial", the convention for unsigned publications): greeting the
 *  brand's first word reads "Hi Cnet," to whichever human reads the desk inbox. */
export function firstNameOf(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n || /\beditorial$/i.test(n)) return "there";
  return n.split(/\s+/)[0] || "there";
}

/**
 * Fill {{tokens}} and strip any that had no value — a leftover {{token}} in a sent email is the
 * one mistake a recipient can screenshot. Tokens listed in `dropLineFor` take their whole line
 * with them when empty ("I read this at: {{article_link}}" must disappear as a line, not leave a
 * dangling "I read this at:").
 */
export function fillTokens(
  template: string,
  vars: Record<string, string>,
  opts: { dropLineFor?: string[] } = {},
): string {
  let t = template;
  for (const token of opts.dropLineFor ?? []) {
    if (vars[token]) continue;
    t = t.split("\n").filter((line) => !line.includes(`{{${token}}}`)).join("\n");
  }
  return t
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "")
    .replace(/\n{3,}/g, "\n\n");
}

const GREETING_RE = /^\s*(hi|hey|hello|dear)\b/i;
const SIGNOFF_RE = /^(thanks|thank you|best|cheers|regards|warmly|kind regards|sincerely)\b/i;

/**
 * The deterministic guarantee, applied AFTER filling: the body opens with a greeting that names
 * the recipient, and contains the article URL the pitch is about. A template author can place
 * both wherever they like ({{first_name}}, {{article_link}}); this only acts when they forgot —
 * so no drafted pitch ever goes out nameless or linkless again.
 */
export function ensurePersonalized(
  body: string,
  opts: { firstName?: string | null; articleUrl?: string | null },
): string {
  let out = body.trim();
  const first = (opts.firstName ?? "").trim();
  if (first && !GREETING_RE.test(out)) out = `Hi ${first},\n\n${out}`;

  const url = (opts.articleUrl ?? "").trim();
  if (url && !out.includes(url)) {
    // Before the sign-off when one is recognizable; appended otherwise. A link after the
    // signature is worse than none stylistically, but the guarantee outranks style here.
    const paras = out.split("\n\n");
    let at = -1;
    for (let i = paras.length - 1; i > 0; i--) {
      if (SIGNOFF_RE.test(paras[i].trim())) { at = i; break; }
    }
    const line = `The piece I mean: ${url}`;
    if (at > 0) paras.splice(at, 0, line); else paras.push(line);
    out = paras.join("\n\n");
  }
  return out;
}
