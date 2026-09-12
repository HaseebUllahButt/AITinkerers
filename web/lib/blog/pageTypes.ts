// What KIND of article this is, and therefore what it has to contain to be worth publishing.
//
// A client-safe leaf: no database, no Strapi, no server imports. The judge picks from this list, the
// cannibalization gate reads the tier off it, and the writer is briefed from it.
//
// ── Where these came from ───────────────────────────────────────────────────────────────────────
//
// The SEO team's blog-types guide, supplied 2026-08-24. This file is that document made enforceable,
// so the rules below are theirs and the reasons attached to them are theirs too. An earlier version of
// this file was mine, written as a stopgap, and it got two things wrong that this one fixes:
//
//   It offered `explainer` ("what is X"), `news` and `pricing`. All three are now on the AVOID list —
//   the 15:00 slot on the day the guide arrived produced "What is vector art? A plain guide to paths,
//   formats and scaling", which is exactly the article the guide says Wikipedia already owns.
//
//   It described types by their SHAPE and said nothing about their EVIDENCE. The guide's whole thesis
//   is the opposite: what makes a post worth publishing is that it contains real Northwind output,
//   real prompts and firsthand observation. Every type below therefore carries an `evidence` rule, and
//   it is the part the writer is briefed on hardest.
//
// ── The load-bearing constraint ─────────────────────────────────────────────────────────────────
//
// See THE_ONE_TEST. It is not advice, it is the gate: an article that would read identically with
// another tool's name substituted has no reason to be on this blog.

/** The four intent classes. Transactional and navigational are page shapes a BLOG never has. */
export type IntentTier = "informational" | "commercial" | "transactional" | "navigational";

export interface BlogPageType {
  key: string;
  label: string;
  tier: IntentTier;
  /**
   * The sub-intent within the tier.
   *
   * Read by the cannibalization matrix, which says two pages at the same tier conflict only when the
   * SUB-intent matches — a "how to X" and an "X vs Y" can both exist, two "how to X" cannot.
   */
  subIntent: string;
  /** The shape the primary keyword must take. Rendered into the judge's prompt verbatim. */
  keywordShape: string;
  /** The slug formula for this type. */
  slugShape: string;
  /** What the piece is for, in one line. */
  brief: string;
  /**
   * What has to be IN it. The guide's DO rules, as instructions to the writer.
   *
   * Separate from `brief` because these are the checkable part: "step-by-step tied to Northwind's
   * actual interface, with the exact prompt used" is verifiable, "a useful how-to" is not.
   */
  evidence: string[];
  /** The guide's DON'T rules for this type. */
  avoid: string[];
  /**
   * Left out of the slot rotation.
   *
   * Not the same as banned: the team's note is "will improve most of the listicles, as of now we don't
   * need more listicles", which is a statement about INVENTORY rather than about quality. So the type
   * stays available for a candidate that genuinely calls for it and stops being offered by default.
   */
  deprioritised?: boolean;
}

/**
 * The types this pipeline may produce, in rotation order.
 *
 * Ordered to spread the evidence burden across the day rather than by importance: a model guide and a
 * comparison both need generations run against a specific model, and putting them in adjacent slots
 * would concentrate that work into one part of the day.
 */
