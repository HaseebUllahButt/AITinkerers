import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";
import { getBufferDurable, isRunAlive } from "@/lib/pipeline/eventBuffer";
import { getDiscoveryMeta } from "@/lib/redis";
import { findLatestCheckpoint } from "@/lib/pipeline/checkpoint";
import { getCampaign } from "@/lib/db/queries";

export async function GET() {
  // "Alive" = a recent Redis heartbeat (or an in-memory run on this instance). Durable, so a
  // run executing on ANOTHER serverless instance isn't mistaken for dead.
  const alive = await isRunAlive();

  const { data: runs, error: runsError } = await supabaseAdmin
    .from("pipeline_runs")
    .select("*")
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1);
  // A failed read must not render a RUNNING discovery as dead with an empty database.
  if (runsError) return NextResponse.json({ error: `Could not read the run state (${runsError.message}).` }, { status: 503 });

  let activeRun = runs?.[0] ?? null;

  // Only auto-close a DB "running" row when there's NO live heartbeat AND it's old enough
  // that it can't just be mid-startup — i.e. the run genuinely died (function killed / restart).
  const stale = activeRun && (Date.now() - new Date(activeRun.started_at).getTime()) > 90_000;
  if (activeRun && !alive && stale) {
    await supabaseAdmin
      .from("pipeline_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error: "Auto-closed: no heartbeat (function ended or process restarted)" })
      .eq("id", activeRun.id);
    activeRun = null;
  }

  // Live counts from DB — source of truth regardless of SSE/instance state
  const [totRow, procRow, authRow] = await Promise.all([
    supabaseAdmin.from("discovery_hits").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("discovery_hits").select("id", { count: "exact", head: true }).eq("processed", true),
    supabaseAdmin.from("authors").select("id", { count: "exact", head: true }),
  ]);
  for (const r of [totRow, procRow, authRow]) {
    if (r.error) return NextResponse.json({ error: `Could not read the live counts (${r.error.message}).` }, { status: 503 });
  }

  const buffer = await getBufferDurable();

  // Whole-discovery aggregation: ONE elapsed timer + cumulative progress across every chunk,
  // measured against the baseline captured when this discovery first started. This is what
  // makes the UI show steadily-climbing totals instead of per-chunk counters that reset (which
  // looked like it kept restarting). Falls back to the current run's own timer if no meta.
  const meta = await getDiscoveryMeta();
  const totalHits = totRow.count ?? 0;
  const processedHits = procRow.count ?? 0;
  const totalAuthors = authRow.count ?? 0;
  const runProgress = meta ? {
    discovered: Math.max(0, totalHits - meta.baseHits),
    processed: Math.max(0, processedHits - meta.baseProcessed),
    authors: Math.max(0, totalAuthors - meta.baseAuthors),
  } : null;
  const elapsedMs = meta ? Date.now() - meta.startedAt
    : (activeRun ? Date.now() - new Date(activeRun.started_at).getTime() : 0);

  // Which campaign this discovery is running for — so a refresh/resume shows it at the top.
  // Prefer the meta (set at fresh start); fall back to the resume checkpoint for older runs.
  let campaign: { id: string | null; name: string | null } | null = null;
  if (meta && (meta.campaignName || meta.campaignId)) {
    campaign = { id: meta.campaignId ?? null, name: meta.campaignName ?? null };
  } else if (meta) {
    campaign = { id: null, name: null }; // explicitly "All prospects" (no campaign)
  } else if (activeRun) {
    const cp = await findLatestCheckpoint().catch(() => null);
    if (cp?.campaignId) {
      const c = await getCampaign(cp.campaignId).catch(() => null);
      campaign = { id: cp.campaignId, name: c?.name ?? null };
    } else {
      campaign = { id: null, name: null };
    }
  }

  return NextResponse.json({
    isRunning: alive || !!activeRun,
    activeRun,
    totalHits,
    processedHits,
    totalAuthors,
    // Replay buffered events (durable, survives refresh + instance change)
    bufferedEvents: buffer?.events ?? [],
    bufferRunId: buffer?.runId ?? null,
    elapsedMs,       // cumulative across chunks
    runProgress,     // cumulative { discovered, processed, authors } for THIS discovery
    campaign,        // { id, name } this discovery is scoped to (null name = All prospects)
  });
}
