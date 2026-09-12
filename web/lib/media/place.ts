// Putting a generated body image into the article, at the section it was generated for.
//
// ── Why this exists ──────────────────────────────────────────────────────────────────────────────
//
// Summer's account of the problem was that body images "cannot be placed", and that whoever owns the
// article would have to drop the markdown tags in by hand. Both halves are wrong, and the reason is
// worth writing down because it looked convincing.
//
// The Strapi blog type has no body-image slots. `body` is one richtext field holding plain markdown,
// so a body image IS a markdown tag inside the prose — there is no template hole to fill. And the
// placement is not unknown: planAssets() already computes `section_index` and `heading` for every
// inline asset, spread evenly across the real H2s and skipping structural ones. The image knows
// exactly where it goes before it is rendered.
//
// What was actually missing is a way to write into the MIDDLE of a body. update_draft can replace
// the whole body or append to the end, and replacing means the model transmitting all 9,427 words
// back as a tool argument — the exact thing that runs out of turn budget mid-stream and arrives
// empty. So "I cannot edit the body safely" was true of the tools available, and read as a property
// of the CMS.
//
// This does the insert on the SERVER, where the body already is. Nothing large crosses the wire, the
// model never handles the article text, and the offsets come from the same parser the renderer uses.
import { parseBlocks } from "@/lib/blog/markdown";

/** An image to place, and where the plan said it belongs. */
export interface Placement {
  url: string;
  alt: string;
  /** Index into the article's H2 list, as planAssets computed it. */
  sectionIndex?: number | null;
  /** The heading text, used when the index no longer matches — see placeImages. */
  heading?: string | null;
}

/**
 * Insert images into a markdown body under their planned sections.
 *
 * Matching is by HEADING TEXT first and index second. The index was computed when the plan was made
 * and the article has usually been rewritten since — sections get added, merged and reordered, and
 * an index that silently drifts puts the "pricing" image under "limitations". The heading is what
 * the image was actually drawn for, so it wins; the index is the fallback for a heading that was
 * subsequently reworded.
 *
 * Idempotent: an image whose URL is already in the body is skipped. Re-running a generation should
 * not stack three copies of the same picture under one heading.
 */
export function placeImages(body: string, images: Placement[]): { body: string; placed: number; skipped: string[] } {
  const skipped: string[] = [];
  if (!body.trim() || !images.length) return { body, placed: 0, skipped: images.map((i) => i.alt || i.url) };

  const blocks = parseBlocks(body);
  const h2s = blocks.filter((b) => b.t === "h" && b.level === 2) as Array<
    Extract<typeof blocks[number], { t: "h" }>
  >;
  if (!h2s.length) return { body, placed: 0, skipped: images.map((i) => i.alt || i.url) };

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

  // Collect insert positions first, then apply from the END backwards. Applying forwards would
  // invalidate every later offset the moment the first image lengthened the string.
  const inserts: { at: number; text: string }[] = [];

  for (const img of images) {
    if (!img.url) continue;
    if (body.includes(img.url)) { skipped.push(`${img.alt || img.url} (already in the body)`); continue; }

    let target = img.heading ? h2s.find((h) => norm(h.text) === norm(img.heading!)) : undefined;
    if (!target && typeof img.sectionIndex === "number") target = h2s[img.sectionIndex];
    if (!target) { skipped.push(`${img.alt || img.url} (no section matched)`); continue; }

    // After the heading's own line, and after the first paragraph under it when there is one. An
    // image jammed between an H2 and its opening sentence separates the heading from the text it
    // introduces; one paragraph down, it breaks the section up instead of interrupting it.
    const after = blocks.find((b) => b.start > target!.end && b.t === "p") ?? target;
    const at = after.end;

    inserts.push({ at, text: `\n\n![${(img.alt || "").replace(/[[\]]/g, "")}](${img.url})` });
  }

  let out = body;
  for (const ins of inserts.sort((a, b) => b.at - a.at)) {
    out = `${out.slice(0, ins.at)}${ins.text}${out.slice(ins.at)}`;
  }

  return { body: out, placed: inserts.length, skipped };
}