export const BLOG_PAGE_TYPES: BlogPageType[] = [
  {
    key: "how-to",
    label: "How-to guide",
    tier: "informational",
    subIntent: "complete a task in Northwind",
    keywordShape: "how to <task> — the task, never the tool's own head term",
    slugShape: "how-to-<task>",
    brief:
      "A reader with the task in front of them, walked to a finished result inside Northwind.",
    evidence: [
      "Step by step against Northwind's actual interface: the specific model, the specific settings, "
        + "the exact prompt used, and the real output at each step.",
      "Step 1 covers the INPUTS and their specifications — which image, what resolution, what the "
        + "prompt has to contain. A guide that starts at step two assumes the reader already got the "
        + "hard part right.",
      "One paragraph of section intro, then numbered steps. Prose explaining what the steps will be, "
        + "before the steps, is the intro written twice.",
      "What goes wrong and how to fix it. This is the part a generic AI post never has, and it is the "
        + "reason this article can exist.",
    ],
    avoid: [
      "Steps generic enough to apply to any tool (\"open the tool, enter a prompt, generate\").",
      "Showing a finished output without the prompt that produced it.",
      "Describing a control the app does not have. A prompt box, a resolution picker and a length "
        + "selector have all been invented into walkthroughs before — see src/lib/blog/productFacts.ts.",
    ],
  },
  {
    key: "comparison",
    label: "Comparison",
    tier: "commercial",
    subIntent: "choose between named options",
    keywordShape: "<a> vs <b> — both named, never a bare category",
    slugShape: "<a>-vs-<b>",
    brief: "A head-to-head on a decision a reader is actually making right now.",
    evidence: [
      "SIX to EIGHT prompts spanning different use cases, the same prompt run on both sides, and the "
        + "outputs shown. One prompt is an anecdote; a spread is a comparison. For video models, embed "
        + "the clips.",
      "A decision table: choose X if…, choose Y if…",
      "Honesty about where the other side wins. If one tool is better on a dimension, say so plainly.",
    ],
    avoid: [
      "A comparison where Northwind wins every category. Readers notice and stop trusting the page.",
      "Comparing without testing. A pricing table with no quality assessment is not a comparison.",
      "Testing on a single prompt and generalising from it.",
      "Giving either side its own \"What is X?\" section. Introduce both briefly in the intro and spend "
        + "the body on the comparison — a definition section is the piece postponing the thing it "
        + "exists to do.",
    ],
  },
  {
    key: "model-guide",
    label: "Model or feature guide",
    tier: "commercial",
    subIntent: "evaluate and learn one named model",
    keywordShape: "<model> guide / what <model> does / <model> features — a model we actually run",
    slugShape: "<model>-guide",
    brief:
      "What this model does, when to reach for it, and what it costs — for someone deciding whether to "
      + "use it today.",
    evidence: [
      "Real outputs from the model: a hero image and inline examples, not just specifications.",
      "A side-by-side against another model using the same prompt. The guide calls this the single most "
        + "useful thing in any model guide.",
      "Actual credit cost per generation. A number, never \"Low/Medium/High\".",
    ],
    avoid: [
      "A spec sheet with no visual evidence.",
      "Corporate language — \"operationally significant\", \"enables use cases\". State what it means "
        + "practically.",
      "Describing a workflow theoretically instead of showing one real run of it.",
    ],
  },
  {
    key: "prompt-guide",
    label: "Prompt guide",
    tier: "informational",
    subIntent: "get better output from a named model",
    keywordShape: "<model> prompts / prompts for <outcome>",
    slugShape: "<model>-prompt-guide",
    brief: "Prompts that were actually run on Northwind, with the output as the evidence.",
    evidence: [
      "Every prompt tested, with its actual output shown. The generated image IS the evidence.",
      "Organised by use case AND by model — readers need to know which prompt works where.",
      "A weak prompt next to a strong one. The contrast is the value.",
    ],
    avoid: [
      "Prompts not tested on Northwind specifically.",
      "Prompts generic enough to work identically on Midjourney or DALL-E.",
    ],
  },
  {
    key: "use-case",
    label: "Use-case vertical guide",
    tier: "commercial",
    subIntent: "serve one audience's specific workflow",
    keywordShape: "ai <capability> for <audience or vertical>",
    slugShape: "ai-<capability>-for-<audience>",
    brief:
      "One named audience, and Northwind's workflow for the exact job they are trying to do.",
    evidence: [
      "A real example output for that use case — the product mockup, the social post, the headshot.",
      "The practical questions that audience actually asks: licensing, file format, batch size.",
    ],
    avoid: [
      "A generic \"AI is transforming X industry\" opener. Start with the workflow.",
      "Features that audience will never touch. A social media creator does not need MIDI export.",
    ],
  },
  {
    key: "alternatives",
    label: "Alternatives roundup",
    tier: "commercial",
    subIntent: "switch away from a named product",
    keywordShape: "<named product> alternatives",
    slugShape: "<product>-alternatives",
    brief: "For a reader already using something else and looking to move.",
    evidence: [
      "Every tool listed actually tested: a grade, a real output, or one specific honest observation each.",
      "Northwind assessed on the same framework as everything else, including a real con.",
      "A comparison table with actual pricing, not ranges.",
    ],
    avoid: [
      "Twenty tools at 150 generic words each. Pick seven to ten and go deep.",
      "Putting Northwind first in every row of the mapping table unless it genuinely wins that row.",
    ],
    deprioritised: true,
  },
  {
    key: "audience-roundup",
    label: "Best-of for a named role",
    tier: "commercial",
    // Distinct sub-intent from both neighbours, which is what keeps the cannibalisation matrix from
    // treating them as one page. `listicle` shortlists a CATEGORY ("best AI image generators") and is
    // deprioritised because we have enough of those. `use-case` teaches one audience a WORKFLOW. This
    // one answers "which should someone in my job pick", where the job is a real professional identity
    // — and that identity is the whole differentiator, because a graphic designer and a YouTuber
    // shortlist the same category completely differently.
    subIntent: "choose a tool as a named professional",
    keywordShape:
      "best <category> for <role> — the ROLE is required and must be a real job somebody puts on a "
      + "CV, not a vague segment. \"for graphic designers\" yes; \"for creatives\", \"for professionals\", "
      + "\"for businesses\" no, because those collide straight back into the category page.",
    slugShape: "best-<category>-for-<role>",
    brief:
      "A shortlist written for one professional identity, judged on the criteria that role actually "
      + "buys on. Third person — the first-person version of this is the practitioner type.",
    evidence: [
      "The role's real selection criteria stated up front, and they must be that role's: a designer "
        + "cares about text rendering, brand palette control and vector-ready output; a video editor "
        + "cares about duration, consistency across shots and whether the result survives a grade.",
      "Every tool actually tested on the SAME brief, with the output shown.",
      "Northwind assessed on the same framework as everything else, including a real con.",
      "A recognisable working detail — the file format they hand over, the client round, the deadline. "
        + "Somebody in that role should recognise their own week in the first paragraph.",
    ],
    avoid: [
      "A generic roundup with the role's name pasted into the title and nothing in the body that is "
        + "specific to them. That is the deprioritised listicle wearing a costume.",
      "A vague audience. \"For creatives\" is not a role and does not narrow the intent.",
      "First person. This type is third person; the lived-experience version is `practitioner`.",
      "Untested entries, or Northwind winning every category.",
    ],
  },
  {
    key: "practitioner",
    label: "First-person practitioner post",
    tier: "informational",
    // Its own sub-intent on purpose. A practitioner post and a how-to can both exist on the same
    // feature without cannibalising: one answers "how do I do this", the other answers "is this
    // actually any good for work like mine", and they win different queries.
    subIntent: "hear from someone who does this for a living",
    keywordShape:
      "the practitioner's problem, not the tool's head term — \"<role> workflow\", \"<task> for <role>\", "
      + "\"how <role>s use <feature>\". Never a bare product term.",
    slugShape: "<feature-or-task>-for-<role>  |  how-<role>s-use-<feature>",
    brief:
      "A working creative describing how Northwind changed a job they actually do. The one type that is "
      + "openly ours, where admitted friction is what makes the advocacy believable.",
    evidence: [
      "Written as a specific role from src/lib/blog/practitioner.ts, using that trade's vocabulary correctly.",
      "Opens on a working problem a peer recognises, before Northwind is named at all.",
      "At least one failure admitted in detail — the attempt that did not work and the change that fixed it.",
      "The specifics the genre normally omits: the model, the exact prompt, the settings, the number of "
        + "attempts, roughly how long it took.",
      "Tone read from real current creative Substacks in the same session, not from memory of the register.",
      "The feature verified in the product, and — for a new one — traced to #imagine-general rather than assumed.",
    ],
    avoid: [
      "An invented named person, client, employer, award or statistic. The role is the byline; a rough honest "
        + "timing beats a precise invented one.",
      "Uniform delight. A piece with no friction in it is an advertisement and reads as one.",
      "Company voice. \"We\" anywhere in the body collapses the conceit.",
      "Engagement furniture: \"Let that sink in\", stacked rhetorical questions, a closing call to action.",
      "A listicle where a narrative belongs. This type is prose.",
    ],
  },
  {
    key: "listicle",
    label: "Best-of roundup",
    tier: "commercial",
    subIntent: "shortlist a category",
    keywordShape: "best <category> for <use case> — the use case is what stops it colliding with the category page",
    slugShape: "best-<category>-for-<use-case>",
    brief: "A shortlist a reader can act on, with the selection criteria stated up front.",
    evidence: [
      "Every tool listed actually tested.",
      "Northwind assessed on the same framework as everything else, including a real con.",
      "A comparison table with actual pricing, not ranges.",
    ],
    avoid: [
      "Twenty tools at 150 generic words each. Pick seven to ten and go deep.",
      "Untested entries. A roundup with no testing has no credibility.",
    ],
    deprioritised: true,
  },
];


