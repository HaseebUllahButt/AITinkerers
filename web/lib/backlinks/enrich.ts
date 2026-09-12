/**
 * Kick the email finder for a backlink campaign.
 *
 * Why this exists as its own module: the backlink pipeline discovers prospects and then drafts
 * pitches, but `draftBacklinkPitches` SKIPS anyone without an email on file (its `skippedNoEmail`
 * counter). Nothing in the pipeline ever went and found those emails — enrichment lived in a
 * separate system behind the /email-finder page, and had to be triggered by hand.
 *
 * The measured effect of that gap: 28 of 32 prospects stranded at stage `found`, and a send queue
 * where most rows read "no email address". So discovery now always chains into enrichment, and this
 * is the one place that knows how.
 *
 * It goes over HTTP to our own /api/enrich/run rather than calling the enrichment library directly,
 * because that route owns the run lock, the QStash continuation chunking, and the run-history rows
 * the Email Finder UI reads. Calling the library straight would bypass all three and let two runs
 * collide.
 */

/** Fire the email finder for one campaign. Never throws — enrichment failing must not fail the
 *  discovery that preceded it, since the prospects are already saved and usable. */
export async function kickEnrichment(campaignId: string, opts: { onlyNew?: boolean; retryStaleDays?: number } = {}): Promise<{ started: boolean; detail?: string }> {
  const base = (process.env.APP_URL || process.env.NEXTAUTH_URL || "").replace(/\/$/, "");
  if (!base) return { started: false, detail: "APP_URL / NEXTAUTH_URL is not set, so the finder cannot be reached." };

  const secret = process.env.CRON_SECRET ?? "";
  try {
    const res = await fetch(`${base}/api/enrich/run${secret ? `?key=${encodeURIComponent(secret)}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaign_id: campaignId, mode: "email", only_new: opts.onlyNew ?? false,
        ...(opts.retryStaleDays ? { retry_stale_days: opts.retryStaleDays } : {}),
      }),
    });
    const json = await res.json().catch(() => ({}) as Record<string, unknown>);
    // `alreadyRunning` is the expected answer when a finder run is in flight — not a failure.
    if (json?.alreadyRunning) return { started: false, detail: "A finder run is already in progress." };
    if (!res.ok) return { started: false, detail: typeof json?.error === "string" ? json.error : `finder returned ${res.status}` };
    return { started: true };
  } catch (e) {
    return { started: false, detail: e instanceof Error ? e.message : "could not reach the finder" };
  }
}
