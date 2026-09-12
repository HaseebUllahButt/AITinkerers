import { NextRequest, NextResponse } from "next/server";

import { isProjectColor } from "@/components/agent/projects/colors";
import { createHermesProject, listHermesProjectAssignments, listHermesProjects } from "@/lib/db/queries";

import { MAX_PROJECT_NAME, normaliseProjectName, requireUserEmail } from "./guard";

export const maxDuration = 15;

/**
 * GET /api/hermes/projects — the shelf, and where every filed conversation currently sits.
 *
 * One request rather than two because the rail cannot render either half alone: it groups a session
 * list fetched from /api/hermes/sessions, whose select predates projects and does not carry
 * `project_id` (see HermesSessionWithProject in queries.ts). The mapping is what joins them, and it
 * covers every session the user has — not just the page the rail is showing — so the counts beside
 * a project name are the project's real size.
 */
export async function GET(req: NextRequest) {
  const who = await requireUserEmail(req);
  if ("response" in who) return who.response;
  try {
    const [projects, assignments] = await Promise.all([
      listHermesProjects(who.email),
      listHermesProjectAssignments(who.email),
    ]);
    return NextResponse.json({
      ok: true,
      projects,
      assignments: assignments.bySession,
      lastActivity: assignments.lastActivity,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "load failed" },
      { status: 500 },
    );
  }
}

/** POST /api/hermes/projects — create one. `{ name, color? }`. */
export async function POST(req: NextRequest) {
  const who = await requireUserEmail(req);
  if ("response" in who) return who.response;

  const body = (await req.json().catch(() => null)) as { name?: unknown; color?: unknown } | null;
  const name = normaliseProjectName(body?.name);
  if (!name) {
    return NextResponse.json(
      { ok: false, error: `A project needs a name, up to ${MAX_PROJECT_NAME} characters.` },
      { status: 400 },
    );
  }
  // Validated against the same five tokens the dot renderer knows rather than merely typed as a
  // string: the value ends up in a class lookup, so an unrecognised name is a project with an
  // invisible dot. Anything else silently becomes "no colour", which at least renders.
  const color = isProjectColor(body?.color) ? body.color : null;

  try {
    const project = await createHermesProject(who.email, name, color);
    return NextResponse.json({ ok: true, project });
  } catch (e: unknown) {
    // 23505 is the unique index on (user_email, lower(name)). A name you already used is your
    // answer to give, not a server fault — 409, with the name in it so the dialog can say so.
    if ((e as { code?: string })?.code === "23505") {
      return NextResponse.json(
        { ok: false, error: `You already have a project called “${name}”.` },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "create failed" },
      { status: 500 },
    );
  }
}
