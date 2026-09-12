// Reading and writing the media gallery.
//
// Separate from src/lib/db/queries.ts on purpose: that file is already ~3,300 lines and this is a
// self-contained surface with its own tables, the same way src/lib/sitemap/store.ts is.
import { supabaseAdmin } from "@/lib/db/supabase";
import type { AssetRole } from "./plan";

export interface MediaAsset {
  id: string;
  url: string;
  storage_key: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  mime: string | null;
  source: "generated" | "uploaded" | "url_import";
  provider: string | null;
  model: string | null;
  prompt: string | null;
  revised_prompt: string | null;
  seed: number | null;
  params: Record<string, unknown>;
  role: AssetRole | string;
  alt: string | null;
  caption: string | null;
  draft_id: string | null;
  cluster_id: string | null;
  strapi_media_id: number | null;
  strapi_url: string | null;
  archived: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListAssetsOptions {
  role?: string;
  draftId?: string;
  /** Matches the prompt and the alt text, so "headshot" finds what you made for headshots. */
  q?: string;
  limit?: number;
  /** Newest first by default; the gallery is chronological. */
  includeArchived?: boolean;
}

export async function listMediaAssets(opts: ListAssetsOptions = {}): Promise<MediaAsset[]> {
  let q = supabaseAdmin.from("media_assets").select("*").order("created_at", { ascending: false });
  if (!opts.includeArchived) q = q.eq("archived", false);
  if (opts.role) q = q.eq("role", opts.role);
  if (opts.draftId) q = q.eq("draft_id", opts.draftId);
  if (opts.q?.trim()) {
    const needle = `%${opts.q.trim()}%`;
    q = q.or(`prompt.ilike.${needle},alt.ilike.${needle}`);
  }
  // PostgREST caps at 1000 rows regardless; the gallery paginates rather than pretending otherwise.
  const { data, error } = await q.limit(Math.min(opts.limit ?? 60, 1000));
  if (error) throw error;
  return (data ?? []) as MediaAsset[];
}

export async function getMediaAsset(id: string): Promise<MediaAsset | null> {
  const { data, error } = await supabaseAdmin.from("media_assets").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data ?? null) as MediaAsset | null;
}

export type NewMediaAsset = Omit<MediaAsset, "id" | "created_at" | "updated_at" | "archived"> & {
  archived?: boolean;
};

/**
 * Insert an asset, or return the existing row when this URL is already known.
 *
 * The URL is uniquely indexed so re-importing an image we already host finds it instead of creating a
 * duplicate gallery entry.
 */
export async function createMediaAsset(row: Partial<NewMediaAsset> & { url: string }): Promise<MediaAsset> {
  const { data, error } = await supabaseAdmin
    .from("media_assets")
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "url" })
    .select()
    .single();
  if (error) throw error;
  return data as MediaAsset;
}

export async function updateMediaAsset(id: string, patch: Partial<MediaAsset>): Promise<MediaAsset> {
  // Server-owned columns can never be set by a caller.
  const { id: _i, created_at: _c, url: _u, ...safe } = patch as Record<string, unknown> & { id?: string };
  const { data, error } = await supabaseAdmin
    .from("media_assets")
    .update({ ...safe, updated_at: new Date().toISOString() })
    .eq("id", id).select().single();
  if (error) throw error;
  return data as MediaAsset;
}

/** Soft delete. The row survives because a published article's markdown may still reference the URL. */
export async function archiveMediaAsset(id: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("media_assets").update({ archived: true, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export interface GenerationLog {
  provider: string;
  model: string;
  prompt: string;
  role?: string | null;
  ok: boolean;
  error?: string | null;
  ms?: number | null;
  est_cost_usd?: number | null;
  asset_id?: string | null;
  created_by?: string | null;
}

/**
 * Log every attempt, including refusals.
 *
 * A content-policy block is information — that prompt shape does not work — and dropping it silently
 * means rediscovering the same wall repeatedly. Best-effort: a logging failure must never lose an
 * image we already paid to generate.
 */
export async function logGeneration(row: GenerationLog): Promise<void> {
  const { error } = await supabaseAdmin.from("media_generations").insert(row);
  if (error) console.error("[media] generation log failed:", error.message);
}

export async function mediaStats(): Promise<{ assets: number; generations: number; failures: number }> {
  const [a, g, f] = await Promise.all([
    supabaseAdmin.from("media_assets").select("id", { count: "exact", head: true }).eq("archived", false),
    supabaseAdmin.from("media_generations").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("media_generations").select("id", { count: "exact", head: true }).eq("ok", false),
  ]);
  return { assets: a.count ?? 0, generations: g.count ?? 0, failures: f.count ?? 0 };
}
