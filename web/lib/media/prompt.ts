// Building the image prompt.
//
// The single most transferable lesson from forge, and it is counterintuitive:
//
//   **Negatives for GPT Image 2. Positives for Nano Banana.**
//
// forge's own comment, from the avatar prompt it had to rewrite:
//
//   "Nano Banana / Gemini image models read negatives weakly and tend to *draw* whatever you name, so
//    the old prompt's 'no phone, no recording timer, no record button, no app icons' was producing
//    exactly a phone-selfie-recording frame (status bar, 00:00 timer, capture button). A rich positive
//    description of a professional headshot leaves no room for a device or UI."
//
// Whereas its GPT Image 2 director states plainly: "Negatives are honoured strongly."
//
// So the same unwanted outcome needs two opposite prompt strategies. Getting this backwards actively
// summons the thing you are trying to avoid, which is why it is the first thing in this file.
//
// The second lesson: a batch does not diverge on its own. forge found that "the director's own
// 'randomly select' never diverges across near-identical calls on the same prompt" — so variety has to
// be locked per slot, in code. See STYLE_AXES.
import { isGptImage } from "./fal";
import type { PlannedAsset } from "./plan";

/**
 * Locked style axes. One is assigned per batch slot so N images genuinely differ.
 *
 * Kept deliberately editorial rather than photographic: these images sit next to prose on a
 * publisher-style page, and a stock-photo look reads as filler.
 */
export const STYLE_AXES = {
  // ── Measured from the reference set the team actually wants ────────────────────────────────────
  //
  // Six campaign images were handed over as "this is the vibe". What they share is specific enough
  // to prompt for, and none of it is "editorial restraint", which is what these axes used to say:
  //
  //   · a SATURATED two-colour palette, usually complementary — pink against blue, red against blue,
  //     butter yellow against sky. Not muted, not tonal, not one colour with accents.
  //   · HARD directional light throwing real geometric shadows. Soft even studio light is what makes
  //     an image read as a stock photo, and every reference avoids it.
  //   · the product OVERSIZED and centred, often shot from below so it towers.
  //   · staging that is quietly impossible — objects suspended mid-air, stacked on fruit, balanced on
  //     a swing, a bottle the size of an aircraft. The surrealism is the craft signal.
  //
  // "1 of 4"-style batch words and generic renders are what these replace.
  worlds: [
    "a saturated two-colour set, complementary — blush pink against a clear sky blue — with hard sunlight and sharp geometric shadows",
    "an architectural colour-block interior: coloured walls, an arch or a doorway, one strong shaft of daylight across the floor",
    "a clean seamless sweep in one confident colour, the subject lit hard from one side so the shadow is part of the composition",
    "a bright open sky with soft cloud, the subject suspended against it, colours pushed warm and pastel",
    "a glossy tabletop in a single saturated colour, reflections under the subject, light raking from one side",
  ],
  compositions: [
    "the subject oversized and centred, shot from slightly below so it dominates the frame",
    "the subject held or reached toward by a hand entering frame, forced perspective, fingers near the lens",
    "objects suspended in mid-air around the subject, caught as if dropped a moment ago",
    "the subject balanced improbably on stacked objects, the whole tower centred with air above it",
    "an overhead flat-lay, objects arranged with deliberate spacing on a coloured ground",
  ],
  treatments: [
    "editorial campaign photography, sharp throughout, colour graded with real contrast",
    "clean product 3D render, matte and glossy surfaces, soft global illumination with one hard key",
    "high-craft studio still life, macro-sharp on the product, shallow fall-off behind it",
    "playful physics photography — motion, suspension, things caught mid-fall",
    "glossy commercial CGI, oversaturated, toy-like scale play",
  ],
} as const;

/** Assign axes by slot so a batch diverges. The composition index is offset so it does not track the
 *  world one-to-one, which is what makes variations feel like different executions rather than one
 *  dial being turned. */
export function axesForSlot(slot: number): { world: string; composition: string; treatment: string } {
  return {
    world: STYLE_AXES.worlds[slot % STYLE_AXES.worlds.length],
    composition: STYLE_AXES.compositions[(slot * 2) % STYLE_AXES.compositions.length],
    treatment: STYLE_AXES.treatments[slot % STYLE_AXES.treatments.length],
  };
}

