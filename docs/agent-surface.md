# Hermes Surface Layer

Goes with `seo-aeo-geo-agent.md`. That file says what the agent does. This one says where you talk to Hermes from.

This is an architecture document for Hermes, not the product pitch. Hermes is the shared operating layer. SEO, AEO, GEO, coding, research, analytics, and operations are specialist capabilities that run through it.

## The idea

One assistant, one project brain, many places to reach it.

You should be able to use it from a terminal, a browser, Slack, Discord, email, a scheduled job, a webhook, or an actual computer worker, and get the same assistant every time. Same projects, same history, same work in progress, same permissions, and the same outcome record.

This layer is just wiring. Keep it thin and dull and the same for every channel, so adding a new place to reach Hermes takes a day, not a month.

## What Hermes is and is not

Hermes is not:

- A generic chat window
- A replacement for T3 Code or another coding-agent control surface
- A collection of disconnected chatbots
- A vector database containing every message ever written
- An unrestricted computer operator

Hermes is:

- Persistent project context
- Specialist capabilities selected for the task
- Cross-tool execution
- Durable jobs that can pause and resume
- Explicit approvals and permissions
- Evidence, receipts, and outcome history

The model provides reasoning. Hermes provides context, tools, execution, memory, trust boundaries, and proof that work happened.

## What "everywhere" really means

The obvious version is a chat box in more apps. That's the smaller half.

The useful half runs the other way:

- The agent starts working without being asked, because a deploy went out or a crawl finished.
- It finds you wherever you happen to be.
- It stops, waits for a yes or no, and picks up days later knowing exactly where it was.
- You can answer from a different place than the one that asked.

Chatting to it is a nice-to-have. Reaching out to you, and being able to pause and resume, is the actual point.

## How it fits together

```text
      Slack    Discord    CLI    Web    Email    Cron / Webhook
        |         |         |      |       |            |
        +---------+---------+------+-------+------------+
                              |
                          Adapters
                 (clean up messages in, format out)
                              |
                       Shared memory
            (sessions, people, workspaces, approvals, log)
                              |
                         Job runner
                (queue, progress, pausing, resuming)
                              |
                        Agent core
             (tools, site map, memory, past results)
```

The core knows nothing about Slack or Discord. It takes an event and sends back blocks. Anything channel-specific lives in an adapter.

### 1. Agent core

No interface of its own. Owns the tools, the map of your sites and projects, the memory, and the record of what worked, as described in the other doc.

You hand it some context, it streams back blocks. It never formats output for a specific channel and never calls a channel's API itself.

The core routes work to specialist capabilities instead of pretending one giant prompt knows every domain:

- SEO/AEO/GEO
- Repository and code
- Browser and research
- Analytics and Search Console
- Deployment and infrastructure
- Documentation and content

Specialists return typed findings, plans, diffs, evidence, and approval requests. They are replaceable workers behind Hermes, not separate user-facing products.

### 1a. Computer and VM workers

Hermes may run work inside an isolated VM with access to a real browser, filesystem, terminal, and approved applications. The VM is a worker, not an unrestricted always-on identity.

It can support:

- Browser navigation and form interaction
- Repository inspection and local commands
- Screenshots, DOM/accessibility inspection, and logs
- Preview deployment checks
- Provider tools that do not have a usable API

Every computer action is scoped to a project and permission grant. External messages, publishing, deletion, purchases, credential changes, and deployments require explicit approval.

### 2. Shared memory

This is the part that makes it feel like one agent instead of five.

What it stores:

- **Workspace** — the top box. Holds projects, connections, memory, and history.
- **Project** — repo, live site, deploy target, environment, search property.
- **Person** — you, matched up across channels. Your Slack account, Discord account, terminal key, and web login are all the same person.
- **Session** — one ongoing conversation, tied to a thread and a person.
- **Approval** — a decision waiting to be made. A real record, not just a chat message.
- **Log** — who asked, what ran, what proof it used, what changed, how it turned out.

