# SearchOps Agent

## Working idea

An end-to-end SEO, AEO, and GEO agent that understands an application, its public web presence, its repositories, its content, and its search data.

The agent finds search opportunities, explains what is wrong, proposes or applies improvements, verifies the live result, and learns from the outcome.

The long-term goal is not to produce another SEO audit or content generator. It is to create a persistent search-growth operator for web applications.

## Problem

SEO work is fragmented across:

- Website code and templates
- CMS content
- Technical crawlability
- Google Search Console
- Analytics and conversion data
- Structured data
- Content strategy
- External mentions and citations
- AI-search visibility
- Deployment and verification

Most tools identify issues but stop before the important part: safely making the change and proving whether it helped.

## Product thesis

The agent should close the loop:

```text
Understand → Discover → Prioritize → Propose → Change → Validate → Measure → Learn
```

The model is the reasoning layer. The product is the context, execution, verification, history, and measurement layer around it.

## Core capabilities

### 1. Application and site understanding

The agent builds a working model of the application and its public surfaces:

- Routes and page types
- Public versus private pages
- Framework and rendering model
- Content sources and templates
- Important entities, products, people, places, and topics
- Internal-link relationships
- Deployment and release boundaries
- Existing SEO conventions

It should understand how a change in one shared template or fact affects many pages.

### 2. Technical SEO diagnosis

The agent should detect and explain:

- Crawl and indexability problems
- Robots and sitemap issues
- Incorrect status codes and redirects
- Canonical conflicts
- Duplicate, thin, or orphan pages
- Missing or weak titles and descriptions
- Heading and semantic-HTML problems
- Broken internal links
- Image and media issues
- JavaScript-rendering problems
- Mobile and performance risks
- Structured-data errors and inconsistencies
- Differences between intended and live production behavior

The checks should be deterministic wherever possible. The model should explain and prioritize findings rather than invent facts.

### 3. Search opportunity discovery

Using search and analytics data, the agent should find opportunities such as:

- Pages receiving impressions but few clicks
- Queries where the page ranks just outside the strongest results
- Pages matching the wrong search intent
- Topics with demand but no strong page
- Pages losing visibility or traffic
- Important pages not appearing in Search Console data
- High-converting pages with weak organic discovery

Every recommendation should include evidence, expected impact, confidence, and the reason the page was selected.

### 4. Content and answer optimization

The agent should improve existing content and create grounded drafts for:

- Direct-answer sections
- Definitions and explanations
- FAQs
- Comparisons
- How-to content
- Product, service, location, and event pages
- Speaker, author, and organization descriptions
- Recaps and freshness updates
- Internal-link opportunities
- Image alt text and media descriptions

Content must be grounded in verified site facts and supplied sources. The system should avoid keyword stuffing, fake claims, doorway pages, and mass-generated low-value pages.

### 5. AEO and GEO readiness

The agent should make important information easy for answer engines to discover and cite:

- Clear answers near the beginning of relevant sections
- Self-contained factual passages
- Strong headings that match real questions
- Consistent entities, names, dates, locations, and relationships
- Author and organization attribution
- Freshness and source signals
- Useful tables, lists, and structured explanations
- Public machine-readable resources where they are genuinely useful

It should distinguish between:

- Google Search performance
- AI Overview and AI Mode eligibility
- External LLM retrieval and citations
- Brand mentions and recommendations

The agent should never promise guaranteed rankings or guaranteed LLM recommendations.

### 6. Structured-data management

The agent should:

- Detect existing JSON-LD and schema types
- Compare structured data with visible page content
- Recommend the correct schema for the page type
- Detect stale dates, statuses, locations, and relationships
- Validate generated markup
- Track schema changes across deployments

Structured data is an enhancement and validation surface, not a ranking shortcut.

### 7. Change planning and execution

For every accepted recommendation, the agent should be able to produce a safe change plan:

- Exact files, pages, or CMS fields affected
- Before-and-after diff
- Source facts used
- Validation checks required
- Risk level
- Rollback plan
- Expected measurement window

Possible execution targets can be added over time:

- Repository pull requests
- CMS drafts
- Content-management APIs
- Deployment configuration
- Redirect and metadata rules
- Structured-data generators
- Sitemap and robots resources