/**
 * Professional identities worth writing for.
 *
 * A roster rather than free choice, because the failure mode of audience-targeted content is a title
 * that names a demographic the body never serves. Every entry here is a real job with a real buying
 * criterion, and most of them are visible in the product's own traffic: interior design, children's
 * book illustration, YouTube thumbnails, product photography and event posters all turn up repeatedly
 * in live prompts.
 *
 * `buysOn` is the load-bearing field. It is what makes the piece about the role rather than about the
 * category, and it is the thing a generic roundup cannot fake.
 */
export interface CreativeAudience {
  role: string;
  buysOn: string;
}

export const CREATIVE_AUDIENCES: CreativeAudience[] = [
  { role: "graphic designers", buysOn: "legible text in-image, brand palette control, output that survives being placed in a layout" },
  { role: "video editors", buysOn: "clip length, shot-to-shot consistency, whether the result holds up after a colour pass" },
  { role: "interior designers", buysOn: "keeping the client's actual room — windows, ceiling height, door swing — while changing the finish" },
  { role: "illustrators", buysOn: "character consistency across many images, line and palette control" },
  { role: "YouTubers and short-form creators", buysOn: "thumbnail text legibility at small sizes, turnaround per upload, channel-consistent style" },
  { role: "e-commerce sellers", buysOn: "the product surviving the edit exactly — label, colour, proportions — and on-white plus lifestyle from one shot" },
  { role: "social media managers", buysOn: "volume, per-platform aspect ratios, and staying on brand across a month of posts" },
  { role: "photographers", buysOn: "retouching that keeps identity, batch consistency, and resolution that stands up to print" },
  { role: "real estate agents", buysOn: "staging a room that still is the room, and speed per listing" },
  { role: "marketing teams", buysOn: "brand consistency across a campaign set, licensing clarity, and rounds of client revision" },
  { role: "small business owners", buysOn: "cost per asset and getting something usable without design skill" },
  { role: "teachers and educators", buysOn: "classroom-appropriate output, speed, and being free or cheap" },
  { role: "game developers", buysOn: "asset consistency within an art style, and usable transparency or tiling" },
  { role: "musicians and podcasters", buysOn: "cover art at platform specs, and something that matches a release identity" },
];

