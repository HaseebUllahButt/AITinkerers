import { NextRequest, NextResponse } from "next/server";
import { rescheduleScheduledToTimezone } from "@/lib/db/queries";

export const maxDuration = 120;

// POST { timezone } — restandardise the whole queue to one timezone and re-time it.
export async function POST(req: NextRequest) {
  try {
    const { timezone } = await req.json();
    if (!timezone || typeof timezone !== "string") {
      return NextResponse.json({ error: "timezone required" }, { status: 400 });
    }
    const moved = await rescheduleScheduledToTimezone(timezone);
    return NextResponse.json({ ok: true, rescheduled: moved, timezone });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
