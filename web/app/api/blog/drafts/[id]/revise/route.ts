import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getBlogDraft, getWriterSession, getWriterVoice, listWriterVoices } from "@/lib/db/queries";
import { reviseText, type ReviseMode } from "@/lib/writer/revise";

export const maxDuration = 60;

// POST /api/blog/drafts/:id/revise — shorten or rewrite a selection (or the whole body).
//
// Returns the replacement text and does NOT write it. The client splices it into the editor, which
// makes it an ordinary edit: autosaved, journalled, undoable, and visible before it is committed.
// Writing it here would make an AI edit the one change the user can't see before it lands.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const draft = await getBlogDraft(id);
  if (!draft) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const mode = body?.mode as ReviseMode;
  if (mode !== "shorten" && mode !== "rewrite") {
    return NextResponse.json({ ok: false, error: "mode must be shorten or rewrite" }, { status: 400 });
  }

  // The selection comes from the client because only the client knows what is highlighted. It is
  // bounded here so a runaway request can't send a megabyte of prose to the model.
  const text = String(body?.text ?? "");
  if (!text.trim()) return NextResponse.json({ ok: false, error: "Nothing selected." }, { status: 400 });
  if (text.length > 40_000) {
    return NextResponse.json({ ok: false, error: "That's too much text at once. Select a section." }, { status: 400 });
  }

  // Same voice the piece was written in, so a shortened paragraph keeps the same rules.
  const session = draft.writer_session_id ? await getWriterSession(draft.writer_session_id).catch(() => null) : null;
  let voice = session?.voice_id ? await getWriterVoice(session.voice_id).catch(() => null) : null;
  if (!voice) voice = (await listWriterVoices().catch(() => [])).find((v) => v.is_default) ?? null;

  const result = await reviseText({
    mode,
    text,
    target_words: typeof body?.target_words === "number" ? body.target_words : undefined,
    instruction: typeof body?.instruction === "string" ? body.instruction : undefined,
    before: typeof body?.before === "string" ? body.before : undefined,
    after: typeof body?.after === "string" ? body.after : undefined,
    voice,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
