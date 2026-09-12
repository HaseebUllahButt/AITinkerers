# Stack

> **Status: superseded.** The built stack is Next.js + local Postgres + OpenRouter + Exa + Slack. This doc describes the earlier Discord/Trigger.dev/CopilotKit plan — kept for the reasoning, not the vendor list. See HANDOFF.md for what exists.

What we're using and the exact job each thing does. If something here has no job, we drop it.

| Tool | Job |
|---|---|
| OpenRouter | ask the same benchmark questions to several models through one key |
| OpenAI | reasoning, and one voice in the benchmark |
| Exa | retrieval check — who gets cited instead of us |
| Trigger.dev | durable jobs, approval waits, scheduled re-checks |
| CopilotKit | interactive web report (optional) |
| Auth0 | a real name on the approval record (if time) |
| Cloud Run | hosting, and a public URL for webhooks |

## Trigger.dev

Load-bearing. It runs the loop.

**1. Ack fast, work slow.** Discord fails any command that doesn't answer in 3 seconds. Our check takes about 60.

```ts
// discord handler
await ack(interaction)              // defer immediately
await checkSite.trigger({ url, channelId, messageId })
```

The task edits the Discord message when it's done.

**2. Pause for approval.** Wait tokens let a task stop and resume later without us building a state machine:

```ts
const token = await wait.createToken({ timeout: "24h" })
await postApprovalCard(channelId, token.id, diff)
const result = await wait.forToken(token)   // task sleeps here
if (result.ok && result.output.approved) await openPR(diff)
```

Discord and the web page both just complete the same token. That's cross-surface approval with no extra plumbing.

**3. Scheduled re-check.** Cron task: re-run checks on saved sites, compare against the last result, post to Discord **only if something got worse**. This is what makes it an agent instead of a command.

**4. Benchmark fan-out.** 5 questions across 3 models is 15 calls that will flake. Batch them, let retries handle it.

**5. Post-deploy verify.** Deploy webhook → verify task → re-fetch the page → confirm the change is live → post the receipt.

Realtime also gives us live job status on the web page without writing websockets.

## CopilotKit

Optional. Only worth it if the web report is more than a static table.

**Ask about findings** — the page already holds the results, so expose them:

```tsx
useCopilotReadable({ description: "SEO findings", value: findings })
```

"What's the highest-impact fix?" gets answered from state, no re-run.

**Approvals as generative UI** — an action can render a real component:

```tsx
useCopilotAction({
  name: "showPendingFix",
  render: ({ args }) => <DiffCard fix={args.fix} onApprove={completeToken} />
})
```

"Show me the pending fix" renders the actual diff with working buttons. Second approval surface, and it demos well.

## Two numbers, not one

Worth building in from the start:

- Asking a model directly tests whether it **knows** us — training data.
- Exa retrieval tests whether it can **find** us when it searches.

Different failures, different fixes. Most tools collapse these into one "AI visibility score." We shouldn't.

## Not using

**Blacksmith** — faster CI runners. Slow CI isn't our problem and it's zero demo value. What we actually want is a **deploy webhook** to trigger verification, which is an endpoint, not a vendor.

## How it fits

Trigger.dev runs and pauses the work. Discord is how it reaches you. CopilotKit is how you talk to it on the web.

One job, three places, one approval token.
