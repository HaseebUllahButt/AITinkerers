import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";
import { isAuthorized } from "@/lib/auth/service";

// POST — turn AI negotiation on/off for a set of outreach threads, and (optionally) set the
// per-thread price ceiling + criteria note the negotiator should use.
//   { ids: string[], managed?: boolean, max_offer?: number|null, criteria?: string }
//   { all: true, managed?: boolean, max_offer?, criteria? }   → every sent initial
//
// Auth matters more here than on most routes: `{all:true, managed:true}` arms the autonomous
// negotiator on every sent thread at once, and with ai_autonomy on it SENDS. This route shipped
// with no check at all.
export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const managed = body.managed !== false; // default true
    const patch: Record<string, any> = { ai_managed: managed };
    if (body.max_offer !== undefined) patch.max_offer = body.max_offer === null ? null : Number(body.max_offer);
    if (typeof body.criteria === "string") patch.negotiation_notes = body.criteria;

    let q = supabaseAdmin.from("outreach_emails").update(patch);
    if (Array.isArray(body.ids) && body.ids.length > 0) {
      q = q.in("id", body.ids);
    } else if (body.all === true) {
      q = q.eq("kind", "initial").eq("status", "sent");
    } else {
      return NextResponse.json({ error: "provide ids[] or all:true" }, { status: 400 });
    }
    const { data, error } = await q.select("id");
    if (error) throw error;
    return NextResponse.json({ ok: true, updated: data?.length ?? 0, managed });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "failed" }, { status: 500 });
  }
}
