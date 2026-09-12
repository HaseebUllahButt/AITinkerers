// fal.ai image generation.
//
// Ported from the request/transport behaviour proven in Vyro's forge pipeline, because every one of
// these details is something forge hit in production:
//
//   - The header is `Authorization: Key …`, NOT Bearer.
//   - Anything at 2K or above must go through the QUEUE host. Nano Banana Pro at 4K routinely takes
//     minutes and read-times-out the synchronous endpoint.
//   - Reads (status, result) retry freely. The SUBMIT retries only on pre-acceptance failures, because
//     once fal has accepted a job it is billable and a retry pays for the same image twice.
//   - A content-policy refusal arrives as HTTP 200 with an empty `images` array. Treating "no image in
//     a 200" as success is how a pipeline silently produces nothing.
//   - `/edit` REQUIRES image_urls. With no references the suffix must be stripped or the call fails.
import { SIZE_PRESETS, type AssetRole } from "./plan";

const FAL_RUN = "https://fal.run";
const FAL_QUEUE = "https://queue.fal.run";

/** Model ids, pinned as code constants rather than env vars — which model draws the picture is a
 *  product decision, not deployment config. Same posture as forge's constants.py. */
export const MODELS = {
  /** Best text rendering of the two, and it honours negatives strongly. Use for cards with copy. */
  gptImage: "openai/gpt-image-2",
  gptImageEdit: "openai/gpt-image-2/edit",
  /** Better photographic realism, but reads negatives weakly — prompt it positively. */
  nanoBanana: "fal-ai/nano-banana-pro",
  nanoBananaEdit: "fal-ai/nano-banana-pro/edit",
  upscaler: "fal-ai/clarity-upscaler",
} as const;

export function falEnabled(): boolean {
  const k = process.env.FAL_KEY;
  return !!k && k.length > 8;
}

function headers(): Record<string, string> {
  // `Key`, not `Bearer`. This is the single most common fal integration mistake.
  return { Authorization: `Key ${process.env.FAL_KEY}`, "Content-Type": "application/json" };
}

export class FalError extends Error {
  /** True when fal returned a 200 with no image — i.e. a safety/moderation block, not a fault. */
  readonly refused: boolean;
  constructor(message: string, refused = false) {
    super(message);
    this.name = "FalError";
    this.refused = refused;
  }
}

/** GPT Image 2 hard cap per edge. */
const MAX_EDGE = 3840;
const RES_PX: Record<string, number> = { "0.5K": 512, "1K": 1024, "2K": 2048, "4K": 3840 };
const ASPECT_WH: Record<string, [number, number]> = {
  "1:1": [1, 1], "16:9": [16, 9], "9:16": [9, 16], "4:3": [4, 3], "3:4": [3, 4],
  "3:2": [3, 2], "2:3": [2, 3], "4:5": [4, 5], "1.91:1": [191, 100], "21:9": [21, 9],
  "1200:630": [1200, 630],
};

/** Edges must be multiples of 16 for GPT Image 2. */
const r16 = (n: number) => Math.max(16, Math.round(n / 16) * 16);

/**
 * Pixel dimensions for an aspect at a resolution tier, obeying the /16 and 3840 constraints.
 *
 * Note what this means for the OG card: 630 is not a multiple of 16, so the exact 1200x630 spec
 * CANNOT come out of GPT Image 2. The render happens at the correct ratio, larger, and is resized to
 * exactly 1200x630 when the bytes are re-hosted. Platforms downscale cleanly; they do not upscale
 * cleanly, so erring large is the right direction.
 */
export function imageSizeFor(aspect: string, resolution: string): { width: number; height: number } | "auto" {
  const wh = ASPECT_WH[aspect];
  if (!wh) return "auto";
  const base = Math.min(RES_PX[resolution] ?? 2048, MAX_EDGE);
  const [w, h] = wh;
  return w >= h
    ? { width: base, height: r16((base * h) / w) }
    : { width: r16((base * w) / h), height: base };
}

export const isGptImage = (model: string) => model.toLowerCase().includes("gpt-image");

export interface GenerateParams {
  prompt: string;
  aspect: string;
  resolution?: "0.5K" | "1K" | "2K" | "4K";
  quality?: "high" | "medium" | "low" | "auto";
  numImages?: number;
  outputFormat?: "png" | "jpeg" | "webp";
  /** Reference images as data URLs or publicly-reachable https URLs. Max 6. */
  imageUrls?: string[];
}

