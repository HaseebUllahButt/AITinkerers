import { NextRequest, NextResponse, after } from "next/server";
import { getAuthorsNeedingEmail, getAuthorsNeedingLinkedin, getCampaign } from "@/lib/db/queries";
import {
  startEnrich, checkRunning, setEnrichTargets, getEnrichTargets,
  restoreFromSnapshot, snapshotToRedis, doneCount,
} from "@/lib/enrich/enrichBuffer";
import { enrichLoop, type FindMode, type EnrichTarget } from "@/lib/enrich/run";

export const maxDuration = 300;

// POST — start an on-demand finding run, OR continue one in a fresh serverless invocation.
//   fresh:      { campaign_id?, mode? }        (mode "email" default | "linkedin")
//   continue:   { continue: true, campaign_id?, mode? }   (fired by QStash to beat the 300s
//               function limit — resumes the same target list at the current done index)
// Work runs via after() so Vercel keeps the function alive past the response.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const findMode: FindMode = body.mode === "linkedin" ? "linkedin" : "email";

  // ── Continuation chunk ──────────────────────────────────────────────
  if (body.continue) {
    const targets = await getEnrichTargets<EnrichTarget>();
    const restored = await restoreFromSnapshot();
    if (!targets || !restored) return NextResponse.json({ continued: false, reason: "nothing to continue" });
    const resumeAt = doneCount();
    after(async () => { try { await enrichLoop(targets, findMode, body.campaign_id, resumeAt); } catch { /* snapshot holds partial state */ } });
    return NextResponse.json({ continued: true, resumeAt, remaining: targets.length - resumeAt });
  }

  // ── Fresh start ─────────────────────────────────────────────────────
  if (await checkRunning()) return NextResponse.json({ started: false, alreadyRunning: true });

  const onlyNew = body.only_new === true;
  const staleDays = Number.isFinite(Number(body.retry_stale_days)) && Number(body.retry_stale_days) > 0
    ? Number(body.retry_stale_days) : undefined;
  const targets = findMode === "linkedin"
    ? await getAuthorsNeedingLinkedin(body.campaign_id)
    : await getAuthorsNeedingEmail(body.campaign_id, onlyNew, staleDays);
  if (targets.length === 0) {
    return NextResponse.json({
      started: false, total: 0,
      reason: findMode === "linkedin"
        ? "Every author already has a LinkedIn on file."
        : onlyNew ? "No brand-new authors to search — everyone left has already been searched before." : "No authors without an email.",
    });
  }

  const campaign = body.campaign_id ? await getCampaign(body.campaign_id).catch(() => null) : null;
  startEnrich(body.campaign_id ?? "all", targets.length, campaign?.name);
  await setEnrichTargets(targets);
  await snapshotToRedis(); // so the status poll (possibly another instance) sees it at once
  after(async () => { try { await enrichLoop(targets, findMode, body.campaign_id, 0); } catch { /* snapshot holds partial state */ } });

  return NextResponse.json({ started: true, total: targets.length, mode: findMode });
}
