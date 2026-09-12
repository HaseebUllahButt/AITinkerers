// Re-checking sites on a schedule — the piece that makes a bound channel a subscription.
//
// A site earns a re-audit by having at least one channel bound to it: somebody asked to hear
// about it. The cadence is deliberately coarse (default 24h, RECHECK_INTERVAL_HOURS to tune) —
// AI-answer visibility does not move minute to minute, and a five-minute audit per site per day
// is already the expensive end of reasonable.
//
// On each run a bound, due site is re-audited, the result is stored in site_audits, and the
// channels only hear about it when something MOVED — a score change or a finding appearing or
// resolving. Silence between deltas is the feature: a channel that posts "nothing changed" every
// day teaches people to ignore it.
import { publicUrl, internalUrl } from "@/lib/appUrl";
import { query, queryOne } from "@/lib/db/pg";
import { postToChannel } from "@/lib/surfaces/post";
import { channelsForSite, type Surface } from "@/lib/surfaces/store";

import { runAudit, type AuditResult } from "./run";

/** Store a finished audit against its site so the next run can answer "what moved". */
export async function recordAudit(result: AuditResult): Promise<void> {
  await query(
    `insert into site_audits (site_id, score, result)
     select s.id, $2, $3::jsonb from sites s where s.domain = $1 limit 1`,
    [result.domain.replace(/^www\./, "").toLowerCase(), result.score, JSON.stringify(result)],
  );
}

interface DueSite {
  id: string;
  url: string;
  domain: string;
  last_ran: string | null;
}

/** Sites with an audience whose last audit is older than the interval — or was never recorded. */
async function dueSites(intervalHours: number, limit: number): Promise<DueSite[]> {
  return query<DueSite>(
    `select s.id, s.url, s.domain, max(a.ran_at) as last_ran
       from sites s
       left join site_audits a on a.site_id = s.id
      where s.recheck_enabled
        and exists (select 1 from surface_channels c where c.site_id = s.id)
      group by s.id
     having max(a.ran_at) is null or max(a.ran_at) < now() - ($1 || ' hours')::interval
      order by max(a.ran_at) asc nulls first
      limit $2`,
    [String(intervalHours), limit],
  );
}

interface FindingLike {
  id?: unknown;
  severity?: unknown;
  title?: unknown;
}

/** The diff a channel cares about: score movement plus findings that appeared or resolved. */
function auditDelta(prev: AuditResult | null, next: AuditResult): {
  changed: boolean;
  text: string;
} {
  const prevFindings = new Map(
    (Array.isArray(prev?.findings) ? prev?.findings : [] as FindingLike[])
      .map((f: FindingLike) => [String(f.id ?? ""), f]),
  );
  const nextFindings = new Map(
    next.findings.map((f) => [f.id, f]),
  );

  const newFindings = next.findings.filter(
    (f) => f.severity !== "ok" && !prevFindings.has(f.id),
  );
  const resolved = [...prevFindings.values()].filter(
    (f: FindingLike) => f.severity !== "ok" && !nextFindings.has(String(f.id ?? "")),
  );
  const scoreDelta = prev && typeof prev.score === "number" ? next.score - prev.score : null;

  if (!newFindings.length && !resolved.length && (scoreDelta === null || scoreDelta === 0)) {
    return { changed: false, text: "" };
  }

  const lines = [
    `*${next.brand} re-check — ${next.score}/100` +
      (scoreDelta !== null && scoreDelta !== 0
        ? ` (${scoreDelta > 0 ? "+" : ""}${scoreDelta})*`
        : "*"),
  ];
  if (newFindings.length) {
    lines.push("", "*New findings:*", ...newFindings.map((f) => `• ${f.title}`));
  }
  if (resolved.length) {
    lines.push("", "*Resolved since last check:*", ...resolved.map((f: FindingLike) => `• ${String(f.title ?? "")}`));
  }
  const appUrl = publicUrl() ?? internalUrl();
  lines.push("", `Full audit: ${appUrl}/audit?url=${encodeURIComponent(next.url)}`);
  return { changed: true, text: lines.join("\n") };
}

export interface RecheckSummary {
  due: number;
  checked: number;
  notified: number;
  errors: string[];
}

export async function runRechecks(opts: { limit?: number } = {}): Promise<RecheckSummary> {
  const intervalHours = Math.max(1, Number(process.env.RECHECK_INTERVAL_HOURS ?? 24) || 24);
  const limit = Math.max(1, Math.min(opts.limit ?? (Number(process.env.RECHECK_MAX_SITES) || 3), 10));
  const due = await dueSites(intervalHours, limit);
  const summary: RecheckSummary = { due: due.length, checked: 0, notified: 0, errors: [] };

  // Sequential on purpose: one audit already fans out to browsers, search and model calls —
  // running several at once is how a cron turns into a thundering herd against your own keys.
  for (const site of due) {
    try {
      const previous = await queryOne<{ result: AuditResult }>(
        `select result from site_audits where site_id = $1 order by ran_at desc limit 1`,
        [site.id],
      );
      const result = await runAudit(site.url);
      await recordAudit(result);
      summary.checked++;

      const delta = auditDelta(previous?.result ?? null, result);
      if (!delta.changed) continue;

      const channels = await channelsForSite(site.id);
      const posts = await Promise.all(channels.map((c) =>
        postToChannel(c.surface as Surface, c.channel_id, delta.text)
          .then((r) => ({ ok: r.ok, error: `${c.surface}/${c.channel_id}: ${r.error}` })),
      ));
      const failed = posts.filter((p) => !p.ok);
      summary.notified += posts.length - failed.length;
      for (const f of failed) summary.errors.push(f.error ?? "post failed");
    } catch (e) {
      summary.errors.push(`${site.domain}: ${e instanceof Error ? e.message : "recheck failed"}`);
    }
  }
  return summary;
}
