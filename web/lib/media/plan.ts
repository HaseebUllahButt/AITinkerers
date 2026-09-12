// What images a page actually needs, at what size, and what to say about them.
//
// This is the SEO half of image generation, and it is deliberately separate from the provider half.
// Nothing here knows or cares which model draws the picture; it decides how many images a piece
// needs, where they go, how big they are, and what the alt text says. Those are the decisions that
// affect ranking. The model choice mostly affects whether the image looks good.
//
// The rules encoded here, and why each one is a ranking decision rather than a taste decision:
//
//  - **Weight is a ranking factor, image count is not.** Largest Contentful Paint is a Core Web Vital,
//    and on an article page the LCP element is almost always the hero image. So there is exactly one
//    priority-loaded image, everything else is lazy, and the target is roughly one image per 400 words
//    rather than "as many as possible". Extra images cost real CWV budget and earn nothing.
//  - **No baked-in text on body images.** Google cannot read it, it does not translate for the /es and
//    /id locales, and it is illegible at mobile width. The one exception is the social card, which is
//    never rendered in the page — it exists to be a thumbnail in someone's feed, where text is the
//    whole point.
//  - **Alt text is for a person who cannot see the image**, first. Google has said this explicitly and
//    keyword-stuffed alt text is a recognised spam pattern. The target keyword appears at most once,
//    and only where it genuinely describes what is shown.
//  - **The filename carries weight in Google Images.** A generated file called `output_4.png` throws
//    that away; a keyword-shaped slug does not.
//  - **Generated beats stock.** Reverse-image matching means a stock photo appearing on four hundred
//    other pages contributes nothing distinguishing. An image nobody else has is a genuine
//    differentiator on an otherwise-commodity topic.
import { slugify } from "@/lib/blog/fields";

export type AssetRole = "og" | "hero" | "inline" | "thumbnail";

/**
 * The three jobs a body image can do.
 *
 *  - `evidence`     the same brief rendered several ways, with the variable named in the caption.
 *                   This is the one that earns a citation: it is a result, not an illustration.
 *  - `ui`           a real capture of an interface. Never generated — see `needs_real_capture`.
 *  - `illustrative` breaks up the read and shows the subject. The default, and the weakest.
 */
export type InlineKind = "evidence" | "ui" | "illustrative";

export interface SizePreset {
  width: number;
  height: number;
  /** Aspect ratio as the providers express it, for the request. */
  ratio: string;
  why: string;
}

/**
 * The sizes, and the reason for each. Not arbitrary round numbers.
 *
 * 1200×630 is the Open Graph / Twitter summary_large_image spec — go under it and platforms upscale
 * and blur, go over and they crop unpredictably. 1600×900 is the largest a hero needs to be for a
 * 2x retina display at typical article column width; larger is pure CWV cost. Body images at 1200 wide
 * cover the same column at 2x without being oversized.
 */
export const SIZE_PRESETS: Record<AssetRole, SizePreset> = {
  og: {
    width: 1200, height: 630, ratio: "1200:630",
    why: "The Open Graph / Twitter large-card spec. Smaller gets upscaled and blurred by the platform; larger gets cropped unpredictably.",
  },
  hero: {
    width: 1600, height: 900, ratio: "16:9",
    why: "Enough for a 2x display at article column width, and no more — the hero is the LCP element and every extra pixel is Core Web Vitals cost.",
  },
  inline: {
    width: 1200, height: 675, ratio: "16:9",
    why: "Covers the article column at 2x. Lazy-loaded, so it does not compete with the hero for LCP.",
  },
  thumbnail: {
    width: 1200, height: 630, ratio: "1200:630",
    why: "Strapi's thumbnail is the preview/social card, so it follows the same spec as the OG image.",
  },
};

