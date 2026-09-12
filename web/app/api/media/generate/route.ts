import { NextRequest, NextResponse } from "next/server";
import { identifyCaller, actorFor } from "@/lib/auth/service";
import {
  falQueue, falEnabled, buildPayload, modelForRole, resolutionForRole, resolveModel,
  MODELS, FalError, refIsReachable, MAX_REFS,
} from "@/lib/media/fal";
import { buildImagePrompt } from "@/lib/media/prompt";
import { planAssets, SIZE_PRESETS, type AssetRole } from "@/lib/media/plan";
import { createMediaAsset, logGeneration } from "@/lib/media/store";
import { renderOne } from "@/lib/media/render";
import { rehostToStrapi } from "@/lib/media/prefill";
import { placeImages } from "@/lib/media/place";
import { updateBlogDraft, getBlogDraft } from "@/lib/db/queries";
import { parseBlocks } from "@/lib/blog/markdown";

// A single 4K render can take minutes; a batch of four takes longer. This route has to outlive that.
export const maxDuration = 300;

/**
 * POST — generate one or more images.
 *
 * Two modes:
 *   { draft_id }              → plan the whole page's assets from the draft and render them
 *   { role, subject, topic }  → render one asset directly, for the gallery page
 *
 * Everything is logged, including refusals, because a content-policy block is information about the
 * prompt rather than a transient fault.
 */
