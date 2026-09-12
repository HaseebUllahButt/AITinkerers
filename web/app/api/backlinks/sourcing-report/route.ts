import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth/service";
import { sourcingEffectiveness } from "@/lib/db/queries";

// Reply/win effectiveness by prospect source. The same query the Hermes sourcing_report tool
// reads; this is its page surface, so the numbers in chat and on /backlinks cannot disagree.
export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const days = Math.min(Math.max(Number(req.nextUrl.searchParams.get("days") ?? 90) || 90, 7), 365);
  try {
    return NextResponse.json({ ok: true, window_days: days, by_source: await sourcingEffectiveness(days) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
