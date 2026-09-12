// Posting a finished audit into whatever Slack channels are watching that site.
//
// Shared by the two places an audit can finish: the web route (app/api/audit) and the manual
// trigger (app/api/slack/post). Keeping it in one function is what stops the two surfaces from
// slowly disagreeing about what a posted audit looks like.
//
// ── Silence is the normal case ──────────────────────────────────────────────────────────────────
//
// Most audits are of sites nobody has bound a channel to — a stranger pasting a URL into the
// landing page, most of all. That is not a failure and must never read as one: no site row, or a
// site with no channel, returns `posted: 0` with a reason and nothing is logged as an error.
//
// ── It must not be able to break an audit ───────────────────────────────────────────────────────
//
// The audit has already succeeded by the time this runs. Slack being down, a bot that was removed
// from a channel, a revoked token — none of that should turn a good audit into a failed request,
// so every path here resolves rather than throws, and callers run it after the response.
import type { AuditResult } from "@/lib/audit/run";
import { query, queryOne } from "@/lib/db/pg";
import { internalUrl, publicUrl } from "@/lib/appUrl";
import { postMessage } from "./api";
import { renderAuditPost } from "./blocks";

export interface NotifyOutcome {
  posted: number;
  /** Why nothing was posted, when nothing was. Absent on a successful post. */
  skipped?: string;
  errors?: string[];
}

export async function notifySlackOfAudit(result: AuditResult): Promise<NotifyOutcome> {
  try {
    const domain = result.domain.replace(/^www\./, "").toLowerCase();

    const site = await queryOne<{ id: string }>(
      `select id from sites where domain = $1 limit 1`, [domain],
    );
    if (!site) return { posted: 0, skipped: "no site record for this domain" };

    const channels = await query<{ channel_id: string }>(
      `select channel_id from slack_channels where site_id = $1 order by bound_at`, [site.id],
    );
    if (!channels.length) return { posted: 0, skipped: "no channel bound to this site" };

    const blocks = renderAuditPost(result, publicUrl() ?? internalUrl());
    const posts = await Promise.all(channels.map((channel) =>
      // The fallback text is what shows in the sidebar and in a phone notification, where blocks
      // are not rendered at all. "New message" would tell nobody anything.
      postMessage(channel.channel_id, `${result.brand} audit: ${result.score}/100`, blocks),
    ));

    const errors = posts.filter((p) => !p.ok).map((p) => p.error ?? "unknown");
    return { posted: posts.filter((p) => p.ok).length, ...(errors.length ? { errors } : {}) };
  } catch (e: unknown) {
    // Reported, never thrown: see the note at the top.
    return { posted: 0, errors: [e instanceof Error ? e.message : "slack notify failed"] };
  }
}
