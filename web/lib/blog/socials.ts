// Northwind's own social accounts, and when an article has earned the right to link one.
//
// A client-safe leaf: no database, no Strapi, no server imports. The blog writer, Summer and the
// validator all read from here, so there is exactly one place a handle can be wrong.
//
// ── Where these came from ───────────────────────────────────────────────────────────────────────
//
// Lifted from the footer of the shipped lifecycle and broadcast emails (the imagine-email-design
// skill), which is the only place in our tooling that already had the canonical set. They are
// identical across every example there, so this is the list marketing actually sends to users rather
// than one assembled from memory.
//
// TikTok appears in that skill only as a note about its icon rendering badly — there is no account URL
// on record, so there is no TikTok entry here. A platform with no verified URL is worse than a missing
// one: the model would fill the gap with a plausible handle.
//
// ── Why a relevance rule per platform, and not one "follow us" block ────────────────────────────
//
// The obvious implementation is a footer row of six icons on every post. That is worth nothing: the
// blog template already carries the site footer, the links are boilerplate a reader skips, and six
// outbound links repeated across 750 posts is a pattern search engines read as a farm rather than as
// a recommendation.
//
// A link is worth something when the sentence around it does work — "if a generation comes out wrong,
// the Discord is where people post prompts that fixed it" is a reason to click. So each entry below
// carries the specific editorial situation that earns it, and the writer is told that ZERO is the
// right number when none of those situations is present.

export interface Social {
  platform: string;
  /** The canonical URL. Never a deep link — see the note on fabrication in `SOCIALS_RULES`. */
  url: string;
  handle: string;
  /** The editorial situation that earns this link. Written to be read by the model verbatim. */
  whenRelevant: string;
}

export const SOCIALS: Social[] = [
  {
    platform: "Discord",
    url: "https://discord.gg/z7kjUyvAbv",
    handle: "the Northwind Discord",
    whenRelevant:
      "The article leaves the reader somewhere something can go wrong — a generation that came out "
      + "distorted, a prompt that will not behave, a setting whose effect is hard to predict. The "
      + "Discord is where people post the prompt that fixed it. Best placed in a troubleshooting or "
      + "'what goes wrong' section, which how-tos are required to have anyway.",
  },
  {
    platform: "Reddit",
    url: "https://www.reddit.com/r/ImagineAiArt/",
    handle: "r/ImagineAiArt",
    whenRelevant:
      "The piece is about prompting or style, and seeing what other people got from the same model is "
      + "genuinely useful — a prompt guide, or a section on style variation.",
  },
  {
    platform: "YouTube",
    url: "https://www.youtube.com/@northwindofficial",
    handle: "the Northwind YouTube channel",
    whenRelevant:
      "The workflow is one a reader would rather watch than read: a multi-step walkthrough through the "
      + "interface, or a video feature where the result is motion and a still cannot show it.",
  },
  {
    platform: "X",
    url: "https://x.com/Northwind_X",
    handle: "@Northwind_X",
    whenRelevant:
      "The article covers something that is still moving — a model that just shipped, a capability in "
      + "rollout, a version whose limits are still being published. Suits model guides and comparisons, "
      + "where 'this is where the next change gets announced' is a real service to the reader.",
  },
  {
    platform: "Instagram",
    url: "https://www.instagram.com/northwindofficial/",
    handle: "@northwindofficial",
    whenRelevant:
      "The subject is visual output as inspiration rather than as instruction — style, composition, "
      + "before-and-after. A reader wanting to see more of what the tool produces is served by it.",
  },
  {
    platform: "LinkedIn",
    url: "https://www.linkedin.com/company/northwindai/",
    handle: "Northwind on LinkedIn",
    whenRelevant:
      "The audience is professional rather than hobbyist — an agency, a marketing team, an ecommerce "
      + "operation. Use-case guides written for a business audience, and nothing else.",
  },
];

/** Every canonical social URL. The allowlist the provenance gate needs. */
export const SOCIAL_URLS: string[] = SOCIALS.map((s) => s.url);

const SOCIAL_HOSTS = new Set(
  SOCIALS.map((s) => {
    try { return new URL(s.url).host.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
  }).filter(Boolean),
);

/**
 * How many social links one article may carry.
 *
 * Two. One is the normal answer and two is the ceiling for a piece that genuinely serves two different
 * needs — a video walkthrough and a troubleshooting section, say. Past that it stops reading as a
 * recommendation and starts reading as a footer that wandered into the body.
 */
export const MAX_SOCIAL_LINKS = 2;

/** Social links found in a markdown body, canonical or not. */
export function socialLinksIn(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
    try {
      if (SOCIAL_HOSTS.has(new URL(m[1]).host.replace(/^www\./, "").toLowerCase())) out.push(m[1]);
    } catch { /* not a URL we can parse; the provenance gate will have it */ }
  }
  return out;
}

/** True when the URL is one of ours rather than somebody else's page on the same platform. */
export function isOurSocial(url: string): boolean {
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  return SOCIAL_URLS.some((s) => norm(s) === norm(url));
}

/** The rules, shared verbatim between the blog writer and Summer so they cannot drift apart. */
export const SOCIALS_RULES = [
  `At most ${MAX_SOCIAL_LINKS} of these in an article, and zero is the right number when none of the `
    + "situations above is present. An article that had nothing to say about the community and links the "
    + "Discord anyway has spent a link and earned nothing.",
  "Inline, in a sentence that does the work. Never a \"Follow us\" block, never a row of platform names, "
    + "never a heading about our socials. The published page already has the site footer; repeating it in "
    + "the body is what makes the link worthless.",
  "Only the exact URLs listed. A link to a specific tweet, video, post or thread is a fabrication unless "
    + "a research tool returned that URL this session — and a deep link that rots is worse than no link.",
  "Never state a follower count, a member count, how active a community is, or that something is "
    + "\"trending\" there. None of that is measured and all of it ages badly.",
  "No tracking parameters. Bare URLs.",
] as const;

/**
 * The compact form, for the writing turns.
 *
 * The full note is handed over once, while the link plan is being made. Restating all six relevance
 * rules on every write turn would be a thousand characters per turn to re-decide something already
 * decided — but saying nothing is worse, because this module's sibling (prompt.ts) records that an
 * approved link plan stopped being salient by writing time and produced an article with zero links.
 * So the URLs and the two rules that are easy to break travel with every turn; the reasoning does not.
 */
export function socialsReminder(): string {
  return [
    "<our_socials>",
    `Ours, if one genuinely fits the sentence you are writing (max ${MAX_SOCIAL_LINKS} in the article, `
      + "zero is fine, inline only — never a \"Follow us\" block or a heading):",
    ...SOCIALS.map((s) => `  ${s.platform}: ${s.url}`),
    "Only these exact URLs. A link to a specific post or video is a fabrication.",
    "</our_socials>",
  ].join("\n");
}

/**
 * The block handed to a model.
 *
 * One renderer for both consumers. Two prompts describing the same six accounts in slightly different
 * words is how one of them ends up with a stale handle.
 */
export function socialsNote(): string {
  return [
    "<our_socials>",
    "Our own accounts. Link one only where the sentence around it genuinely helps the reader:",
    "",
    ...SOCIALS.map((s) => `- ${s.platform} — ${s.url} (${s.handle})\n    When: ${s.whenRelevant}`),
    "",
    "Rules:",
    ...SOCIALS_RULES.map((r, i) => `${i + 1}. ${r}`),
    "</our_socials>",
  ].join("\n");
}
