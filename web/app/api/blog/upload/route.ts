import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { uploadFile, mediaUrl, strapiConfigured } from "@/lib/strapi/client";

export const maxDuration = 120;

async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
    if (req.nextUrl.searchParams.get("key") === secret) return true;
  }
  return !!(await auth().catch(() => null));
}

// POST multipart/form-data with a "file" field → uploads to the Strapi media library and
// returns the media record (id + absolute url) so the composer can drop it into the post body
// or set it as the cover — "upload images as we go" without leaving the app.
// Optional form fields ref/refId/field attach the upload straight onto an entry's media field.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!strapiConfigured()) return NextResponse.json({ ok: false, error: "Strapi not configured" }, { status: 503 });

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "form field 'file' (a File) is required" }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ref = form.get("ref");
    const refId = form.get("refId");
    const field = form.get("field");
    const attach = ref && refId && field
      ? { ref: String(ref), refId: String(refId), field: String(field) }
      : undefined;
    const alt = form.get("alt");

    const media = await uploadFile(
      { bytes, filename: file.name || "upload", mime: file.type || "application/octet-stream" },
      attach,
      alt ? { alternativeText: String(alt) } : undefined,
    );
    const first = media[0];
    return NextResponse.json({
      ok: true,
      media: media.map((m) => ({ id: m.id, url: mediaUrl(m.url), name: m.name, mime: m.mime, width: m.width, height: m.height })),
      // Convenience for the editor: markdown to paste, and the raw absolute url.
      markdown: first ? `![${first.alternativeText || first.name}](${mediaUrl(first.url)})` : undefined,
      url: first ? mediaUrl(first.url) : undefined,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "upload failed" }, { status: 500 });
  }
}