/**
 * The one place the two model families diverge.
 *
 * GPT Image 2 takes explicit pixel `image_size` plus a `quality` enum. Nano Banana takes
 * `aspect_ratio` + a `resolution` tier and IGNORES quality. Sending `image_size` to Nano Banana is a
 * bug (forge has it in one path — deliberately not copied).
 */
export function buildPayload(model: string, p: GenerateParams): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: p.prompt,
    num_images: p.numImages ?? 1,
    output_format: p.outputFormat ?? "png",
  };
  if (isGptImage(model)) {
    payload.image_size = imageSizeFor(p.aspect, p.resolution ?? "2K");
    payload.quality = p.quality ?? "high";
  } else {
    payload.aspect_ratio = p.aspect;
    payload.resolution = p.resolution ?? "2K";
  }
  if (p.imageUrls?.length) payload.image_urls = p.imageUrls.slice(0, MAX_REFS);
  return payload;
}

export const MAX_REFS = 6;

/** Hosts fal's fetcher can never reach. Passing one produces a confusing download error. */
const UNREACHABLE = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"]);

export function refIsReachable(url: string): boolean {
  if (url.startsWith("data:")) return true;
  try {
    return !UNREACHABLE.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * `/edit` requires references. Strip the suffix when there are none, or the request fails outright.
 */
export function resolveModel(model: string, hasRefs: boolean): string {
  if (hasRefs) return model;
  return model.endsWith("/edit") ? model.slice(0, -"/edit".length) : model;
}

const RETRY_BACKOFF_MS = [2000, 4000, 8000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry transport failures only. A 4xx/5xx from fal is an answer, not a blip. */
async function retryingFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY_BACKOFF_MS.length) await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }
  throw new FalError(`fal request failed after retries: ${(lastErr as Error)?.message ?? lastErr}`);
}

export interface FalImage { url: string; width?: number; height?: number }

/**
 * Pull the images out of a fal response, or work out why there aren't any.
 *
 * A moderation block is a 200 with `images: []`. The reason hides in one of several fields depending
 * on the model, so all of them get checked before giving up.
 */
export function extractImages(res: Record<string, unknown>): FalImage[] {
  const arr = Array.isArray(res.images) ? res.images : [];
  const out = arr
    .map((i) => (i && typeof i === "object" ? (i as FalImage) : null))
    .filter((i): i is FalImage => !!i?.url);
  if (out.length) return out;

  // Some models return a single `image` instead of an array.
  const single = res.image as FalImage | undefined;
  if (single?.url) return [single];

  const detail = String(res.error ?? res.detail ?? res.message ?? "").trim();
  if (detail) throw new FalError(`fal returned no image: ${detail.slice(0, 200)}`, true);
  if (res.nsfw_content_detected) {
    throw new FalError("The image model's safety filter blocked this prompt.", true);
  }
  throw new FalError(`fal returned no image: ${JSON.stringify(res).slice(0, 200)}`, true);
}

const POLL_MS = 3000;
const QUEUE_TIMEOUT_MS = 600_000;

/**
 * Submit to the queue and poll to completion.
 *
 * The submit is deliberately NOT wrapped in retryingFetch: a retry after fal has accepted the job
 * enqueues a second one and bills twice for the same image. Only a pre-acceptance failure (which
 * throws before a response exists) is safe to retry, and that is handled by attempting once and
 * surfacing the error.
 */
export async function falQueue(
  model: string,
  payload: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<FalImage[]> {
  if (!falEnabled()) throw new FalError("FAL_KEY is not set.");

  // Generous write timeout: the body may carry several megabytes of reference data URLs.
  const submit = await fetch(`${FAL_QUEUE}/${model}`, {
    method: "POST", headers: headers(), body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000),
  });
  if (!submit.ok) {
    throw new FalError(`fal submit failed (${submit.status}): ${(await submit.text()).slice(0, 300)}`);
  }
  const job = (await submit.json()) as Record<string, unknown>;

  // Some models answer inline with no queue handles at all.
  const statusUrl = typeof job.status_url === "string" ? job.status_url : null;
  const responseUrl = typeof job.response_url === "string" ? job.response_url : null;
  if (!statusUrl || !responseUrl) return extractImages(job);

  const deadline = Date.now() + (opts.timeoutMs ?? QUEUE_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const st = await retryingFetch(statusUrl, { headers: headers() }, 60_000);
    const s = (await st.json()) as Record<string, unknown>;
    const status = String(s.status ?? "");
    if (status === "COMPLETED") {
      const res = await retryingFetch(responseUrl, { headers: headers() }, 120_000);
      return extractImages((await res.json()) as Record<string, unknown>);
    }
    if (status === "ERROR" || status === "FAILED") {
      throw new FalError(`fal job failed: ${JSON.stringify(s).slice(0, 300)}`);
    }
    await sleep(POLL_MS);
  }
  throw new FalError(`fal job timed out after ${Math.round((opts.timeoutMs ?? QUEUE_TIMEOUT_MS) / 1000)}s`);
}