/**
 * Where the image will live. This is the single highest-leverage input, which is why it exists as its
 * own field rather than something you have to describe in prose every time.
 *
 * A blog hero and a landing-page hero are not the same job. A blog image sits next to 2,000 words of
 * editorial and its job is to look considered and not interrupt reading — restraint reads as quality
 * there, and a glossy product shot reads as an ad someone dropped into an article. A landing-page image
 * IS the pitch: it has to look expensive, lead the eye to one thing, and hold up beside a Buy button.
 * The same "clean 3D render" direction produces the right image for one and the wrong image for the
 * other, so the surface has to change the art direction, not just the caption.
 *
 * Defaults to blog: it is the more conservative of the two, and an over-restrained landing image is a
 * milder failure than a salesy blog image.
 */
export type AssetSurface = "blog" | "landing";

interface SurfacePreset {
  /** One line naming the register, prepended so it frames everything after it. */
  register: string;
  /** Which STYLE_AXES worlds suit this surface. Indices into STYLE_AXES.worlds. */
  worlds: number[];
  /** Which treatments suit it. Indices into STYLE_AXES.treatments. */
  treatments: number[];
  /** Extra art direction, surface-specific. */
  direction: string[];
}

/**
 * Hand-tuned per surface. These are the presets that make a two-word prompt sufficient: the operator
 * says "seedance 2.5 launch" and the surface supplies the register, the palette range, the composition
 * discipline and the things to avoid.
 */
const SURFACE_PRESETS: Record<AssetSurface, SurfacePreset> = {
  blog: {
    // ── MEASURED, not designed ────────────────────────────────────────────────────────────────
    //
    // This preset used to describe an editorial illustration: quiet grounds, illustration and
    // isometric diagram ahead of photography, muted restraint. Then the live blog images were
    // actually looked at, and none of them are that. Three archetypes, all photographic:
    //
    //   /blogs/best-ai-website-builders     hero, 5504x3072. Near-white room, a real person at a
    //                                       laptop, three product UI panels floating in perspective
    //                                       to her right, and the article title set across the top
    //                                       in heavy black sans.
    //   /blogs/tiktok-ad-hooks              body, 1376x768. A flat saturated yellow interior, one
    //                                       expressive person mid-gesture to a phone on a tripod,
    //                                       glassy rounded app icons floating around their head.
    //   /blogs/tiktok-ad-hooks (second)     body, 3840x2160. Overhead flat-lay on marble, a phone
    //                                       rendered pin-sharp showing a real content grid, story
    //                                       cards fanned around it, one cohesive blush palette.
    //
    // Not one vector illustration, not one isometric diagram, not one muted editorial still. Asking
    // for those was producing images that could not sit next to the real ones, so the preset now
    // describes what the house actually publishes.
    register:
      "This is a campaign image, made for one specific article. It has the production value of a " +
      "commissioned shoot: real light with real shadows, one confident colour idea, and a subject " +
      "staged rather than merely photographed.",
    // Saturated and architectural first. The measured reference set is bold colour with hard light,
    // not the quiet grounds this used to prefer.
    worlds: [0, 1, 2, 3, 4],
    treatments: [0, 1, 2, 3],
    direction: [
      "One confident colour idea, two colours at most, usually complementary. Push the saturation.",
      "Hard directional light. The shadows are part of the composition, with clean geometric edges.",
      // The single most transferable thing about the reference set, and the hardest to get by asking
      // for "creative": the staging is quietly impossible. That is what separates it from stock.
      "Stage it. Suspend it, stack it, balance it, scale it wrong, reach into frame for it — the " +
      "image should be a small impossible moment rather than an object on a table.",
      "The subject is oversized and unmistakably the point, often shot from slightly below.",
      "Composed so it still reads at 640px wide in a body column.",
    ],
  },
  landing: {
    register:
      "This is the hero visual for a product landing page. It carries the pitch: it should look " +
      "expensive and confident, and lead the eye to one focal subject.",
    // Clean light studio is IN this list on purpose, not an oversight. Before this, landing worlds
    // were dark premium / brand saturated / gradient wash only — three ways to end up with the exact
    // failure the imagine-lp-assets skill names as the commonest one: "a set of near-black cards with
    // violet glows." Measured against real ImagineArt surfaces, the app shell, homepage rails and
    // feature pages run white / lavender-white / cream; dark is a register earned by cinematic film
    // content, not the default register for "premium." Light stays first in the list — the common
    // case, not the exception — with dark/saturated still available for launches and film-adjacent
    // pages where that register is actually earned.
    worlds: [0, 1, 2, 4],
    // Render and photography first: a landing image sells a made thing.
    treatments: [1, 0, 4, 2],
    direction: [
      "Premium and deliberate. Strong single focal subject, clear depth, confident lighting.",
      "Leave one uncluttered region where headline copy and a button will sit on top.",
      "Higher contrast and richer saturation than an editorial image, held within a controlled palette.",
      "It must hold up as the largest element on the page at full desktop width.",
    ],
  },
};

