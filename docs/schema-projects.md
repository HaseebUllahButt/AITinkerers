# Schema: site projects and team

> **Status: planned, not migrated.** The live schema is `migrations/002_searchops.sql` — `sites` + `slack_channels`, no members/roles/`site_project_checks` yet. This doc is the intended shape when team features land.

The tables behind docs/flow.md's "Projects" and "Team" sections. Apply in the order written — the
later statements reference the earlier tables. The same statements sit as comment blocks above the
queries that read them (`lib/projects/site.ts`, `lib/slack/threads.ts`, `lib/db/queries.ts`), so a
change here is a change there too.

Not `hermes_projects`. That table is the per-person folder for filing conversations (migration 069)
and is untouched. These are prefixed `site_` so a grep for either never turns up the other.

## site_projects

A project is a site. The three connection columns are nullable on purpose and stay null until the
agent asks for them mid-conversation — nothing is requested before it is needed.

```sql
create table site_projects (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique,
  site_url      text not null,
  repo          text,                     -- "owner/name", null until GitHub is connected
  gsc_property  text,                     -- Search Console property, null until connected
  sender_email  text,                     -- outreach sender, null until connected
  write_policy  text not null default 'propose'
                check (write_policy in ('propose', 'merge', 'push')),
  created_by    text not null,
  created_at    timestamptz not null default now()
);
```

## site_project_members

Membership is on the project, and it is what the checks read. Keyed by email because that is what
`auth.ts` puts in the JWT and what `slack_identities` resolves a Slack click to — one join key for
both surfaces. Emails are lowercased on write.

```sql
create table site_project_members (
  project_id  uuid not null references site_projects(id) on delete cascade,
  user_email  text not null,
  role        text not null check (role in ('viewer', 'operator', 'owner')),
  added_by    text not null,
  added_at    timestamptz not null default now(),
  primary key (project_id, user_email)
);
```

| Role | May |
|---|---|
| viewer | read the project's sessions |
| operator | read, take turns, confirm and decline cards |
| owner | all of that, plus manage connections and the write policy |

`createSiteProject` inserts the creator as an owner immediately; `removeSiteProjectMember` refuses
to remove the last owner.

## hermes_sessions.site_project_id

The column that changes who owns a session. Set, and project membership decides access; null, and
the session is personal — only `user_email` may read, speak, or confirm, exactly as before.

`ON DELETE SET NULL`, not cascade: deleting a project returns its conversations to their creators as
personal chats rather than erasing them (the same rule `hermes_projects.project_id` follows).

```sql
alter table hermes_sessions
  add column site_project_id uuid references site_projects(id) on delete set null;
create index hermes_sessions_site_project_idx on hermes_sessions (site_project_id);
```

`hermes_sessions.project_id` (the folder) is a different column and keeps its meaning.

## slack_channel_projects

One project per channel — the primary key says so — because the binding exists so nobody types
which site they mean. A project may own many channels. Cascade: a deleted project's channels revert
to unbound, which means personal sessions.

```sql
create table slack_channel_projects (
  slack_team_id  text not null,
  channel_id     text not null,
  project_id     uuid not null references site_projects(id) on delete cascade,
  bound_by       text not null,
  bound_at       timestamptz not null default now(),
  primary key (slack_team_id, channel_id)
);
```

## site_project_checks

The proactive check's history (`lib/projects/watch.ts`). Every run is a row, quiet or not — the
table is the heartbeat, so Slack never has to be. `snapshot` is what the next run diffs against;
`regressions` and `posted` answer "why did / didn't it post" from one row.

Its own table rather than `indexing_runs` or `link_audit_runs`: both are read by pages that present
them as the one site's history, and both store a report shape this check does not produce.
`automation_runs` still gets a heartbeat row per run (scope `site-watch`) but cannot hold the
snapshot — its `workflow_id` references outreach workflows, not projects.

```sql
create table site_project_checks (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references site_projects(id) on delete cascade,
  ran_at       timestamptz not null default now(),
  ran_by       text not null,                       -- 'cron' | 'manual:<email>'
  sitemap_url  text not null,
  sitemap_ok   boolean not null,
  checked      integer not null,
  counts       jsonb not null,                      -- {pass, flag, block}
  snapshot     jsonb not null,                      -- per-url verdict + failure keys; the diff input
  gsc          jsonb,                               -- {errors, warnings}; null = not connected / unknown
  regressions  jsonb not null default '[]'::jsonb,
  posted       boolean not null default false,
  post_error   text
);
create index site_project_checks_project_idx on site_project_checks (project_id, ran_at desc);
```

What counts as worse — `diffSnapshots` is the rule, this is its summary:

| Change | Worse? |
|---|---|
| a URL's verdict moves up pass → flag → block | yes |
| a non-passing URL gains a failure key it did not have | yes |
| a URL new to the sample does not pass | yes |
| the sitemap answered last run and does not now | yes |
| Search Console sitemap **errors** rose | yes |
| Search Console warnings rose | no |
| a URL left the sitemap | no — pages get retired on purpose; the link audit files the 404 if it is still linked |
| a URL improved | no — counted, mentioned in the footer, never a reason to post |

## How access resolves

`lib/hermes/access.ts` is the one place. `canRead`, `canTurn`, `canConfirm`, `canManage` each take a
session and an email:

```text
session.site_project_id set   → site_project_members role for that email:
                                  read ≥ viewer, turn/confirm ≥ operator, manage = owner
session.site_project_id null  → email === session.user_email (manage never granted)
```

Two rules survive unchanged: a confirm needs an authenticated identity (every caller has an email
from `auth()` or `resolveSlackUser` before it asks), and `resolved_by` is always that same email —
the human who clicked, on whichever surface.
