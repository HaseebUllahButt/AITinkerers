import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { listWriterVoices, createWriterVoice, getWriterVoiceBySlug } from "@/lib/db/queries";
import { renderVoiceSystem, voiceSystemApproxTokens } from "@/lib/writer/voice";
import { slugify } from "@/lib/blog/fields";

export const maxDuration = 30;

async function session(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.get("authorization") === `Bearer ${secret}` || req.nextUrl.searchParams.get("key") === secret)) {
    return { user: { email: "cron" } };
  }
  return auth().catch(() => null);
}

// GET — the selectable voices, for the picker and the editor.
// ?preview=1 also returns the exact rendered system prompt per voice, so the SEO team can see what
// the model will actually be told rather than inferring it from the form fields.
export async function GET(req: NextRequest) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const withPreview = req.nextUrl.searchParams.get("preview") === "1";
  const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
  try {
    const voices = await listWriterVoices(includeArchived);
    return NextResponse.json({
      ok: true,
      voices: voices.map((v) => ({
        ...v,
        ...(withPreview
          ? { rendered: renderVoiceSystem(v), approx_tokens: voiceSystemApproxTokens(v) }
          : {}),
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "list failed" }, { status: 500 });
  }
}

// POST { name, ...fields } — add a voice. Slug is derived from the name and must be unique, since
// it's the stable handle used to reference a voice from a session or a cluster.
export async function POST(req: NextRequest) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const name = String((body as any)?.name ?? "").trim();
  if (!name) return NextResponse.json({ ok: false, error: "name is required" }, { status: 400 });

  const slug = slugify(String((body as any)?.slug || name));
  if (!slug) return NextResponse.json({ ok: false, error: "could not derive a slug from that name" }, { status: 400 });
  try {
    if (await getWriterVoiceBySlug(slug)) {
      return NextResponse.json({ ok: false, error: `A voice with the slug "${slug}" already exists.` }, { status: 400 });
    }
    const voice = await createWriterVoice({
      slug,
      name,
      description: (body as any)?.description ?? null,
      tone_doc: String((body as any)?.tone_doc ?? ""),
      workflow_rules: String((body as any)?.workflow_rules ?? ""),
      brand_name: (body as any)?.brand_name ?? null,
      created_by: s.user?.email ?? undefined,
      // Never created as the default — promoting a voice is a separate, explicit action so that
      // adding a draft voice can't silently change what every future article sounds like.
      is_default: false,
    });
    return NextResponse.json({ ok: true, voice });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "create failed" }, { status: 500 });
  }
}
