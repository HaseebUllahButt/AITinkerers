// Discord request verification — same job as lib/slack/verify.ts, different scheme.
//
// Discord signs interactions with Ed25519: X-Signature-Ed25519 over (timestamp + raw body),
// verified against the app's public key. Two properties matter, same as Slack:
//
//   1. The signature proves the request came from Discord. Without it the interactions endpoint
//      is an open "run this action as this Discord user" API.
//   2. The timestamp bounds replay — a captured payload stays validly signed forever otherwise.
//
// Verification needs the RAW body — parse after verifying, never before.
import crypto from "crypto";

const MAX_SKEW_MS = 5 * 60 * 1000;

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/** Discord publishes a raw 32-byte Ed25519 key; wrap it in SPKI DER so node crypto can use it. */
function publicKey(): crypto.KeyObject | null {
  const hex = process.env.DISCORD_PUBLIC_KEY?.trim();
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) return null;
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(hex, "hex"),
  ]);
  return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
}

export function verifyDiscordRequest(rawBody: string, headers: Headers): VerifyResult {
  const key = publicKey();
  // Fail closed — same rule as Slack: an unset key must not mean "accept everything" on a route
  // that can execute actions.
  if (!key) return { ok: false, reason: "DISCORD_PUBLIC_KEY is not set" };

  const sig = headers.get("x-signature-ed25519");
  const ts = headers.get("x-signature-timestamp");
  if (!sig || !ts) return { ok: false, reason: "missing signature headers" };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(Date.now() - tsNum * 1000) > MAX_SKEW_MS) return { ok: false, reason: "stale timestamp" };

  try {
    const ok = crypto.verify(
      null,
      Buffer.from(ts + rawBody, "utf8"),
      key,
      Buffer.from(sig, "hex"),
    );
    return ok ? { ok: true } : { ok: false, reason: "signature mismatch" };
  } catch {
    return { ok: false, reason: "malformed signature" };
  }
}