/** The synchronous host. Only for small, fast renders — 180s and no polling. */
export async function falRun(model: string, payload: Record<string, unknown>): Promise<FalImage[]> {
  if (!falEnabled()) throw new FalError("FAL_KEY is not set.");
  const res = await retryingFetch(
    `${FAL_RUN}/${model}`,
    { method: "POST", headers: headers(), body: JSON.stringify(payload) },
    180_000,
  );
  if (!res.ok) throw new FalError(`fal failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return extractImages((await res.json()) as Record<string, unknown>);
}

/** Which model suits a role. The card carries text, so it goes to the one that renders text best. */
export function modelForRole(role: AssetRole, hasRefs: boolean): string {
  // GPT Image 2 for everything, and this is a correction rather than a preference.
  //
  // The split used to be: GPT for text-bearing cards, Nano Banana Pro for photographic work. Three
  // things say that was wrong here.
  //
  // 1. SPEED, measured. Nano Banana is asked for "2K" at any long edge over 1024 — which is every
  //    role except nothing — renders far larger than we display (2752x1536 for a 1600x900 hero) and
  //    takes minutes. Observed: one hero at 3m31s against a 220s deadline, so the call died, the turn
  //    died with it, and the render was billed anyway. Six body images at 1200x675 also resolve to
  //    "2K", so the same wall was waiting for the body pass.
  // 2. SIZE. GPT Image 2 takes an explicit image_size and renders exactly the dimensions we publish.
  //    Nano Banana's resolution enum is coarse (0.5K/1K/2K/4K), so anything between 1024 and 2048 is
  //    rounded UP and the surplus is discarded on the way to the CDN.
  // 3. IT WAS ALREADY THE DECISION. modelForPrefill has pinned GPT Image 2 for every role "by
  //    request" since it was written. modelForRole simply never caught up, so the gallery and the
  //    prefill disagreed about the same image.
  //
  // buildImagePrompt branches on the family, so pinning the model also pins the prompt strategy to
  // the negatives-heavy one — which is the strategy where "no text, no logos, no watermarks" is
  // actually honoured. Nano Banana reads negatives weakly and draws whatever you name.
  //
  // MEDIA_ROLE_MODEL=nano-banana restores the old split without a code change, for the case where
  // photographic quality genuinely matters more than the clock.
  if (process.env.MEDIA_ROLE_MODEL?.trim() === "nano-banana") {
    const wantsText = role === "og" || role === "thumbnail";
    return resolveModel(wantsText ? MODELS.gptImageEdit : MODELS.nanoBananaEdit, hasRefs);
  }
  return resolveModel(MODELS.gptImageEdit, hasRefs);
}

/**
 * The model the create-time prefill uses for EVERY role.
 *
 * modelForRole() deliberately splits the two families — GPT Image 2 for anything text-bearing because it
 * renders quoted strings reliably, Nano Banana for photographic work. That split is still right for the
 * gallery, where someone is choosing per image.
 *
 * The prefill pins one family instead, and it is GPT Image 2 by request. The reason that is safe rather
 * than a downgrade: buildImagePrompt() already branches on the family and writes a negatives-heavy prompt
 * for GPT and a positives-heavy one for Nano, because Nano draws whatever you name. Pinning the model
 * therefore also pins the prompt strategy to the one where an explicit "no text, no logos, no watermarks"
 * clause is honoured — which is what a starter image most needs.
 *
 * MEDIA_PREFILL_MODEL overrides it, so reverting to the per-role split is one env var, not a code change.
 */
export function modelForPrefill(role: AssetRole, hasRefs: boolean): string {
  const override = process.env.MEDIA_PREFILL_MODEL?.trim();
  if (override === "per-role") return modelForRole(role, hasRefs);
  return resolveModel(override || MODELS.gptImageEdit, hasRefs);
}

/** Resolution tier for a role, from the pixel target in the plan. */
export function resolutionForRole(role: AssetRole): "1K" | "2K" | "4K" {
  const longEdge = Math.max(SIZE_PRESETS[role].width, SIZE_PRESETS[role].height);
  if (longEdge > 2048) return "4K";
  if (longEdge > 1024) return "2K";
  return "1K";
}
