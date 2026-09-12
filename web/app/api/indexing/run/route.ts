import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { runIndexingReport } from "@/lib/indexing/run";
import { closeIndexingBrowser } from "@/lib/indexing/fetchRendered";
import { saveRun } from "@/lib/indexing/persist";

export const maxDuration = 300;

// Same authorization convention as the link-audit routes: CRON_SECRET Bearer/?key= for
// automated callers, or a signed-in session for the page's "Run scan" button.
async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  const session = await auth().catch(() => null);
  return !!session;
}

// POST — run one indexing + CWV scan, return the report, and persist a summary to
// indexing_runs (scan history — additive table, migration scripts/032_indexing_reports.mjs).
// The scan itself makes no external side effects; live PR/ticket/Slack dispatch only ever
// happens via the separate /pr, /slack, /ticket endpoints on an explicit user click.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 40);
  const device = body.device === "desktop" ? "desktop" : "mobile";
  const template = typeof body.template === "string" && body.template.trim() ? body.template.trim() : undefined;
  const moneyFirst = body.moneyFirst === true;

  try {
    const report = await runIndexingReport({ limit, device, template, moneyFirst });
    const session = await auth().catch(() => null);
    const runId = await saveRun(report, session?.user?.email);
    return NextResponse.json({ ok: true, report, runId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "scan failed" }, { status: 500 });
  } finally {
    // Release the shared Chromium so a local dev server doesn't hold a browser between runs.
    await closeIndexingBrowser().catch(() => {});
  }
}
