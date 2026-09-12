import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getWriterVoice, saveWriterVoice, setDefaultWriterVoice } from "@/lib/db/queries";
import { renderVoiceSystem, voiceSystemApproxTokens } from "@/lib/writer/voice";

export const maxDuration = 30;

async function session(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.get("authorization") === `Bearer ${secret}` || req.nextUrl.searchParams.get("key") === secret)) {
    return { user: { email: "cron" } };
  }
  return auth().catch(() => null);
}

// GET — one voice, plus the exact system prompt it renders to. The rendered block is the thing that
// actually steers the model, so showing it is the difference between editing a voice and guessing.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const voice = await getWriterVoice(id);
    if (!voice) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({
      ok: true, voice,
      rendered: renderVoiceSystem(voice),
      approx_tokens: voiceSystemApproxTokens(voice),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "load failed" }, { status: 500 });
  }
}

// PUT { ...fields } — edit a voice. Only the whitelisted columns are applied, and prompt_revision
// advances only when a prompt-bearing field actually changed (see saveWriterVoice) so renaming a
// voice doesn't throw away a warm prompt cache.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  try {
    const before = await getWriterVoice(id);
    if (!before) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    const voice = await saveWriterVoice(id, body as Record<string, unknown>);
    if (!voice) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({
      ok: true, voice,
      rendered: renderVoiceSystem(voice),
      approx_tokens: voiceSystemApproxTokens(voice),
      // Surfaced so an editor can see when a change will cost one cold prompt-cache write, and when
      // it's free. Cheap transparency on an otherwise invisible cost.
      prompt_changed: voice.prompt_revision !== before.prompt_revision,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "save failed" }, { status: 500 });
  }
}

// POST { action: "make_default" } — promote this voice to the one used when nobody picks.
// Separate from PUT because it mutates a different row too (a partial unique index allows exactly
// one default), and because it changes what future articles sound like by default.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  if ((body as any)?.action !== "make_default") {
    return NextResponse.json({ ok: false, error: 'unknown action (expected "make_default")' }, { status: 400 });
  }
  try {
    const voice = await getWriterVoice(id);
    if (!voice) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    if (voice.archived) {
      return NextResponse.json({ ok: false, error: "An archived voice can't be the default." }, { status: 400 });
    }
    await setDefaultWriterVoice(id);
    return NextResponse.json({ ok: true, voice: await getWriterVoice(id) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "action failed" }, { status: 500 });
  }
}
