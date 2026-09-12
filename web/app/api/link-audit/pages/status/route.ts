import { NextResponse } from "next/server";
import { getPageSweepState } from "@/lib/linkaudit/pages";

// GET — live progress of an in-flight page sweep. Run history comes from the shared
// /api/link-audit/status endpoint (link_audit_runs now carries `kind`).
export async function GET() {
  const state = await getPageSweepState();
  const running = !!state && Date.now() - state.updatedAt < 10 * 60_000;
  return NextResponse.json({
    running,
    progress: state ? {
      runId: state.runId,
      pagesChecked: state.index,
      pagesTotal: state.pages.length,
      broken: state.broken,
      unreachable: state.unreachable,
      log: state.log ?? [],
    } : null,
  });
}
