// WAHA (WhatsApp HTTP API) bridge — the unofficial transport (docs/WHATSAPP_CHANNEL_PLAN.md).
// A linked-device relay running on the droplet next to the hermes/ sidecar: the SEO person scans
// a QR once, and WAHA mirrors their PERSONAL number's messages to Summit and (optionally) sends
// on its behalf. This exists because the vendor chats already live on personal numbers with full
// history; the Cloud API (lib/whatsapp/cloudApi.ts) can't see any of that.
//
// The trade is stated where it's decided, not hidden here: programmatic SENDING from a personal
// number is against WhatsApp's ToS and is the bannable act. So sending is split from reading:
//   - waBridgeEnabled()      — configured to READ (mirror inbound, learn deals, draft suggestions)
//   - waBridgeSendEnabled()  — ALSO cleared to SEND, gated behind an explicit env flag the human
//                              flips per their own risk call. Read-only is the default posture.
//
// Env surface:
//   WHATSAPP_BRIDGE_URL         — WAHA base, e.g. http://127.0.0.1:3000
//   WHATSAPP_BRIDGE_API_KEY     — WAHA's X-Api-Key
//   WHATSAPP_BRIDGE_SECRET      — shared token WAHA sends back as X-Bridge-Token on every webhook
//   WHATSAPP_BRIDGE_SESSION     — WAHA session name (default "default")
//   WHATSAPP_BRIDGE_ALLOW_SEND  — "1" turns programmatic sending ON (the risk decision)
import { safeEqual } from "@/lib/auth/service";
import type { WaSendResult } from "@/lib/whatsapp/cloudApi";

const BASE = () => (process.env.WHATSAPP_BRIDGE_URL || "").replace(/\/+$/, "");
const SESSION = () => process.env.WHATSAPP_BRIDGE_SESSION || "default";

/** Configured to READ — mirror inbound, run the negotiator in suggestion mode. */
export function waBridgeEnabled(): boolean {
  return !!(process.env.WHATSAPP_BRIDGE_URL && process.env.WHATSAPP_BRIDGE_API_KEY);
}

/** Additionally cleared to SEND from the personal number. Off unless the flag is explicitly "1"
 *  — the whole read-only-by-default design hinges on this one check. */
export function waBridgeSendEnabled(): boolean {
  return waBridgeEnabled() && process.env.WHATSAPP_BRIDGE_ALLOW_SEND === "1";
}

/** WAHA addresses individuals as "<digits>@c.us"; groups are "@g.us" (we never negotiate those). */
export function bridgeChatId(digits: string): string {
  return `${digits}@c.us`;
}
export function digitsFromChatId(chatId: string | null | undefined): string | null {
  if (!chatId) return null;
  const d = String(chatId).split("@")[0].replace(/\D+/g, "");
  return d.length >= 8 && d.length <= 15 ? d : null;
}
export function isIndividualChat(chatId: string | null | undefined): boolean {
  return !!chatId && String(chatId).endsWith("@c.us");
}

// ── LID addressing ───────────────────────────────────────────────────────────
// WhatsApp has migrated to LIDs ("linked ids"): a privacy-preserving identifier that replaces
// the phone-number JID on the wire. Real inbound events now carry `from: "<lid>@lid"` and only
// our OWN number as `to: "<digits>@c.us"`. This is not cosmetic — a LID's digits are NOT a phone
// number (they even pass an 8-15 length check), so treating them as one mints vendors with
// unreachable wa.me links. Every inbound must be resolved through WAHA's lid map before use.

export function isLidChat(chatId: string | null | undefined): boolean {
  return !!chatId && String(chatId).endsWith("@lid");
}

/** lid -> phone digits. The mapping is stable for the life of a contact, so cache it process-wide
 *  and never pay the round trip twice for a chatty vendor. */
const lidCache = new Map<string, string>();

