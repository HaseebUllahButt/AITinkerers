import { NextRequest, NextResponse } from "next/server";
import { isAdminCaller } from "@/lib/auth/service";
import { buildAdoptionReport } from "@/lib/adoption/report";

// The report fans out across a dozen tables; 30s is generous but a cold connection plus twelve
// windowed reads is not instant.
export const maxDuration = 30;

/**
 * The adoption report.
 *
 * Admin-only, and that is a real access decision rather than a formality: this endpoint reports what
 * every named colleague did and did not do. Per-person activity is management information, so it is
 * gated to the admin list rather than to any signed-in user.
 */
export async function GET(req: NextRequest) {
  const gate = await isAdminCaller(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

  const raw = Number(req.nextUrl.searchParams.get("days"));
  // Clamped rather than trusted: an unbounded window would push every read past PostgREST's 1000-row
  // ceiling and silently under-report instead of erroring.
  const days = Number.isFinite(raw) ? Math.min(365, Math.max(7, raw)) : 90;

  try {
    return NextResponse.json(await buildAdoptionReport(days));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
