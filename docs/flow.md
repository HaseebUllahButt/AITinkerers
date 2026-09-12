# The flow

One rule underneath all of it: **nothing is asked for before it is needed, and every request is made
by the agent at the moment it is blocked.** Connections are not a settings page you visit up front.
They are the agent saying "I can fix this, but I need the repo" — and a button, in the conversation,
wherever that conversation is happening.

## Stages

```text
1. Audit        paste a URL          no account, no connection
2. Fix          connect GitHub       PR / merge / push, per project policy
3. Publish      connect Search Console   sitemap resubmit, index status
4. Earn         connect Gmail        outreach and negotiation for citations
5. Operate      Slack                the same agent, in the channel
```

Each stage is unlocked by the stage before it producing something the user wants acted on. Nobody is
shown four Connect buttons and asked to trust an empty page.

### 1. Audit — no auth

Landing page, one box, a URL. Deterministic checks plus the answer-engine read. Findings ranked, with
evidence. This is the whole product's honesty test: it has to be useful before it asks for anything.

Findings are tagged by what fixing them would require — `code`, `search-console`, `outreach`, or
`nothing`. That tag is what drives every request that follows.

### 2. Fix — connect GitHub

The first `code` finding the user wants fixed triggers the request. GitHub App install, one repo,
`contents` + `pull_requests`.

At connect time, and only once, the project picks its write policy:

| Policy | What the agent does |
|---|---|
| **Propose** | Opens a PR. Never merges. Default. |
| **Merge** | Opens a PR, merges when required checks pass — for promoted change classes only. |
| **Push** | Commits to main directly. Single-page, low blast-radius classes only. |

Blast radius overrides policy at every level: a change touching a shared template is always a PR with
a human on it, even on Push. And nothing auto-merges unless it can auto-revert.

### 3. Publish — connect Search Console

After a fix deploys and verifies, the agent proposes the follow-through: bump `lastmod`, resubmit the
sitemap, watch index status. That proposal is what asks for Google.

Google has no API to force a reindex — URL Inspection is read-only and the Indexing API officially
covers only job postings and broadcast events. So the agent resubmits and then reports what Google
actually did. It never claims to have made indexing happen.

### 4. Earn — connect Gmail

When the finding is "answer engines cite four sources and we are in none of them", the fix is not in
the repo. It is getting into those sources.

Connecting a sender is what unlocks the existing outreach machine: discovery, drafting, negotiation,
follow-ups, suppression. Gmail SMTP first (app password, encrypted at rest), Outlook and the rest
after — the sender is an interface, not a hardcoded provider.

The existing rule holds and does not soften: **the agent drafts, a human authorizes.** Every send is
a human click or a policy a human confirmed, with a daily cap and a trust floor.

### 5. Operate — Slack

The same agent, same sessions, same confirm cards. A channel is bound to a project, so nobody types
which site they mean. Mention it in a thread and the thread is the conversation.

## Connections are confirm cards

Every request above uses the machinery that already exists. A `connect_github` / `connect_gsc` /
`connect_sender` card is proposed by the agent exactly like `open_pr` or `send_emails`, and renders
as a button in the web app and in Slack without either surface learning anything new.

That is the whole reason the flow works in two places at once.

## Projects

A project is **a site**: url, repo, Search Console property, sender, write policy, connections.

This is not `HermesProject`, which is a per-user folder for filing conversations. Same word, different
object — keep them apart.

Every connection, credential, finding and run belongs to a project. That is also the boundary for cost
caps, rate limits and blast radius.

## Team

Membership is on the project, and it is what the checks read.

The change that makes this real: **a session is owned by its project, not by the person who started
it.** Today every check is `session.user_email !== email`, so the moment a second person replies in a
Slack thread their turn is rejected as "not yours". Channel-originated sessions belong to the project;
membership decides who can read, take a turn, and confirm.

Two rules survive that change unchanged:

- A confirm still requires a linked identity. A stranger in a channel authorizes nothing.
- `resolved_by` still records the actual human who clicked, on whichever surface they clicked.

Roles: **viewer** reads, **operator** takes turns and confirms, **owner** manages connections and
write policy.
