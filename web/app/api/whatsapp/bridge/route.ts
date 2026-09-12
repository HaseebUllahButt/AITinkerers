import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import {
  findVendorByWaDigits, createWhatsappVendor, insertWaBridgeMessageOnce, updateWaMessageStatus,
  recordWaOptin, clearWaSuggestionForAuthor,
} from "@/lib/db/queries";
import {
  verifyBridgeToken, resolveChatDigits, isDirectChat, isLidChat, normalizeWaId,
  bridgeMessageBody, bridgeMediaType, fetchBridgeContactName, PHONEBOOK_ACTOR,
} from "@/lib/whatsapp/bridge";
import { acquireLock, releaseLock } from "@/lib/redis";

// The negotiator (in suggestion or send mode) thinks for up to a couple of minutes; the 200 goes
// back to WAHA immediately and the work runs in after().
export const maxDuration = 300;

// Constant that stamps messages the person typed on their OWN phone, mirrored in by WAHA. Not a
// SearchOps user and not the negotiator — a real human keystroke on the linked device.
const DEVICE_ACTOR = "bridge@device";

// POST /api/whatsapp/bridge — WAHA posts every message + ack here. Auth is a shared token WAHA
// is configured to send as X-Bridge-Token (see lib/whatsapp/bridge.ts); checked before any parse,
// the same isGeoIngest discipline the Cloud webhook uses. Subscribe WAHA to `message.any`
// (inbound AND our own outbound, so the human's phone replies mirror in) and `message.ack`.
export async function POST(req: NextRequest) {
  // Header preferred, but WAHA can be configured entirely by env if the token rides the webhook
  // URL as ?token= (no custom-header support needed) — one less thing to click. Query strings do
  // land in logs, so it's the fallback, exactly the cron ?key= precedent.
  const token = req.headers.get("x-bridge-token") ?? req.nextUrl.searchParams.get("token");
  if (!verifyBridgeToken(token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let evt: any;
  try { evt = await req.json(); } catch { return NextResponse.json({ error: "not json" }, { status: 400 }); }

  const type = String(evt?.event ?? "");
  const p = evt?.payload ?? {};
  // `unresolved` is its own count on purpose: a LID we could not map to a phone number is a
  // dropped vendor message, which must never hide inside the same bucket as group chatter.
  const counts = { ingested: 0, duplicates: 0, mirrored: 0, acks: 0, skipped: 0, unresolved: 0 };
  const toNegotiate: string[] = [];

  try {
    if (type === "message" || type === "message.any") {
      const fromMe = !!p?.fromMe;
      // Our own outgoing carries the counterparty in `to`; their incoming carries them in `from`.
      // Either side may be a LID rather than a phone JID (see lib/whatsapp/bridge.ts).
      const counterparty = String((fromMe ? p?.to : p?.from) ?? "");
      // Group chats and status broadcasts are never vendor negotiations.
      if (!isDirectChat(counterparty)) {
        counts.skipped++;
      } else {
        // Resolve LID -> real phone digits before anything else: the LID's own digits are not a
        // phone number, so using them would mint a vendor nobody can message back.
        const digits = await resolveChatDigits(counterparty);
        const waId = normalizeWaId(p?.id);
        // A caption-less image or voice note is a message, not nothing (see bridge.ts).
        const kind = String(p?.type ?? "").trim().toLowerCase();
        const mediaType = bridgeMediaType(p);
        const body = bridgeMessageBody(p?.body, p?.type);
        if (!digits || !waId || !body) {
          if (!digits && isLidChat(counterparty)) {
            counts.unresolved++;
            // A LID we cannot map to a phone number is a vendor message we DROPPED. The counts only
            // ever went back to WAHA in a response body nobody reads, so "the chat stopped
            // receiving messages" had no trail to follow. Say it where the logs are.
            console.warn(`[wa-bridge] dropped a message: WAHA could not resolve ${counterparty} to a phone number`);
          } else {
            counts.skipped++;
            console.warn(`[wa-bridge] dropped an event from ${counterparty}: ${
              !digits ? "no phone number" : !waId ? "no message id" : `bodiless ${kind || "unknown"} type`}`);
          }
        } else {
          const known = await findVendorByWaDigits(digits);
          const vendor = known ?? await (async () => {
            // Names, best source first (see fetchBridgeContactName):
            //  1. the linked phone's ADDRESS BOOK — someone on our team typed it about a person
            //     they deal with, so it is both the name the team recognises and a name we can
            //     use to their face. Vouched on arrival.
            //  2. the sender's pushname — self-declared, and the reason this order exists. Stored
            //     as a label only; the negotiator will not address anyone by it until a human
            //     confirms it. On a fromMe mirror notifyName is OUR OWN account name (it labelled
            //     every counterparty "Imagine art"), so it is only ever read for inbound.
            //  3. a neutral placeholder.
            const saved = await fetchBridgeContactName(digits).catch(() => null);
            const pushName = !fromMe ? String(p?.notifyName ?? p?._data?.notifyName ?? "").trim() : "";
            const name = saved || pushName || `WhatsApp +${digits}`;
            const v = await createWhatsappVendor(name, `https://wa.me/${digits}`, saved ? PHONEBOOK_ACTOR : null);
            return { author_id: v.author_id, name };
          })();
          const ts = Number(p?.timestamp ?? 0);
          const row = await insertWaBridgeMessageOnce({
            author_id: vendor.author_id,
            direction: fromMe ? "outbound" : "inbound",
            body, wa_message_id: waId, media_type: mediaType,
            sent_at: ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
            sent_by: fromMe ? DEVICE_ACTOR : null,
          });
          if (!row) counts.duplicates++;
          else if (fromMe) {
            // The person answered on their phone — clear any pending AI suggestion; it's stale now.
            counts.mirrored++;
            await clearWaSuggestionForAuthor(vendor.author_id).catch(() => {});
          } else {
            counts.ingested++;
            await recordWaOptin(vendor.author_id, digits, "inbound_message", null).catch(() => {});
            if (!toNegotiate.includes(vendor.author_id)) toNegotiate.push(vendor.author_id);
          }
        }
      }
    } else if (type === "message.ack") {
      // WAHA ack levels: 1 server(sent) · 2 device(delivered) · 3 read · 4 played.
      const waId = normalizeWaId(p?.id);
      const ack = Number(p?.ack ?? 0);
      const status = ack >= 3 ? "read" : ack === 2 ? "delivered" : null;
      if (waId && status) { await updateWaMessageStatus(waId, status).catch(() => {}); counts.acks++; }
      else counts.skipped++;
    } else {
      counts.skipped++; // session.status, presence, etc. — acknowledged, ignored
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "ingest failed", ...counts }, { status: 500 });
  }

  // Negotiate only on genuinely NEW inbound messages, after the 200, one vendor at a time.
  if (toNegotiate.length) {
    after(async () => {
      const { runWaNegotiator } = await import("@/lib/whatsapp/negotiator");
      for (const authorId of toNegotiate) {
        const token = `wa-bridge-${Date.now()}`;
        if (!(await acquireLock(`lock:wa:negotiate:${authorId}`, 240, token))) continue;
        try { await runWaNegotiator(authorId); }
        catch { /* the negotiator records park/fail on the anchor itself */ }
        finally { await releaseLock(`lock:wa:negotiate:${authorId}`, token); }
      }
    });
  }
  return NextResponse.json({ ok: true, ...counts });
}