/** Pick axes for a slot, constrained to the ones that suit this surface. Divergence still comes from
 *  the slot index — it just diverges within the range that is right for where the image will live. */
function surfaceAxes(surface: AssetSurface, slot: number): { world: string; composition: string; treatment: string } {
  const preset = SURFACE_PRESETS[surface];
  const w = preset.worlds[slot % preset.worlds.length];
  const t = preset.treatments[slot % preset.treatments.length];
  return {
    world: STYLE_AXES.worlds[w],
    // Composition is surface-agnostic; offset by 2 so it does not track the world one-to-one.
    composition: STYLE_AXES.compositions[(slot * 2) % STYLE_AXES.compositions.length],
    treatment: STYLE_AXES.treatments[t],
  };
}

/**
 * The negatives clause. GPT Image 2 only — naming these to Nano Banana would draw them.
 *
 * Every entry is a failure forge actually shipped and then had to forbid.
 */
const GPT_NEGATIVES = [
  "no borders, frames, gutters, seams, dividing lines or rounded canvas corners",
  "no watermarks, badges, page numbers, or 'N of M' counters",
  // Every internal planning word eventually gets rendered as visible text unless it is forbidden by
  // name. These are OUR vocabulary for describing an image, not copy that belongs on one — forge had to
  // forbid each of them after seeing it painted onto a canvas.
  "no words 'hero', 'thumbnail', 'social card', 'inline', 'HOOK', 'CTA', 'BENEFIT', 'STEP', 'SLIDE', "
  + "'variation' or 'draft' appearing as text in the image",
  "no gibberish, misspelled or lorem-ipsum text",
  "no invented company names, logos, wordmarks or app icons of any kind",
  "no stock-photo clichés: no handshakes, no people pointing at charts, no lightbulb-as-idea",
  "no more than three type layers",
  "nothing at equal focal weight competing with the subject",
].join("; ");

/** Text is allowed on a social card and nowhere else — see plan.ts for why. */
const NO_TEXT_POSITIVE =
  "The image is purely visual: it communicates entirely through colour, light, staging and the subject " +
  "itself. Any lettering that appears belongs to a product's own printed packaging and nothing more.";
const NO_TEXT_NEGATIVE =
  "no text, lettering, captions, headlines, watermarks, labels, callouts, numbers, UI copy, logos or " +
  "typography of any kind anywhere in the image — lettering printed on a product's own packaging is " +
  "the only exception, and even that must be minimal";

/**
 * Claim safety: what a generated image is never allowed to assert, regardless of model or role.
 *
 * From the imagine-lp-assets skill's honesty table, which exists because of a real incident: a
 * fabricated "trusted by thousands" banner shipped once already, rendered small enough at low
 * resolution to look like cosmetic texture rather than a claim — and only became legible, and
 * obviously wrong, once someone regenerated it at full size. GPT_NEGATIVES stops invented brand
 * marks and stock-photo poses; nothing before this stopped an image from inventing SOCIAL PROOF,
 * which is the more damaging failure because it reads as evidence rather than decoration.
 *
 * Every one of these is a claim published on a real company's site would have to stand behind, so
 * "the model made it up" is not a defence available after the fact.
 */
const CLAIM_SAFETY = [
  "no testimonial quotes, star ratings, review counts, user-count or customer-count figures, " +
  "percentages, growth multipliers ('10x faster') or any statistic, invented or otherwise",
  "no fabricated app interface, dashboard or product screen presented as if it were a real captured " +
  "screenshot — an illustrated or abstracted UI impression is fine, a literal fake screenshot is not",
  "if a person's face is shown, it carries no name, job title, quote or attribution of any kind",
].join("; ");

