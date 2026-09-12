import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { listMediaAssets, mediaStats, createMediaAsset } from "@/lib/media/store";
import { falEnabled } from "@/lib/media/fal";

export const maxDuration = 30;

// GET — the gallery. Filterable by role, by the draft an asset was made for, and by a text search
// over the prompt and alt text (so "headshot" finds what you made for headshots).
export async function GET(req: NextRequest) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const p = req.nextUrl.searchParams;
  try {
    const [assets, stats] = await Promise.all([
      listMediaAssets({
        role: p.get("role") ?? undefined,
        draftId: p.get("draft_id") ?? undefined,
        q: p.get("q") ?? undefined,
        limit: Number(p.get("limit")) || 60,
      }),
      mediaStats(),
    ]);
    return NextResponse.json({ ok: true, assets, stats, generation_enabled: falEnabled() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "load failed" }, { status: 500 });
  }
}

// POST — register an asset the gallery did not generate: an upload that already went through
// /api/blog/upload, or an image imported from a URL. Generation has its own route.
export async function POST(req: NextRequest) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const url = String(body?.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ ok: false, error: "A https URL is required." }, { status: 400 });
  }
  try {
    const asset = await createMediaAsset({
      url,
      source: body?.source === "url_import" ? "url_import" : "uploaded",
      role: typeof body?.role === "string" ? body.role : "inline",
      alt: typeof body?.alt === "string" ? body.alt : null,
      width: Number(body?.width) || null,
      height: Number(body?.height) || null,
      mime: typeof body?.mime === "string" ? body.mime : null,
      draft_id: typeof body?.draft_id === "string" ? body.draft_id : null,
      strapi_media_id: Number(body?.strapi_media_id) || null,
      strapi_url: typeof body?.strapi_url === "string" ? body.strapi_url : null,
      created_by: s.user?.email ?? null,
      params: {},
      provider: null, model: null, prompt: null, revised_prompt: null, seed: null,
      storage_key: null, bytes: null, caption: null, cluster_id: null,
    });
    return NextResponse.json({ ok: true, asset });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "save failed" }, { status: 500 });
  }
}
