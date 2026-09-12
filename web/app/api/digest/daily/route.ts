import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { buildDailyDigest, sendDailyDigest } from "@/lib/digest/daily";

export const maxDuration = 120;

// Same cron auth convention as the other automated routes.
async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  return !!(await auth().catch(() => null));
}

// POST — send the daily digest if the toggle is on. ?dry=1 returns the digest WITHOUT sending
// (preview); ?force=1 sends even if the toggle is off (the "send test now" button).
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const force = req.nextUrl.searchParams.get("force") === "1";
  try {
    if (dry) return NextResponse.json({ dry: true, ...(await buildDailyDigest()) });
    return NextResponse.json(await sendDailyDigest(force));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) { return POST(req); }
