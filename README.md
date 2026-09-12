# AITinkerers

Product specs and the interface for **Hermes** — one assistant that knows your
projects, works across your tools, and proves what it did.

## Layout

| Path    | Contents                          |
| ------- | --------------------------------- |
| `docs/` | Product specs (markdown)          |
| `web/`  | Next.js interface / marketing site |

### docs/

Read in this order — they were written as a progression:

1. `hermes.md` — current positioning. The product in one page.
2. `agent-surface.md` — the Hermes surface layer: agent core, workers, shared
   memory, adapters, job runner, approvals.
3. `seo-aeo-geo-agent.md` — SearchOps, the SEO/AEO/GEO agent. Originally the
   whole product; now the first specialist that runs inside Hermes.

### web/

Next.js 16 (Turbopack) + React 19 + Tailwind v4.

```bash
cd web
pnpm install
pnpm dev
```