export interface PlannedAsset {
  role: AssetRole;
  /** 0-based index of the H2 this image sits under. Absent for og/hero/thumbnail. */
  section_index?: number;
  heading?: string;
  width: number;
  height: number;
  ratio: string;
  /** Keyword-shaped, so Google Images has something to read. No extension. */
  filename: string;
  /** What the image should show, in plain language. Feeds the image prompt AND the alt text. */
  subject: string;
  alt: string;
  /** Whether this one is priority-loaded. Exactly one asset per page may be. */
  priority: boolean;
  /** Whether legible text in the image is appropriate here. Only the social card. */
  allow_text: boolean;
  /**
   * What KIND of body image this is. Only meaningful for `inline`.
   *
   * Taken from how the roundups that actually rank use pictures. Zapier's best-AI-image-generator
   * post is the reference: its hero is a designed logo grid, its evidence images are the same prompt
   * rendered four ways with the variable named underneath, and each tool's section opens on a real
   * screenshot of that tool's interface. Three different jobs, and only one of them is decoration.
   */
  kind?: InlineKind;
  /**
   * The line printed under the image.
   *
   * An evidence grid is worthless without one — four pictures of a dog-shaped cloud mean nothing
   * until the caption says "clockwise from top-left: 10, 20, 40 and 120 steps". The caption is where
   * the citable fact lives, so it is a field rather than something the writer may forget.
   */
  caption?: string;
  /**
   * True when this slot must be filled by a REAL capture and cannot be rendered.
   *
   * A screenshot of a product's interface is a record of how that product looks. Generating one
   * produces a picture of an interface that does not exist, which is a fabricated record however
   * pretty it is — so the planner asks for the slot and refuses to fill it, rather than quietly
   * substituting a render.
   */
  needs_real_capture?: boolean;
  why: string;
}

/**
 * Headings that describe the article's STRUCTURE rather than its subject. An image here is filler:
 * "Intro" is already covered by the hero, and a picture under "Frequently asked questions" illustrates
 * nothing. They are skipped as placement targets, and their text makes terrible alt text.
 */
const STRUCTURAL_HEADINGS = [
  "intro", "introduction", "overview", "conclusion", "summary", "wrapping up", "final thoughts",
  "faq", "faqs", "frequently asked questions", "key takeaways", "tl;dr",
];

export function isStructuralHeading(heading: string): boolean {
  const h = heading.toLowerCase().replace(/[^a-z; ]/g, "").trim();
  return STRUCTURAL_HEADINGS.includes(h);
}

/**
 * A filename Google Images can read, without saying the same thing twice.
 *
 * The keyword prefix is dropped when the heading slug already contains it — repeating it produced
 * names like `ai-fashion-model-generator-which-ai-fashion-model-generator-is-best`, which is both
 * keyword stuffing and past the length where a filename is useful.
 */
export function assetFilename(slugBase: string, part: string, max = 70): string {
  const tail = slugify(part);
  if (!tail) return slugBase.slice(0, max);
  // Does the heading already carry the keyword? Then the prefix is redundant.
  const firstWord = slugBase.split("-")[0];
  const combined = tail.includes(slugBase) || (slugBase.length > 8 && tail.includes(firstWord) && tail.length > slugBase.length)
    ? tail
    : `${slugBase}-${tail}`;
  if (combined.length <= max) return combined;
  // Trim at a word boundary rather than mid-word.
  return combined.slice(0, max).replace(/-[^-]*$/, "");
}

/** Roughly one image per this many words of body copy. */
const WORDS_PER_INLINE_IMAGE = 400;
/** Hard ceiling regardless of length: past this, page weight costs more than the images add. */
const MAX_INLINE_IMAGES = 6;

export interface Heading { index: number; heading: string; level?: string }

/**
 * Alt text for one image.
 *
 * The keyword goes in at most once and only when it is genuinely part of what is shown — a caption
 * for a blind reader, not a keyword slot. Length is capped around 125 characters because screen
 * readers truncate near there.
 */
export function altFor(subject: string, keyword: string, opts: { includeKeyword: boolean }): string {
  const s = subject.trim().replace(/\s+/g, " ");
  // An empty subject used to yield an empty alt, silently. Alt text is the one field on an image that
  // is never optional — a screen reader gets nothing, and Google gets nothing — so it falls back to
  // the keyword rather than to "".
  if (!s) return (keyword.trim() || "Illustration").slice(0, 125);
  const base = s.charAt(0).toUpperCase() + s.slice(1);
  if (!opts.includeKeyword || !keyword.trim()) return base.slice(0, 125);
  // Only append when the keyword is not already in there — repeating it is the stuffing pattern.
  if (base.toLowerCase().includes(keyword.toLowerCase())) return base.slice(0, 125);
  return `${base} — ${keyword}`.slice(0, 125);
}

