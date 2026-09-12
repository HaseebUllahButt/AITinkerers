import { NextRequest, NextResponse } from "next/server";

import { isAuthorized } from "@/lib/auth/service";
import { auth } from "@auth";
import { supabaseAdmin } from "@/lib/db/supabase";
import { rankByNewsworthiness } from "@/lib/research/sweep";

export const maxDuration = 30;

// The ranking lives in lib/research/sweep so the board and Summer's whats_coming answer order rows
// the same way. It used to be defined here, and the tool that did not share it led with API
// snapshots retiring next October — a future date is the largest number on the board.

// GET  /api/research            → the board
// PATCH /api/research           → a person's decision on one item
//
// The board is everyone's, not per-person: research is a team backlog and scoping it to whoever
// swept would mean the same release surfacing separately for each of them.
export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const showDismissed = req.nextUrl.searchParams.get("dismissed") === "1";
  let q = supabaseAdmin
    .from("research_items")
    .select("*")
    .order("item_date", { ascending: false })
    .limit(200);
  if (!showDismissed) q = q.neq("status", "dismissed");

  const { data, error } = await q;
  if (error) {
    // Never an empty board on a failed read — an empty backlog and an unreachable database look
    // identical on screen, and only one of them means "nothing to do".
    return NextResponse.json({ ok: false, error: error.message }, { status: 503 });
  }
  return NextResponse.json({ ok: true, items: rankByNewsworthiness(data ?? []) });
}

export async function PATCH(req: NextRequest) {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const id = String((body as { id?: unknown }).id ?? "").trim();
  if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });

  const patch: Record<string, unknown> = { decided_by: email, decided_at: new Date().toISOString() };

  const status = String((body as { status?: unknown }).status ?? "").trim();
  if (status) {
    if (!["open", "dismissed", "claimed"].includes(status)) {
      return NextResponse.json({ ok: false, error: `unknown status "${status}"` }, { status: 400 });
    }
    patch.status = status;
    if (status === "dismissed") patch.dismissed_reason = String((body as { reason?: unknown }).reason ?? "") || null;
  }

  // Overriding the routing verdict. A person disagreeing with the classifier is the expected case,
  // not an error — the rule has been wrong before — so the override is stored plainly and the
  // reason says who decided rather than pretending the classifier changed its mind.
  const surfaces = (body as { surfaces?: unknown }).surfaces;
  if (Array.isArray(surfaces)) {
    const clean = surfaces.map(String).filter((x) => x === "blog" || x === "landing");
    if (!clean.length) return NextResponse.json({ ok: false, error: "surfaces must include blog and/or landing" }, { status: 400 });
    patch.surfaces = clean;
    patch.route_reason = `Set by ${email}.`;
    patch.route_confidence = "high";
  }

  const { data, error } = await supabaseAdmin
    .from("research_items").update(patch).eq("id", id).select().single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, item: data });
}
