// Checkable facts about our own product, and the rule that stops the writer inventing more.
//
// A client-safe leaf: no database, no Strapi.
//
// ── Why this file exists ────────────────────────────────────────────────────────────────────────
//
// Editorial review of the interior-design article on 2026-09-08 found the writer describing controls
// the app does not have and omitting the ones it does:
//
//   - it wrote a prompt box into the interior-design VIDEO app, which has none
//   - it offered a choice of resolution and clip length, neither of which that app exposes
//   - it never mentioned the room-type selector or the room-type reference upload, which are the two
//     controls that actually decide the output
//
// None of that is a writing problem. Every sentence was fluent and every one was wrong, and a reader
// who opens the app finds a different product. It is the same failure as an invented benchmark, and
// it is more likely, because a plausible UI is easier to imagine than a plausible number.
//
// So the interfaces we write about most are written down. This list is short on purpose: a fact here
// is one somebody checked, and a long list nobody maintains is worse than none.

export interface SurfaceFacts {
  surface: string;
  path?: string;
  /** Controls the interface really exposes. */
  controls: string[];
  /** Controls it does NOT have, listed because the writer has invented these. */
  absent: string[];
  notes?: string[];
}

export const SURFACE_FACTS: SurfaceFacts[] = [
  {
    surface: "Interior design (image)",
    controls: [
      "Upload a photo of the real room",
      "Select the room type",
      "Upload a reference image for the room type",
      "A prompt describing the restyle",
    ],
    absent: [],
    notes: [
      "Generate variations as SEPARATE iterations. Asking for three options in one prompt returns one "
        + "confused image; three runs return three usable ones.",
      "The job is editing the client's actual room — keeping windows, ceiling height and door swing — "
        + "rather than generating a nicer room.",
    ],
  },
  {
    surface: "Interior design (video)",
    controls: [
      "Upload the chosen image",
      "Select the camera angle",
      "Generate",
    ],
    absent: [
      "A prompt box — there is none; the camera angle is the only direction you give it",
      "A resolution picker",
      "A clip-length picker",
    ],
    notes: ["Output is a short clip, on the order of 5 or 10 seconds."],
  },
];

/**
 * ── Pricing ─────────────────────────────────────────────────────────────────────────────────────
 *
 * Third-party roundups list Basic at $9 a month and that is wrong in a way worth correcting in
 * public: $9 is the effective monthly rate on ANNUAL billing, which is $108 charged upfront. The
 * monthly price is $13.
 *
 * The credit-expiry line matters more than the price to anyone budgeting: subscription credits expire
 * at each monthly renewal and never roll over, so a plan sized for your busiest month is money left
 * unspent in your quietest one.
 *
 * Verified against our own plan pricing and subscription documentation, 2026-09-08. If these change,
 * change them here rather than in an article.
 */
export const PRICING = {
  basicMonthlyUsd: 13,
  basicYearlyUpfrontUsd: 108,
  basicYearlyEffectiveMonthlyUsd: 9,
  creditsRollOver: false,
  verifiedOn: "2026-09-08",
} as const;

export const PRICING_RULES = [
  `Basic is $${PRICING.basicMonthlyUsd} a month. $${PRICING.basicYearlyEffectiveMonthlyUsd} is the `
    + `effective monthly rate on yearly billing only, at $${PRICING.basicYearlyUpfrontUsd} upfront.`,
  "Third-party pricing roundups repeat the $9 figure as if it were the monthly price. Where a third "
    + "party and our own official page disagree, publish the official page — and say that the widely "
    + "repeated number is the annual rate, because the correction is useful to the reader.",
  "Subscription credits expire at monthly renewal and never roll over. Worth saying whenever the piece "
    + "helps somebody choose a plan.",
  "Do not build a section around cost. State the number in the sentence where the reader needs it.",
];

/** Facts for one surface, by loose name match. */
export function surfaceFacts(name: string): SurfaceFacts | undefined {
  const n = name.trim().toLowerCase();
  return SURFACE_FACTS.find((s) => s.surface.toLowerCase().includes(n) || n.includes(s.surface.toLowerCase()));
}

/**
 * The rule, which matters more than the list.
 *
 * The list will always be incomplete. What has to hold for every surface is that the writer describes
 * an interface it has actually seen.
 */
export const UI_ACCURACY_RULES = [
  "Never describe a control you have not confirmed exists. A prompt box, a resolution picker, a length "
    + "selector and a quality toggle are the four the writer has invented before — every one fluent, "
    + "every one absent from the app.",
  "Never omit the controls that decide the output. For the interior-design app that is the room-type "
    + "selector and the room-type reference upload; a walkthrough without them describes a different "
    + "product.",
  "If you cannot confirm what an interface offers, write the outcome rather than the click path, and "
    + "say the steps need checking against the live app. A vague accurate paragraph beats a precise "
    + "wrong one.",
  "An invented control is the same class of error as an invented benchmark, and likelier — a plausible "
    + "UI is easier to imagine than a plausible number.",
];

/** The block handed to the writer when a piece walks through one of our interfaces. */
export function productFactsNote(surface?: string): string {
  const picked = surface ? surfaceFacts(surface) : undefined;
  const list = picked ? [picked] : SURFACE_FACTS;
  const lines = ["## What our interfaces actually do", ""];
  for (const s of list) {
    lines.push(`### ${s.surface}`, "", "Controls it has:");
    lines.push(...s.controls.map((c) => `- ${c}`));
    if (s.absent.length) {
      lines.push("", "Controls it does NOT have — do not write these in:");
      lines.push(...s.absent.map((c) => `- ${c}`));
    }
    if (s.notes?.length) {
      lines.push("", ...s.notes.map((n) => `- ${n}`));
    }
    lines.push("");
  }
  lines.push("Rules:", ...UI_ACCURACY_RULES.map((r) => `- ${r}`));
  lines.push("", "Pricing:", ...PRICING_RULES.map((r) => `- ${r}`));
  return lines.join("\n");
}
