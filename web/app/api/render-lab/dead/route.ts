import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";

import { sweepDeadUrls } from "@/lib/renderlab/deadUrls";
import { supabaseAdmin } from "@/lib/db/supabase";

// GET  — the dead pages we know about, grouped by path pattern.
// POST — check another batch. Also the daily cron target.
//
// Unlike the render diff, this needs no browser: it is status codes and Search Console, both of which
// work anywhere. So this one genuinely can run on a schedule in production.
export const maxDuration = 300;

async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  const session = await auth().catch(() => null);
  return !!session;
}

export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const pattern = sp.get("pattern");
  // `all=1` returns rows across every pattern, for the CSV export. The UI never asks for this while
  // browsing — the whole point of the grouping is that nobody wants 16,686 rows on screen — but an
  // export of one group at a time would be unusable for exactly the same reason.
  const all = sp.get("all") === "1";
  const limit = Math.min(Number(sp.get("limit") ?? 100) || 100, 5000);

  const { data: summary, error: se } = await supabaseAdmin.rpc("dead_urls_summary");
  if (se) return NextResponse.json({ error: se.message }, { status: 500 });
  // Per-pattern disposition, so the group list can show what has been decided without a second call.
  const { data: dispositions } = await supabaseAdmin.rpc("dead_urls_dispositions");

  // Rows only when a group is selected. The whole point of the grouping is that nobody wants 16,686
  // rows by default — the top-level view is the pattern list, and rows are the drill-in.
  let rows: unknown[] = [];
  if (pattern || all) {
    let q = supabaseAdmin
      .from("dead_urls")
      .select("url, path, pattern, http_status, verdict, redirect_to, clicks, impressions, position, sources, linked_from, suggestion, checked_at, disposition")
      .order("impressions", { ascending: false })
      .limit(limit);
    if (pattern && !all) q = q.eq("pattern", pattern);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    rows = data ?? [];
  }

  return NextResponse.json({ ok: true, ...(summary as Record<string, unknown>), dispositions: dispositions ?? [], pattern, rows });
}

/**
 * Record what should happen to a set of dead URLs.
 *
 * 'gone' is the interesting one: a 404 tells Google "maybe later" and a 410 tells it "deliberately
 * removed", and a 410 drops out of the index materially faster. Nothing here can make a URL return 410
 * on its own — a status code is served by the app, not the CMS — so this records the decision and
 * scripts/generate_gone_rules.mjs turns it into middleware for imagine-web.
 *
 * Accepts whole PATTERNS as well as individual urls, because the case this exists for is 16,686
 * /read/9zqf5s/ URLs and nobody is ticking those one at a time.
 */
export async function PATCH(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const session = await auth().catch(() => null);
  const actor = (session?.user?.email as string | undefined) ?? "api";

  const body = await req.json().catch(() => ({})) as {
    disposition?: "gone" | "redirect" | "leave" | null;
    urls?: string[];
    patterns?: string[];
  };
  const d = body.disposition ?? null;
  if (d !== null && !["gone", "redirect", "leave"].includes(d)) {
    return NextResponse.json({ error: "disposition must be gone, redirect, leave or null." }, { status: 400 });
  }
  const patch = {
    disposition: d,
    disposition_by: d ? actor : null,
    disposition_at: d ? new Date().toISOString() : null,
  };

  let changed = 0;
  const urls = (body.urls ?? []).filter((u) => typeof u === "string").slice(0, 2000);
  if (urls.length) {
    const { count, error } = await supabaseAdmin.from("dead_urls")
      .update(patch, { count: "exact" }).in("url", urls);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    changed += count ?? 0;
  }
  const patterns = (body.patterns ?? []).filter((p) => typeof p === "string").slice(0, 100);
  for (const pattern of patterns) {
    const { count, error } = await supabaseAdmin.from("dead_urls")
      .update(patch, { count: "exact" }).eq("pattern", pattern);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    changed += count ?? 0;
  }
  if (!urls.length && !patterns.length) {
    return NextResponse.json({ error: "Give urls or patterns." }, { status: 400 });
  }
  return NextResponse.json({ ok: true, disposition: d, changed });
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  // ?scope=blogs-features restricts the sweep to /blogs/ and /features/ — both the GSC fetch and the
  // sitemap candidates — which is what actually makes it fast: an unfiltered GSC query over this date
  // range hits the 25,000-row page cap (several round trips to Google every call, measured at ~116s for
  // a single-URL batch); a scoped query almost always finishes in one round trip per prefix.
  const scope = sp.get("scope");
  const pathPrefixes = scope === "blogs-features" ? ["/blogs/", "/features/"] : undefined;
  const result = await sweepDeadUrls({
    batch: Math.min(Number(sp.get("batch") ?? 400) || 400, 1500),
    days: Number(sp.get("days") ?? 480) || 480,
    pathPrefixes,
  });
  return NextResponse.json({ ok: true, ...result });
}
