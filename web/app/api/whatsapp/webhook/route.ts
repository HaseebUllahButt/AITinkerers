import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import {
  findVendorByWaDigits, createWhatsappVendor, insertWaInboundOnce, updateWaMessageStatus,
  recordWaOptin,
} from "@/lib/db/queries";
import { verifyWaSignature } from "@/lib/whatsapp/cloudApi";
import { acquireLock, releaseLock } from "@/lib/redis";

// Meta retries a slow webhook; the ingest is fast DB work but the negotiator thinks for up to
// a couple of minutes, so it runs in after() once the 200 is already on the wire.
export const maxDuration = 300;

// GET /api/whatsapp/webhook — Meta's one-time subscription handshake: echo hub.challenge iff
// hub.verify_token matches ours. Unset token = the transport isn't configured; refuse loudly.
export async function GET(req: NextRequest) {
  const verify = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verify) return NextResponse.json({ error: "WhatsApp webhook is not configured (WHATSAPP_VERIFY_TOKEN unset)" }, { status: 503 });
  const p = req.nextUrl.searchParams;
  if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === verify) {
    return new NextResponse(p.get("hub.challenge") ?? "", { status: 200 });
  }
  return NextResponse.json({ error: "verification failed" }, { status: 403 });
}

// POST /api/whatsapp/webhook — every message and delivery receipt for the business number.
// Auth is the X-Hub-Signature-256 HMAC over the RAW body, checked BEFORE any parsing (the
// isGeoIngest discipline: the proxy lets this path through; the route is the gate and a curl
// debugger gets a 401, not login HTML).
export async function POST(req: NextRequest) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return NextResponse.json({ error: "WhatsApp webhook is not configured (WHATSAPP_APP_SECRET unset)" }, { status: 503 });
  const raw = await req.text();
  if (!verifyWaSignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ error: "not json" }, { status: 400 }); }

  const ingested: string[] = []; // author_ids with a NEW message this delivery (dupes excluded)
  const counts = { messages: 0, duplicates: 0, statuses: 0 };
  try {
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        const profileByWaId = new Map<string, string>(
          (value.contacts ?? []).map((c: any) => [String(c?.wa_id ?? ""), String(c?.profile?.name ?? "")]),
        );
        for (const msg of value.messages ?? []) {
          const from = String(msg?.from ?? "").replace(/\D+/g, "");
          const waId = String(msg?.id ?? "");
          if (!from || !waId) continue;
          // The message text; media arrives as an id we don't fetch yet (Phase 2 keeps the
          // caption + a labeled placeholder so the thread never silently drops what they sent).
          const type = String(msg?.type ?? "text");
          const body = type === "text"
            ? String(msg?.text?.body ?? "").trim()
            : (String(msg?.[type]?.caption ?? "").trim() || `[${type} received on WhatsApp]`);
          if (!body) continue;
          const known = await findVendorByWaDigits(from);
          const vendor = known ?? await (async () => {
            // A number we don't know is usually a vendor's second SIM or a referral — file it as
            // a vendor under their WhatsApp profile name so the message lands somewhere visible.
            const name = profileByWaId.get(from) || `WhatsApp +${from}`;
            const v = await createWhatsappVendor(name, `https://wa.me/${from}`);
            return { author_id: v.author_id, name };
          })();
          const ts = Number(msg?.timestamp ?? 0);
          const row = await insertWaInboundOnce({
            author_id: vendor.author_id, body, wa_message_id: waId,
            media_type: type !== "text" ? String(msg?.[type]?.mime_type ?? type) : null,
            sent_at: ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
          });
          if (row) {
            counts.messages++;
            if (!ingested.includes(vendor.author_id)) ingested.push(vendor.author_id);
            // Their inbound message IS the consent that opens the service window; record it so
            // template sends (outside the window) have the paper trail Meta requires.
            await recordWaOptin(vendor.author_id, from, "inbound_message", null).catch(() => {});
          } else counts.duplicates++;
        }
        for (const st of value.statuses ?? []) {
          const s = String(st?.status ?? "");
          const id = String(st?.id ?? "");
          if (!id || !["delivered", "read", "failed"].includes(s)) continue; // 'sent' is already our insert state
          const reason = (st?.errors ?? []).map((e: any) => e?.message ?? e?.title).filter(Boolean).join("; ") || null;
          await updateWaMessageStatus(id, s as "delivered" | "read" | "failed", reason).catch(() => {});
          counts.statuses++;
        }
      }
    }
  } catch (e: any) {
    // A half-ingested delivery is fine — Meta retries, and wa_message_id dedupe makes the retry
    // idempotent. Say what broke instead of pretending the batch landed.
    return NextResponse.json({ error: e?.message ?? "ingest failed", ...counts }, { status: 500 });
  }

  // Negotiate AFTER the 200 is sent: the reply takes a thinking model, Meta's timeout doesn't
  // wait for it, and a per-author lock keeps a double-texting vendor from getting two replies
  // from two overlapping deliveries.
  if (ingested.length) {
    after(async () => {
      const { runWaNegotiator } = await import("@/lib/whatsapp/negotiator");
      for (const authorId of ingested) {
        const token = `wa-webhook-${Date.now()}`;
        if (!(await acquireLock(`lock:wa:negotiate:${authorId}`, 240, token))) continue; // the running turn answers them
        try {
          await runWaNegotiator(authorId);
        } catch { /* parked/failed paths are recorded on the anchor by the negotiator itself */ }
        finally { await releaseLock(`lock:wa:negotiate:${authorId}`, token); }
      }
    });
  }
  return NextResponse.json({ ok: true, ...counts });
}
