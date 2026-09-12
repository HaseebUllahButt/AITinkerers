import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { runIndexingReport } from "@/lib/indexing/run";
import { closeIndexingBrowser } from "@/lib/indexing/fetchRendered";
import { saveRun, logDispatch } from "@/lib/indexing/persist";
import { getWebhook } from "@/lib/linkaudit/slack";

export const maxDuration = 300;

// Same auth convention as the other cron routes.
async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  const session = await auth().catch(() => null);
  return !!session;
}

// Nightly automated page-health check: scan the most important pages, persist the run, and
// post a digest to Slack — a daily heartbeat with a louder header when a money page is in a
// hard-broken (P0) state. Pass ?dry=1 to run + persist WITHOUT posting to Slack (safe test).
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";

  try {
    const report = await runIndexingReport({ limit: 25, moneyFirst: true, device: "mobile" });
    const runId = await saveRun(report, "nightly-cron");

    const p0 = report.counts.p0;
    const header =
      p0 > 0
        ? `:rotating_light: *Nightly page-health check — ${p0} urgent money-page issue${p0 === 1 ? "" : "s"}*`
        : `:sunrise: *Nightly page-health check*`;
    const text = `${header}\n${report.slackPreview}`;

    let posted = false;
    let slackError: string | undefined;
    if (!dry) {
      const webhook = await getWebhook();
      if (!webhook) {
        slackError = "no Slack webhook configured (set it on the Link Audit settings panel)";
      } else {
        const res = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(15_000),
        }).catch((e) => ({ ok: false, status: 0, _err: e?.message } as any));
        posted = (res as Response).ok;
        if (!posted) slackError = (res as any)._err ?? `Slack HTTP ${(res as Response).status}`;
        await logDispatch({
          runId,
          kind: "slack",
          title: "Nightly digest",
          status: posted ? "ok" : "error",
          error: slackError,
          dispatchedBy: "nightly-cron",
        });
      }
    }

    return NextResponse.json({
      ok: true,
      runId,
      analyzed: report.analyzed,
      jsGated: report.counts.jsGated,
      p0,
      issues: report.counts.issues,
      slackPosted: posted,
      slackError,
      dry,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "cron scan failed" }, { status: 500 });
  } finally {
    await closeIndexingBrowser().catch(() => {});
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