export interface PromptInput {
  asset: PlannedAsset;
  /** What the article is about. */
  topic: string;
  /** The article's own title, used verbatim on a card. */
  title?: string;
  /** Which batch slot this is, for axis locking. */
  slot?: number;
  /** Extra direction from the user, applied within the rules rather than overriding them. */
  direction?: string;
  /** Brand name, only ever rendered as a plain wordmark and never as a drawn logo. */
  brand?: string;
  /** Where this image will live. Changes the art direction, not just the caption — see AssetSurface. */
  surface?: AssetSurface;
  /**
   * Art direction the team has taught us, from standing rules scoped to imagery.
   *
   * This is the difference between feedback that lasts one conversation and feedback that changes
   * every render after it. Someone looks at a hero, says "ours always have a real person in them",
   * and without this the next render has never heard of it.
   */
  houseDirection?: string[];
}

/**
 * Build a prompt for one planned asset, adapted to the model that will render it.
 *
 * The `model` argument is not cosmetic — it switches the whole avoidance strategy.
 */
export function buildImagePrompt(model: string, input: PromptInput): string {
  const { asset, topic } = input;
  const surface: AssetSurface = input.surface ?? "blog";
  const preset = SURFACE_PRESETS[surface];
  // Axes constrained to the surface, so variants diverge WITHIN the right register rather than
  // wandering between editorial and advertising across a single batch.
  const axes = surfaceAxes(surface, input.slot ?? 0);
  const gpt = isGptImage(model);
  const parts: string[] = [];

  // The register goes first: it frames every instruction after it, and it is the reason a two-word
  // subject is enough input to get a usable image.
  parts.push(preset.register);

  // ── What the team has taught us about our own images ────────────────────────────────────────
  //
  // Standing rules scoped to imagery, set by somebody looking at a render they did not like and
  // saying why. Placed HERE — after the register, before the per-asset instructions — so they frame
  // the whole prompt rather than arriving as an afterthought the model has already written past.
  //
  // Without this, art direction lasted exactly as long as one conversation: a person would say "our
  // heroes always have a real person in them", the next render would ignore it, and the only way to
  // make it stick was to edit this file and deploy.
  if (input.houseDirection?.length) {
    parts.push(
      "House direction, learned from images this team has accepted and rejected. Where it disagrees " +
      "with anything below, follow it:",
      ...input.houseDirection.map((d: string) => `- ${d}`),
    );
  }

  if (asset.role === "og" || asset.role === "thumbnail") {
    // The one asset where text is the point: it is never rendered in the page, it exists to be a
    // legible thumbnail in a feed.
    parts.push(
      `Design a social share card, ${asset.width}x${asset.height}, for an article titled "${input.title ?? topic}".`,
      "Set the headline in DISPLAY type with a point of view — a condensed grotesque, a high-contrast " +
      "serif, something drawn rather than defaulted to. Never a plain UI sans-serif: this is the one " +
      "image where the type IS the design, and a default face makes it look unmade. " +
      "Two type layers at most: the headline, and optionally one short kicker.",
      `Background: ${axes.world}. Composition: ${axes.composition}.`,
      "At least 40% of the frame is quiet negative space. One dominant focal element, nothing competing with it.",
    );
    if (input.brand) {
      // Never let the model draw a logo — it invents distorted marks. A wordmark in plain type only,
      // and the real logo gets composited afterwards if one is needed.
      parts.push(
        `Include the word "${input.brand}" once, small, as plain correctly-spelled type in a quiet corner. ` +
        "Do not design a graphical logo, icon or symbol for it.",
      );
    }
  } else if (asset.role === "hero") {
    // A BLOG hero carries the article title as real type. That is not a preference, it is what the
    // live pages do: the best-ai-website-builders hero sets "Best AI Website Builders" across the top
    // in heavy black sans with a lighter subhead under it, and the same holds across the blog. Body
    // images stay wordless — the distinction is between the image that opens the piece and the images
    // inside it, not between "social card" and "everything else" as this branch used to assume.
    //
    // A LANDING hero stays wordless. Its headline is real HTML sitting on top of the image, so type
    // baked into the file would collide with the copy the page renders over it.
    // Heroes are wordless on both surfaces now — see the note on allow_text in media/plan.ts. Kept as
    // a variable rather than deleted because a caller can still force a titled hero by passing
    // allow_text on the asset, and that path should keep working.
    const blogHeroTitle = asset.allow_text && surface === "blog" ? (input.title ?? "").trim() : "";

    parts.push(
      `A wide opening image, ${asset.width}x${asset.height}, for an article about ${topic}.`,
      `Subject: ${asset.subject}.`,
      `Style: ${axes.treatment}. Setting: ${axes.world}. Composition: ${axes.composition}.`,
      // Surface-dependent, because the two registers want opposite things here. Hardcoding the
      // editorial line fired it on landing too, directly contradicting that surface's own register
      // ("carries the pitch, should look expensive") within the same prompt.
      surface === "landing"
        ? "It should read as a premium product visual — the kind of image a company puts at the top of its own page."
        // Not "with real people": half the reference set is pure product with no one in frame. What
        // is required is the production value, not a human subject.
        : "It should look commissioned rather than sourced — the kind of image a brand pays for.",
    );

    if (blogHeroTitle) {
      parts.push(
        `Set the headline "${blogHeroTitle}" across the upper third, spelled exactly as written.`,
        "Choose display type with a point of view — a condensed grotesque, a high-contrast serif, " +
        "something drawn for this. Not a default UI sans.",
        "Two type layers at most: that headline, and optionally one lighter subheading beneath it. " +
        "Keep the lower two thirds clear for the photographic subject.",
        // Same rule the social card already follows, for the same reason: models invent distorted marks.
        "Do not draw a logo, app icon or wordmark of any kind.",
      );
    } else {
      parts.push(gpt ? NO_TEXT_NEGATIVE.replace(/^no/, "Avoid: no") : NO_TEXT_POSITIVE);
    }
  } else {
    parts.push(
      `An editorial image, ${asset.width}x${asset.height}, illustrating "${asset.heading ?? asset.subject}" ` +
      `in an article about ${topic}.`,
      `Show: ${asset.subject}.`,
      `Style: ${axes.treatment}. Setting: ${axes.world}. Composition: ${axes.composition}.`,
      gpt ? NO_TEXT_NEGATIVE.replace(/^no/, "Avoid: no") : NO_TEXT_POSITIVE,
    );
  }

  // Surface art direction. Before the operator's own note, so a specific request can still override
  // the preset's defaults rather than being buried under them.
  parts.push(preset.direction.join(" "));

  if (input.direction?.trim()) {
    parts.push(`Additional direction, applied within the rules above: ${input.direction.trim()}`);
  }

  // The avoidance strategy, and it is model-specific. For Nano Banana we add MORE positive
  // specificity instead, because naming what we don't want is how forge summoned it.
  if (gpt) {
    const negatives = asset.allow_text ? GPT_NEGATIVES : `${GPT_NEGATIVES}; ${NO_TEXT_NEGATIVE}`;
    // Claim safety folds into the same negatives clause here. GPT Image 2 honours a negatives list
    // strongly, so naming "no star ratings" is safe the way naming "no phone" is safe — see the file
    // header. It does not get its own NEGATIVES line; that would just be two lists doing one job.
    parts.push(`NEGATIVES: ${negatives}; ${CLAIM_SAFETY}.`);
  } else {
    // Nano Banana reads negatives weakly and draws what you name, and a star rating or a quote box
    // is exactly the kind of concrete glyph naming it as a negative would summon — the same trap the
    // avatar prompt hit with "no recording timer". So this stays positive: state plainly that nothing
    // in frame is standing in for evidence, rather than listing the fakes to avoid.
    parts.push(
      "Render this as a single clean, finished, intentional image: one clear subject, a calm uncluttered " +
      "ground, and generous empty space. Every surface in frame is plain and deliberate. Whatever is " +
      "shown is simply itself — nothing in the frame stands in for a rating, a quote, a user count or " +
      "any other piece of evidence, and a person in frame carries no name, title or attribution.",
    );
  }

  return parts.filter(Boolean).join("\n\n");
}
