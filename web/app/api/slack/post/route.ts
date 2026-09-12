import { NextRequest, NextResponse } from "next/server";

import { runAudit } from "@/lib/audit/run";
import { identifyCaller } from "@/lib/auth/service";
import { queryOne } from "@/lib/db/pg";
import { channelsForSite } from "@/lib/surfaces/store";
import { notifySurfacesOfAudit } from "@/lib/surfaces/notify";

// Stage trigger — re-runs an audit and posts it to every bound channel on every surface:
// curl -X POST http://localhost:3000/api/slack/post \
//   -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
//   -d '{"domain":"example.com"}'
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!await identifyCaller(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { siteId?: string; domain?: string; competitors?: string[] };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: "Send siteId or domain as JSON." }, { status: 400 }); }

  const site = await queryOne<{ id: string; url: string; domain: string }>(
    `select id, url, domain from sites
      where ($1::uuid is not null and id = $1::uuid)
         or ($2::text is not null and domain = $2::text)
      limit 1`,
    [body.siteId || null, body.domain?.replace(/^www\./, "").toLowerCase() || null],
  ).catch(() => null);
  if (!site) return NextResponse.json({ error: "Site not found." }, { status: 404 });

  const channels = await channelsForSite(site.id);
  if (!channels.length) {
    return NextResponse.json({ error: "No channel is bound to this site on any surface." }, { status: 409 });
  }

  try {
    const result = await runAudit(site.url, { competitors: body.competitors ?? [] });
    const outcome = await notifySurfacesOfAudit(result);
    if (outcome.errors?.length) {
      return NextResponse.json({
        error: "One or more surfaces rejected the post.",
        posted: outcome.posted,
        failed: outcome.errors,
      }, { status: 502 });
    }
    return NextResponse.json({ ok: true, site: site.domain, score: result.score, posted: outcome.posted });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Audit or post failed." },
      { status: 500 },
    );
  }
}
