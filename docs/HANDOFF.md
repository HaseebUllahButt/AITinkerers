# Handoff

Everything below is in `web/`. The app is now just the SearchOps spine: the Summit
surface it was ported from has been stripped out, and only what the audit →
connect → agent loop needs remains.

## What the app is

```text
URL in → audit → report with findings tagged by what fixing needs
  ├─ code           → connect GitHub    → (planned) agent opens real PRs
  ├─ search-console → connect Google    → (planned) sitemap resubmit
  ├─ offsite        → connect Gmail     → (planned) outreach sends
  └─ always         → connect Slack     → posts + the agent in-channel
```

The full intent lives in `docs/flow.md`; the product frame in `docs/hermes.md`
and `docs/agent-surface.md`; the original spec in `docs/seo-aeo-geo-agent.md`.

## State of the tree

- `tsc --noEmit` clean, `next build` passes.
- Pages: `/` (marketing + audit form), `/audit`, `/dashboard`.
- API: `audit`, `connections`, `status`, `auth`, `slack/{commands,events,interactions,post}`.
- DB: `lib/db/pg.ts`, schema `migrations/002_searchops.sql`
  (`sites`, `connections`, `agent_sessions`, `agent_messages`, `agent_actions`,
  `slack_identities`, `slack_channels`, `slack_threads`).
- Agent: `lib/agent.ts` — OpenAI SDK over OpenRouter, tools wrap `lib/audit`,
  writes proposals to `agent_actions`. Reachable from Slack only.
- Slack: `lib/slack/*` — verify fails closed, `/searchops` command with
  `link`/`use`/`unuse`/`where`, app_mention + DM events, confirm cards.
- Old Summit code lives in git history (and a local `ref/` copy, gitignored).

## Known gaps, in order

1. **Nothing executes.** `resolveAction` marks a proposal approved and stops —
   no PR is opened, no sitemap resubmitted, no email sent. The missing piece is
   one `executeAction(actionId)` dispatch keyed on `kind`, wired to:
   - `lib/indexing/repo.ts` (Octokit PR machinery — kept, but reads
     `GITHUB_BOT_TOKEN`/`REPO_MAP` env, not the `connections` table, and only
     writes proposal-document PRs)
   - `lib/indexing/gsc.ts` (submitSitemap — kept, needs `GSC_SA_JSON`)
   - `lib/email/smtp.ts` (kept — needs a `connections` kind for per-site SMTP)
2. **`connections.kind` has no `smtp`.** Check constraint is
   `('github','google','slack')` — the earn stage can't be stored yet.
3. **`findings.needs` has no `email` tag.** `offsite` exists; nothing maps it to
   the Gmail ask in the UI.
4. **Audit speed.** The Playwright render pass, then sequential competitor
   discovery (search loop, then per-domain verify), then `readDemand`'s
   sequential 5-prompt loop. Parallelizing those is the planned fix.
5. **Multi-engine share of voice** is pinned to one DeepSeek model for cost —
   the benchmark spec wants several engines.
6. **No scheduled re-check** on the new schema — "the schedule is what makes it
   an agent" isn't built yet.
7. Auth is open (any email, no password) — fine on localhost, must be replaced
   before any public deployment. Slack verify already fails closed.

## Testing Slack without Slack

`scripts/slack-sim.mjs` sends correctly-signed fake Slack requests at localhost.

```bash
node scripts/slack-sim.mjs badsig  "x"      # must 401 — that is the check working
node scripts/slack-sim.mjs command "hello"  # must 200
```

## Setup

```bash
docker compose up -d db          # Postgres on 5433, schema self-loads
cd web && pnpm install && pnpm dev
```

Needs in `.env.local`: `DATABASE_URL`, `OPENROUTER_API_KEY`, `EXA_API_KEY`,
`CONNECTIONS_KEY` (`openssl rand -hex 32`), `SLACK_BOT_TOKEN`,
`SLACK_SIGNING_SECRET`, `APP_URL`, `CRON_SECRET`. `GSC_SA_JSON` for the
service-account connect path. `.env.example` documents the whole surface.
