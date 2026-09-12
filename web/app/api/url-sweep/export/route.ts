import { NextRequest, NextResponse } from "next/server";

import { isAuthorized } from "@/lib/auth/service";
import { supabaseAdmin } from "@/lib/db/supabase";

export const maxDuration = 60;

// GET /api/url-sweep/export?run=<id> — every row, flat, as CSV.
//
// The grouped report is for deciding what to do; this is for doing it. The ask was explicitly for
// "the full list at once so we can review and remove them in one go", and a review of a thousand
// rows happens in a spreadsheet, not in a web page.
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Escape per RFC 4180. A leading =, +, - or @ is prefixed with a quote so a spreadsheet treats a
  // URL fragment as text rather than a formula.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let runId = req.nextUrl.searchParams.get("run");
  if (!runId) {
    const { data } = await supabaseAdmin
      .from("url_sweep_runs").select("id").order("started_at", { ascending: false }).limit(1).maybeSingle();
    runId = data?.id ?? null;
  }
  if (!runId) return NextResponse.json({ error: "no sweep has been run yet" }, { status: 404 });

  const { data: rows, error } = await supabaseAdmin
    .from("url_sweep_findings")
    .select("page_url, link_url, link_host, matched, kind, anchor_text, zone, heading, hits, context")
    .eq("run_id", runId)
    .order("matched", { ascending: true })
    .order("page_url", { ascending: true })
    .limit(20_000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const header = [
    "page_url", "retired_url", "host", "pattern", "kind",
    "anchor_text", "zone", "nearest_heading", "hits", "where",
  ];
  const body = (rows ?? []).map((r) =>
    [r.page_url, r.link_url, r.link_host, r.matched, r.kind, r.anchor_text, r.zone, r.heading, r.hits, r.context]
      .map(csvCell).join(","),
  );

  return new NextResponse([header.join(","), ...body].join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="retired-urls-${runId.slice(0, 8)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
