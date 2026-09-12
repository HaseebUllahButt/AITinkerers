import type { Metadata } from "next";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { supabaseAdmin } from "@/lib/db/supabase";
import { AuditReport, type Report } from "./AuditReport";
import { RunAuditControls } from "./RunAuditControls";

export const metadata: Metadata = { title: "JS-Render Audit" };
export const dynamic = "force-dynamic";

// Renders the newest report scripts/js-render-audit.mts has produced. Supabase first — the audit
// can only ever run on a local machine (it needs a real Chromium, same constraint Render Lab's own
// render diff has), but once a report exists it's just data, and data isn't local-only. A run
// uploads there automatically; local files under scripts/output/ are the fallback for a report that
// predates that, or a machine without Supabase env vars.
const OUT_ROOT = join(process.cwd(), "scripts", "output", "js-render-audit");

async function fromSupabase(): Promise<{ report: Report; runId: string } | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("js_render_audit_reports")
      .select("run_id, generated_at, base, dropped_from_sitemap, shared_hidden, findings")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return {
      runId: data.run_id,
      report: {
        generatedAt: data.generated_at,
        base: data.base,
        droppedFromSitemap: data.dropped_from_sitemap,
        sharedHidden: data.shared_hidden ?? [],
        findings: data.findings ?? [],
      },
    };
  } catch {
    return null;
  }
}

async function fromLocalFiles(): Promise<{ report: Report; runId: string } | null> {
  let dirs: string[];
  try {
    dirs = (await readdir(OUT_ROOT, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return null;
  }
  for (let i = dirs.length - 1; i >= 0; i--) {
    try {
      const raw = await readFile(join(OUT_ROOT, dirs[i], "report.json"), "utf8");
      return { report: JSON.parse(raw), runId: dirs[i] };
    } catch {
      // that run never reached a final report.json (killed mid-sweep) — try the one before it
    }
  }
  return null;
}

async function latestReport(): Promise<{ report: Report; runId: string } | null> {
  return (await fromSupabase()) ?? (await fromLocalFiles());
}

export default async function JsRenderAuditPage() {
  const data = await latestReport();

  if (!data) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-heading font-medium">JS-Render Audit</h1>
        <p className="text-sm text-muted-foreground">No report yet — start one below.</p>
        <RunAuditControls />
      </div>
    );
  }

  return <AuditReport report={data.report} runId={data.runId} />;
}
