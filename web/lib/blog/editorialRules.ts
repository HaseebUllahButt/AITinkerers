// Editorial rules taken from real review of published drafts.
//
// A client-safe leaf: no database, no Strapi. The writer, Summer and the validator read from here.
//
// Everything below came from a line-by-line review of three articles (interior-design visuals,
// product-photo prompts, Wan 3.0 vs Wan 2.6) on 2026-09-08. They are written as rules rather than as
// fixes to those three, because every one of them recurred — the same note landed on all three pieces
// in different words.

/**
 * ── Contrastive negation ────────────────────────────────────────────────────────────────────────
 *
 * The single most-repeated tell. "The demand is measured, not theoretical" was flagged verbatim as
 * "a typical AI writing style", and a sweep of thirty days of drafts found it everywhere:
 *
 *   "decoration, not communication"      "faster, not cheaper"
 *   "inferring, not quoting"             "generated, not recovered"
 *   "the sound bed is timing, not decoration"
 *   "real, not cosmetic"                 "it reads lines, not tones"
 *
 * The construction is seductive because it feels precise — it defines a thing by excluding its
 * neighbour. But it says the same thing twice, once positively and once negatively, and at this
 * density it is a rhythm rather than an argument. A reader clocks it long before they can name it.
 *
 * The fix is always the same: keep the positive half and delete the rest. "The demand is measured."
 * If the excluded thing genuinely needs saying, it deserves its own sentence with its own reason.
 */
export const CONTRASTIVE_PATTERNS: Array<{ re: RegExp; shape: string }> = [
  // "X is measured, not theoretical" — the commonest by a distance.
  { re: /\b(?:is|are|was|were|feels?|reads?|looks?|sounds?|sits?|comes?|becomes?)\s+[\w-]+,\s+not\s+[\w-]/gi,
    shape: "\"is X, not Y\"" },
  // "not a description of the thing, but the thing itself"
  { re: /\bnot\s+[^,.;!?\n]{2,60},\s+but\s+/gi, shape: "\"not X, but Y\"" },
  // "It is not a preference; it is a rule."
  { re: /\bit(?:'s|\s+is)\s+not\s+[^,.;!?\n]{2,60}[;,]\s*it(?:'s|\s+is)\b/gi,
    shape: "\"it is not X; it is Y\"" },
  // "not just faster, but cheaper"
  { re: /\bnot\s+(?:just|only|merely|simply)\s+[^,.;!?\n]{2,60},\s+but\b/gi,
    shape: "\"not just X, but Y\"" },
  // "less a redesign than a repaint"
  { re: /\bless\s+(?:a|an|of a)\s+[^,.;!?\n]{2,40}\s+than\s+(?:a|an)\b/gi,
    shape: "\"less a X than a Y\"" },
];

export interface ContrastiveHit { text: string; shape: string }

/** Every contrastive-negation construction in the body, with the shape each one matched. */
export function contrastiveNegations(body: string): ContrastiveHit[] {
  const out: ContrastiveHit[] = [];
  const seen = new Set<string>();
  for (const { re, shape } of CONTRASTIVE_PATTERNS) {
    for (const m of (body ?? "").matchAll(re)) {
      const text = m[0].trim().replace(/\s+/g, " ");
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text, shape });
    }
  }
  return out;
}

/**
 * How many are tolerable.
 *
 * Zero is the honest target and an unrealistic gate: one can be the right sentence, and a validator
 * that fires on every article gets ignored. Two is where it stops being a sentence and starts being
 * a habit — and the sampled drafts were running at five to ten.
 */
export const MAX_CONTRASTIVE = 1;

/** ── Structure rules, all of which recurred across the three reviews ─────────────────────────── */
export const STRUCTURE_RULES = [
  "Open a section with the concrete thing, not a framing sentence. \"The value sits in the gap "
    + "between the first conversation and the signed proposal\" was marked as filler: it describes "
    + "where value might be instead of stating any. If the section has a statistic, a price, a "
    + "setting or a step, that is the first sentence.",
  "Use a list when the content is a list. Criteria, specifications, failure modes, platform sizes and "
    + "selection rules are all lists, and running them as consecutive prose paragraphs makes them "
    + "unscannable and unquotable. This note landed on five separate sections across three articles.",
  "In a how-to, the section intro is ONE paragraph. Everything after it becomes numbered steps. Prose "
    + "that explains what the steps will be, before the steps, is the intro twice.",
  "A how-to's first step covers INPUTS and their specifications — what image, what resolution, what "
    + "the prompt has to contain. A guide that starts at step two assumes the reader already got the "
    + "hard part right.",
  "Do not open the intro with the deliverable count. \"22 prompts for X\" as the first line skips the "
    + "reason anyone wants them; build the context in a few sentences, then say how many.",
  "End with a conclusion. This is NOT a call to action and does not conflict with the ban on one: it "
    + "is what the reader now knows and what to do first. A piece that stops after its last H2 reads "
    + "as truncated.",
  "Do not give a compared product its own \"What is X?\" section. In a head-to-head, introduce both "
    + "briefly in the intro and spend the body on the comparison — a definition section is the piece "
    + "postponing the thing it exists to do.",
  "Do not build a section around cost when the answer is one number. State the price in a sentence "
    + "where the reader needs it.",
];

/** ── Evidence rules ─────────────────────────────────────────────────────────────────────────── */
export const EVIDENCE_RULES = [
  "A comparison tested on ONE prompt is not a comparison. Run six to eight prompts spanning different "
    + "use cases, and show the outputs — for a video model, embed the clips.",
  "When a piece shows several variations, run them as SEPARATE iterations. Asking a model for three "
    + "options in one prompt produces one confused image, not three usable ones.",
  "When a section covers output specifications, cover the platforms the reader actually publishes to "
    + "and list them: Amazon, Shopify, Etsy, Instagram, Facebook, a website hero. One generic "
    + "resolution answer serves nobody, because every one of those has its own requirement.",
  "Where a third-party roundup and our own official page disagree on a fact about us, the official "
    + "page is the one to publish. Say so plainly when correcting a widely-repeated third-party number: "
    + "the correction is itself worth reading.",
];

/** The block handed to the writer. */
export function editorialNote(): string {
  return [
    "## House rules from editorial review",
    "",
    "### Contrastive negation — the one to watch",
    "",
    "Do not write \"X, not Y\". \"The demand is measured, not theoretical\" is the exact construction "
      + "flagged as reading machine-written, and a sweep found it in most drafts: \"decoration, not "
      + "communication\", \"faster, not cheaper\", \"generated, not recovered\".",
    "",
    "It says the same thing twice, once positively and once negatively. Keep the positive half and stop: "
      + "\"The demand is measured.\" If the excluded thing matters, give it its own sentence and its own "
      + "reason. The same applies to \"not X, but Y\", \"it is not X; it is Y\", \"not just X, but Y\" "
      + "and \"less a X than a Y\". Aim for none in the whole article.",
    "",
    "### Structure",
    ...STRUCTURE_RULES.map((r) => `- ${r}`),
    "",
    "### Evidence",
    ...EVIDENCE_RULES.map((r) => `- ${r}`),
  ].join("\n");
}

/** Compressed reminder for the section turns. */
export function editorialReminder(): string {
  return (
    "No \"X, not Y\" constructions — keep the positive half and stop. Open the section with the "
    + "concrete thing (a number, a setting, a step), not a framing sentence. If the content is a list, "
    + "write it as a list."
  );
}
