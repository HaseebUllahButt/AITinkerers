import { NextRequest, NextResponse } from "next/server";
import { createWhatsappVendor, getWhatsappVendorList, getTeamMembers } from "@/lib/db/queries";
import { normalizeWaNumber } from "@/lib/email/whatsappNote";
import { identifyCaller, actorFor } from "@/lib/auth/service";

// GET /api/whatsapp/vendors — every vendor chat, newest activity first, for the WhatsApp page's
// chat list. Team-visible by design (see getWhatsappVendorList); unread state is per-viewer, so a
// machine caller's synthetic actor simply has no read state and sees everything as unread.
//
// `team` and `me` ride along because the page needs both to render ownership (094): who a chat can
// be handed to, and which of them is you. `me` is null for a machine caller, which has no "mine".
export async function GET(req: NextRequest) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const me = caller.kind === "user" ? caller.email : null;
    const [vendors, roster] = await Promise.all([
      getWhatsappVendorList(actorFor(caller) ?? "cron"),
      // A failed roster read costs the picker its names, not the page its chats.
      getTeamMembers().catch(() => [] as { email: string; label: string }[]),
    ]);
    // A viewer with no user_email_config row (never set up to send) still has to be able to claim
    // their own chats, so they are always in their own picker.
    const team = me && !roster.some((m) => m.email.toLowerCase() === me.toLowerCase())
      ? [...roster, { email: me, label: me.split("@")[0] }]
      : roster;
    return NextResponse.json({ vendors, team, me });
  } catch (e) {
    // A failed read is not "no vendors" — same honesty contract as /api/inbox.
    return NextResponse.json({ error: `The database did not answer (${e instanceof Error ? e.message : "read failed"}). Your chats are not gone.` }, { status: 503 });
  }
}

// POST /api/whatsapp/vendors — register a vendor the team already negotiates with on WhatsApp:
// an author row plus a canonical wa.me contact. These are known counterparties with standing
// relationships, not scraped prospects, so there is no discovery pipeline behind them — a person
// (or Hermes) says "this is Ali, +92 300 …" and the thread exists from that moment.
export async function POST(req: NextRequest) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { name, number } = await req.json();
    if (typeof name !== "string" || !name.trim() || typeof number !== "string") {
      return NextResponse.json({ error: "name and number required" }, { status: 400 });
    }
    const digits = normalizeWaNumber(number);
    // Same refusal as the manual-channel number save: a mangled number must never be stored.
    if (!digits) {
      return NextResponse.json({ error: "That doesn't look like an international number. Include the country code, e.g. +92 300 1234567." }, { status: 400 });
    }
    // A name typed into this form came from a person, so it is vouched from the start (095) and
    // the negotiator may use it. Names the bridge learns from a vendor's own WhatsApp profile are
    // not, and stay unusable until someone confirms them.
    const { author_id, existing } = await createWhatsappVendor(name.trim(), `https://wa.me/${digits}`, actorFor(caller));
    return NextResponse.json({ ok: true, author_id, existing });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
