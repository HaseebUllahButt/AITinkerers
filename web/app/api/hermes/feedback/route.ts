import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import {
  upsertAgentFeedback, deleteAgentFeedback, listAgentFeedbackForSession, feedbackByRevision,
} from "@/lib/db/queries";
import { HERMES_PROMPT_REVISION } from "@/lib/hermes/prompt";

// The rating a person gives one agent run (§10.3). Session-only: this is a human judgement and there
// is no machine caller that could legitimately produce one.
//
// POST { run_id, value, comment?, session_id?, surface?, trajectory?, model? }
//   value 1 | 0 rates the run; value null DELETES the rating, which is what clicking the already-set
//   thumb does. The client's FeedbackButtons only moves its local state once this resolves, so a
//   non-2xx here correctly leaves the thumb where it was.
//
// GET ?session_id=…  every rating on a thread, so a reopened session shows its thumbs already set.
// GET ?by=revision   up/down per prompt revision — the read that turns "it feels worse lately" into
//                    a number attributable to a specific change.

export async function POST(req: NextRequest) {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const runId = String((body as { run_id?: unknown }).run_id ?? "").trim();
  if (!runId) return NextResponse.json({ error: "run_id is required" }, { status: 400 });

  const raw = (body as { value?: unknown }).value;
  // null is a real, meaningful value here — it is the delete. Distinguished from "absent", which is a
  // malformed request, because silently treating a missing field as a delete would let a bug wipe
  // ratings.
  if (raw === null) {
    try {
      await deleteAgentFeedback(runId);
      return NextResponse.json({ ok: true, deleted: true });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "delete failed" }, { status: 500 });
    }
  }
  if (raw !== 0 && raw !== 1) {
    return NextResponse.json({ error: "value must be 1 (good), 0 (bad), or null to remove" }, { status: 400 });
  }

  const comment = typeof (body as { comment?: unknown }).comment === "string"
    ? ((body as { comment: string }).comment).trim().slice(0, 4000) || null
    : null;
  const sessionId = String((body as { session_id?: unknown }).session_id ?? "").trim() || null;
  const trajectory = Array.isArray((body as { trajectory?: unknown }).trajectory)
    // Bounded: the trajectory is diagnostic, and a pathological run must not write a megabyte row.
    ? ((body as { trajectory: unknown[] }).trajectory).slice(0, 60)
    : [];

  try {
    const row = await upsertAgentFeedback({
      run_id: runId,
      session_id: sessionId,
      surface: String((body as { surface?: unknown }).surface ?? "summer"),
      user_email: email,
      value: raw,
      comment,
      trajectory,
      model: String((body as { model?: unknown }).model ?? "") || null,
      // Stamped server-side, never taken from the client: the point is attributing a rating to the
      // prompt that produced it, and a client could send anything.
      prompt_revision: HERMES_PROMPT_REVISION,
    });
    return NextResponse.json({ ok: true, feedback: row });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "save failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const s = await auth().catch(() => null);
  if (!s?.user?.email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (req.nextUrl.searchParams.get("by") === "revision") {
    try {
      return NextResponse.json({ ok: true, by_revision: await feedbackByRevision() });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "read failed" }, { status: 500 });
    }
  }

  const sessionId = req.nextUrl.searchParams.get("session_id");
  if (!sessionId) return NextResponse.json({ error: "session_id or by=revision is required" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, feedback: await listAgentFeedbackForSession(sessionId) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "read failed" }, { status: 500 });
  }
}
