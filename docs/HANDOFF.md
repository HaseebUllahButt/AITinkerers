# Handoff

Everything below is in `web/` (the app) and `services/whatsapp-bridge/` (the
WhatsApp socket process). The app is the SearchOps spine: the Summit surface it
was ported from has been stripped out, and only what the audit → connect → agent
loop needs remains.

## What the app is

```text
URL in → audit → report with findings tagged by what fixing needs
  ├─ code           → connect GitHub    → approve → real branch+commit+PR
  ├─ search-console → connect Google    → approve → sitemap resubmitted
  ├─ offsite        → connect Gmail     → approve → outreach email sends
  └─ always         → pick a surface    → posts + the agent in-channel
                     (Slack · Discord · WhatsApp · Telegram)
```

The full intent lives in `docs/flow.md`; the product frame in `docs/hermes.md`
and `docs/agent-surface.md`; the original spec in `docs/seo-aeo-geo-agent.md`.

## State of the tree

- `tsc --noEmit` clean, `next build` passes.
- Pages: `/` (marketing + audit form), `/audit`, `/dashboard` (incl. the
  Approvals panel — the web path for resolving proposals).
- API: `audit`, `actions`, `connections`, `status`, `auth`,
  `slack/{commands,events,interactions,post}`, `discord/interactions`,
  `telegram/events`, `whatsapp/events`.
- DB: `lib/db/pg.ts`. Schema: `migrations/002_searchops.sql` (core) +
  `003_surfaces.sql` (generic `surface_identities` / `surface_channels` /
  `surface_threads`; `connections.kind` now allows `smtp`). The old `slack_*`
  tables were migrated in and dropped.
- Agent: `lib/agent.ts` — OpenAI SDK over OpenRouter, tools wrap `lib/audit`,
  writes proposals to `agent_actions`. Reachable from every surface + the web.
- Executor: `lib/executor.ts` — approving a proposal now RUNS it. Kinds:
  `open_pr` (Octokit, per-site token from `connections` or `GITHUB_BOT_TOKEN`),
  `resubmit_sitemap` (GSC write scope, per-site property or `GSC_PROPERTY`),
  `send_email` (per-site SMTP creds, env `SMTP_*` fallback),
  `post_update` (every channel bound to the site, every surface).
- Surfaces: `lib/surfaces/{store,commands,text,post,notify}.ts` is the shared
  layer — identity/channel/session rows keyed by `surface`, one set of binding
  verbs (`link`/`use`/`where`/`unuse`), one audit-notify fan-out.
  - Slack (`lib/slack/*`): HMAC verify fails closed, slash command, mentions +
    DMs, confirm cards.
  - Discord (`lib/discord/*` + `app/api/discord/interactions`): Ed25519 verify
    fails closed, `/searchops` command (register with
    `scripts/discord-register.mjs`), button components resolve actions.
  - Telegram (`lib/telegram/api.ts` + `app/api/telegram/events`): webhook with
    `secret_token` check, Bot API replies.
  - WhatsApp (`services/whatsapp-bridge/` + `app/api/whatsapp/events`): a
    Baileys socket process (adapted from the Sangi bot) bridges to HTTP —
    inbound messages forward to the app with a shared secret; the app replies
    through the bridge's `/send`. Pair once via `GET /qr`; session persists in
    `creds/`.
- Old Summit code lives in git history (and a local `ref/` copy, gitignored).

## Known gaps, in order

1. **Audit speed.** The Playwright render pass, then sequential competitor
   discovery (search loop, then per-domain verify), then `readDemand`'s
   sequential 5-prompt loop. Parallelizing those is the planned fix.
2. **`open_pr` still writes proposal-document PRs** when the agent passes no
   `files` — there is no URL→source-file mapping yet, and inventing one would
   be wrong. Give the agent repo-read tools or pass files explicitly.
3. **WhatsApp/Telegram have no approve buttons** — replies name the action id
   and point at the dashboard/Slack. Real buttons (Telegram inline keyboards,
   WhatsApp interactive replies) are a follow-up.
4. **Multi-engine share of voice** is pinned to one DeepSeek model for cost —
   the benchmark spec wants several engines.
5. **No scheduled re-check** on the new schema — "the schedule is what makes it
   an agent" isn't built yet.
6. Auth is open (any email, no password) — fine on localhost, must be replaced
   before any public deployment. Every inbound surface verifies and fails
   closed (Slack HMAC, Discord Ed25519, Telegram secret token, WhatsApp shared
   secret).

## Testing surfaces without the real services

`scripts/slack-sim.mjs` sends correctly-signed fake Slack requests at localhost.

```bash
node scripts/slack-sim.mjs badsig  "x"      # must 401 — that is the check working
node scripts/slack-sim.mjs command "hello"  # must 200
```

Unset or wrong secrets on Discord/Telegram/WhatsApp return 401 by design —
hitting the routes with no env configured is itself the signature test.

## Setup

```bash
docker compose up -d db          # Postgres on 5433; run migrations/00{2,3}.sql
cd web && pnpm install && pnpm dev
# optional WhatsApp:
cd services/whatsapp-bridge && npm install && npm start   # scan GET /qr once
```

Needs in `.env.local`: `DATABASE_URL`, `OPENROUTER_API_KEY`, `EXA_API_KEY`,
`CONNECTIONS_KEY` (`openssl rand -hex 32`), `SLACK_BOT_TOKEN`,
`SLACK_SIGNING_SECRET`, `APP_URL`, `CRON_SECRET`. `GSC_SA_JSON` for the
service-account connect path (write scope needed for sitemap submit).
`DISCORD_*`, `TELEGRAM_*`, `WHATSAPP_BRIDGE_*` per surface.
`.env.example` documents the whole surface.
