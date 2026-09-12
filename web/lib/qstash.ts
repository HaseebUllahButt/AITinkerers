import { Client } from "@upstash/qstash";

// Fire a one-off QStash message that POSTs one of our own endpoints — used to auto-continue
// a long job (email finding, discovery profiling) in a fresh serverless invocation before
// the current one hits Vercel's maxDuration. Forwards CRON_SECRET so the proxy + route let
// it through. No-op (returns false) if QStash/base URL aren't configured (e.g. local dev).
export function qstashEnabled(): boolean {
  return !!(process.env.QSTASH_TOKEN && (process.env.APP_URL || process.env.NEXTAUTH_URL));
}

// True only on Vercel — where the 300s function limit means long jobs must chunk + continue.
// Locally, after() runs to completion with no hard limit, so we don't chunk.
export function isServerless(): boolean {
  return process.env.VERCEL === "1";
}

export async function qstashPublish(path: string, body: unknown): Promise<boolean> {
  const token = process.env.QSTASH_TOKEN;
  const base = (process.env.APP_URL || process.env.NEXTAUTH_URL || "").replace(/\/$/, "");
  if (!token || !base) return false;
  try {
    const client = new Client({ token });
    const secret = process.env.CRON_SECRET;
    await client.publishJSON({
      url: `${base}${path}`,
      body,
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    return true;
  } catch {
    return false;
  }
}
