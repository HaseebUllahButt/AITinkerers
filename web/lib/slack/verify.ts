// Slack request verification — the ONLY thing standing between a public endpoint and anyone being
// able to execute a confirm card as one of your users.
//
// Slack signs every request with HMAC-SHA256 over `v0:<timestamp>:<raw body>` using the app's
// signing secret. Two properties matter and both are load-bearing:
//
//   1. The signature proves the request came from Slack. Without it the interactions endpoint is an
//      open "run this action as this Slack user" API, because the user id arrives in the payload.
//   2. The timestamp bounds replay. A captured payload stays validly signed forever, so a confirm
//      click could be re-fired months later against a different action id.
//
// Verification needs the RAW body — parsing and re-serialising changes bytes and the HMAC fails. So
// every caller reads `await req.text()` first and parses afterwards, never `req.json()`.
import crypto from "crypto";

/** Slack's own recommendation. Older than this and the signature is valid but the request is not. */
const MAX_SKEW_MS = 5 * 60 * 1000;

export interface VerifyResult {
  ok: boolean;
  /** Why it failed, for the server log. Never returned to the caller — a probe should learn nothing. */
  reason?: string;
}

export function verifySlackRequest(rawBody: string, headers: Headers): VerifyResult {
  const secret = process.env.SLACK_SIGNING_SECRET?.trim();
  // Fail closed. An unset secret must not mean "accept everything" on a route that can execute
  // actions — that is the exact shape of an auth bypass that survives to production unnoticed.
  if (!secret) return { ok: false, reason: "SLACK_SIGNING_SECRET is not set" };

  const sig = headers.get("x-slack-signature");
  const ts = headers.get("x-slack-request-timestamp");
  if (!sig || !ts) return { ok: false, reason: "missing signature headers" };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(Date.now() - tsNum * 1000) > MAX_SKEW_MS) return { ok: false, reason: "stale timestamp" };

  const expected = "v0=" + crypto
    .createHmac("sha256", secret)
    .update(`v0:${ts}:${rawBody}`)
    .digest("hex");

  // Constant-time compare. timingSafeEqual throws on a length mismatch, so guard that first.
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return { ok: false, reason: "signature length mismatch" };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };

  return { ok: true };
}
