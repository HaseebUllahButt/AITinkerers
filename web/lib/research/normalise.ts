// Subject normalisation — the one piece of vocabulary shared by the ledger and the slug proposer.
//
// It lives on its own because both of them have to agree. The ledger says "we already cover this
// subject" and the slug proposer says "this slug is too close to that one"; if they normalise
// differently, the ledger can pass a subject that the proposer then names identically to an existing
// page, and the run ships a duplicate under a slug that looks deliberate.
//
// Ported from the template-launch skill's ledger.mjs, which measured these lists against the real
// corpus. Every entry below is there because leaving it out produced a wrong answer in a real run:
//
//   STOP     "ai" is in ~40% of the site's slugs, so it carries no signal. Neither does "best" or
//            "free" — they are SERP-bait modifiers, not subjects.
//   SYN      "generation"/"creator"/"maker" all name the same page. "enhancer" and "upscaler" are
//            the case that actually bit: ai-video-upscaler, ai-video-enhancer and upscale-video-ai
//            were one page split three ways, competing with each other.
//   GENERIC  head words that do NOT make a new subject when bolted onto an existing page's name.
//            "nano banana 2 image generator" is /apps/nano-banana-2, not a second page. Without this
//            set the "we are more specific, so this is allowed" escape hatch lets every duplicate
//            through, because every duplicate adds at least one word.

/** Words with no topical meaning in this corpus. Stripped before comparison. */
const STOP = new Set([
  "ai", "the", "a", "an", "for", "with", "to", "of", "and", "best", "free", "online", "your", "new",
]);

/** Different words for the same thing, collapsed onto one representative. */
const SYN = new Map<string, string>(Object.entries({
  generation: "generator", generate: "generator", creator: "generator", maker: "generator",
  enhancer: "upscaler", enhance: "upscaler", upscale: "upscaler",
  pictures: "image", picture: "image", photos: "image", photo: "image", images: "image",
  videos: "video", movie: "video", clip: "video",
  alternatives: "alternative", vs: "alternative", versus: "alternative",
}));

/** Head words that do not distinguish one page from another. See the note above. */
const GENERIC = new Set([
  "image", "video", "photo", "generator", "maker", "editor", "creator",
  "tool", "app", "studio", "model", "converter", "pro", "lite", "new",
]);

/** A subject reduced to its meaning-carrying tokens. Order-insensitive by construction. */
export function subjectTokens(input: string): Set<string> {
  return new Set(
    String(input)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .filter((w) => !STOP.has(w))
      .map((w) => SYN.get(w) ?? w),
  );
}

/**
 * Jaccard overlap: intersection over union.
 *
 * Symmetric on purpose. A directional measure ("how much of A is in B") rates a two-word subject as a
 * perfect match for a six-word page, which is how "video generator" would be declared a duplicate of
 * "ai anime video generator for tiktok".
 */
export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / new Set([...a, ...b]).size;
}

/**
 * Tokens `subject` adds that `existing` lacks AND that actually specialise it.
 *
 * Being more specific than an existing page is legitimate and normal on this site — /features carries
 * ai-video-generator alongside ai-anime-video-generator. But the added token has to mean something:
 * "claymation" specialises, "generator" does not.
 */
export function specialisingTokens(subject: Set<string>, existing: Set<string>): string[] {
  return [...subject].filter((t) => !existing.has(t) && !GENERIC.has(t));
}

export { GENERIC as GENERIC_HEAD_WORDS, STOP as STOP_WORDS };
