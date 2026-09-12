import { NextResponse, after } from "next/server";

import { runAudit } from "@/lib/audit/run";
import { dbConfigured, execute } from "@/lib/db/pg";
import { notifySurfacesOfAudit } from "@/lib/surfaces/notify";

// The render pass drives a real browser and the market read makes five sequential model calls,
// so this is nowhere near a default serverless budget.
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let url = "";
  let competitors: string[] = [];
  try {
    const body = (await req.json()) as { url?: string; competitors?: unknown };
    url = String(body?.url ?? "");
    if (Array.isArray(body?.competitors)) {
      competitors = body.competitors.filter((c): c is string => typeof c === "string").slice(0, 6);
    }
  } catch {
    return NextResponse.json({ error: "Send a JSON body with a url." }, { status: 400 });
  }
  if (!url.trim()) return NextResponse.json({ error: "Enter a URL to audit." }, { status: 400 });

  try {
    const result = await runAudit(url, { competitors });

    // Register the site, then post to Slack — AFTER the response, not before it. The audit already
    // took minutes; making the person who ran it wait on housekeeping they are not waiting to see
    // would be paying twice. The upsert is what lets `/searchops use <domain>` find the site later:
    // without it a Slack channel can only ever bind to something that was connected by hand first.
    after(async () => {
      if (dbConfigured()) {
        await execute(
          `insert into sites (url, domain, brand) values ($1, $2, $3)
           on conflict (domain) do update set url = excluded.url, brand = excluded.brand`,
          [result.url, result.domain, result.brand],
        ).catch((e) => console.warn("[audit] could not register site:", e instanceof Error ? e.message : e));
      }
      const outcome = await notifySurfacesOfAudit(result);
      if (outcome.posted) console.log(`[notify] posted ${result.domain} audit to ${outcome.posted} channel(s)`);
      else if (outcome.errors?.length) console.warn(`[notify] could not post ${result.domain}:`, outcome.errors.join("; "));
    });

    return NextResponse.json(result);
  } catch (err) {
    // Name what failed. "Something went wrong" is not a finding.
    const message = err instanceof Error ? err.message : "The audit failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
