# SearchOps

Answer engines are answering questions about your product wrong. This finds out why, fixes it, and proves the fix landed.

## The problem

SEO work is scattered across your code, your content, your structured data, Search Console, and now a handful of LLMs that answer questions about you without ever sending a click.

Every tool stops at the same place: a list of problems. The hard part — making the change safely and showing whether it helped — is left to you.

## What it does

```text
check → explain → fix → verify → keep score
```

1. **Check.** Crawl the live site. Run deterministic checks. Ask a fixed set of questions to several models and see what they say about you.
2. **Explain.** Rank what's wrong by how much it costs you, with the evidence attached.
3. **Fix.** Produce a real change — a pull request or a content draft — grounded in facts from the site, never invented.
4. **Verify.** Re-fetch the deployed page and confirm the change is actually live.
5. **Keep score.** Store the before, the change, and the after, so the next recommendation is better than the last.

The model does the reasoning. The product is the context, the execution, the proof, and the history.

## The checks

Deterministic wherever possible. The model explains and prioritizes; it doesn't guess at facts.

- **Reachable** — status codes, redirects, robots, sitemap, canonical conflicts
- **Readable** — titles, descriptions, headings, semantic HTML, rendering without JS
- **Structured** — JSON-LD present, valid, and matching what the page actually says
- **Answerable** — a direct answer near the top, self-contained facts, headings that match real questions
- **Consistent** — names, dates, locations, and roles that agree across pages

## The answer-engine benchmark

The part traditional tools miss.

Ask the same five questions about the site to several models, on a fixed schedule, and record the answers with dates:

- Does the site get mentioned at all?
- Are the facts right?
- Which source gets cited instead?

One reply is not a trend, so the query set stays fixed and every run is dated. This turns "are we visible to AI" from a vibe into a number that moves.

## The surface

Three parts and nothing else.

```text
chat  →  one command  →  web report link
  ↑
  └── a scheduled re-check pings you when something breaks
```

- **Chat is the front door.** One command against a URL. Back comes a short scorecard, the worst issue, and a button to fix it.
- **The web page holds the proof.** Chat can't show a thirty-row evidence table, so it doesn't try. Every reply links out.
- **The schedule is what makes it an agent.** It re-checks on its own and comes to you when something regresses.

## Approvals

Anything that touches a live site or a repo needs an explicit yes.

- An approval is a saved record, not a chat message: used once, with an expiry.
- It stores the exact diff and evidence you were looking at when you decided.
- If the underlying code moved between proposal and approval, it goes invalid instead of applying a stale diff.
- Every applied change keeps a receipt: what it looked at, what it changed, what happened after.

Read-only checks need no permission. Writes always do.

## First version

One site. Reachable from chat and the web.

Ask for a check. Get the deterministic findings plus the answer-engine benchmark. Pick the top issue. Approve the fix. Watch it deploy and get verified. See the result recorded.

No multi-site, no CMS adapters, no framework coverage beyond the one in front of you.

## Keeping score

- Pages with clean indexability
- Time from finding a problem to a verified fix
- Impressions, clicks, CTR
- Mentions and citations across the fixed benchmark
- Changes with proof they reached production
- Rollback and false-positive rate

## The principle

Don't build something that talks about SEO.

Build something that reads the real site, makes a safe change, checks what actually happened, and keeps score.
