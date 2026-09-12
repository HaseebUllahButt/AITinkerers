// Generate a page's images the moment it is created, and re-host them so they can actually be published.
//
// Two problems this solves at once.
//
// **Nobody generated the images.** `planAssets()` has always known exactly what a page needs — social
// card, hero, thumbnail, body images placed on real H2s — and `/api/media/generate` has always been able
// to render a whole plan from a `draft_id`. Nothing ever called it. Every draft started with zero images
// and stayed that way unless someone remembered to open the gallery, so the plan was advice rather than
// output.
//
// **Publishing was blocked on the thumbnail, and generating one did not help.** Strapi's `resources` type
// requires `thumbnail`, and 0 of 11 drafts had one — which is why nothing has ever published from this
// tool. The reason generating an image did not fix it: `thumbnail_media_id` is a STRAPI MEDIA ID, an
// integer from Strapi's upload API, while a generated asset is a URL on fal's CDN. Only the editor UI ever
// set that field, by hand. So the last mile is uploading the bytes to Strapi and writing the id back.
//
// That upload is not extra work bolted on — it is the same "re-host the bytes" step the asset rules
// require anyway. Provider URLs expire, and a hero that 404s three weeks after publishing is worse than no
// hero. Doing it at generation time means the URL that lands in the draft is already permanent.

import { planAssets, type PlannedAsset } from "./plan";
import { updateMediaAsset } from "./store";
import { uploadFile } from "@/lib/strapi/client";
import { updateBlogDraft } from "@/lib/db/queries";

export interface PrefillResult {
  planned: number;
  generated: number;
  failed: number;
  /** Set when a thumbnail reached Strapi — this is what unblocks publishing. */
  thumbnailMediaId: number | null;
  notes: string[];
}

/** Roles worth generating before a person has looked at the page. */
const PREFILL_ROLES_BLOG = ["thumbnail", "hero"] as const;
const PREFILL_ROLES_LANDING = ["hero", "og"] as const;

/**
 * Download a generated image and put it in Strapi, returning its media id.
 *
 * `alternativeText` is set from the plan's alt text rather than left empty: it is the field Strapi exposes
 * to the front end, and an empty alt on a published hero is an accessibility defect that ships.
 */
export async function rehostToStrapi(
  url: string,
  asset: PlannedAsset,
): Promise<{ id: number; url: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Provider output is PNG unless asked otherwise; the filename carries the keyword-shaped slug the
    // plan already worked out, because filenames carry weight in image search.
    const filename = asset.filename?.endsWith(".png") ? asset.filename : `${asset.filename || "image"}.png`;
    const media = await uploadFile(
      { bytes, filename, mime: "image/png" },
      undefined,
      { name: filename, alternativeText: asset.alt ?? undefined },
    );
    const first = media?.[0] as { id?: number; url?: string } | undefined;
    return first?.id ? { id: first.id, url: first.url ?? url } : null;
  } catch {
    return null;
  }
}

/**
 * Generate and attach a new page's starter images.
 *
 * Deliberately best-effort throughout. A page must be created even when fal is down, out of credit, or
 * refuses the prompt on moderation grounds — the alternative is that an image provider outage blocks
 * someone from writing a blog post, which is a far worse failure than a missing hero. Every partial
 * outcome is reported in `notes` rather than thrown.
 *
 * Only the roles in PREFILL_ROLES_* are rendered, not the whole plan. Body images depend on the article's
 * real H2s, which do not exist yet at creation time — generating them from an empty outline would produce
 * images for sections nobody has written. Those stay on-demand from the gallery.
 */
export async function prefillAssets(input: {
  draftId?: string | null;
  title: string;
  keyword?: string | null;
  kind: "blog" | "landing";
  actor?: string | null;
  /** Set false to plan without rendering — used by the probe, so it costs nothing to test. */
  render?: boolean;
}): Promise<PrefillResult> {
  const notes: string[] = [];
  const out: PrefillResult = { planned: 0, generated: 0, failed: 0, thumbnailMediaId: null, notes };

  if (!process.env.FAL_KEY) {
    notes.push("FAL_KEY is not set, so no images were generated. The page was still created.");
    return out;
  }

  const { assets } = planAssets({
    title: input.title,
    keyword: input.keyword ?? input.title,
    // No body text yet, so no inline images — see the note above.
    words: 0,
    headings: [],
    kind: input.kind,
  });

  const roles: readonly string[] = input.kind === "landing" ? PREFILL_ROLES_LANDING : PREFILL_ROLES_BLOG;
  const todo = assets.filter((a) => roles.includes(a.role));
  out.planned = todo.length;
  if (input.render === false) {
    notes.push(`Would generate: ${todo.map((a) => a.role).join(", ")}.`);
    return out;
  }

  const { renderOne } = await import("./render");
  const { modelForPrefill } = await import("./fal");

  for (const asset of todo) {
    try {
      const rendered = await renderOne({
        asset,
        title: input.title,
        topic: input.keyword ?? input.title,
        slot: 0,
        refs: [],
        actor: input.actor ?? null,
        draftId: input.draftId ?? null,
        surface: input.kind,
        modelOverride: modelForPrefill(asset.role, false),
      });
      if (!rendered.ok || !rendered.asset) {
        out.failed++;
        // A refusal is the model declining on content policy, which reads as a 200 with no image — a
        // different thing from a transport failure, and the operator should be told which it was.
        notes.push(`${asset.role}: ${rendered.refused ? "refused on content policy" : rendered.error ?? "no image came back"}`);
        continue;
      }

      out.generated++;

      // renderOne already stored the row against fal's URL. Re-host on top of it: provider outputs expire,
      // so a published page must not reference one. Updating in place rather than inserting a second row
      // keeps one asset per render — two rows for one image is how a gallery starts showing duplicates.
      const hosted = await rehostToStrapi(rendered.asset.url, asset);
      if (hosted) {
        await updateMediaAsset(rendered.asset.id, {
          strapi_media_id: hosted.id,
          strapi_url: hosted.url,
        } as Record<string, unknown>).catch(() => { /* the fal URL still works for now */ });
      } else {
        notes.push(`${asset.role}: generated, but could not be uploaded to Strapi — it still points at the provider CDN, which expires.`);
      }

      // The line that unblocks publishing. Written only when the upload produced a real Strapi id —
      // setting this field to anything else would make publishReadiness() pass while Strapi still
      // rejected the entry, which is worse than the current honest block.
      if (asset.role === "thumbnail" && hosted?.id && input.draftId) {
        await updateBlogDraft(input.draftId, {
          thumbnail_media_id: hosted.id,
          thumbnail_media_url: hosted.url,
        } as Record<string, unknown>).catch(() => {
          notes.push("Generated the thumbnail but could not attach it to the draft.");
        });
        out.thumbnailMediaId = hosted.id;
        notes.push("Thumbnail generated and attached — this is the field that blocks publishing.");
      }
    } catch (e) {
      out.failed++;
      notes.push(`${asset.role}: ${e instanceof Error ? e.message : "generation failed"}`);
    }
  }

  return out;
}
