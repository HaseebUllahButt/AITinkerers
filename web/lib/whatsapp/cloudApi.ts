// Meta WhatsApp Business Cloud API client — the Phase 2 transport (docs/WHATSAPP_CHANNEL_PLAN.md).
// Everything here is env-gated: with no WHATSAPP_* env the whole channel degrades to Phase 1's
// human-sends-via-wa.me flow, so this ships before the WABA exists and turns on when the tokens
// land in Vercel.
//
// Env surface:
//   WHATSAPP_ACCESS_TOKEN     — system-user token for the WABA
//   WHATSAPP_PHONE_NUMBER_ID  — the business number's id (NOT the number itself)
//   WHATSAPP_APP_SECRET       — Meta app secret; signs every webhook (X-Hub-Signature-256)
//   WHATSAPP_VERIFY_TOKEN     — the string we hand Meta for webhook GET verification
//   WHATSAPP_GRAPH_VERSION    — optional, default v22.0
//   WHATSAPP_GRAPH_BASE       — optional override of https://graph.facebook.com; exists ONLY so
//                               the E2E probe can point sends at a local mock. Never set in prod.
import { createHmac, timingSafeEqual } from "crypto";

const GRAPH_BASE = () => process.env.WHATSAPP_GRAPH_BASE || "https://graph.facebook.com";
const GRAPH_VERSION = () => process.env.WHATSAPP_GRAPH_VERSION || "v22.0";

/** The transport is configured — sending via API is possible. The webhook needs only the app
 *  secret + verify token, so it is gated separately (see the route). */
export function waCloudEnabled(): boolean {
  return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

/** Meta's customer-service window: 24h from the vendor's LAST inbound message, rolling. Inside
 *  it, free-form text is allowed; outside it, only approved templates. Pure, for the selfcheck. */
export function serviceWindowOpen(lastInboundAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastInboundAt) return false;
  const t = Date.parse(lastInboundAt);
  if (Number.isNaN(t)) return false;
  return now - t < 24 * 60 * 60 * 1000 && t <= now + 5 * 60 * 1000; // tolerate small clock skew forward
}

/** Verify Meta's webhook signature over the RAW request body. Constant-time; returns false for
 *  anything malformed rather than throwing — the route turns false into a 401 before parsing.
 *  Pure given its inputs, for the selfcheck. */
export function verifyWaSignature(rawBody: string, signatureHeader: string | null | undefined, appSecret: string | null | undefined): boolean {
  if (!appSecret || !signatureHeader?.startsWith("sha256=")) return false;
  const theirs = signatureHeader.slice("sha256=".length).trim();
  if (!/^[0-9a-f]{64}$/i.test(theirs)) return false;
  const ours = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(ours, "hex"), Buffer.from(theirs.toLowerCase(), "hex"));
}

export interface WaSendResult {
  ok: boolean;
  waMessageId: string | null;
  /** Human-readable failure — stored on the row (load honesty: a failed send says why). */
  error: string | null;
}

async function graphPost(payload: Record<string, unknown>): Promise<WaSendResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { ok: false, waMessageId: null, error: "WhatsApp Cloud API is not configured" };
  try {
    const res = await fetch(`${GRAPH_BASE()}/${GRAPH_VERSION()}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
      signal: AbortSignal.timeout(30_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.error?.message ?? `HTTP ${res.status}`;
      return { ok: false, waMessageId: null, error: `Graph API refused the send: ${detail}` };
    }
    const id = data?.messages?.[0]?.id ?? null;
    // No id on a 200 is a contract break worth surfacing, not a success to assume.
    return id ? { ok: true, waMessageId: id, error: null } : { ok: false, waMessageId: null, error: "Graph API answered 200 without a message id" };
  } catch (e: any) {
    return { ok: false, waMessageId: null, error: `Graph API unreachable: ${e?.message ?? "network error"}` };
  }
}

/** Free-form text — legal only inside an open service window; the caller checks the window
 *  (sendVendorMessage does) because only it knows the thread. */
export function sendWaText(toDigits: string, body: string): Promise<WaSendResult> {
  return graphPost({ to: toDigits, type: "text", text: { body, preview_url: false } });
}

/** An approved template — the only way to message outside the 24h window. Callers gate this on a
 *  whatsapp_optins row: vendor relationships are standing, but Meta wants the consent recorded. */
export function sendWaTemplate(toDigits: string, templateName: string, langCode: string, bodyParams: string[] = []): Promise<WaSendResult> {
  return graphPost({
    to: toDigits,
    type: "template",
    template: {
      name: templateName,
      language: { code: langCode },
      ...(bodyParams.length ? { components: [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: t })) }] } : {}),
    },
  });
}
