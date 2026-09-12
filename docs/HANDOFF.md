# Handoff

Everything below is in `web/`. Postgres is already running and the app already audits.

## Where things stand

**Working, pushed (commit b14b054)**
- Postgres in Docker. `docker compose up -d db`, published on **5433** (5432 was taken). Schema loads itself on first start.
- `lib/db/pg.ts` — `query` / `queryOne` / `execute`. Parameterised SQL, no ORM. A missing `DATABASE_URL` makes reads empty and writes throw.
- `migrations/002_searchops.sql` — `sites`, `connections`, `agent_sessions`, `agent_messages`, `agent_actions`, plus `slack_identities`, `slack_channels`, `slack_threads`.
- `lib/indexing/gsc.ts` — `submitSitemap`, `listSitemaps`, `deleteSitemap`, `listAccessibleSites`. Separate write-scoped client: read and write cannot share a `GoogleAuth` instance, because scopes are fixed at construction and the instance is cached, so a shared one 403s depending on which call built it first.
- The audit itself, with competitors and share of voice across four engines.

**Uncommitted, half-done**
- `lib/audit/run.ts` — a `requires` field was added to findings (`code` | `search-console` | `offsite`). This is what the connect flow keys on. Keep it.
- `lib/connections/crypto.ts` — new, for encrypting tokens before they go into `connections.secret_enc`.
- `lib/slack/*` and `app/api/slack/*` — written against the OLD architecture. **22 TypeScript errors, all in these files. Nothing else in the repo is broken.**

## Job 1 — make Slack compile

Every error is a dead import. Those modules were deleted when the repo was stripped:

| Dead import | Replace with |
|---|---|
| `@/lib/db/supabase`, `@/lib/db/queries` | `@/lib/db/pg` — plain SQL |
| `@/lib/hermes/agent`, `/confirm`, `/access` | the new agent (Job 2); stub until it exists |
| `@/lib/projects/site`, `/watch` | the `sites` table |
| `@/lib/linkaudit/slack` (`getBotToken`) | read `SLACK_BOT_TOKEN` from env |
| `@/lib/appUrl` | a two-line helper, or `process.env.APP_URL` |
| `@/lib/redis` | drop it — it only deduped Slack retries. Dedupe on `slack_threads`, or skip. |

Also two implicit-`any` errors on `catch (e)` parameters.

**Do not touch `lib/slack/verify.ts`.** It has no dead imports, and it is the only thing stopping anyone on the internet from firing commands at you. It must keep failing closed when `SLACK_SIGNING_SECRET` is unset.

## Job 2 — a small agent

Hermes is gone and should stay gone. Build a plain tool-use loop on `@anthropic-ai/sdk` (already installed). Target ~400 lines.

- Tools are thin wrappers over `lib/audit/` — run an audit, read findings, competitors, share of voice. Do not reimplement any checking.
- Persist to `agent_sessions` / `agent_messages` via `lib/db/pg.ts`. Store content blocks as jsonb, not flattened text, or tool calls vanish from the history.
- Anything that would change something **outside our own database** does not do it. It inserts an `agent_actions` row with status `proposed` and returns that. A human resolves it.
- One `resolveAction` function, so a web click and a Slack click take the same path. Record `resolved_by` and `resolved_via`.
- Emit typed events (text / tool call / proposal), never pre-formatted strings — Slack renders them, so the loop must not know about any surface.

## Job 3 — the connect flow (this is the demo)

Findings already carry `requires`. On the results page:

- `code` → "Fix this" → asks for GitHub
- `search-console` → asks for Google, offering **both**: "we do it for you" (our service account — the user adds its email in Search Console, no Google review needed) and "connect your own" (OAuth, needs Google review, slow)
- always → "get updates in Slack"

Each writes a `connections` row: `kind`, non-secret bits in `config`, token encrypted into `secret_enc` via `lib/connections/crypto.ts`.

A stub is fine for the demo. **The UI must never imply a connection exists when it does not.**

## Job 4 — outbound Slack

The one that matters on stage: a route that posts an audit result into a bound channel, triggerable by a single curl. Nobody can wait for a schedule.

`slack_channels` maps a channel to a site, so the post knows what it is about.

## Testing Slack without Slack

`scripts/slack-sim.mjs` sends correctly-signed fake Slack requests at localhost. No workspace, no tunnel.

```bash
node scripts/slack-sim.mjs badsig  "x"      # must 401 — that is the check working
node scripts/slack-sim.mjs command "hello"  # must 200
```

Run `badsig` first. If it succeeds, the endpoint is open to the internet.

## Not code — someone has to do these

1. **API keys in `.env.local`** — the audit calls Claude, ChatGPT, Perplexity, Gemini. No keys, no share of voice, and that is the best screen in the demo.
2. **Slack app** — scopes `chat:write` + `commands`, install it, then `/invite` the bot into the channel. A bot with `chat:write` can still only post where it has been invited; this WILL be the first thing that fails.
3. `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` in `.env.local`.
4. **A tunnel** (`cloudflared tunnel --url http://localhost:3000`) — only needed for Slack talking *back*. Posting updates out works without one.

## Known gaps

- No real GitHub PRs. OAuth is 30–40 minutes; the fix is shown and the button says it needs GitHub.
- Google OAuth needs Google's review for the write scope (days). The service-account path has no such gate.
- Nothing has been tested against real Slack — only the sim script.
- `migrations/001_initial.sql` is the old outreach schema. Nothing reads it.
