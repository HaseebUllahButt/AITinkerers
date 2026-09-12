import { NextRequest, NextResponse, after } from "next/server";
import { runDiscoveryPipeline } from "@/lib/pipeline/run";
import { getCampaign, updateCampaign } from "@/lib/db/queries";
import { findLatestCheckpoint } from "@/lib/pipeline/checkpoint";
import { supabaseAdmin } from "@/lib/db/supabase";
import { acquireDiscoveryLock, refreshDiscoveryLock, releaseDiscoveryLock, startDiscoveryMeta } from "@/lib/redis";

export const maxDuration = 300; // 5 minutes on Vercel

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  let campaignId = body.campaign_id as string | undefined;
  let customKeywords: string[] | undefined;
  let seedWriter: { name?: string; articleUrl?: string } | undefined;
  let seedDomains: string[] | undefined;
  let seedArticleUrls: string[] | undefined;
  let resume: { usedQueries: string[]; round: number; rssComplete: boolean; discoveryDone?: boolean; oldRunId?: string } | undefined;

  // Resume mode — load checkpoint and continue from where we left off.
  if (body.resume === true) {
    const cp = await findLatestCheckpoint();
    if (cp) {
      resume = { usedQueries: cp.usedQueries, round: cp.round, rssComplete: cp.rssComplete, discoveryDone: cp.discoveryDone, oldRunId: cp.runId };
      if (!campaignId && cp.campaignId) campaignId = cp.campaignId;
      if (!customKeywords && cp.customKeywords) customKeywords = cp.customKeywords;
    } else {
      // Checkpoint missing (evicted / a chunk was killed before it re-saved). CRITICAL: never
      // fall back to a fresh full run here — that re-harvests RSS and reprocesses from zero
      // (the "restarts everything mid-run" bug). If there's still an unprocessed backlog,
      // resume in processing-only mode (skip RSS + the query loop) to finish it; otherwise
      // there's nothing to do.
      const { count, error: backlogError } = await supabaseAdmin.from("discovery_hits").select("id", { count: "exact", head: true }).eq("processed", false);
      // Hermes calls this route: "no pending work to resume" must be a measured zero, or the
      // agent reports a stalled backlog as finished.
      if (backlogError) return NextResponse.json({ started: false, error: `Could not read the backlog (${backlogError.message}).` }, { status: 503 });
      if ((count ?? 0) > 0) {
        resume = { usedQueries: [], round: 99, rssComplete: true, discoveryDone: true };
      } else {
        return NextResponse.json({ started: false, reason: "no checkpoint and no pending work to resume" });
      }
    }
  }

  // HARD global lock: only one discovery runs at a time, across every instance and user. A
  // FRESH start must take the lock (NX) or it's refused — no matter who/where triggers it.
  // Resume continuations don't take the lock (the run already holds it); they just extend it
  // so the hand-off gap between chunks doesn't let a duplicate slip in.
  if (!resume) {
    const got = await acquireDiscoveryLock(`fresh-${Date.now()}`);
    if (!got) return NextResponse.json({ started: false, alreadyRunning: true, reason: "A discovery is already running. Only one can run at a time." });
    // Snapshot baseline counts + start time so the UI shows ONE continuous timer + cumulative
    // progress across all chunks, rather than per-chunk counters that reset.
    const [hits, processed, authors, campaign] = await Promise.all([
      supabaseAdmin.from("discovery_hits").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("discovery_hits").select("id", { count: "exact", head: true }).eq("processed", true),
      supabaseAdmin.from("authors").select("id", { count: "exact", head: true }),
      campaignId ? getCampaign(campaignId).catch(() => null) : Promise.resolve(null),
    ]);
    // A zero baseline from a failed count inflates every "discovered N" figure for the whole run.
    for (const r of [hits, processed, authors]) {
      if (r.error) {
        await releaseDiscoveryLock().catch(() => {});
        return NextResponse.json({ started: false, error: `Could not read the baseline counts (${r.error.message}).` }, { status: 503 });
      }
    }
    await startDiscoveryMeta({
      startedAt: Date.now(), baseHits: hits.count ?? 0, baseProcessed: processed.count ?? 0, baseAuthors: authors.count ?? 0,
      campaignId: campaignId ?? null, campaignName: campaign?.name ?? null,
    });
  } else {
    await refreshDiscoveryLock(`resume-${Date.now()}`);
  }

  if (campaignId && !resume) {
    const campaign = await getCampaign(campaignId);
    if (campaign) {
      customKeywords = campaign.keywords.length > 0 ? campaign.keywords : undefined;
      if (campaign.seed_writer_name || campaign.seed_article_url) {
        seedWriter = { name: campaign.seed_writer_name ?? undefined, articleUrl: campaign.seed_article_url ?? undefined };
      }
      seedDomains = campaign.seed_domains?.length ? campaign.seed_domains : undefined;
      seedArticleUrls = campaign.seed_article_urls?.length ? campaign.seed_article_urls : undefined;
      await updateCampaign(campaignId, { status: "running" });
    }
  } else if (campaignId && resume) {
    await updateCampaign(campaignId, { status: "running" }).catch(() => {});
  }

  // Run the pipeline via after() so it's fully independent of the caller's tab/connection:
  // closing the tab never stops it (Vercel keeps the function alive for after() work, up to
  // maxDuration; long crawls then auto-continue via QStash). The UI shows progress by polling
  // /api/pipeline/live (Redis-durable), and the QStash auto-continuation path is identical.
  // (seedWriter is only ever set on a fresh, non-resumed run — see discover/route.ts above —
  // and runDiscoveryPipeline itself also guards on !isResuming, so a resume never re-runs it.)
  after(async () => {
    try { await runDiscoveryPipeline(undefined, { campaignId, customKeywords, seedWriter, seedDomains, seedArticleUrls, resume }); }
    catch { if (campaignId) await updateCampaign(campaignId, { status: "done" }).catch(() => {}); }
  });
  return NextResponse.json({ started: true, auto: body.auto === true });
}

export async function GET() {
  return NextResponse.json({ message: "POST to this endpoint to start discovery" });
}
