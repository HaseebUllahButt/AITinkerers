-- SearchOps: the small amount of state the audit itself does not need.
--
-- 001_initial.sql is the OLD outreach schema (authors, articles, contacts, links). Nothing in the
-- current code reads it. It is left in place as history; this file is what the app actually uses.
--
-- Scope, deliberately: a site, what is connected to it, and the agent's conversations and proposals.
-- Audit RESULTS are not stored here — a report is cheap to recompute and expensive to keep correct,
-- and storing one would immediately raise "whose is it, who may read it" before there are answers.

create table if not exists sites (
  id          uuid primary key default gen_random_uuid(),
  url         text not null,
  domain      text not null,
  brand       text,
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (domain)
);

-- One row per connected service per site.
--
-- `secret_enc` is encrypted at the application layer, never a plaintext token: this table is dumped
-- into logs, backups and screenshots far more casually than anyone expects. `config` holds the
-- non-secret half (repo name, property URL, channel id) so a UI can show what is connected without
-- ever touching the secret.
create table if not exists connections (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references sites(id) on delete cascade,
  kind         text not null check (kind in ('github', 'google', 'slack')),
  config       jsonb not null default '{}'::jsonb,
  secret_enc   text,
  connected_by text,
  created_at   timestamptz not null default now(),
  -- One connection of each kind per site. Reconnecting updates in place rather than silently
  -- leaving two rows where the older one still "works" until it doesn't.
  unique (site_id, kind)
);

create table if not exists agent_sessions (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid references sites(id) on delete cascade,
  title      text,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists agent_messages (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references agent_sessions(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  -- Content blocks as the model API shapes them, not a flat string: a turn carries tool calls and
  -- tool results, and flattening them to text makes the history unusable as history.
  content    jsonb not null,
  created_at timestamptz not null default now()
);

-- A proposal waiting on a human.
--
-- This is a row and not a chat message on purpose. It is single-use, it expires, it records who
-- decided and from where, and it can be answered from a different surface than the one that asked —
-- none of which a message in a channel can do.
create table if not exists agent_actions (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references agent_sessions(id) on delete cascade,
  kind        text not null,
  params      jsonb not null default '{}'::jsonb,
  summary     text not null,
  status      text not null default 'proposed'
                check (status in ('proposed', 'executed', 'declined', 'expired', 'failed')),
  proposed_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  -- Which surface the human clicked on. Worth recording: "approved in Slack at 9am" and "approved
  -- on the web at 9am" are different facts when something later goes wrong.
  resolved_via text,
  result      jsonb
);

create index if not exists idx_connections_site on connections(site_id);
create index if not exists idx_messages_session on agent_messages(session_id, created_at);
create index if not exists idx_actions_session on agent_actions(session_id, proposed_at desc);
create index if not exists idx_actions_status on agent_actions(status) where status = 'proposed';
