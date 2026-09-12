// Scan-history persistence (indexing_runs / indexing_dispatches — additive tables, migration
// scripts/032_indexing_reports.mjs). Called by the API route layer, not by the pure
// runIndexingReport() orchestrator, so the core pipeline stays side-effect-free and testable.
import { supabaseAdmin } from "@/lib/db/supabase";
import type { IndexingReport } from "./types";

export async function saveRun(report: IndexingReport, createdBy?: string | null): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("indexing_runs")
    .insert({
      target: report.target,
      started_at: report.startedAt,
      finished_at: report.finishedAt,
      duration_ms: report.durationMs,
      limit_requested: report.limit,
      discovered: report.discovered,
      analyzed: report.analyzed,
      templates_count: report.counts.templates,
      issues_count: report.counts.issues,
      p0_count: report.counts.p0,
      js_gated_count: report.counts.jsGated,
      playwright_enabled: report.playwrightEnabled,
      pagespeed_key_present: report.pagespeedKey,
      report,
      created_by: createdBy ?? null,
    })
    .select("id")
    .single();
  if (error) {
    console.error("indexing: failed to persist run", error.message);
    return null;
  }
  return data.id as string;
}

export interface DispatchLog {
  runId: string | null;
  kind: "pr" | "ticket" | "slack";
  reason?: string;
  title: string;
  targetRef?: string;
  status: "ok" | "error";
  error?: string;
  dispatchedBy?: string | null;
}

export async function logDispatch(entry: DispatchLog): Promise<void> {
  const { error } = await supabaseAdmin.from("indexing_dispatches").insert({
    run_id: entry.runId,
    kind: entry.kind,
    reason: entry.reason ?? null,
    title: entry.title,
    target_ref: entry.targetRef ?? null,
    status: entry.status,
    error: entry.error ?? null,
    dispatched_by: entry.dispatchedBy ?? null,
  });
  if (error) console.error("indexing: failed to log dispatch", error.message);
}

export interface RunSummary {
  id: string;
  target: string;
  started_at: string;
  finished_at: string;
  analyzed: number;
  templates_count: number;
  issues_count: number;
  p0_count: number;
  js_gated_count: number;
  created_by: string | null;
  created_at: string;
}

export async function listRuns(limit = 20): Promise<RunSummary[]> {
  const { data, error } = await supabaseAdmin
    .from("indexing_runs")
    .select("id, target, started_at, finished_at, analyzed, templates_count, issues_count, p0_count, js_gated_count, created_by, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  // Throw: `[]` renders as "this site has never been scanned", and console.error helps nobody
  // in serverless.
  if (error) throw error;
  return data as RunSummary[];
}

export async function getRunReport(id: string): Promise<IndexingReport | null> {
  const { data, error } = await supabaseAdmin.from("indexing_runs").select("report").eq("id", id).single();
  if (error || !data) return null;
  return data.report as IndexingReport;
}
