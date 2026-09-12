// Posting a finished audit into every channel watching that site, on every surface.
//
// ── Silence is the normal case ────────────────────────────────────────────────────────────────
// Most audits are of sites nobody has bound a channel to — a stranger pasting a URL into the
// landing page, most of all. That is not a failure and must never read as one: no site row, or a
// site with no channels, returns `posted: 0` with a reason and nothing is logged as an error.
//
// ── It must not be able to break an audit ─────────────────────────────────────────────────────
// The audit has already succeeded by the time this runs. A bridge that is down, a bot removed
// from a channel, a revoked token — none of that should turn a good audit into a failed request,
// so every path here resolves rather than throws, and callers run it after the response.
import type { AuditResult } from "@/lib/audit/run";
import { internalUrl, publicUrl } from "@/lib/appUrl";
import { queryOne } from "@/lib/db/pg";
import { postMessage } from "@/lib/slack/api";
import { renderAuditPost } from "@/lib/slack/blocks";
import { postToChannel } from "./post";
import { channelsForSite, type Surface } from "./store";
import { renderAuditText } from "./text";

export interface NotifyOutcome {
  posted: number;
  /** Why nothing was posted, when nothing was. Absent on a successful post. */
  skipped?: string;
  errors?: string[];
}

export async function notifySurfacesOfAudit(result: AuditResult): Promise<NotifyOutcome> {
  try {
    const domain = result.domain.replace(/^www\./, "").toLowerCase();
    const site = await queryOne<{ id: string }>(
      `select id from sites where domain = $1 limit 1`, [domain],
    );
    if (!site) return { posted: 0, skipped: "no site record for this domain" };

    const channels = await channelsForSite(site.id);
    if (!channels.length) return { posted: 0, skipped: "no channel bound to this site" };

    const appUrl = publicUrl() ?? internalUrl();
    // Slack keeps its block rendering — it is the one surface with real structure. Everything
    // else gets the shared text rendering, which already speaks their markup dialect.
    const slackBlocks = renderAuditPost(result, appUrl);
    const fallbackText = `${result.brand} audit: ${result.score}/100`;
    const text = renderAuditText(result, appUrl);

    const posts = await Promise.all(channels.map((channel) =>
      channel.surface === "slack"
        ? postMessage(channel.channel_id, fallbackText, slackBlocks)
            .then((r) => ({ ok: r.ok, error: r.error }))
        : postToChannel(channel.surface as Surface, channel.channel_id, text),
    ));

    const errors = posts.filter((p) => !p.ok).map((p) => p.error ?? "unknown");
    return { posted: posts.filter((p) => p.ok).length, ...(errors.length ? { errors } : {}) };
  } catch (e: unknown) {
    return { posted: 0, errors: [e instanceof Error ? e.message : "notify failed"] };
  }
}
