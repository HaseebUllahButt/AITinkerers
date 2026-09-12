import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getBlogDraft, deleteBlogDraft } from "@/lib/db/queries";
import { getEntry, blogType, strapiConfigured } from "@/lib/strapi/client";
import { applyDraftPatch } from "@/lib/blog/save";
import { deriveSyncState } from "@/lib/blog/state";
import { adminEntryUrl } from "@/lib/strapi/client";
import { supabaseAdmin } from "@/lib/db/supabase";

export const maxDuration = 30;

async function session(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.get("authorization") === `Bearer ${secret}` || req.nextUrl.searchParams.get("key") === secret)) {
    return { user: { email: "cron" } };
  }
  return auth().catch(() => null);
}

// GET — one draft. Pass ?live=1 to also pull the Strapi copy for a side-by-side; the editor loads
// with ?live=0 (the default) so opening a post never depends on Strapi being reachable.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const wantLive = req.nextUrl.searchParams.get("live") === "1";
  try {
    const draft = await getBlogDraft(id);
    if (!draft) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

    // Heal a stale admin link rather than serving it.
    //
    // strapi_url is DERIVED — it is adminEntryUrl(strapi_id) at the moment of the sync — but it is
    // stored, so it freezes whatever the URL format was that day. Measured: entry 846 was synced on
    // 12 Aug with the old `collection-types` path (hyphenated plural), which the Strapi admin answers
    // with "Woops! Something went wrong."; every draft synced after the format was corrected is fine.
    // The stored copy could not fix itself, so "Open in Strapi" stayed broken for that one draft
    // forever and the person had to go and find the entry by hand.
    //
    // Recomputing on read costs nothing and means the format can change again without stranding rows.
    if (draft.strapi_id) {
      const fresh = adminEntryUrl(draft.strapi_id);
      if (draft.strapi_url !== fresh) {
        draft.strapi_url = fresh;
        // Persisted opportunistically so the notifier and anything else reading the column agree with
        // what the editor just showed. Never allowed to fail the read.
        void supabaseAdmin.from("blog_drafts").update({ strapi_url: fresh }).eq("id", id).then(
          () => {}, () => {},
        );
      }
    }
    let live: unknown = null;
    if (wantLive && draft.strapi_id && strapiConfigured()) {
      live = await getEntry(blogType(), draft.strapi_id).catch(() => null);
    }
    return NextResponse.json({ ok: true, draft, syncState: deriveSyncState(draft), live });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "load failed" }, { status: 500 });
  }
}

// PATCH { ...changedFields, base_rev } — the autosave write path.
//
// Only allow-listed fields are applied (src/lib/blog/fields.ts), and the write is conditional on
// base_rev so a second tab can't silently clobber the first. On a rev mismatch this answers 409
// with the current row and writes nothing — the client keeps its text and resolves the conflict.
//
// ⚠️ This deliberately does NOT touch Strapi. The previous handler pushed the whole mapped payload
// live whenever strapi_id was set, which would make every debounced autosave an edit to published
// content. Pushing lives in /sync and /publish only.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const baseRev = typeof (body as any)?.base_rev === "number" ? (body as any).base_rev : null;
  const force = (body as any)?.force === true;
  try {
    const res = await applyDraftPatch(id, body, {
      // force skips the guard: used only by "Keep mine" in the conflict dialog, which snapshots
      // the losing branch first via reason: "pre_conflict_overwrite".
      baseRev: force ? null : baseRev,
      editedBy: s.user?.email ?? null,
      reason: force ? "pre_conflict_overwrite" : ((body as any)?.reason ?? "autosave"),
    });
    if (!res) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, conflict: true, draft: res.conflict, error: "This draft was edited elsewhere." },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      draft: res.draft,
      syncState: deriveSyncState(res.draft),
      // Surfaced so a client that drifts out of sync with EDITABLE_FIELDS is noticed in dev
      // instead of silently dropping the user's edits to that field.
      ...(res.rejected.length ? { rejected: res.rejected } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "save failed" }, { status: 500 });
  }
}

// PUT — alias of PATCH, kept so any existing caller keeps working. Identical semantics.
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return PATCH(req, ctx);
}

// DELETE — remove the local record. Does NOT delete the Strapi entry if one exists (that's a
// separate, deliberate action — removing live content shouldn't be a side effect of tidying up).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await deleteBlogDraft(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "delete failed" }, { status: 500 });
  }
}
