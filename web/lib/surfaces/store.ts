// One store for every messaging surface: who a user is, which site a channel follows, and which
// agent session a thread continues. Slack, Discord, WhatsApp and Telegram all resolve to the same
// three shapes, so the rows are keyed by (surface, workspace, channel[, thread]) and each adapter
// only has to translate its own wire format into these calls.
//
// `workspaceId` is whatever the surface calls a tenant: Slack team id, Discord guild id, the
// WhatsApp account's own number, the Telegram group id. DMs and single-tenant bridges use a
// fixed placeholder — the column exists for the surfaces that can collide across workspaces.
import { execute, query, queryOne } from "@/lib/db/pg";
import { createAgentSession, getAgentSession } from "@/lib/agent";

export type Surface = "slack" | "discord" | "whatsapp" | "telegram";

export interface SurfaceIdentity {
  surface: Surface;
  workspace_id: string;
  external_user_id: string;
  user_email: string | null;
}

export interface SiteRow {
  id: string;
  url: string;
  domain: string;
  brand: string | null;
}

// ── Identities ────────────────────────────────────────────────────────────────────────────────

/** Record a user the first time they arrive inside a verified payload. */
export async function ensureSurfaceUser(
  surface: Surface, workspaceId: string, externalUserId: string,
): Promise<void> {
  await execute(
    `insert into surface_identities (surface, workspace_id, external_user_id)
     values ($1, $2, $3) on conflict do nothing`,
    [surface, workspaceId, externalUserId],
  );
}

export async function resolveSurfaceUser(
  surface: Surface, workspaceId: string, externalUserId: string,
): Promise<SurfaceIdentity | null> {
  return queryOne<SurfaceIdentity>(
    `select surface, workspace_id, external_user_id, user_email
       from surface_identities
      where surface = $1 and workspace_id = $2 and external_user_id = $3`,
    [surface, workspaceId, externalUserId],
  );
}

export async function linkSurfaceUser(
  surface: Surface, workspaceId: string, externalUserId: string,
  userEmail: string, linkedBy: string,
): Promise<void> {
  await execute(
    `insert into surface_identities
       (surface, workspace_id, external_user_id, user_email, linked_by, linked_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (surface, workspace_id, external_user_id) do update set
       user_email = excluded.user_email, linked_by = excluded.linked_by, linked_at = now()`,
    [surface, workspaceId, externalUserId, userEmail.trim().toLowerCase(), linkedBy],
  );
}

/** Who is acting, for attribution: their linked email when known, else a surface-scoped handle. */
export function surfaceHandle(surface: Surface, workspaceId: string, externalUserId: string): string {
  return `${surface}:${workspaceId}:${externalUserId}`;
}

// ── Channel → site bindings ───────────────────────────────────────────────────────────────────

export async function boundSite(
  surface: Surface, workspaceId: string, channelId: string,
): Promise<SiteRow | null> {
  return queryOne<SiteRow>(
    `select s.id, s.url, s.domain, s.brand
       from surface_channels c join sites s on s.id = c.site_id
      where c.surface = $1 and c.workspace_id = $2 and c.channel_id = $3`,
    [surface, workspaceId, channelId],
  );
}

export async function findSite(domain: string): Promise<SiteRow | null> {
  return queryOne<SiteRow>(
    `select id, url, domain, brand from sites where domain = $1`,
    [domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").toLowerCase()],
  );
}

export async function bindChannel(
  surface: Surface, workspaceId: string, channelId: string, siteId: string, boundBy: string,
): Promise<void> {
  await execute(
    `insert into surface_channels (surface, workspace_id, channel_id, site_id, bound_by, bound_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (surface, workspace_id, channel_id) do update set
       site_id = excluded.site_id, bound_by = excluded.bound_by, bound_at = now()`,
    [surface, workspaceId, channelId, siteId, boundBy],
  );
}

export async function unbindChannel(
  surface: Surface, workspaceId: string, channelId: string,
): Promise<void> {
  await execute(
    `delete from surface_channels where surface = $1 and workspace_id = $2 and channel_id = $3`,
    [surface, workspaceId, channelId],
  );
}

export interface BoundChannel {
  surface: Surface;
  workspace_id: string;
  channel_id: string;
  bound_by: string | null;
}

export async function channelsForSite(siteId: string): Promise<BoundChannel[]> {
  return query<BoundChannel>(
    `select surface, workspace_id, channel_id, bound_by
       from surface_channels where site_id = $1 order by bound_at`,
    [siteId],
  );
}

// ── Thread → session ──────────────────────────────────────────────────────────────────────────
//
// A thread IS an agent session. On surfaces without threads (WhatsApp, Telegram DM) the adapter
// passes a fixed thread id — the chat itself is the conversation.

export async function findSession(
  surface: Surface, workspaceId: string, channelId: string, threadId: string,
): Promise<string | null> {
  const row = await queryOne<{ session_id: string }>(
    `select session_id from surface_threads
      where surface = $1 and workspace_id = $2 and channel_id = $3 and thread_id = $4`,
    [surface, workspaceId, channelId, threadId],
  );
  return row?.session_id ?? null;
}

export async function attachThread(
  surface: Surface, workspaceId: string, channelId: string, threadId: string, sessionId: string,
): Promise<void> {
  await execute(
    `insert into surface_threads (surface, workspace_id, channel_id, thread_id, session_id)
     values ($1, $2, $3, $4, $5)
     on conflict (surface, workspace_id, channel_id, thread_id)
       do update set session_id = excluded.session_id`,
    [surface, workspaceId, channelId, threadId, sessionId],
  );
}

export async function findOrCreateSession(input: {
  surface: Surface;
  workspaceId: string;
  channelId: string;
  threadId: string;
  createdBy: string;
  title: string;
}): Promise<{ sessionId: string }> {
  const existing = await findSession(input.surface, input.workspaceId, input.channelId, input.threadId);
  if (existing && await getAgentSession(existing)) return { sessionId: existing };

  const site = await boundSite(input.surface, input.workspaceId, input.channelId);
  const session = await createAgentSession({
    siteId: site?.id ?? null, title: input.title.slice(0, 120), createdBy: input.createdBy,
  });
  await attachThread(input.surface, input.workspaceId, input.channelId, input.threadId, session.id);
  return { sessionId: session.id };
}
