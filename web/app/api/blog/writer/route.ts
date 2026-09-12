import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import {
  createWriterSession, getDefaultWriterVoice, getWriterVoice, createBlogDraft, listWriterSessionSummaries,
} from "@/lib/db/queries";
import { writerEnabled } from "@/lib/writer/anthropic";
import { placeholderSlug } from "@/lib/blog/fields";

export const maxDuration = 30;

// POST { voice_id? } — start a new single-post writing session.
//
// Creates the blog_draft row up front (empty body, local-only) so submit_section always has a
// target — the agent never creates its own draft, which keeps "one row per session" guaranteed and
// keeps drafts out of Strapi until a human explicitly syncs, same as the rest of the composer.
export async function POST(req: NextRequest) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!writerEnabled()) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not set." }, { status: 503 });
  }
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  try {
    const voice = (body as any)?.voice_id
      ? await getWriterVoice(String((body as any).voice_id))
      : await getDefaultWriterVoice();
    if (!voice) {
      return NextResponse.json({ ok: false, error: "No voice available. Create one at /blog/voices first." }, { status: 400 });
    }

    const draft = await createBlogDraft({
      title: "", slug: placeholderSlug(), body: "", description: "",
      created_by: s.user?.email ?? undefined,
    });

    const session = await createWriterSession({
      voice_id: voice.id,
      voice_revision: voice.prompt_revision,
      kind: "single",
      draft_id: draft.id,
      created_by: s.user?.email ?? undefined,
    });

    return NextResponse.json({ ok: true, session, voice, draft });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "create failed" }, { status: 500 });
  }
}

// GET — recent sessions, for a "resume where I left off" list.
export async function GET() {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const sessions = await listWriterSessionSummaries();
    return NextResponse.json({ ok: true, sessions: sessions.filter((x) => x.kind === "single") });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "list failed" }, { status: 500 });
  }
}
