-- 003_surfaces.sql — one binding model for every place the agent can be reached.
--
-- 002 built slack_identities / slack_channels / slack_threads keyed by Slack's own ids. Discord,
-- WhatsApp and Telegram have the same three shapes — a workspace, a channel/chat, a thread — under
-- different names, so the tables generalise instead of multiplying. `surface` is the discriminator;
-- `workspace_id` holds whatever the surface calls a tenant (Slack team id, Discord guild id, the
-- WhatsApp account's own number, the Telegram chat's group id).
--
-- Existing Slack rows are copied across before the old tables are dropped.

create table if not exists surface_identities (
  surface          text not null,
  workspace_id     text not null,
  external_user_id text not null,
  user_email       text,
  linked_by        text,
  linked_at        timestamptz not null default now(),
  primary key (surface, workspace_id, external_user_id)
);

create table if not exists surface_channels (
  surface      text not null,
  workspace_id text not null,
  channel_id   text not null,
  site_id      uuid not null references sites(id) on delete cascade,
  bound_by     text,
  bound_at     timestamptz not null default now(),
  -- One site per channel, same rule as before: the binding exists so nobody has to type which
  -- site they mean, and a channel that could mean two sites would put the question back.
  primary key (surface, workspace_id, channel_id)
);

create table if not exists surface_threads (
  surface      text not null,
  workspace_id text not null,
  channel_id   text not null,
  thread_id    text not null,
  session_id   uuid not null references agent_sessions(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (surface, workspace_id, channel_id, thread_id)
);

create index if not exists idx_surface_channels_site on surface_channels(site_id);
create index if not exists idx_surface_threads_session on surface_threads(session_id);

insert into surface_identities (surface, workspace_id, external_user_id, user_email, linked_by, linked_at)
  select 'slack', slack_team_id, slack_user_id, user_email, linked_by, linked_at
    from slack_identities
  on conflict do nothing;

insert into surface_channels (surface, workspace_id, channel_id, site_id, bound_by, bound_at)
  select 'slack', slack_team_id, channel_id, site_id, bound_by, bound_at
    from slack_channels
  on conflict do nothing;

insert into surface_threads (surface, workspace_id, channel_id, thread_id, session_id, created_at)
  select 'slack', slack_team_id, channel_id, thread_ts, session_id, created_at
    from slack_threads
  on conflict do nothing;

drop table if exists slack_threads;
drop table if exists slack_channels;
drop table if exists slack_identities;

-- smtp joins the staged kinds: Gmail app-password creds for the outreach path.
alter table connections drop constraint if exists connections_kind_check;
alter table connections
  add constraint connections_kind_check check (kind in ('github', 'google', 'slack', 'smtp'));
