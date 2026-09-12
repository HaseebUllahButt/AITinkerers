# Slack connector

> **Status: describes an earlier architecture.** The shipped version uses `/searchops` (not `/hermes`), `sites`/`slack_channels` (not `site_projects`), and `lib/agent.ts` on Postgres (not `lib/hermes/*` + `mintSessionCookie`). See HANDOFF.md + `migrations/002_searchops.sql` for what exists; this remains the fuller intended design.

A Slack thread is a Hermes session. You ask in the thread, Hermes answers in the thread, and a
confirm card gets a real **Confirm** button that executes from Slack.

## Why a button works at all

`lib/hermes/confirm.ts` executes an action by self-calling the same route the page button hits,
forwarding the clicking user's session cookie — so every existing guard and all attribution apply
unchanged. A Slack click has no cookie.

Auth uses JWT sessions, so the connector mints one for the linked identity and the existing path runs
untouched. Nothing reimplements execution and no check is weakened.

`mintSessionCookie` is a "become any user" primitive. It only ever receives an email from
`slack_identities`, keyed by a Slack user id that arrived inside a signature-verified payload. Never
from anything a caller controls.

## Tables

```sql
create table slack_identities (
  slack_user_id text primary key,
  slack_team_id text not null,
  user_email    text not null,
  linked_by     text,
  linked_at     timestamptz not null default now()
);

create table slack_threads (
  slack_team_id text not null,
  channel_id    text not null,
  thread_ts     text not null,
  session_id    uuid not null,
  user_email    text not null,
  created_at    timestamptz not null default now(),
  primary key (slack_team_id, channel_id, thread_ts)
);
```

No row in `slack_identities` means no turn and no confirm. An unlinked Slack user is a stranger.

## Slack app setup

1. Create an app, add bot scopes: `chat:write`, `commands`.
2. Slash command `/hermes` → `https://<host>/api/slack/commands`
3. Interactivity → `https://<host>/api/slack/interactions`
4. Install, then `/invite @summit` in the channel — a bot with `chat:write` can still only post where
   it has been invited.
5. Set `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`.

## Files

| File | Job |
|---|---|
| `lib/slack/verify.ts` | HMAC signature + replay window. Fails closed. |
| `lib/slack/identity.ts` | Slack user → email, and the session mint |
| `lib/slack/threads.ts` | thread ↔ session |
| `lib/slack/blocks.ts` | Hermes events → Block Kit. The only Slack-specific rendering. |
| `lib/slack/api.ts` | `chat.postMessage` / `chat.update` |
| `app/api/slack/commands/route.ts` | `/hermes <text>`, and `use` / `unuse` / `where` |
| `lib/projects/watch.ts` | the proactive check: sample, diff, store, post on regression |
| `app/api/projects/watch/route.ts` | cron entry + manual trigger for the check |
| `app/api/slack/interactions/route.ts` | Confirm / Decline |

## Binding a channel to a project

Three words of the same `/hermes` command — no second slash command to install:

| Command | Does | Who |
|---|---|---|
| `/hermes use <slug>` | binds this channel to the project; threads here become its conversations | owner of that project |
| `/hermes unuse` | unbinds | owner of the currently bound project |
| `/hermes where` | says what the channel follows | anyone linked |

A viewer or operator gets a refusal that names their role and says to ask an owner. "No such
project" and "not a member" are the same reply, so slugs cannot be enumerated from Slack. Rows live
in `slack_channel_projects` (docs/schema-projects.md).

## The agent speaks first

`lib/projects/watch.ts` — the one path where nobody asked. Nightly (`/api/cron/daily` →
`/api/projects/watch`), every project with a bound channel gets its sitemap sampled through the
same gate the web app runs (`checkUrls`), the result stored in `site_project_checks`, and compared
with the previous run. **It posts only when something got worse.** A quiet night writes a row and
says nothing — an alert that fires every day is muted in a week.

The message: what broke, where, what it would take — and a real Confirm card (`open_pr` when the
project has a repo, `create_ticket` when Linear is configured) built from the regressed pages only.
The message's thread is a project session, so anyone on the project can reply to it, and any
operator can click Confirm.

Run one by hand:

```sh
curl -X POST "https://<host>/api/projects/watch?slug=<slug>&force=1" -H "Authorization: Bearer $CRON_SECRET"
```

`force=1` posts even when there is no earlier run to compare with — every current failure reads as
new, and the header says so. Without it the first run is a silent baseline. `dry=1` stores and
posts nothing; `limit=N` caps the sample (default 100). Without `slug` it runs every bound project
and refuses `force`.

## The 3-second rule

Slack times out a route that hasn't answered in 3 seconds and then *retries*. Both routes answer
immediately and do the work in `after()`. For a confirm, a retry would be a second execution attempt
— the guarded UPDATE in `resolveHermesAction` is the backstop.

## Before this goes on a public hostname

`auth.ts` currently accepts **any email with no password**. Anyone who can reach the URL can sign in
as anyone, on a surface that opens PRs and writes to live sites. That must be replaced before this is
publicly reachable — the Slack connector inherits whatever that door allows.
