import { NextRequest, NextResponse } from "next/server";

import { isProjectColor } from "@/components/agent/projects/colors";
import { deleteHermesProject, updateHermesProject } from "@/lib/db/queries";

import { MAX_PROJECT_NAME, normaliseProjectName, requireUserEmail } from "../guard";

export const maxDuration = 15;

/**
 * PATCH /api/hermes/projects/:id — rename and/or recolour. `{ name?, color? }`.
 *
 * A field that is absent is left alone; `color: null` is a real instruction (drop the colour) and
 * is not the same as omitting it, which is why the two are told apart by `in` rather than by
 * truthiness.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const who = await requireUserEmail(req);
  if ("response" in who) return who.response;
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const patch: { name?: string; color?: string | null } = {};

  if (body && "name" in body) {
    const name = normaliseProjectName(body.name);
    if (!name) {
      return NextResponse.json(
        { ok: false, error: `A project needs a name, up to ${MAX_PROJECT_NAME} characters.` },
        { status: 400 },
      );
    }
    patch.name = name;
  }
  if (body && "color" in body) {
    patch.color = isProjectColor(body.color) ? body.color : null;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "Nothing to change." }, { status: 400 });
  }

  try {
    const project = await updateHermesProject(id, who.email, patch);
    // 404 rather than 403 when it belongs to someone else: the caller has no business learning that
    // the id exists at all, and the query cannot tell the two cases apart anyway — by design.
    if (!project) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, project });
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "23505") {
      return NextResponse.json(
        { ok: false, error: `You already have a project called “${patch.name}”.` },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "rename failed" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/hermes/projects/:id — remove the shelf, keep the conversations.
 *
 * The FK is ON DELETE SET NULL, so its chats return to the unfiled bucket. `released` is how many
 * did, and it is returned rather than assumed so the UI can confirm the harmless thing that just
 * happened instead of leaving the user to wonder.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const who = await requireUserEmail(req);
  if ("response" in who) return who.response;
  const { id } = await params;

  try {
    const { deleted, released } = await deleteHermesProject(id, who.email);
    if (!deleted) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, released });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "delete failed" },
      { status: 500 },
    );
  }
}