/** The roster as one line, for the judge's prompt. */
export function describeAudiences(): string {
  return CREATIVE_AUDIENCES.map((a) => `  - ${a.role} — buy on: ${a.buysOn}`).join("\n");
}

export const PAGE_TYPE_KEYS = BLOG_PAGE_TYPES.map((t) => t.key);

export function pageType(key: string | null | undefined): BlogPageType | null {
  if (!key) return null;
  const k = key.trim().toLowerCase();
  return BLOG_PAGE_TYPES.find((t) => t.key === k) ?? null;
}

/**
 * THE test, applied before anything else.
 *
 * Quoted from the guide because paraphrasing it would soften it, and the softened version is what the
 * pipeline was already doing.
 */
export const THE_ONE_TEST =
  "Can we put real Northwind-generated images, specific prompts, and firsthand observations in this — "
  + "content that couldn't exist if we swapped Northwind out for another tool? If yes: write it. If no: "
  + "it does not belong on the Northwind blog at all.";

/**
 * Article shapes this pipeline must not produce, with the team's reason for each.
 *
 * Reasons included on purpose. A bare ban gets worked around by a model that finds a technically
 * compliant framing — "What is vector art" becomes "Understanding vector art" and ships anyway. The
 * reason is what makes the rule generalise.
 */
export const AVOID = [
  "\"What is X\" explainers — no Northwind angle, and Wikipedia and established sites already own these.",
  "AI trends and predictions — off-topic for Northwind's authority, and no original substance is possible.",
  "News recaps — Northwind is not a news site and will not win on speed. A newly released model is "
    + "still worth covering, but as a model guide or a comparison with real generations in it, never as a "
    + "restatement of the announcement.",
  "Roundups without real testing — twenty tools at 200 words each has no credibility.",
  "General productivity or marketing strategy — dilutes topical authority.",
] as const;

/**
 * ── The two rules that hold for EVERY type on this list ────────────────────────────────────────
 *
 * Constants rather than per-type flags because there is no blog page type they do not apply to. A blog
 * on this site never owns a transactional head term: the feature page does. Writing either rule as a
 * field would invite a future type to set it to `false`, which is precisely the mistake the first
 * eleven posts made.
 */