Do not treat memory as a dump of every conversation. Durable memory should be structured and source-backed:

- Facts
- Decisions
- Open tasks
- Project relationships
- Approved terminology and preferences
- Permission boundaries
- Past actions and their results
- Evidence sources, timestamps, and confidence

Rules:

- A thread is a session. A new thread starts a new session but keeps the same workspace memory.
- Work out who someone is once, at the edge. The core only ever sees a person.
- Build the context fresh each turn from the session, the project list, and the workspace memory. Don't just rely on whatever happens to be in the chat log.
- Every memory has a workspace/project scope, source, timestamp, and retention policy. Similar facts from different repositories or sites must never be silently mixed.

### 3. Adapters

Each one does three things and nothing else:

1. Turn an incoming message, command, or event into one standard shape.
2. Turn outgoing blocks into whatever that channel understands.
3. Match a channel account to a person, and a channel to a trust level.

That's it. No prompts, no tool logic, no rules about the work. If an adapter starts making decisions, that decision belongs in the core.

### 4. Blocks, not markdown

The core sends back typed pieces:

- `text`
- `progress` — updated in place as work moves along
- `evidence` — rows with source and confidence
- `diff` — before and after
- `approval_request`
- `link` — a link into the web app
- `error`

Each adapter shows these as well as its channel can, and says plainly when it can't. Slack gets Block Kit, Discord gets embeds, the terminal gets plain text, email gets a digest.

This one choice is what keeps the whole layer cheap. Skip it and every new channel means redoing all the formatting, and the channels slowly end up able to show different things.

### 5. Job runner

Every request becomes a job, because the real work takes minutes or days and no chat app will sit there waiting.

```text
take it in → say you got it → run → (pause for approval) → resume → report
```

What it needs:

- Reply within a second, every time, before starting any work.
- Show progress by editing the message you already sent, not posting new ones.
- Pause on an approval and wait as long as it takes, using nothing while it waits.
- Resume from an answer that might come from anywhere.
- Ignore repeats. Every chat platform sends things twice sometimes.
- Survive a restart. A crash must not lose paused work.

### 6. Reaching out

The agent starting the conversation, with per-workspace rules for:

- Which events are worth telling you about at all
- Which channel each kind goes to
- What gets saved up into a digest and what goes out now
- Quiet hours and limits

This is how the nightly crawl, the freshness check, the failed post-deploy check, and the weekly numbers reach you.

## The cross-tool work loop

```text
Message or event arrives
→ resolve person, workspace, project, and permissions
→ assemble structured context
→ select specialist capabilities
→ run tools or a computer worker
→ produce evidence and a proposed action
→ pause for approval when needed
→ execute the change
→ verify the live result
→ store the outcome
→ notify the person on the available surface
```

Example:

```text
Slack: “Prepare the SEO fix for the Islamabad event site.”
→ find the correct project and repositories
→ SEO specialist reads Search Console and the live site
→ repository specialist prepares a patch
→ worker checks the preview
→ Hermes opens an approval
→ user approves from mobile or web
→ deployment is verified
→ Slack receives the evidence and result
```

The point is not that Hermes can answer in Slack. The point is that work can begin in Slack, continue in a VM, pause for a decision, resume from another surface, and leave behind a trustworthy receipt.

## One main place

One surface is home: a web app with your projects, findings and the proof behind them, pending approvals, change history, and the scorecard.

Every chat channel is a remote control for it, and every chat reply links back into it.

That settles the fight between reach and detail. Chat can't show a crawl diff or a thirty-row table of evidence, and forcing it to makes the output bad everywhere. So don't. Chat carries the short version, the decision, and the link. The web app carries the proof.

## Approvals

Approvals matter most here, because that's where a change to a live site gets the go-ahead.

- Saved records. Each one used once, with an expiry.
- Answerable from any channel by anyone with permission.
- Store who decided, from where, when, and the exact diff and proof they were looking at.
- A change suggested by a job at 2am can be approved from your phone at 9am and applied right after.

