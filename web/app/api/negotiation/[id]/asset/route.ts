import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";

export const maxDuration = 60;

// POST /api/negotiation/[id]/asset — stage a document (one-pager, deck, etc.) on the thread anchor
// so an assisted reply can attach it. Stored base64 on the row (no external storage); the attach +
// clear happens when the reply is actually sent. multipart/form-data with a "file" field.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    const f = file as File;
    if (f.size > 8 * 1024 * 1024) return NextResponse.json({ error: "File too large (max 8MB)." }, { status: 400 });
    const b64 = Buffer.from(await f.arrayBuffer()).toString("base64");
    await supabaseAdmin.from("outreach_emails").update({
      intervention_asset_name: f.name || "attachment",
      intervention_asset_mime: f.type || "application/octet-stream",
      intervention_asset_b64: b64,
    }).eq("id", id);
    return NextResponse.json({ ok: true, name: f.name, size: f.size });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "upload failed" }, { status: 500 });
  }
}

// DELETE — remove a staged document (before sending).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await supabaseAdmin.from("outreach_emails").update({ intervention_asset_name: null, intervention_asset_mime: null, intervention_asset_b64: null }).eq("id", id);
  return NextResponse.json({ ok: true });
}