export const HEAD_TERM_RULES = [
  "The primary keyword must never be a head term a feature, app or tool page already owns. That page "
    + "is the one that should rank for it.",
  "The head term must never open the title or the H1. It may appear later in the body, in a sentence "
    + "that links to the page that owns it.",
] as const;

/**
 * Which type this slot should lean towards, so six posts a day are not six of the same shape.
 *
 * A PREFERENCE and not a constraint: the judge is told to favour this type and allowed to pick another
 * when the day's candidates do not support it. A hard rotation would mean a slot with no comparison
 * worth writing either writes a bad one or writes nothing, and both are worse than a good how-to.
 *
 * Deprioritised types are excluded — they stay pickable, they just stop being suggested.
 */
export function preferredType(slotIndex: number, day = Math.floor(Date.now() / 86_400_000)): BlogPageType {
  const pool = BLOG_PAGE_TYPES.filter((t) => !t.deprioritised);
  const n = pool.length;
  return pool[(((day + slotIndex) % n) + n) % n];
}

/**
 * Guess the type from a title, for callers that do not declare one.
 *
 * Read off the TITLE and not the slug, for the same reason slugGuide.contentTypeOf does it: the slug is
 * frequently the thing under review, so inferring intent from it would only ever agree with whatever was
 * proposed.
 *
 * Ordered most-specific first. `how-to` is the fallback because it is the broadest shape — and because
 * the types it would previously have fallen through to (`explainer`, `news`) no longer exist.
 */
export function inferPageType(title: string): string {
  const t = (title ?? "").toLowerCase();
  const ROLE = "designers?|editors?|illustrators?|creators?|photographers?|marketers?|agents?"
    + "|teachers?|developers?|musicians?|podcasters?|sellers?|managers?|youtubers?|architects?";

  if (/\bvs\.?\b|\bversus\b/.test(t)) return "comparison";
  if (/\balternatives?\b/.test(t)) return "alternatives";
  if (/\bprompt(ing)? (guide|tips)\b|\bprompts\b/.test(t)) return "prompt-guide";

  // Ordered above `listicle` deliberately. "Best AI logo generators for graphic designers" matches
  // both, and the role is what makes it the narrower, non-colliding page — so the role wins. Below
  // this line a bare "best …" is still the deprioritised generic roundup.
  if (/\b(best|top \d+)\b/.test(t) && new RegExp(`\\bfor [a-z ]*\\b(${ROLE})\\b`).test(t)) return "audience-roundup";

  // Practitioner is inferred from LIVED-EXPERIENCE markers only. It deliberately does not claim every
  // "<capability> for <role>" title: that shape is the use-case type's own keyword shape, and letting
  // practitioner take it would silently convert every vertical guide into a first-person piece.
  if (/\bhow (i|we) \b|\bi (tried|tested|switched|replaced|spent|stopped)\b|\bmy (workflow|process|week|setup)\b/.test(t)) return "practitioner";
  // "how video editors use …" — the role is usually qualified ("video" editors, "graphic" designers),
  // so the qualifier has to be allowed between "how" and the role or the branch never fires.
  if (new RegExp(`\\bhow [a-z ]*\\b(${ROLE})\\b [a-z ]*\\buse\\b`).test(t)) return "practitioner";

  if (/\bbest\b|\btop \d/.test(t)) return "listicle";
  if (/\bfor (e-?commerce|marketers|creators|agencies|teams|developers|realtors|educators)\b|\bfor (small )?business\b/.test(t)) return "use-case";
  if (new RegExp(`\\bfor [a-z ]*\\b(${ROLE})\\b`).test(t)) return "use-case";
  if (/\bguide\b|\bexplained\b|\bwhat it does\b|\bfeatures\b|\breview\b/.test(t)) return "model-guide";
  return "how-to";
}

/** The type list as the judge sees it, with the evidence each one owes. */
export function describeTypes(): string {
  return BLOG_PAGE_TYPES.map((t) => {
    const lines = [
      `### ${t.key} — ${t.label}${t.deprioritised ? "  [DEPRIORITISED: we have enough of these; pick only if a candidate genuinely demands it]" : ""}`,
      `${t.tier}, "${t.subIntent}". Keyword: ${t.keywordShape}. Slug: ${t.slugShape}.`,
      t.brief,
      "Must contain:",
      ...t.evidence.map((e) => `  - ${e}`),
      "Must not:",
      ...t.avoid.map((a) => `  - ${a}`),
    ];
    return lines.join("\n");
  }).join("\n\n");
}
