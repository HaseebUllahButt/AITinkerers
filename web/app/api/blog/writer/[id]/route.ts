import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getWriterSession, listWriterMessages, getWriterVoice, getBlogDraft } from "@/lib/db/queries";
import { stripDirectives } from "@/lib/writer/prompt";
import { describeToolCall } from "@/lib/writer/steps";

export const maxDuration = 30;

// GET — rehydrate a session: its phase/brief/outline, the display-relevant slice of message
// history, the voice, and the attached draft. The chat UI calls this on load/refresh instead of
// keeping state only in memory, so reloading the page never loses where you were.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const session = await getWriterSession(id);
    if (!session) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

    const [messages, voice, draft] = await Promise.all([
      listWriterMessages(id),
      session.voice_id ? getWriterVoice(session.voice_id) : null,
      session.draft_id ? getBlogDraft(session.draft_id) : null,
    ]);

    // Flatten stored content blocks into display events. The raw blocks remain exactly what
    // agent.ts replays to the model; this is a read-only projection for rendering the transcript.
    //
    // Two things it must do that the raw blocks don't:
    //  1. Strip machine directives. They live in the user turn by necessity, so without this a
    //     <section_assignment> block listing every source URL renders as a giant user chat bubble
    //     that looks like the human pasted it. Done here rather than in the UI so it cannot be
    //     forgotten by a second caller.
    //  2. Turn tool calls into something a person can read. "Wrote a section" eight times tells you
    //     nothing; which section, and how long it came out, tells you where it is.
    const outlineSections = session.outline?.sections ?? [];
    // Same describer the live stream uses, so a reloaded transcript reads identically to one you
    // watched happen. Two implementations would drift.
    const describeTool = (name: string, input: any) =>
      describeToolCall(name, (input ?? {}) as Record<string, unknown>, outlineSections);

    // Pass 1: pair every result back to its call by tool_use_id, so a step that failed can be shown
    // as failed. Positional pairing would be wrong the moment the model issues two calls in one turn.
    const failures = new Map<string, string>();
    for (const m of messages) {
      for (const b of (Array.isArray(m.blocks) ? m.blocks : []) as any[]) {
        if (b?.type !== "tool_result" || !b.is_error) continue;
        const text = Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join("") : String(b.content ?? "");
        failures.set(String(b.tool_use_id), text);
      }
    }

    // Pass 2: emit one display item per step. Results are folded into their call rather than emitted
    // separately — a call and its result are one thing to a reader, not two.
    const display = messages.flatMap((m) => {
      const blocks = Array.isArray(m.blocks) ? m.blocks : [];
      return blocks
        .map((b: any) => {
          if (b.type === "text") {
            const text = m.role === "user" ? stripDirectives(String(b.text ?? "")) : String(b.text ?? "");
            if (!text.trim()) return null;   // the whole block was a directive
            return { role: m.role, kind: "text", text };
          }
          if (b.type === "tool_use") {
            const { label, detail } = describeTool(b.name, b.input);
            const error = failures.get(String(b.id));
            return {
              role: m.role, kind: "tool_use", name: b.name, label,
              detail: error ?? detail,
              state: error ? "error" : "done",
            };
          }
          return null; // thinking + tool_result blocks: not surfaced (results fold into the call above)
        })
        .filter(Boolean);
    });

    // A compact, honest summary of where this piece actually stands, so the UI doesn't have to
    // reconstruct it from the transcript.
    const written = Object.keys(session.sections ?? {}).length;
    const status = {
      phase: session.phase,
      sections_written: written,
      sections_total: outlineSections.length,
      words: draft?.body ? draft.body.trim().split(/\s+/).filter(Boolean).length : 0,
      target_words: session.brief?.word_count ?? null,
      sources_found: Object.keys((session.research?.sources ?? {}) as Record<string, unknown>).length,
      real_questions_found: ((session.research?.paa as string[]) ?? []).length,
      writer_status: draft?.writer_status ?? null,
      usage: session.usage ?? {},
    };

    return NextResponse.json({ ok: true, session, voice, draft, messages: display, status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "load failed" }, { status: 500 });
  }
}