Never treat a casual reply as approval. It has to be an actual yes against the approval record.

## Trust and computer access

Computer access is useful only if it is safer and more reliable than asking a model to improvise in a terminal or browser.

Requirements:

- Per-workspace and per-project isolation
- Brokered credentials instead of raw secrets in prompts or extensions
- Domain, command, and application allowlists
- Human approval for consequential external actions
- Screenshots, tool calls, logs, and receipts for meaningful actions
- Timeouts, cancellation, and a kill switch
- Ephemeral workers or clean snapshots where possible
- No automatic sharing of private repository or workspace content across projects

“Remember everything” is not the requirement. The requirement is selective, source-backed memory that helps Hermes finish work without leaking context.

## Who can do what

Channels don't all deserve the same trust, and the gap is not a detail.

- A DM from the workspace owner: high trust.
- A message in a private team channel: medium.
- A message in a public Discord channel: low, possibly from strangers.
- Text the agent pulled off someone else's web page: not trusted at all, and never an instruction.

So permissions hang on the combination of person, workspace, and how much the channel is trusted, not on the person alone. Read-only questions are fine in low-trust places. Anything that writes to a repo, a CMS, or a live site needs a high-trust channel and a real approval.

Get this in before the first write connection ships. Add it later and your history can't tell you who approved a change to a live site.

## Working with other people

Later, but two things have to be right now, because they're painful to add afterwards:

1. Record every action against a person, from the first commit, even while it's only you.
2. Make workspace a real boundary in the data, not a column you bolt on later.

With those, multi-user is mostly permissions and routing. Without them, it's rebuilding the entire history.

## Where the moat can come from

Integrations, Slack access, VM control, and specialist prompts are individually copyable. The defensible combination is:

- High-quality project and entity context
- Reliable cross-tool execution
- Permission and approval history
- Durable jobs that survive interruptions
- Evidence receipts for every action
- Outcome history showing what actually worked
- Specialized workflows built on accumulated results

For example, an SEO specialist should not only propose a title. Hermes should remember which page type, change pattern, and search opportunity produced which result for that site.

The moat is context quality plus execution reliability plus outcome data—not the number of integrations.

## First product wedge

Do not launch as “an AI assistant for everything.” Start with project operations for builders working across repositories, websites, deployments, search data, and team channels.

The first useful workflow could be:

```text
Ask in Slack or CLI
→ resolve project context
→ inspect repository and live app
→ select a specialist
→ create a change or report
→ validate it in a worker
→ request approval
→ execute and verify
→ report the outcome
```

SEO/AEO/GEO is one strong specialist capability inside Hermes, not the entire identity of Hermes. Additional specialists can be added without changing the surface architecture.

Hermes should own the operating layer. The specialist workflow should own the domain value.

## What Hermes must not become

- A weaker T3-style coding-agent GUI
- A broad assistant that claims to know every project without scoped memory
- A pile of integrations with no durable workflow state
- A black-box autonomous worker with no approval or audit trail
- A dashboard that reports problems but cannot safely finish the work

## Order to build in

1. **Core plus terminal.** Quickest loop. Proves context resolution, specialist routing, tools, and receipts.
2. **Structured memory and project isolation.** Proves that the same assistant can safely work across repositories and sites.
3. **One computer/VM worker.** Proves browser and terminal execution with approvals and receipts.
4. **Web app.** Home. Projects, proof, approvals, history, numbers.
5. **Job runner and outbound.** Scheduled crawl, parked approvals, and a weekly digest.
6. **Slack.** Questions, alerts, and approvals. First serious test of blocks and identity mapping.
7. **Discord, email, browser, and in-app.** Add only after the core contracts are stable.

After the core is stable, each new channel should take days. If one doesn't, the fix goes in the blocks, shared memory, session spine, or permission model—not another pile of channel-specific logic.

## The point

This layer should be the most boring code in the product.

Its whole job: let you reach the agent from anywhere, keep one continuous memory across those places, and make permission clear and recorded. Everything that makes the agent good sits behind it.
