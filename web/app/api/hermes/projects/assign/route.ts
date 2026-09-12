import { NextRequest, NextResponse } from "next/server";

import { setHermesSessionProject } from "@/lib/db/queries";

import { requireUserEmail } from "../guard";

export const maxDuration = 15;

/**
 * POST /api/hermes/projects/assign — file a conversation, move it, or take it out of a project.
 *
 * One endpoint for all three because they are one write: `project_id: null` unfiles. A separate
 * "move" route would be a second file for the same column, and unfiling would end up as a DELETE
 * against something that was never created.
 *
 * It lives under /projects rather than on the session because this is the projects feature's own
 * surface — the /api/hermes/sessions routes belong to the chat loop, and their shape is the
 * transcript's. A static segment always beats a dynamic one in the App Router, so `assign` can
 * never be mistaken for a project id (and ids here are uuids in any case).
 */
export async function POST(req: NextRequest) {
  const who = await requireUserEmail(req);
  if ("response" in who) return who.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: "session_id is required" }, { status: 400 });
  }

  // `undefined` and `null` must not be conflated. Omitting project_id is a malformed request;
  // sending null is the explicit instruction to take the chat out of every project. Collapsing the
  // two would make a typo'd body silently unfile a conversation.
  if (!body || !("project_id" in body)) {
    return NextResponse.json(
      { ok: false, error: "project_id is required (null to remove from a project)" },
      { status: 400 },
    );
  }
  const raw = body.project_id;
  if (raw !== null && typeof raw !== "string") {
    return NextResponse.json({ ok: false, error: "project_id must be a uuid or null" }, { status: 400 });
  }
  const projectId = raw === null || raw === "" ? null : raw;

  try {
    const session = await setHermesSessionProject(sessionId, who.email, projectId);
    // One "no" for both halves — the conversation isn't yours, or the project isn't. The query
    // cannot distinguish them and the caller should not be able to either.
    if (!session) {
      return NextResponse.json(
        { ok: false, error: "That conversation or project isn’t yours." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, session });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "assign failed" },
      { status: 500 },
    );
  }
}
