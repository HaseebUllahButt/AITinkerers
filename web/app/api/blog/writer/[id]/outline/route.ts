import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getWriterSession, updateWriterSession } from "@/lib/db/queries";
import { sanitizeOutlineEdit, outlineSizingProblem } from "@/lib/writer/control";

export const maxDuration = 30;

// PATCH — edit the outline that is awaiting approval, directly.
//
// Replying "move section 4 up, drop section 6" works but costs a model round-trip to restate what the
// reviewer could just do, and the model sometimes rewrites more than was asked. This edits it in place.
//
// Only while `outline_pending`. Once approved, `submit_section` is writing against these indices and
// `sections` is keyed by them, so changing the outline underneath a part-written article would attach
// finished prose to the wrong headings.
//
// Session-only auth, matching the approve route: editing the outline is part of the same human review
// step, and there is no automated caller for it.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  try {
    const session = await getWriterSession(id);
    if (!session) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    if (session.phase !== "outline_pending") {
      return NextResponse.json(
        { ok: false, error: `The outline can only be edited while it is awaiting approval — this session is "${session.phase}".` },
        { status: 400 },
      );
    }
    if (!session.outline) {
      return NextResponse.json({ ok: false, error: "No outline recorded on this session." }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const { outline, error, notes } = sanitizeOutlineEdit(session.outline, body?.outline ?? {});
    if (!outline) return NextResponse.json({ ok: false, error, notes }, { status: 400 });

    // The same sizing rule propose_outline enforces. Applied here as a WARNING, not a rejection: the
    // model gets told to fix its own overshoot, but a human editing deliberately is allowed to, and
    // finding out at approval time that the piece will fail the word count is worse than being told
    // now.
    const sizing = outlineSizingProblem(outline.sections, session.brief?.word_count);
    if (sizing) notes.push(sizing);

    const updated = await updateWriterSession(id, { outline });
    return NextResponse.json({ ok: true, session: updated, notes });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "outline edit failed" }, { status: 500 });
  }
}
