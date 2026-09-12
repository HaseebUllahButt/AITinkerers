import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { autopilotEnabled, autopilotCap, setAutopilot, runAutopilot } from "@/lib/email/autopilot";

export const maxDuration = 120;

function cronOk(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}` || req.nextUrl.searchParams.get("key") === secret;
}
async function ok(req: NextRequest): Promise<boolean> {
  return cronOk(req) || !!(await auth().catch(() => null));
}

// GET → current autopilot setting.
export async function GET(req: NextRequest) {
  if (!(await ok(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ enabled: await autopilotEnabled(), cap: await autopilotCap() });
}

// PATCH { enabled?, cap? } → update the setting. If `run` is true, also top up the queue now.
export async function PATCH(req: NextRequest) {
  if (!(await ok(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  await setAutopilot({
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    cap: typeof body.cap === "number" ? body.cap : undefined,
  });
  const actor = (await auth().catch(() => null))?.user?.email ?? null;
  const result = body.run ? await runAutopilot({ force: true, actorEmail: actor }) : null;
  return NextResponse.json({ ok: true, enabled: await autopilotEnabled(), cap: await autopilotCap(), result });
}

// POST → run the top-up now (manual "top up" button, and the cron calls this too).
export async function POST(req: NextRequest) {
  if (!(await ok(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const force = req.nextUrl.searchParams.get("force") === "1";
  // A cron-drafted pitch carries no sender, and the processor refuses unstamped rows outright
  // (the old env-SMTP fallback sent them from a real teammate's mailbox). When a PERSON is arming
  // the queue, they own the sends, so pass them through; the unattended cron run has no actor and
  // leaves those rows alone rather than arming rows that would only park as failed.
  const actorEmail = (await auth().catch(() => null))?.user?.email ?? null;
  try {
    return NextResponse.json({ ok: true, result: await runAutopilot({ force, actorEmail }) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "autopilot failed" }, { status: 500 });
  }
}
