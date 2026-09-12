// Give machine-written drafts the thumbnail they need to publish.
//
// ── Why not "on creation" ───────────────────────────────────────────────────────────────────────
//
// A draft is created before it has a title, and for the pipeline it is created before it has a word
// of body — the row exists so the writer has somewhere to put the article. Generating an image at
// that moment means paying a real fal render to illustrate an empty row, and the prompt would be
// built from a placeholder slug.
//
// So the trigger is "the writing is DONE and the thumbnail is the thing missing", which is both the
// first moment a good image can be made and the last moment before it blocks a publish.
//
// ── Why only machine-written drafts ─────────────────────────────────────────────────────────────
//
// Somebody drafting by hand may be about to upload a specific picture, and spending money to
// pre-empt them is presumptuous. A draft that arrived from Atlas or was written by Summer has
// nobody standing over it, and its missing thumbnail is a job nobody is going to do.
//
// "Or was written by Summer" was aspirational for a while: Summer stamped created_by with the signed-in
// user's address, so its drafts looked hand-typed and every one of them was skipped here. The marker
// that fixes it lives in blog/origin.ts — this gate did not need changing, only telling.
//
// ── Why the YouTube frame comes first ───────────────────────────────────────────────────────────
//
// If the piece is about a video, that video's own poster frame is the right picture and it is free.
// Rendering an imagined scene for an article about a specific stream is paying more for something
// worse. Generation is the fallback, not the default.
import { supabaseAdmin } from "@/lib/db/supabase";
import { youtubeIdFrom, youtubeThumbnail } from "@/lib/blog/request";
import { isMachineMade } from "@/lib/blog/origin";
import { internalUrl } from "@/lib/appUrl";

/** Per run. A cap, not a target — if twenty drafts need one, nineteen can wait an hour. */
const MAX_PER_RUN = 4;

export interface ThumbResult {
  considered: number;
  fromVideo: number;
  generated: number;
  skipped: number;
  failures: { draft: string; error: string }[];
  notes: string[];
}

async function attach(draftId: string, title: string, url: string): Promise<boolean> {
  const { rehostToStrapi } = await import("@/lib/media/prefill");
  const { planAssets } = await import("@/lib/media/plan");
  const spec = planAssets({ title, keyword: title, words: 0, headings: [], kind: "blog" })
    .assets.find((a) => a.role === "thumbnail" || a.role === "hero");
  if (!spec) return false;
  const hosted = await rehostToStrapi(url, spec);
  if (!hosted?.id) return false;
  const { data: cur } = await supabaseAdmin
    .from("blog_drafts").select("cover_media_id").eq("id", draftId).maybeSingle();
  await supabaseAdmin.from("blog_drafts").update({
    thumbnail_media_id: hosted.id, thumbnail_media_url: hosted.url,
    // The cover only when there is not one already — a hero somebody chose is not ours to replace.
    ...(cur?.cover_media_id ? {} : { cover_media_id: hosted.id, cover_media_url: hosted.url }),
  }).eq("id", draftId);
  return true;
}

/**
 * Find machine-written drafts that are finished but have no thumbnail, and give them one.
 *
 * Never throws: this runs on a schedule beside the notifier, and a fal outage must not take the
 * whole cron down with it.
 */
export async function ensureThumbnails(
  opts: { dryRun?: boolean; skipDraftIds?: readonly string[]; deadlineAt?: number } = {},
): Promise<ThumbResult> {
  const out: ThumbResult = { considered: 0, fromVideo: 0, generated: 0, skipped: 0, failures: [], notes: [] };

  const { data, error } = await supabaseAdmin
    .from("blog_drafts")
    .select("id, title, slug, body, created_by, thumbnail_media_id")
    .is("thumbnail_media_id", null)
    .eq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) { out.notes.push(`Could not read drafts: ${error.message}`); return out; }

  // Drafts a resumed run owns this tick. Generating a thumbnail for one of these would race the
  // resumed run's own image step and pay for the same render twice — see resumeStalled.ts.
  const skip = new Set(opts.skipDraftIds ?? []);

  const candidates = (data ?? []).filter((d) => {
    if (skip.has(d.id)) return false;
    if (!isMachineMade(d.created_by)) return false;
    // A title AND a body: the two things a good prompt needs, and together they mean the writing
    // actually finished rather than the row merely existing.
    return !!d.title?.trim() && (d.body ?? "").length > 500;
  });
  out.considered = candidates.length;
  out.skipped = (data ?? []).length - candidates.length;

  // ── Stop before the pass after this one starves ────────────────────────────────────────────────
  //
  // A 2K fal render routinely takes minutes, this does up to four of them, and it shares one 120s
  // function with the resume pass and the notifier. When the budget ran out mid-notifier the result
  // was not a missed notification but a REPEATED one — the notifier posted to Slack and was killed
  // before it could record that it had. Two drafts were announced twice an hour apart because of it.
  //
  // So a render that cannot be finished in the time left is not started. A draft with no thumbnail is
  // picked up by the next tick unchanged; a duplicate Slack message cannot be taken back.
  const outOfTime = () => opts.deadlineAt !== undefined && Date.now() > opts.deadlineAt;

  for (const d of candidates.slice(0, MAX_PER_RUN)) {
    if (opts.dryRun) { out.generated++; continue; }
    if (outOfTime()) {
      out.notes.push("Stopped early to leave the notifier enough time; the rest are picked up next run.");
      break;
    }
    try {
      // 1. The video's own frame, if the piece is about one.
      const { data: s } = await supabaseAdmin
        .from("writer_sessions").select("required_sources, must_follow, brief")
        .eq("draft_id", d.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      const hay = [
        (s?.required_sources ?? []).join(" "),
        String((s?.brief as Record<string, unknown> | null)?.source_material ?? ""),
        String(s?.must_follow ?? ""),
        d.body ?? "",
      ].join("\n");
      const vid = youtubeIdFrom(hay);
      if (vid) {
        const url = await youtubeThumbnail(vid);
        if (await attach(d.id, d.title!, url)) { out.fromVideo++; continue; }
      }

      // 2. Otherwise render one. Through the same endpoint the pipeline uses, so the art direction,
      //    the size preset and the model are identical to every other image this tool makes.
      // internalUrl(), not publicUrl(): this is a call the app makes to ITSELF, so loopback is the
      // correct value in development rather than something to be filtered out.
      const base = internalUrl();
      const secret = process.env.CRON_SECRET ?? "";
      const res = await fetch(`${base}/api/media/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify({ draft_id: d.id, roles: ["thumbnail"] }),
        signal: AbortSignal.timeout(220_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { out.failures.push({ draft: d.title ?? d.slug, error: `HTTP ${res.status}` }); continue; }
      if ((body as { promoted?: Record<string, number> }).promoted?.thumbnail) out.generated++;
      else out.failures.push({ draft: d.title ?? d.slug, error: "rendered but not attached" });
    } catch (e) {
      out.failures.push({ draft: d.title ?? d.slug, error: e instanceof Error ? e.message : "failed" });
    }
  }

  if (candidates.length > MAX_PER_RUN) {
    out.notes.push(`${candidates.length - MAX_PER_RUN} more need one; capped at ${MAX_PER_RUN} this run.`);
  }
  return out;
}