export async function POST(req: NextRequest) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!falEnabled()) {
    // Degrade with an explanation, the same way writerEnabled() gates the writer. The gallery, the
    // planner and the picker all work without a key; only rendering needs one.
    return NextResponse.json(
      { ok: false, error: "FAL_KEY is not set, so images cannot be generated yet. Everything else in the gallery works." },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  // Machine callers get a synthetic actor so created_by is never null — the adoption report
  // counts by owner, and a null would silently under-count generated assets.
  const actor = actorFor(caller);

  // References the model may condition on. fal cannot reach localhost, and a data URL over a few
  // hundred KB makes it reject its own input — so anything large should be a public URL.
  const refs = (Array.isArray(body?.image_urls) ? body.image_urls : [])
    .map((u: unknown) => String(u))
    .filter(refIsReachable)
    .slice(0, MAX_REFS);

  // Art direction the team has taught us, read ONCE for the whole request. Scoped to imagery, so a
  // writing rule about em dashes never ends up in an image prompt. Best-effort: a failed read costs
  // this batch its learned direction, where a thrown error would cost it the images.
  const houseDirection = await (async () => {
    try {
      const { listStandingRules } = await import("@/lib/db/queries");
      const rules = await listStandingRules();
      return rules.filter((r) => r.scope === "imagery").map((r) => r.rule);
    } catch { return [] as string[]; }
  })();

  try {
    // ── Mode 1: plan a whole draft's assets ────────────────────────────────────────────────────
    if (typeof body?.draft_id === "string" && body.draft_id) {
      const draft = await getBlogDraft(body.draft_id);
      if (!draft) return NextResponse.json({ ok: false, error: "Draft not found." }, { status: 404 });

      const words = (draft.body ?? "").trim().split(/\s+/).filter(Boolean).length;
      const headings = parseBlocks(draft.body ?? "")
        .filter((b) => b.t === "h" && (b as { level?: number }).level === 2)
        .map((b, i) => ({ index: i, heading: (b as { text: string }).text, level: "h2" }));

      const keyword = String(body?.keyword ?? draft.seo_keywords?.split(",")[0] ?? draft.title ?? "").trim();
      const { assets: planned, notes } = planAssets({
        title: draft.title || "Untitled", keyword, words, headings,
        kind: body?.kind === "landing" ? "landing" : "blog",
        pageType: typeof body?.page_type === "string" ? body.page_type : undefined,
      });

      // Only the roles asked for, so "just the hero" does not cost a whole page of renders.
      const wanted: string[] = Array.isArray(body?.roles) && body.roles.length
        ? body.roles.map(String)
        : planned.map((a) => a.role);
      let todo = planned.filter((a) => wanted.includes(a.role));

      // A UI slot is a request for a real screenshot, and a render would be a picture of an
      // interface that does not exist. Reported so a person can supply one, never generated.
      const uiSlots = todo.filter((a) => a.needs_real_capture);
      todo = todo.filter((a) => !a.needs_real_capture);
      if (uiSlots.length) {
        notes.push(
          `${uiSlots.length} interface slot${uiSlots.length === 1 ? "" : "s"} planned but NOT rendered `
          + `(${uiSlots.map((a) => a.heading ?? a.filename).join(", ")}). A screenshot has to be a real `
          + "capture — a generated one is a picture of a product that does not exist.",
        );
      }

      // Body images are capped per call. An unattended run on a 9,000-word guide would otherwise
      // plan six of them, and six renders at 60-90s each does not fit the caller's 220s deadline —
      // which is how a run ends up billed for images it then reports as having timed out.
      const inlineCap = Number.isFinite(Number(body?.inline_cap)) ? Math.max(0, Number(body.inline_cap)) : 3;
      const inlines = todo.filter((a) => a.role === "inline");
      if (inlines.length > inlineCap) {
        const keep = new Set(inlines.slice(0, inlineCap));
        todo = todo.filter((a) => a.role !== "inline" || keep.has(a));
        notes.push(`${inlines.length} body images planned, ${inlineCap} rendered this call — the rest stay on demand.`);
      }

      // PARALLEL, and this is a correctness fix rather than a speed one.
      //
      // Rendering these in sequence meant a four-asset plan took four render times end to end —
      // roughly 60-90s each for a Nano Banana Pro hero, so 4+ minutes — against a caller deadline
      // of 220s. The whole call died having billed for whatever had already completed, and the
      // agent reported "not run at all, no spend" for images that were in fact generated and paid
      // for. Observed: an OG card landed against a draft whose hero and thumbnail had "timed out".
      //
      // The renders are independent (different roles, different files, no shared state), so the
      // wall clock is now one render rather than the sum. Promise.all is safe here because
      // renderOne resolves rather than throws on a failed asset.
      const results = await Promise.all(
        todo.map((asset, slot) => renderOne({
          asset, topic: keyword || draft.title, title: draft.title, slot, refs, actor,
          draftId: draft.id, direction: body?.direction, houseDirection,
        })),
      );

      // ── Promote the images onto the draft ────────────────────────────────────────────────────
      //
      // Generating an image and attaching one are different acts, and until now only the first
      // happened here. The symptom: assets existed in media_assets with the right role and the
      // right draft_id, the draft's thumbnail_media_id stayed null, and the publish gate kept
      // saying "Thumbnail image is required" about a thumbnail that had already been generated and
      // paid for. Summer reported exactly that and was right.
      //
      // The gap is a type mismatch, not a missing write. thumbnail_media_id is a STRAPI MEDIA ID —
      // an integer from Strapi's upload API — while a rendered asset is a URL on fal's CDN. So the
      // bytes have to be re-hosted into Strapi before there is any id to store. That is the same
      // re-hosting the asset rules require anyway: a provider URL expires, and a hero that 404s
      // three weeks after publishing is worse than no hero.
      //
      // prefill.ts has done this correctly since it was written and nothing ever called it.
      const promoted: Record<string, number> = {};
      // Body images are re-hosted too, and keyed by INDEX because there can be several of them —
      // `todo.find(a => a.role === role)` would return the first inline plan for every inline asset.
      const rehostedInline = new Map<number, string>();
      await Promise.all(results.map(async (r, i) => {
        const role = r.asset?.role;
        const url = r.asset?.url;
        if (!url) return;

        // ── Body images expire too ────────────────────────────────────────────────────────────
        //
        // This gate was `role !== "thumbnail" && role !== "hero"`, which was correct only while
        // body images were never generated on the unattended path. Now that they are, an inline
        // image would be written into the PROSE as a raw fal.media URL — and the reasoning in the
        // comment above ("a provider URL expires, and a hero that 404s three weeks after
        // publishing is worse than no hero") applies at least as much to an image inside the
        // article, because nothing surfaces a broken body image the way an empty cover slot does.
        if (role === "inline") {
          const hostedInline = await rehostToStrapi(url, todo[i]);
          if (hostedInline?.url) rehostedInline.set(i, hostedInline.url);
          return;
        }
        if (role !== "thumbnail" && role !== "hero") return;
        const hosted = await rehostToStrapi(url, todo.find((a) => a.role === role)!);
        if (!hosted?.id) return;
        promoted[role] = hosted.id;
        // Only ever written with a REAL Strapi id. Storing anything else would make
        // publishReadiness() pass while Strapi still rejected the entry — worse than an honest block.
        await updateBlogDraft(draft.id, role === "thumbnail"
          ? { thumbnail_media_id: hosted.id, thumbnail_media_url: hosted.url }
          : { cover_media_id: hosted.id, cover_media_url: hosted.url } as never,
        ).catch(() => { /* the image still exists in the gallery; the field just did not take */ });
      }));

      // ── Place the body images in the article ─────────────────────────────────────────────────
      //
      // An inline image that exists in the asset library and not in the prose is an image nobody
      // will ever see. The plan already knows which H2 each one belongs under, so there is nothing
      // to decide here — only a write into the middle of the body, which is done server-side
      // because the body is already here and shipping 9,000 words back through a tool argument is
      // what breaks (see lib/media/place.ts).
      // Paired BY INDEX: results came from todo.map through Promise.all, which resolves in input
      // order regardless of which render finished first. Matching on a field instead would need one
      // that survives the round trip, and MediaAsset does not carry the plan's filename.
      const inlineImages = todo
        .map((planned, i) => ({ planned, asset: results[i]?.asset, i }))
        .filter((p) => p.planned.role === "inline" && p.asset?.url)
        .map(({ planned, asset, i }) => ({
          // The re-hosted URL when the upload worked, the provider URL as a fallback. A body image
          // on a provider URL is better than no body image; it just will not outlive the CDN.
          url: (rehostedInline.get(i) ?? asset!.url) as string,
          alt: (asset!.alt as string) ?? planned.alt ?? "",
          sectionIndex: planned.section_index ?? null,
          heading: planned.heading ?? null,
        }));

      if (inlineImages.length && draft.body?.trim()) {
        const { body: nextBody, placed, skipped } = placeImages(draft.body, inlineImages);
        if (placed > 0) {
          await updateBlogDraft(draft.id, { body: nextBody } as never).catch(() => {
            notes.push("Body images were generated but the article could not be updated with them.");
          });
          notes.push(`${placed} body image${placed === 1 ? "" : "s"} placed in the article under their own sections.`);
        }
        // Named rather than silently dropped: "generated 6" and "placed 4" differ, and the two the
        // person has to deal with by hand are exactly the ones worth naming.
        for (const s of skipped) notes.push(`Not placed: ${s}`);
      }

      if (promoted.thumbnail) notes.push("Thumbnail attached to the draft — this is the field that blocks publishing.");
      else if (todo.some((a) => a.role === "thumbnail")) {
        notes.push("A thumbnail was generated but could not be uploaded to Strapi, so publishing is still blocked on it.");
      }

      return NextResponse.json({
        ok: true, assets: results.filter((r) => r.asset).map((r) => r.asset), results, notes, promoted,
      });
    }

    // ── Mode 2: one asset, straight from the gallery page ──────────────────────────────────────
    const role = (["og", "hero", "inline", "thumbnail"] as const).includes(body?.role) ? (body.role as AssetRole) : "inline";
    const subject = String(body?.subject ?? "").trim();
    const topic = String(body?.topic ?? subject).trim();
    if (!subject) return NextResponse.json({ ok: false, error: "Describe what the image should show." }, { status: 400 });

    const count = Math.max(1, Math.min(Number(body?.count) || 1, 4));
    const preset = SIZE_PRESETS[role];
    // Blog is the safe default: an over-restrained landing image is a milder failure than a salesy
    // blog image, so an unknown value lands on the conservative side.
    const surface = body?.surface === "landing" ? "landing" as const : "blog" as const;
    const results = [];
    for (let slot = 0; slot < count; slot++) {
      results.push(await renderOne({
        asset: {
          role, ...preset, filename: "", subject,
          alt: String(body?.alt ?? subject),
          priority: role === "hero",
          allow_text: role === "og" || role === "thumbnail",
          why: preset.why,
        },
        topic, title: String(body?.title ?? subject), slot, refs, actor, surface, houseDirection,
        draftId: typeof body?.draft_id === "string" ? body.draft_id : null,
        direction: body?.direction,
      }));
    }
    return NextResponse.json({ ok: true, assets: results.filter((r) => r.asset).map((r) => r.asset), results });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "generation failed" }, { status: 500 });
  }
}

export { MODELS, resolveModel };