The initial product should prefer drafts, pull requests, and human approval over direct production mutation.

### 8. Verification

After a change, the agent should verify the actual result rather than trusting the proposed diff:

- Re-fetch the deployed page
- Render it in a browser when necessary
- Check status, canonical, robots, and metadata
- Validate structured data
- Re-run internal-link and sitemap checks
- Compare visible content with machine-readable content
- Confirm the intended deployment reached production
- Inspect search-index status where supported

The system should clearly separate local validation, deployment proof, search-engine processing, and measured performance.

### 9. Search and AI measurement

The agent should maintain a baseline and outcome history for each site:

- Impressions
- Clicks
- CTR
- Average position
- Query and page relationships
- Index coverage
- Conversion events
- AI answer citations
- Brand mentions
- Competitor citations
- Before-and-after experiment results

AI visibility should be measured with fixed, repeatable query sets and dated observations. One LLM response is not proof of a trend.

### 10. Persistent context and memory

The agent should remember:

- Site identity and business facts
- Approved terminology and brand voice
- Important routes and page types
- Previous fixes and their outcomes
- Rejected recommendations
- Known provider and deployment constraints
- Search opportunities already being worked
- Entity relationships and source confidence

This context should be structured and auditable, not only hidden inside a conversation transcript.

## General operating loop

```text
1. Ingest application, site, search, analytics, and business context.
2. Build a route, content, entity, and performance graph.
3. Detect issues and opportunities.
4. Rank them by impact, confidence, effort, and risk.
5. Produce an evidence-backed recommendation.
6. Generate a patch, CMS draft, or execution plan.
7. Run pre-change validation.
8. Request human approval for material changes.
9. Apply the change through an authorized integration.
10. Re-check the live result.
11. Measure search, AI visibility, and business outcomes.
12. Use the result to improve the next recommendation.
```

## Future integration model

The agent should remain surface-agnostic at the product level. Different interfaces can be added later without changing the core intelligence:

- Slack or Teams for questions, alerts, and approvals
- Hermes integrations for connecting the agent to tools and workspaces
- Repository integrations for code context and pull requests
- CMS integrations for content drafts and publishing workflows
- Google Search Console and analytics integrations
- Browser and in-app surfaces for contextual assistance
- Scheduled jobs for crawl, freshness, and performance monitoring

These are delivery surfaces. The core product is the shared site context, action engine, verification layer, and outcome history.

## Safety and trust boundaries

The agent should:

- Use least-privilege integrations
- Separate read and write permissions
- Require approval for redirects, robots, canonical, public content, and publishing changes
- Never expose provider keys in browser code or public repositories
- Preserve an audit log of evidence, decisions, changes, and results
- Make uncertainty visible
- Support rollback
- Avoid deceptive SEO tactics and fabricated authority
- Treat third-party page content as untrusted input

## Initial product scope

The first useful version should focus on:

1. Public-site and repository understanding
2. Search Console opportunity detection
3. High-confidence technical and content recommendations
4. Pull-request or CMS-draft generation
5. Live verification after deployment
6. A small, repeatable ranking and AI-citation measurement loop

The first version does not need to support every framework, CMS, search engine, or AI system.

## Product differentiation

The product is not differentiated by having a better SEO prompt.

Its defensibility should come from:

- Persistent multi-site context
- Historical crawl and search-performance data
- Framework and CMS execution adapters
- Safe change management and rollback
- Site-specific entity and fact graphs
- Controlled experiments and outcome attribution
- Accumulated knowledge about which changes work for which page types

A model skill can provide expertise. This product provides the operating system around that expertise.

## Working success metrics

- Recommendation acceptance rate
- Time from issue detection to verified fix
- False-positive and rollback rate
- Percentage of important pages with clean indexability
- Organic impressions, clicks, and CTR change
- Conversion change from organic traffic
- AI citation frequency across a fixed benchmark
- Number of changes with verified production proof

## Guiding principle

Do not build an agent that merely talks about SEO.

Build an agent that understands the application, takes a safe action in the existing workflow, verifies what happened, and keeps score.