/** How many inline images a body of this length should carry. */
export function inlineImageCount(words: number, availableSections: number): number {
  if (words < 500) return 0;                       // too short to break up
  const byLength = Math.floor(words / WORDS_PER_INLINE_IMAGE);
  return Math.max(1, Math.min(byLength, MAX_INLINE_IMAGES, availableSections));
}

/**
 * The full image plan for a piece.
 *
 * Deterministic and pure, so the selfcheck can assert it and so two runs on the same draft produce the
 * same plan (which matters: "regenerate the hero" must mean the same slot both times).
 */
export function planAssets(input: {
  title: string;
  keyword: string;
  words: number;
  /** H2 headings, in order. Used to place and describe the inline images. */
  headings?: Heading[];
  /** A landing page gets a hero and a card and no body images. */
  kind?: "blog" | "landing";
  /**
   * The editorial type from src/lib/blog/pageTypes.ts.
   *
   * Decides what the body images are FOR. A comparison's first body image should be the same prompt
   * rendered both ways with the variable captioned — that is the evidence the piece exists to show,
   * and it is what an answer engine quotes. A how-to's body images are illustrative and the weaker
   * for it, which is fine, because its evidence is the steps.
   */
  pageType?: string;
}): { assets: PlannedAsset[]; notes: string[] } {
  const notes: string[] = [];
  const keyword = input.keyword.trim();
  const slugBase = slugify(keyword || input.title) || "image";
  // Structural headings are dropped as placement targets: an image under "Intro" duplicates the hero
  // and one under "FAQ" illustrates nothing.
  const allH2 = (input.headings ?? []).filter((h) => (h.level ?? "h2") === "h2");
  const headings = allH2.filter((h) => !isStructuralHeading(h.heading));
  const skipped = allH2.length - headings.length;
  const assets: PlannedAsset[] = [];

  // 1. The social card. Every page gets one, and it is the ONLY place text belongs: it is never
  // rendered in the page, it exists to be a legible thumbnail in a feed.
  assets.push({
    role: "og",
    ...SIZE_PRESETS.og,
    filename: assetFilename(slugBase, "social-card"),
    subject: `A social share card for "${input.title}"`,
    alt: altFor(input.title, keyword, { includeKeyword: false }),
    priority: false,
    allow_text: true,
    why: "Shown when the URL is pasted into Slack, X or LinkedIn. Legible text is the point here, unlike every other image.",
  });

  // 2. The hero. Priority-loaded, and the only one that is.
  assets.push({
    role: "hero",
    ...SIZE_PRESETS.hero,
    filename: assetFilename(slugBase, "hero"),
    subject: `A wide opening image representing ${keyword || input.title}`,
    alt: altFor(`${keyword || input.title}`, keyword, { includeKeyword: true }),
    priority: true,
    // No baked type on a hero, either surface.
    //
    // This was briefly true the other way: the live blog heroes DO carry their headline, so the
    // planner was changed to match them. Then the art direction was set explicitly — "very less
    // typography if at all... mostly non typographic assets" — with a reference set where the only
    // lettering is printed on the product itself, never laid over the picture.
    //
    // A picture that has to work at 640px in a body column and survive being cropped by a social
    // card is better without type, and the page renders a real headline in real HTML above it
    // anyway. Text stays on the social card, where legibility in a feed IS the job.
    allow_text: false,
    why: "The LCP element. Priority-loaded and size-capped, because Largest Contentful Paint is a Core Web Vital.",
  });

  // 3. Strapi's thumbnail field, which blocks publishing. Same spec as the card, and in practice the
  // same asset — the plan says so rather than making someone generate a second near-identical image.
  assets.push({
    role: "thumbnail",
    ...SIZE_PRESETS.thumbnail,
    filename: assetFilename(slugBase, "thumbnail"),
    subject: `A preview card for "${input.title}"`,
    alt: altFor(input.title, keyword, { includeKeyword: false }),
    priority: false,
    allow_text: true,
    why: "Strapi requires a thumbnail before it will publish. Usually the same asset as the social card — reuse it rather than generating twice.",
  });

  if (input.kind === "landing") {
    notes.push("Landing page: hero and cards only. Body images belong to articles, not conversion pages.");
    return { assets, notes };
  }

  // 4. Inline body images, spread across the H2s.
  const wanted = inlineImageCount(input.words, headings.length);
  if (wanted === 0) {
    notes.push(
      input.words < 500
        ? `At ${input.words} words this is too short to need body images.`
        : "No H2 headings found, so there is nowhere to place a body image.",
    );
  } else {
    // Spread them evenly rather than clustering at the top: an image every few sections breaks up the
    // read, three images in the intro does not.
    const stride = Math.max(1, Math.floor(headings.length / wanted));
    // Types whose whole value is a shown result. Their first body image is evidence, not decoration.
    const EVIDENCE_TYPES = new Set(["comparison", "model-guide", "prompt-guide", "audience-roundup", "alternatives"]);
    const wantsEvidence = EVIDENCE_TYPES.has(String(input.pageType ?? ""));
    // Types that walk through named tools or a named interface. One real capture beats any render,
    // and the slot is flagged rather than filled — see needs_real_capture.
    const UI_TYPES = new Set(["comparison", "audience-roundup", "alternatives", "how-to"]);
    const wantsUi = UI_TYPES.has(String(input.pageType ?? ""));

    for (let n = 0; n < wanted; n++) {
      const h = headings[Math.min(n * stride, headings.length - 1)];
      if (!h) break;
      const label = h.heading.replace(/\?$/, "");

      const kind: InlineKind = n === 0 && wantsEvidence ? "evidence"
        : n === 1 && wantsUi ? "ui"
        : "illustrative";

      if (kind === "evidence") {
        assets.push({
          role: "inline", kind, ...SIZE_PRESETS.inline,
          section_index: h.index, heading: h.heading,
          filename: assetFilename(slugBase, `${label}-compared`),
          subject: `The same brief rendered several ways, for "${label}" — one panel per option being compared`,
          alt: altFor(`${label}, the same prompt rendered by each option side by side`, keyword, { includeKeyword: false }),
          caption: "REQUIRED — name the variable and the order, e.g. \"clockwise from top left: <option A>, "
            + "<option B>, <option C>\", plus the prompt used. Without it the panel proves nothing.",
          priority: false,
          // The only body image allowed lettering, and only the panel labels — no headline, no
          // marketing copy. A grid nobody can read the order of is worse than one picture.
          allow_text: true,
          why: "The citable image. A result shown side by side with the variable named is what an answer "
            + "engine lifts and what a competitor's post cannot supply.",
        });
        continue;
      }

      if (kind === "ui") {
        assets.push({
          role: "inline", kind, ...SIZE_PRESETS.inline,
          section_index: h.index, heading: h.heading,
          filename: assetFilename(slugBase, `${label}-interface`),
          subject: `A real screenshot of the interface described under "${label}"`,
          alt: altFor(`The ${label} interface`, keyword, { includeKeyword: false }),
          caption: "Optional — say what is being pointed at if it is not obvious.",
          priority: false,
          allow_text: true,
          needs_real_capture: true,
          why: "A capture of a real interface. NEVER generated: a rendered screenshot is a picture of a "
            + "product that does not exist, which is a fabricated record. Leave the slot empty and say "
            + "so if no real capture is available.",
        });
        continue;
      }

      assets.push({
        role: "inline", kind, ...SIZE_PRESETS.inline,
        section_index: h.index,
        heading: h.heading,
        filename: assetFilename(slugBase, h.heading || `section-${h.index}`),
        subject: label,
        // The keyword is already on the hero. Repeating it in every alt is the stuffing pattern, so
        // body images describe their own section instead.
        alt: altFor(label, keyword, { includeKeyword: false }),
        priority: false,
        allow_text: false,
        why: `Breaks up the "${h.heading}" section. Lazy-loaded, no text — text in a body image is unreadable on mobile, untranslatable for /es and /id, and invisible to Google.`,
      });
    }
    notes.push(`${wanted} body image${wanted === 1 ? "" : "s"} for ${input.words.toLocaleString()} words, about one per ${WORDS_PER_INLINE_IMAGE}.`);
    if (skipped > 0) {
      notes.push(`Skipped ${skipped} structural heading${skipped === 1 ? "" : "s"} (intro, FAQ and the like) — an image there is filler.`);
    }
  }

  return { assets, notes };
}
