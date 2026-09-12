// The machine's logbook (automation_runs, 072). Writers are the automated actors — the nightly
// backlinks cron, the send autopilot, the send processor — and readers are the Hermes
// automation_status tool and the daily digest. Two rules keep it honest:
//   - writes are best-effort and NEVER fail the work being logged;
//   - an all-zero run is still a row. The table doubles as the scheduler's heartbeat, and a
//     writer that skips quiet nights makes "the scheduler is broken" invisible again.
import { supabaseAdmin } from "@/lib/db/supabase";

export interface AutomationRun {
  id: string;
  scope: string;
  workflow_id: string | null;
  ran_at: string;
  result: Record<string, unknown>;
  anomalies: string[];
}

export async function recordAutomationRun(
  scope: string,
  workflowId: string | null,
  result: Record<string, unknown>,
  anomalies: string[] = [],
): Promise<void> {
  try {
    await supabaseAdmin.from("automation_runs").insert({ scope, workflow_id: workflowId, result, anomalies });
  } catch { /* the logbook must never break the machine */ }
}

export async function listAutomationRuns(opts: { sinceDays?: number; scopes?: string[]; limit?: number } = {}): Promise<AutomationRun[]> {
  const sinceDays = Math.min(Math.max(opts.sinceDays ?? 2, 1), 90);
  const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  let q = supabaseAdmin.from("automation_runs").select("*").gte("ran_at", cutoff)
    .order("ran_at", { ascending: false }).limit(Math.min(opts.limit ?? 200, 500));
  if (opts.scopes?.length) q = q.in("scope", opts.scopes);
  const { data, error } = await q;
  // The best-effort rule above is for WRITES. The reader must throw: an error swallowed into []
  // inverted the heartbeat alarm — a transient read failure made automation_status assert "the
  // scheduler that drives the nightly loop may be broken" as if it were measured.
  if (error) throw error;
  return (data ?? []) as AutomationRun[];
}
