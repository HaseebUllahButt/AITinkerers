// Persistent, serverless-safe cache over allBacklinks(). Ahrefs bills per ROW, and the client's
// in-process 6h Map dies with every cold start — the workspace burned its full monthly budget in
// days partly on re-fetches of profiles we had already paid for. A fetched profile is an asset:
// keep it, slice it, and only go back to Ahrefs when the request genuinely exceeds what we hold.
import { supabaseAdmin } from "@/lib/db/supabase";
import { allBacklinks, type AhrefsBacklink } from "@/lib/writer/ahrefs";

/** Long on purpose: link profiles move slowly, and a two-week-old row set is still a fine
 *  prospecting source. A fresh fetch always overwrites, so staleness never compounds. */
export const AHREFS_CACHE_TTL_DAYS = 14;

export interface CachedBacklinks {
  rows: AhrefsBacklink[];
  /** True when no Ahrefs units were spent answering this call. */
  cached: boolean;
  fetched_at: string;
  /** Rows billed BY THIS CALL — zero on a cache hit. */
  rows_billed: number;
}

/**
 * allBacklinks() with a durable cache keyed on (target, dr band). A stored fetch answers any
 * request for the same band at an equal-or-smaller limit (rows come back DR-desc, so a prefix of a
 * bigger fetch IS the smaller fetch). Returns null exactly when allBacklinks does — key missing,
 * budget spent, Ahrefs down — so callers keep their existing failure handling.
 */
export async function cachedAllBacklinks(
  target: string,
  opts: { limit: number; minDr: number; maxDr: number },
): Promise<CachedBacklinks | null> {
  const freshAfter = new Date(Date.now() - AHREFS_CACHE_TTL_DAYS * 86_400_000).toISOString();
  const { data } = await supabaseAdmin
    .from("ahrefs_fetches").select("rows, limit_rows, fetched_at")
    .eq("target", target).eq("min_dr", opts.minDr).eq("max_dr", opts.maxDr)
    .gte("fetched_at", freshAfter)
    .limit(1);
  const hit = data?.[0] as { rows: AhrefsBacklink[]; limit_rows: number; fetched_at: string } | undefined;
  if (hit && hit.limit_rows >= opts.limit) {
    return { rows: (hit.rows ?? []).slice(0, opts.limit), cached: true, fetched_at: hit.fetched_at, rows_billed: 0 };
  }

  const rows = await allBacklinks(target, opts);
  if (rows === null) return null;
  // Best-effort write: a cache save failing must never fail the fetch that just cost real units.
  await supabaseAdmin.from("ahrefs_fetches").upsert({
    target, min_dr: opts.minDr, max_dr: opts.maxDr,
    limit_rows: opts.limit, rows, rows_billed: rows.length, fetched_at: new Date().toISOString(),
  }, { onConflict: "target,min_dr,max_dr" }).then(({ error }) => { if (error) console.error("ahrefs cache save failed:", error.message); });
  return { rows, cached: false, fetched_at: new Date().toISOString(), rows_billed: rows.length };
}
