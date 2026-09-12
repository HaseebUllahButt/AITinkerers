import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import PQueue from "p-queue";
import { supabaseAdmin } from "@/lib/db/supabase";
import { checkLink, HARD_BROKEN_REASONS, type FingerprintMap } from "@/lib/linkaudit/run";

export const maxDuration = 300;

// POST — re-check a run's still-open broken links against the LIVE site, right now.
//
// This is the "live re-verification" loop the SEO roadmap calls a core capability: a finding
// is closed because the target was just probed and answered, not because a report went quiet.
// Now-working links get resolved_at stamped across every run that recorded them (the fact
// "this URL works" is not scoped to one crawl); still-broken links get last_checked_at so the
// UI can say "still broken as of this morning" instead of "as of the last crawl".
//
// Body: { run_id? (defaults to latest completed), link? (re-check just one URL) }.

const MAX_LINKS_PER_CALL = 300; // bounded by maxDuration; a full daily run re-checks the rest anyway

// Same authorization convention as /run: cron secret or a signed-in session.
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
  const body = await req.json().catch(() => ({})) as { run_id?: string; link?: string };

  let runId = typeof body.run_id === "string" ? body.run_id : null;
  if (!runId) {
    const { data, error } = await supabaseAdmin
      .from("link_audit_runs").select("id").eq("status", "completed")
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    // A failed read must not report "nothing to re-verify" — that reads as "all fixed".
    if (error) return NextResponse.json({ error: `Could not read the audit runs (${error.message}).` }, { status: 503 });
    runId = data?.id ?? null;
  }
  if (!runId) return NextResponse.json({ error: "No completed run to re-verify." }, { status: 404 });

  const { data: rows, error: rowsError } = await supabaseAdmin
    .from("link_audit_findings").select("link_url, reason")
    .eq("run_id", runId).is("resolved_at", null);
  if (rowsError) return NextResponse.json({ error: `Could not read the findings (${rowsError.message}).` }, { status: 503 });

  let links = [...new Set((rows ?? []).filter((r) => HARD_BROKEN_REASONS.has(r.reason)).map((r) => r.link_url as string))];
  if (typeof body.link === "string" && body.link) links = links.filter((l) => l === body.link);
  const truncated = links.length > MAX_LINKS_PER_CALL;
  links = links.slice(0, MAX_LINKS_PER_CALL);
  if (links.length === 0) return NextResponse.json({ ok: true, runId, checked: 0, fixed: 0, stillBroken: 0, fixedLinks: [] });

  const fpCache: FingerprintMap = {};
  const queue = new PQueue({ concurrency: 8 });
  const fixedLinks: string[] = [];
  const stillBroken: string[] = [];
  await Promise.all(links.map((link) => queue.add(async () => {
    const v = await checkLink(link, fpCache);
    // "ok" means the live site just answered correctly. Anything inconclusive (unreach) or
    // still-broken leaves the finding open — never close on a bot-block.
    if (v.verdict === "ok") fixedLinks.push(link);
    else stillBroken.push(link);
  })));
  await queue.onIdle();

  const now = new Date().toISOString();
  for (let i = 0; i < fixedLinks.length; i += 100) {
    await supabaseAdmin.from("link_audit_findings")
      .update({ resolved_at: now, last_checked_at: now })
      .in("link_url", fixedLinks.slice(i, i + 100)).is("resolved_at", null);
  }
  for (let i = 0; i < stillBroken.length; i += 100) {
    await supabaseAdmin.from("link_audit_findings")
      .update({ last_checked_at: now })
      .eq("run_id", runId).in("link_url", stillBroken.slice(i, i + 100));
  }

  return NextResponse.json({
    ok: true, runId, checked: links.length, fixed: fixedLinks.length,
    stillBroken: stillBroken.length, fixedLinks, ...(truncated ? { truncated: true } : {}),
  });
}
