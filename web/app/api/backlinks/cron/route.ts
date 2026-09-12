import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth/service";
import { listBacklinkCampaigns, draftBacklinkPitches, verifyBacklinks, sweepRepliedWins } from "@/lib/backlinks/pipeline";
import { kickEnrichment } from "@/lib/backlinks/enrich";
import { getDefaultPolicy, getPolicyFor, policyActive, shouldAutoPause, upsertPolicy } from "@/lib/automation/policy";
import { recordAutomationRun } from "@/lib/automation/runs";
import { supabaseAdmin } from "@/lib/db/supabase";

export const maxDuration = 300;

/**
 * Nightly upkeep for every backlink campaign: write the pitches that are missing, re-check links —
 * both first sightings and the weekly decay pass over wins (two consecutive misses demote to
 * 'lost' instead of leaving a phantom win) — and, where the campaign's standing policy allows it
 * (auto_source), top up enrichment including retries of stale no-result authors.
 *
 * This closes the automation loop. The send autopilot only promotes `ready` emails to `scheduled` —
 * it never creates them. Drafting is safe to run repeatedly: `draftBacklinkPitches` only touches
 * prospects in stage found/emailing/ready that have an email and no pitch yet, and everything it
 * writes lands as `ready` — queued, never sent. Sending stays behind the per-workflow policy cap
 * and the send window.
 *
 * The cron is also the anomaly detector: a campaign whose week of sends is bouncing hard is
 * auto-paused (policy.paused_reason) so autopilot stops feeding it — the machine stops itself and
 * says why, rather than a human noticing a burned domain later. Every campaign's night is written
 * to automation_runs; the rows double as the scheduler's heartbeat.
 */
// Auth lives in @/lib/auth/service so a person, a cron and the agent are recognised by one
// rule. The local copy this replaced also returned true when CRON_SECRET was unset.

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const campaigns = await listBacklinkCampaigns().catch(() => []);
  const defaultPolicy = await getDefaultPolicy().catch(() => null);
  const results: Array<{
    target: string; drafted: number; skippedNoEmail: number; checked: number; live: number;
    lost: number; enrichKicked: boolean; paused?: string; error?: string;
  }> = [];

  let totalDrafted = 0, totalSkipped = 0, totalLive = 0, totalLost = 0;
  const cutoff7d = new Date(Date.now() - 7 * 86_400_000).toISOString();

  for (const c of campaigns) {
    try {
      const policy = await getPolicyFor(c.workflow_id).catch(() => defaultPolicy);

      // A tight per-campaign budget: the whole nightly loop shares one 300s function across every
      // campaign, and leftovers roll to the next night (or a button press) rather than one large
      // campaign starving the rest.
      const draft = await draftBacklinkPitches(c, { timeBudgetMs: 60_000 });
      const verify = await verifyBacklinks(c);

      // Policy-gated enrichment top-up. retry_stale_days bounds it to authors whose last empty
      // search has aged out, so a nightly kick cannot re-bill yesterday's failures.
      let enrichKicked = false;
      if (policy?.auto_source && policyActive(policy)) {
        await kickEnrichment(c.campaign_id, { onlyNew: !policy.retry_stale_days, retryStaleDays: policy.retry_stale_days ?? undefined }).catch(() => {});
        enrichKicked = true;
      }

      // Anomaly check — only for campaigns the machine is actually feeding, and only the FIRST
      // time (an existing paused_reason is left alone so a human's un-pause isn't refought).
      const anomalies: string[] = [];
      let paused: string | undefined;
      if (policy && policyActive(policy)) {
        const { data: sentRows, error: sentError } = await supabaseAdmin
          .from("outreach_emails").select("id, bounced_at")
          .eq("workflow_id", c.workflow_id).eq("kind", "initial").gte("sent_at", cutoff7d);
        if (sentError) {
          // Don't false-pause on a blip, but never pretend the check ran: the logbook says so.
          anomalies.push(`bounce check unreadable this run (${sentError.message}) — auto-pause skipped`);
        } else {
          const sent7d = (sentRows ?? []).length;
          const bounced7d = ((sentRows ?? []) as Array<{ bounced_at: string | null }>).filter((r) => r.bounced_at).length;
          const pauseReason = shouldAutoPause({ sent7d, bounced7d });
          if (pauseReason) {
            anomalies.push(pauseReason);
            await upsertPolicy(c.workflow_id, { paused_reason: pauseReason }, "anomaly-detector").catch(() => {});
            paused = pauseReason;
          }
        }
      }
      if (verify.lost > 0) anomalies.push(`${verify.lost} previously live link${verify.lost === 1 ? "" : "s"} no longer found (demoted to lost)`);

      totalDrafted += draft.drafted;
      totalSkipped += draft.skippedNoEmail;
      totalLive += verify.live;
      totalLost += verify.lost;
      results.push({ target: c.target_path, drafted: draft.drafted, skippedNoEmail: draft.skippedNoEmail, checked: verify.checked, live: verify.live, lost: verify.lost, enrichKicked, paused });

      await recordAutomationRun("backlinks-cron", c.workflow_id, {
        campaign: c.name ?? c.target_path,
        drafted: draft.drafted, draftedManual: draft.draftedManual,
        skippedNoEmail: draft.skippedNoEmail, skippedRecentContact: draft.skippedRecentContact,
        skippedOffTopic: draft.skippedOffTopic,
        checked: verify.checked, rechecked: verify.rechecked, live: verify.live, lost: verify.lost,
        enrichKicked,
      }, anomalies);
    } catch (e) {
      // One bad campaign must not stop the rest — record it and carry on.
      const message = e instanceof Error ? e.message : "failed";
      results.push({ target: c.target_path, drafted: 0, skippedNoEmail: 0, checked: 0, live: 0, lost: 0, enrichKicked: false, error: message });
      await recordAutomationRun("backlinks-cron", c.workflow_id, { campaign: c.name ?? c.target_path, error: message }, [`campaign run failed: ${message}`]);
    }
  }

  // Wins the campaign boards can't see: replied threads in PLAIN workflows whose author added a
  // link somewhere the per-prospect verifier never looks. Runs after the campaigns so their 60s
  // budgets come first; its own budget keeps the whole night inside the function's 300s. A failed
  // sweep is recorded AS a failure — zeros would read as "no wins anywhere" (load honesty).
  const sweep = await sweepRepliedWins({ timeBudgetMs: 45_000 })
    .then((s) => ({ ...s, error: undefined as string | undefined }))
    .catch((e) => ({ checked: 0, won: 0, unreachable: 0, remaining: 0, error: (e instanceof Error ? e.message : "sweep failed") as string | undefined }));

  // Heartbeat: the night happened, even if every campaign was quiet.
  await recordAutomationRun("backlinks-cron", null, {
    campaigns: campaigns.length, totalDrafted, totalSkippedNoEmail: totalSkipped, totalLive, totalLost,
    repliedSweepChecked: sweep.checked, repliedSweepWon: sweep.won, repliedSweepRemaining: sweep.remaining,
    ...(sweep.error ? { repliedSweepError: sweep.error } : {}),
  }, sweep.error ? [`replied-wins sweep failed this run (${sweep.error})`] : []);

  return NextResponse.json({
    ok: true,
    campaigns: campaigns.length,
    totalDrafted,
    // Surfaced deliberately: a high number here means enrichment is the bottleneck, not drafting.
    totalSkippedNoEmail: totalSkipped,
    totalLive,
    totalLost,
    repliedSweep: sweep,
    results,
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