export async function resolveLidToDigits(lid: string): Promise<string | null> {
  const cached = lidCache.get(lid);
  if (cached) return cached;
  const key = process.env.WHATSAPP_BRIDGE_API_KEY;
  if (!BASE() || !key) return null;
  try {
    const res = await fetch(`${BASE()}/api/${SESSION()}/lids/${encodeURIComponent(lid)}`, {
      headers: { "X-Api-Key": key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    // WAHA answers { lid, pn } where pn is "<digits>@c.us".
    const digits = digitsFromChatId(data?.pn);
    if (digits) lidCache.set(lid, digits);
    return digits;
  } catch {
    return null;
  }
}

// ── Names ────────────────────────────────────────────────────────────────────
// A WhatsApp contact carries two different names and they routinely disagree:
//   pushname (`notifyName` on the event) — what the ACCOUNT HOLDER typed into their own profile.
//     Self-declared, frequently a persona or a shop tagline. This is what we used to store, which
//     is how a vendor saved on the team's phone as "ali Ahmed Vendor" got answered "Hello Katie".
//   name — what OUR side saved in the phone's address book, synced to the linked device.
//     Someone on the team typed it about a person they actually deal with.
//
// The address-book name wins, always. It is the name on the phone the team is looking at, and it
// is the only one a human on our side ever vouched for.

/** Recorded as `named_by` when a name came from the phone's address book rather than from someone
 *  clicking confirm. It IS a human act — a person typed it into their contacts — and saying which
 *  human is not something WhatsApp tells us. */
export const PHONEBOOK_ACTOR = "phone-contact";

/** The name the linked phone has saved for this number, or null when the number isn't in the
 *  address book (or WAHA can't answer). Deliberately never falls back to `pushname`: an absent
 *  saved name must read as "we don't know what they're called", not as the profile string this
 *  whole path exists to stop trusting. */
export async function fetchBridgeContactName(digits: string): Promise<string | null> {
  const key = process.env.WHATSAPP_BRIDGE_API_KEY;
  if (!BASE() || !key) return null;
  try {
    const url = `${BASE()}/api/contacts?contactId=${encodeURIComponent(bridgeChatId(digits))}&session=${encodeURIComponent(SESSION())}`;
    const res = await fetch(url, { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return bridgeContactSavedName(data);
  } catch {
    return null; // a name lookup must never cost us the message it was called for
  }
}

/** Pull the address-book name out of whatever shape WAHA's contact endpoint returned. Engines and
 *  versions differ (WEBJS vs NOWEB, single object vs one-element array), and `name` is absent
 *  rather than empty for an unsaved number. Pure, so the field precedence is assertable without a
 *  live bridge. */
export function bridgeContactSavedName(payload: unknown): string | null {
  const c = (Array.isArray(payload) ? payload[0] : payload) as Record<string, unknown> | null | undefined;
  if (!c || typeof c !== "object") return null;
  // `name` is the address book; `shortName` is WhatsApp's abbreviation OF that saved name, so it
  // is a fair second. `pushname`/`verifiedName` are the contact's own claims and are never used.
  for (const field of ["name", "shortName"]) {
    const v = c[field];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** The counterparty's phone digits for either addressing scheme. Null for groups, status
 *  broadcasts, and LIDs WAHA cannot resolve — callers must skip those rather than guess, because
 *  a wrong number here files a vendor's words under a stranger. */
export async function resolveChatDigits(chatId: string | null | undefined): Promise<string | null> {
  if (isIndividualChat(chatId)) return digitsFromChatId(chatId);
  if (isLidChat(chatId)) return resolveLidToDigits(String(chatId));
  return null;
}

/** Is this a one-to-one conversation at all (either scheme)? Groups/broadcasts are excluded. */
export function isDirectChat(chatId: string | null | undefined): boolean {
  return isIndividualChat(chatId) || isLidChat(chatId);
}

/** Authenticate a WAHA webhook call. WAHA is configured to send our secret as a custom header;
 *  we compare it constant-time rather than reimplement WAHA's HMAC scheme (which varies by
 *  version). Same trust model as CRON_SECRET: a long shared token on a public endpoint. */
export function verifyBridgeToken(header: string | null | undefined): boolean {
  const secret = process.env.WHATSAPP_BRIDGE_SECRET?.trim();
  if (!secret) return false; // unset = the bridge webhook is not configured; refuse everything
  const got = (header ?? "").trim();
  return got.length > 0 && got.length === secret.length && safeEqual(got, secret);
}

// ── media messages ───────────────────────────────────────────────────────────
// Message types that carry no text but ARE something the vendor sent. A rate card arrives as a
// screenshot and a price as a voice note, and both used to vanish: the bridge ingest required a
// non-empty body, so a caption-less image was counted as "skipped" and never reached the thread —
// one of the ways a chat looks like it stopped receiving messages. The Cloud webhook already files
// these under a labeled placeholder; the bridge now matches it.
//
// An allowlist, deliberately, rather than "anything that isn't text": WAHA also emits protocol
// events with empty bodies, and filing those as messages would put noise into a negotiation
// transcript the negotiator reads back to decide what to say next.
const MEDIA_KINDS = new Set([
  "image", "video", "audio", "ptt", "voice", "document", "sticker", "location", "vcard", "contact", "contacts",
]);

/** The TEXT to file for a mirrored message. WAHA puts a media message's caption in `body` (same as
 *  the Cloud API), so a captioned image needs nothing special; an empty body on a known media type
 *  gets a label saying what arrived. Returns "" for anything that should not be filed at all —
 *  callers treat that as a drop, and it is the only honest answer for an event with no content we
 *  can name. Never invents words the vendor didn't send. */
export function bridgeMessageBody(body: unknown, type: unknown): string {
  const text = String(body ?? "").trim();
  if (text) return text;
  const kind = String(type ?? "").trim().toLowerCase();
  return MEDIA_KINDS.has(kind) ? `[${kind} received on WhatsApp]` : "";
}

/** The mime type we can honestly record for a mirrored message, or null. The file itself is not
 *  fetched yet (the same Phase-2 gap the Cloud path has), so the type is all we know about it. */
export function bridgeMediaType(payload: unknown): string | null {
  const p = (payload ?? {}) as { type?: unknown; media?: { mimetype?: unknown }; _data?: { mimetype?: unknown } };
  const mime = String(p.media?.mimetype ?? p._data?.mimetype ?? "").trim();
  if (mime) return mime;
  const kind = String(p.type ?? "").trim().toLowerCase();
  return MEDIA_KINDS.has(kind) ? kind : null;
}

/** WAHA returns the sent message's id in one of a few shapes across engines/versions; pull a
 *  stable string out of any of them so dedupe of the echoed fromMe event works. */
export function normalizeWaId(id: unknown): string | null {
  if (!id) return null;
  if (typeof id === "string") return id;
  if (typeof id === "object") {
    const o = id as Record<string, unknown>;
    return (typeof o._serialized === "string" && o._serialized)
      || (typeof o.id === "string" && o.id)
      || null;
  }
  return null;
}

/** Send free-form text from the linked personal number via WAHA. Caller must have checked
 *  waBridgeSendEnabled(). No 24h window applies (that's a Cloud API concept), but WhatsApp still
 *  bans on abusive patterns — the negotiator's natural pacing and caps are the mitigation. */
export async function sendViaBridge(digits: string, text: string): Promise<WaSendResult> {
  const key = process.env.WHATSAPP_BRIDGE_API_KEY;
  if (!BASE() || !key) return { ok: false, waMessageId: null, error: "WhatsApp bridge is not configured" };
  try {
    const res = await fetch(`${BASE()}/api/sendText`, {
      method: "POST",
      headers: { "X-Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ session: SESSION(), chatId: bridgeChatId(digits), text }),
      signal: AbortSignal.timeout(30_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, waMessageId: null, error: `WAHA refused the send: ${data?.error ?? data?.message ?? `HTTP ${res.status}`}` };
    }
    const id = normalizeWaId(data?.id) ?? normalizeWaId(data?.key?.id) ?? normalizeWaId(data);
    return { ok: true, waMessageId: id, error: null };
  } catch (e: any) {
    return { ok: false, waMessageId: null, error: `WAHA unreachable: ${e?.message ?? "network error"}` };
  }
}
