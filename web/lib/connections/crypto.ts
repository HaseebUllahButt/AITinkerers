// Application-layer encryption for `connections.secret_enc`.
//
// The column is text, and it is read by anyone who can read the table: a `pg_dump`, a screenshot of
// a psql session, a log line that printed a row. A GitHub token or a Google refresh token in there as
// plaintext is a credential leak waiting for the first casual SELECT *. So nothing writes that column
// except through `encrypt`, and the key lives in the environment, not in the database.
//
// AES-256-GCM with a random nonce per value: authenticated, so a tampered ciphertext fails to
// decrypt rather than yielding garbage that gets sent to GitHub as a token. The `v1:` prefix is so a
// future key rotation or algorithm change can tell old rows from new ones instead of guessing.
//
// ── No key is a hard stop ────────────────────────────────────────────────────────────────────────
//
// An unset CONNECTIONS_KEY throws from `encrypt`. The alternatives are all worse: a hard-coded
// fallback key is plaintext with extra steps, and silently storing the value unencrypted is exactly
// what this file exists to prevent. Connections that carry no secret (the demo stubs, the
// service-account Google mode) never call this, so the app still runs without the key — it just
// refuses to store a token.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = process.env.CONNECTIONS_KEY?.trim();
  if (!raw) {
    throw new Error(
      "CONNECTIONS_KEY is not set — refusing to store a secret. Generate one with " +
      "`openssl rand -hex 32` and put it in .env.local.",
    );
  }
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("CONNECTIONS_KEY must be 32 bytes (64 hex chars or base64).");
  return buf;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decrypt(stored: string): string {
  const [v, iv, tag, ct] = stored.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unrecognised secret format.");
  const d = createDecipheriv(ALGO, key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}
