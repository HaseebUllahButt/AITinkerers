import { NextRequest, NextResponse } from "next/server";
import { getDistinctWatchedAuthors, getUserEmailConfig, getUserAppPasswordEnc } from "@/lib/db/queries";
import { checkAndNotifyAuthor, type SenderInfo } from "@/lib/pipeline/watch";
import { decryptSecret } from "@/lib/crypto";
import { acquireLock, releaseLock } from "@/lib/redis";
import { auth } from "@auth";

export const maxDuration = 300;

const LOCK_KEY = "lock:notifications:check";

// Same authorization convention as /api/emails/process — cron (CRON_SECRET) or a logged-in
// session (for a manual "check now" trigger during testing).
async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  const session = await auth().catch(() => null);
  return !!session;
}

// Daily job: re-checks every distinctly-watched author ONCE (not once per watcher) for new
// content, then fans a notification (+ email, if the watcher has an app password set) out
// to everyone watching that author. Safe to call repeatedly — the unique constraint on
// author_watch_notifications makes it idempotent.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const got = await acquireLock(LOCK_KEY, 290, lockToken);
  if (!got) {
    return NextResponse.json({ skipped: "another check is in progress" });
  }

  const senderCache = new Map<string, SenderInfo>();
  const getSenderInfo = async (email: string) => {
    if (!senderCache.has(email)) {
      const [enc, cfg] = await Promise.all([getUserAppPasswordEnc(email), getUserEmailConfig(email)]);
      senderCache.set(email, { pass: decryptSecret(enc), fromName: cfg.from_name });
    }
    return senderCache.get(email)!;
  };

  let authorsChecked = 0, newArticles = 0, notified = 0, emailed = 0;

  try {
    const authors = await getDistinctWatchedAuthors(200);
    for (const author of authors) {
      authorsChecked++;
      const result = await checkAndNotifyAuthor(author, getSenderInfo).catch(() => ({ found: [], notified: 0, emailed: 0 }));
      newArticles += result.found.length;
      notified += result.notified;
      emailed += result.emailed;
    }

    return NextResponse.json({ authorsChecked, newArticles, notified, emailed });
  } finally {
    await releaseLock(LOCK_KEY, lockToken);
  }
}

// Vercel cron issues GET — support both.
export async function GET(req: NextRequest) {
  return POST(req);
}
