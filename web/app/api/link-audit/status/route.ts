import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";
import { getAuditState } from "@/lib/linkaudit/run";

// GET — live progress of an in-flight audit + recent run history for the /link-audit page.
export async function GET() {
  const [state, runsRes] = await Promise.all([
    getAuditState(),
    supabaseAdmin.from("link_audit_runs").select("*").order("started_at", { ascending: false }).limit(15),
  ]);
  // A failed read is not "this site was never audited".
  if (runsRes.error) return NextResponse.json({ error: `Could not read the run history (${runsRes.error.message}).` }, { status: 503 });
  const runs = runsRes.data;

  // A run is live if its Redis state heartbeat is fresh (chunks save every few pages).
  const running = !!state && Date.now() - state.updatedAt < 10 * 60_000;

  return NextResponse.json({
    running,
    progress: state ? {
      runId: state.runId,
      pagesChecked: state.index,
      pagesTotal: state.pages.length,
      linksChecked: state.linksChecked,
      broken: state.broken,
      unreachable: state.unreachable,
      log: state.log ?? [],
    } : null,
    runs: runs ?? [],
  });
}
