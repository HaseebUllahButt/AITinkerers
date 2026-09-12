// Render one planned asset. Shared by the gallery route and the create-time prefill.
//
// Extracted from /api/media/generate so both callers use ONE implementation. Duplicating it would mean two
// places deciding which model a role gets, how the payload is shaped, and what a moderation refusal looks
// like — and those are exactly the details that drift apart and then disagree.

import {
  falQueue, buildPayload, modelForRole, resolutionForRole, FalError,
} from "@/lib/media/fal";
import { buildImagePrompt } from "@/lib/media/prompt";
import type { AssetRole } from "@/lib/media/plan";
import { createMediaAsset, logGeneration } from "@/lib/media/store";

/** Render one asset and record it. Never throws — a failure becomes a reported result. */
export async function renderOne(input: {
  asset: Parameters<typeof buildImagePrompt>[1]["asset"];
  topic: string;
  title: string;
  slot: number;
  refs: string[];
  actor: string | null;
  draftId: string | null;
  direction?: unknown;
  /** Where the image will live. Drives the art-direction preset — see AssetSurface in lib/media/prompt. */
  surface?: "blog" | "landing";
  /** Art direction learned from the team's own feedback. Loaded once per request by the caller and
   *  passed in, rather than fetched per image — a six-image batch should not make six identical
   *  reads of the same handful of rules. */
  houseDirection?: string[];
  /** Overrides the per-role model split. The prefill pins GPT Image 2 — see modelForPrefill. */
  modelOverride?: string;
}) {
  const { asset, slot, refs, actor, draftId, surface } = input;
  const model = input.modelOverride ?? modelForRole(asset.role as AssetRole, refs.length > 0);
  const prompt = buildImagePrompt(model, {
      houseDirection: input.houseDirection,
      surface,
    asset, topic: input.topic, title: input.title, slot,
    direction: typeof input.direction === "string" ? input.direction : undefined,
  });
  const payload = buildPayload(model, {
    prompt,
    aspect: asset.ratio,
    resolution: resolutionForRole(asset.role as AssetRole),
    imageUrls: refs.length ? refs : undefined,
  });

  const startedAt = Date.now();
  try {
    const images = await falQueue(model, payload);
    const img = images[0];
    const ms = Date.now() - startedAt;

    // NOTE: this stores fal's own URL. forge does the same and it is correct for an ad creative, but a
    // PUBLISHED page must not depend on a provider CDN — provider outputs expire and a hero that 404s
    // three weeks after publishing is worse than no image. Re-hosting happens when the asset is placed
    // into a draft (see the media placement path), not here, so a rejected variant never costs storage.
    const stored = await createMediaAsset({
      url: img.url,
      width: img.width ?? asset.width,
      height: img.height ?? asset.height,
      source: "generated",
      provider: "fal",
      model,
      prompt,
      role: asset.role,
      alt: asset.alt,
      draft_id: draftId,
      params: payload as Record<string, unknown>,
      created_by: actor,
      storage_key: null, bytes: null, mime: null, revised_prompt: null, seed: null,
      caption: null, cluster_id: null, strapi_media_id: null, strapi_url: null,
    });
    await logGeneration({ provider: "fal", model, prompt, role: asset.role, ok: true, ms, asset_id: stored.id, created_by: actor });
    return { ok: true as const, asset: stored, role: asset.role };
  } catch (e: unknown) {
    const err = e instanceof FalError ? e : new FalError(String((e as Error)?.message ?? e));
    await logGeneration({
      provider: "fal", model, prompt, role: asset.role, ok: false,
      error: err.message, ms: Date.now() - startedAt, created_by: actor,
    });
    return {
      ok: false as const,
      asset: null,
      role: asset.role,
      // A refusal is the model declining, not us failing — the UI says so differently.
      refused: err.refused,
      error: err.message,
    };
  }
}

