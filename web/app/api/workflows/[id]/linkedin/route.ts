import { NextRequest, NextResponse } from "next/server";
import { getLinkedinMessages, upsertLinkedinMessage, markLinkedinNoteSent } from "@/lib/db/queries";
import { identifyCaller, actorFor } from "@/lib/auth/service";

// GET — all generated LinkedIn notes for this workflow (merged into rows client-side).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await getLinkedinMessages(id));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PATCH — hand-edit one prospect's note ({ author_id, body }), and/or record that it was actually
// DM'd ({ author_id, mark_sent: true|false }). Sending is manual copy-paste (no LinkedIn API), so
// this recorded moment is the only thing that lets the funnel advance a LinkedIn-only prospect
// past "Pitch ready" — which is why marking stamps WHO said it was sent.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const { author_id, body, mark_sent } = await req.json();
    if (!author_id || (typeof body !== "string" && typeof mark_sent !== "boolean")) {
      return NextResponse.json({ error: "author_id plus body and/or mark_sent required" }, { status: 400 });
    }
    if (typeof body === "string") await upsertLinkedinMessage({ workflow_id: id, author_id, body });
    if (typeof mark_sent === "boolean") await markLinkedinNoteSent(id, author_id, mark_sent, actorFor(caller));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
