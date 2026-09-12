import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getHermesSession, listHermesMessages, listHermesActions, updateHermesSession, deleteHermesSession } from "@/lib/db/queries";
import { isSuperUser } from "@/lib/auth/admin";
import { SELECTABLE_MODELS } from "@/lib/writer/anthropic";
import { stripHermesDirectives } from "@/lib/hermes/prompt";
import { describeHermesTool } from "@/lib/hermes/steps";

export const maxDuration = 30;

/** One display item. The projection happens HERE, server-side, so the UI can never forget to strip
 *  a machine directive or render a raw tool name (the writer transcript's rule, kept). */
type DisplayItem =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "step"; label: string; detail?: string; is_error?: boolean }
  | { kind: "table"; title: string; columns: string[]; rows: string[][] }
  | { kind: "options"; question: string; options: string[] }
  | { kind: "picker"; title: string; columns: string[]; rows: string[][]; keyCol: number };

// GET — the rehydrated transcript: stored raw blocks projected into display items, plus every
// action (pending cards render as clickable; resolved ones as their outcome), plus usage.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const session = await getHermesSession(id);
    if (!session) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    // The superuser may READ anyone's transcript. Only this GET is widened. The write path is a
    // different route — sessions/[id]/turn — and its `session.user_email !== email` check is left
    // exactly as it was, so a conversation still cannot be continued as somebody else. Reading
    // someone's chat and speaking in it are different acts; only the first is granted here.
    const readable = session.user_email === email || isSuperUser(email);
    if (!readable) return NextResponse.json({ ok: false, error: "not yours" }, { status: 403 });

    const [messages, actions] = await Promise.all([listHermesMessages(id), listHermesActions(id)]);

    // Map raw blocks to display items. tool_result blocks are represented by their tool_use's step
    // (the result preview lives in the live stream only); errors are re-derived by pairing results
    // back to the call so a failed step reads as failed after a reload too.
    const errorToolIds = new Set<string>();
    for (const m of messages) {
      for (const b of m.blocks as Array<Record<string, unknown>>) {
        if (b?.type === "tool_result" && b?.is_error && typeof b.tool_use_id === "string") {
          errorToolIds.add(b.tool_use_id);
        }
      }
    }

    const items: DisplayItem[] = [];
    for (const m of messages) {
      for (const b of m.blocks as Array<Record<string, unknown>>) {
        if (b?.type === "text" && m.role === "user") {
          const text = stripHermesDirectives(String(b.text ?? ""));
          if (text) items.push({ kind: "text", role: "user", text });
        } else if (b?.type === "text" && m.role === "assistant") {
          const text = String(b.text ?? "").trim();
          if (text) items.push({ kind: "text", role: "assistant", text });
        } else if (b?.type === "tool_use") {
          const name = String(b.name ?? "");
          const input = (b.input ?? {}) as Record<string, unknown>;
          // The two layout tools rehydrate as their real payloads, not as steps — a table someone
          // saw live must still be a table after a reload.
          if (name === "show_table" && Array.isArray(input.columns) && Array.isArray(input.rows)) {
            // The projection reads the tool_use INPUT, which is uncapped — the dispatcher's 50-row
            // cap must be re-applied or a reload would show more rows than the live turn did.
            items.push({ kind: "table", title: String(input.title ?? ""), columns: (input.columns as unknown[]).map(String), rows: (input.rows as unknown[]).slice(0, 50).map((r) => (Array.isArray(r) ? r.map(String) : [])) });
          } else if (name === "show_picker" && Array.isArray(input.columns) && Array.isArray(input.rows)) {
            const columns = (input.columns as unknown[]).map(String);
            const rawKey = Number(input.key_column_index ?? 0);
            items.push({
              kind: "picker", title: String(input.title ?? ""), columns,
              rows: (input.rows as unknown[]).slice(0, 50).map((r) => (Array.isArray(r) ? r.map(String) : [])),
              keyCol: Number.isFinite(rawKey) ? Math.min(Math.max(Math.trunc(rawKey), 0), columns.length - 1) : 0,
            });
          } else if (name === "show_options" && Array.isArray(input.options)) {
            items.push({ kind: "options", question: String(input.question ?? ""), options: (input.options as unknown[]).map(String) });
          } else {
            const { label, detail } = describeHermesTool(name, input);
            items.push({ kind: "step", label, detail, is_error: errorToolIds.has(String(b.id ?? "")) });
          }
        }
      }
    }

    return NextResponse.json({ ok: true, session, items, actions });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "load failed" }, { status: 500 });
  }
}

// PATCH — change which model this conversation runs on.
//
// Deliberately NOT widened to the superuser the way GET above is. Reading someone's transcript and
// changing what their next turn costs are different acts, and only the first was ever granted; this
// keeps the same line the turn route draws.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { model?: unknown };

  const want = typeof body.model === "string" ? body.model.trim() : "";
  // Empty string means "back to the default", which is a real choice and distinct from an
  // unrecognised id. Only the latter is an error worth reporting.
  const model = want === "" ? null : (SELECTABLE_MODELS.find((m) => m.id === want)?.id ?? undefined);
  if (model === undefined) {
    return NextResponse.json(
      { ok: false, error: `Unknown model "${want}". Pick one of: ${SELECTABLE_MODELS.map((m) => m.id).join(", ")}.` },
      { status: 400 },
    );
  }

  try {
    const session = await getHermesSession(id);
    if (!session) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    if (session.user_email !== email) return NextResponse.json({ ok: false, error: "not yours" }, { status: 403 });

    const updated = await updateHermesSession(id, { model });
    return NextResponse.json({ ok: true, session: updated });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "save failed" }, { status: 500 });
  }
}

/**
 * DELETE — throw a conversation away, permanently.
 *
 * Owner only, and deliberately NOT widened to the superuser the way GET is. Reading somebody's
 * half-formed thinking is a judgement call the superuser list already makes; destroying it is not the
 * same act, and there is no product reason for one person to be able to erase another's chat.
 *
 * Hard delete rather than an archived flag. A chat is scratch space — the reason to remove one is that
 * it is noise in the rail, and a soft delete leaves the noise in the table while adding a filter to
 * every read. The transcripts worth keeping become drafts, which live in their own table.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const gone = await deleteHermesSession(id, email);
    // One answer for "no such session" and "not yours" — see the query. A distinct 403 here would
    // confirm the id exists to somebody who is not allowed to know that.
    if (!gone) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "delete failed" }, { status: 500 });
  }
}
