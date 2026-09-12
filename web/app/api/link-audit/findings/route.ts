import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";

// GET — findings for a run (?run_id=), defaulting to the most recent completed run.
export async function GET(req: NextRequest) {
  let runId = req.nextUrl.searchParams.get("run_id");
  if (!runId) {
    const { data, error } = await supabaseAdmin
      .from("link_audit_runs").select("id").eq("status", "completed")
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    // A failed read must not report "a clean site with no broken links".
    if (error) return NextResponse.json({ error: `Could not read the audit runs (${error.message}).` }, { status: 503 });
    runId = data?.id ?? null;
  }
  if (!runId) return NextResponse.json({ runId: null, findings: [] });

  // ?group=1 — one row per broken link with the crawl-wide page count, computed over ALL rows
  // for the run. The flat mode below caps at 500 rows, which is fine for browsing but makes
  // group counts lie on a bad day; this mode reads the slim columns so it doesn't have to cap.
  if (req.nextUrl.searchParams.get("group") === "1") {
    const { data: rows, error } = await supabaseAdmin
      .from("link_audit_findings")
      .select("link_url, reason, http_status, pages_seen, resolved_at, draft_target")
      .eq("run_id", runId).limit(5000);
    if (error) return NextResponse.json({ error: `Could not read the findings (${error.message}).` }, { status: 503 });
    const byLink = new Map<string, { link_url: string; reason: string; http_status: number | null; rows: number; pages_seen: number; resolved_at: string | null; draft_target: boolean }>();
    for (const r of rows ?? []) {
      const g = byLink.get(r.link_url) ?? { link_url: r.link_url, reason: r.reason, http_status: r.http_status, rows: 0, pages_seen: 0, resolved_at: r.resolved_at, draft_target: false };
      g.rows++;
      g.pages_seen = Math.max(g.pages_seen, r.pages_seen ?? 0, g.rows);
      if (!r.resolved_at) g.resolved_at = null; // a group is resolved only when every row is
      if (r.draft_target) g.draft_target = true; // stamped per link at finalize — any row carries it
      byLink.set(r.link_url, g);
    }
    const groups = [...byLink.values()].sort((a, b) => b.pages_seen - a.pages_seen);
    return NextResponse.json({ runId, groups });
  }

  const { data: findings, error: findingsError } = await supabaseAdmin
    .from("link_audit_findings").select("*").eq("run_id", runId)
    .order("link_url").limit(500);
  if (findingsError) return NextResponse.json({ error: `Could not read the findings (${findingsError.message}).` }, { status: 503 });
  return NextResponse.json({ runId, findings: findings ?? [] });
}
