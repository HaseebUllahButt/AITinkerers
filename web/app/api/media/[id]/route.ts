import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getMediaAsset, updateMediaAsset, archiveMediaAsset } from "@/lib/media/store";

export const maxDuration = 30;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const asset = await getMediaAsset(id);
  if (!asset) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true, asset });
}

// PATCH — alt text and caption. Alt is the one field that must be right before an asset is placed:
// it is what a screen reader announces and what Google reads.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    const asset = await updateMediaAsset(id, {
      ...(typeof body?.alt === "string" ? { alt: body.alt.slice(0, 125) } : {}),
      ...(typeof body?.caption === "string" ? { caption: body.caption } : {}),
      ...(typeof body?.role === "string" ? { role: body.role } : {}),
    });
    return NextResponse.json({ ok: true, asset });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "update failed" }, { status: 500 });
  }
}

// DELETE — soft delete. The row survives because a published article's markdown may still point at
// this URL; hiding it from the gallery is not the same as making it unreachable.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await archiveMediaAsset(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "delete failed" }, { status: 500 });
  }
}
