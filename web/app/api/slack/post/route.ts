import { NextRequest, NextResponse } from "next/server";

import { runAudit } from "@/lib/audit/run";
import { identifyCaller } from "@/lib/auth/service";
import { query, queryOne } from "@/lib/db/pg";
import { internalUrl, publicUrl } from "@/lib/appUrl";
import { postMessage } from "@/lib/slack/api";
import { renderAuditPost } from "@/lib/slack/blocks";

// Stage trigger:
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

  const channels = await query<{ channel_id: string }>(
    `select channel_id from slack_channels where site_id = $1 order by bound_at`, [site.id],
  );
  if (!channels.length) {
    return NextResponse.json({ error: "No Slack channel is bound to this site." }, { status: 409 });
  }

  try {
    const result = await runAudit(site.url, { competitors: body.competitors ?? [] });
    const blocks = renderAuditPost(result, publicUrl() ?? internalUrl());
    const posts = await Promise.all(channels.map((channel) =>
      postMessage(channel.channel_id, `${result.brand} audit: ${result.score}/100`, blocks),
    ));
    const failed = posts.filter((post) => !post.ok);
    if (failed.length) {
      return NextResponse.json({
        error: "Slack rejected one or more posts.",
        posted: posts.length - failed.length,
        failed: failed.map((post) => post.error ?? "unknown"),
      }, { status: 502 });
    }
    return NextResponse.json({ ok: true, site: site.domain, score: result.score, posted: posts.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Audit or Slack post failed." },
      { status: 500 },
    );
  }
}
