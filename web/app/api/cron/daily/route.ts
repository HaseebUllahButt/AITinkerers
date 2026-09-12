import { NextRequest, NextResponse, after } from "next/server";
import { auth } from "@auth";

export const maxDuration = 300;

// Vercel Hobby allows only 2 cron jobs, so this single daily entry fans out to every
// once-a-day task: the author-watch notifications check and the broken-link audit.
// Each target endpoint keeps its own lock/auth/chunking — this just triggers them with
// the same CRON_SECRET convention the external caller would use.
async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  const session = await auth().catch(() => null);
  return !!session;
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const base = (process.env.APP_URL || process.env.NEXTAUTH_URL || "").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET ?? "";
  if (!base) return NextResponse.json({ error: "APP_URL/NEXTAUTH_URL not set" }, { status: 500 });
  const hit = (path: string) =>
    fetch(`${base}${path}?key=${encodeURIComponent(secret)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

  // Link audit start returns fast (work continues via after()+QStash in its own function).
  const audit = await hit("/api/link-audit/run").then((r) => r.json()).catch((e) => ({ error: e?.message }));

  // Sitemap page sweep: re-syncs site_urls, then checks every sitemap URL itself (soft-404s
  // and homepage redirects the link crawl can't see). Starts fast and self-continues the same
  // way the audit does; post-response so the two starts don't queue behind each other.
  after(async () => { await hit("/api/link-audit/pages/run").catch(() => {}); });

  // JS-links detector: executes every sitemap page's scripts in jsdom (in-process, no
  // browser binary) — weekly (Sundays), because JS-injected links change with deploys, not
  // with content, and the full-execution pass is the expensive one.
  if (new Date().getUTCDay() === 0) {
    after(async () => { await hit("/api/link-audit/jslinks/run").catch(() => {}); });
  }

  // (Page Health runs post-response via after() below — see the /api/indexing/cron call there —
  // so it doesn't block this cron. Not fired here to avoid a double run.)

  // Daily ops digest email (per-person scheduled counts, template usage, site usage). Only sends
  // if the toggle in Settings is on; recipient is configurable there.
  const digest = await hit("/api/digest/daily").then((r) => r.json()).catch((e) => ({ error: e?.message }));

  // Daily email finding — dig out emails for any authors still missing one (only_new keeps it
  // to authors never searched, so it doesn't re-spend credits on the same people every day).
  const finder = await fetch(`${base}/api/enrich/run?key=${encodeURIComponent(secret)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ only_new: true }),
  }).then((r) => r.json()).catch((e) => ({ error: e?.message }));

  // Notifications check + nightly page-health scan both do their work inside the request —
  // run them post-response so this cron returns quickly; Vercel keeps the function alive for
  // after() work. The page-health scan persists a run and posts its digest to Slack itself.
  after(async () => { await hit("/api/notifications/check").catch(() => {}); });
  after(async () => { await hit("/api/indexing/cron").catch(() => {}); });
  // Backlink upkeep BEFORE autopilot, and the order matters: this writes the pitches, autopilot
  // then schedules them. Reversed, autopilot would find an empty queue every night.
  after(async () => {
    await hit("/api/backlinks/cron").catch(() => {});
    // Send autopilot: top the outreach queue up to the user's daily cap (no-op unless enabled).
    await hit("/api/emails/autopilot").catch(() => {});
  });

  return NextResponse.json({ ok: true, audit, digest, finder, notifications: "triggered", pageHealth: "triggered", internalLinks: "triggered", geo: "triggered", backlinks: "triggered", autopilot: "triggered" });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
