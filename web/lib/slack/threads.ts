import { execute, query, queryOne } from "@/lib/db/pg";
import { createAgentSession, getAgentSession } from "@/lib/agent";

export interface SiteRow {
  id: string;
  url: string;
  domain: string;
  brand: string | null;
}

export async function findSession(teamId: string, channelId: string, threadTs: string) {
  const row = await queryOne<{ session_id: string }>(
    `select session_id from slack_threads
      where slack_team_id = $1 and channel_id = $2 and thread_ts = $3`,
    [teamId, channelId, threadTs],
  );
  return row?.session_id ?? null;
}

export async function boundSite(teamId: string, channelId: string): Promise<SiteRow | null> {
  return queryOne<SiteRow>(
    `select s.id, s.url, s.domain, s.brand
       from slack_channels c join sites s on s.id = c.site_id
      where c.slack_team_id = $1 and c.channel_id = $2`,
    [teamId, channelId],
  );
}

export async function findSite(domain: string): Promise<SiteRow | null> {
  return queryOne<SiteRow>(
    `select id, url, domain, brand from sites where domain = $1`,
    [domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").toLowerCase()],
  );
}

export async function bindChannel(
  teamId: string, channelId: string, siteId: string, boundBy: string,
): Promise<void> {
  await execute(
    `insert into slack_channels (slack_team_id, channel_id, site_id, bound_by, bound_at)
     values ($1, $2, $3, $4, now())
     on conflict (slack_team_id, channel_id) do update set
       site_id = excluded.site_id, bound_by = excluded.bound_by, bound_at = now()`,
    [teamId, channelId, siteId, boundBy],
  );
}

export async function unbindChannel(teamId: string, channelId: string): Promise<void> {
  await execute(
    `delete from slack_channels where slack_team_id = $1 and channel_id = $2`,
    [teamId, channelId],
  );
}

export async function channelsForSite(siteId: string) {
  return query<{ slack_team_id: string; channel_id: string; bound_by: string | null }>(
    `select slack_team_id, channel_id, bound_by from slack_channels
      where site_id = $1 order by bound_at`,
    [siteId],
  );
}

export async function attachThread(
  teamId: string, channelId: string, threadTs: string, sessionId: string,
): Promise<void> {
  await execute(
    `insert into slack_threads (slack_team_id, channel_id, thread_ts, session_id)
     values ($1, $2, $3, $4)
     on conflict (slack_team_id, channel_id, thread_ts) do update set session_id = excluded.session_id`,
    [teamId, channelId, threadTs, sessionId],
  );
}

export async function findOrCreateSession(
  teamId: string, channelId: string, threadTs: string, createdBy: string, title: string,
): Promise<{ ok: true; sessionId: string }> {
  const existing = await findSession(teamId, channelId, threadTs);
  if (existing && await getAgentSession(existing)) return { ok: true, sessionId: existing };

  const site = await boundSite(teamId, channelId);
  const session = await createAgentSession({
    siteId: site?.id ?? null, title: title.slice(0, 120), createdBy,
  });
  await attachThread(teamId, channelId, threadTs, session.id);
  return { ok: true, sessionId: session.id };
}
