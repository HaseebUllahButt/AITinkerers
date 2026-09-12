import { NextRequest, NextResponse } from "next/server";
import { getWhatsappMessages, upsertWhatsappMessage, markWhatsappNoteSent, upsertContact } from "@/lib/db/queries";
import { normalizeWaNumber } from "@/lib/email/whatsappNote";
import { identifyCaller, actorFor } from "@/lib/auth/service";

// GET — all generated WhatsApp messages for this workflow (merged into rows client-side).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await getWhatsappMessages(id));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PATCH — hand-edit one prospect's WhatsApp message ({ author_id, body }), record that it was
// actually sent ({ author_id, mark_sent: true|false }), and/or store their number
// ({ author_id, number }). Sending is manual via the wa.me link (no WhatsApp API — Meta requires
// opt-in for business-initiated messages), so the recorded moment is what advances the funnel.
//
// `number` exists for the negotiation dead-end this channel was built to catch: a prospect
// replies "WhatsApp me at +92 300…", and until now that number had nowhere to live. It is stored
// as a contacts row (type='whatsapp', canonical wa.me URL), author-level like every contact.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const { author_id, body, mark_sent, number } = await req.json();
    if (!author_id || (typeof body !== "string" && typeof mark_sent !== "boolean" && typeof number !== "string")) {
      return NextResponse.json({ error: "author_id plus body, mark_sent and/or number required" }, { status: 400 });
    }
    let whatsappUrl: string | null = null;
    if (typeof number === "string") {
      const digits = normalizeWaNumber(number);
      // A rejected number must never be silently mangled into a stored one — say what's wrong.
      if (!digits) {
        return NextResponse.json({ error: "That doesn't look like an international number. Include the country code, e.g. +1 555 010 2030." }, { status: 400 });
      }
      whatsappUrl = `https://wa.me/${digits}`;
      try {
        await upsertContact({ author_id, type: "whatsapp", value: whatsappUrl, confidence: 0.9, source: "manual", verified_syntax: true });
      } catch (e: any) {
        // ignoreDuplicates inside upsertContact makes a re-save of the same number return no row,
        // which .single() reports as an error. Saving what's already saved is a success here.
        if (!/no.*rows|0 rows|multiple \(or no\) rows/i.test(String(e?.message ?? ""))) throw e;
      }
    }
    if (typeof body === "string") await upsertWhatsappMessage({ workflow_id: id, author_id, body });
    if (typeof mark_sent === "boolean") await markWhatsappNoteSent(id, author_id, mark_sent, actorFor(caller));
    return NextResponse.json({ ok: true, whatsappUrl });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
