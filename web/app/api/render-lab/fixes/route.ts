import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";

import { scanForFixes, applyFix, autoFixSection, rewritePrefix, type FixRow, type Job } from "@/lib/renderlab/fixEngine";
import { writesEnabled } from "@/lib/renderlab/strapiEntry";
import { supabaseAdmin } from "@/lib/db/supabase";

// GET   — the queue for one job, grouped by target, plus the rows.
// POST  — scan another batch of pages (?job=dead | ?job=prefix&from=features&to=tools).
// PATCH — apply, skip, or edit the proposed URL on selected rows.
//
// The three verbs are deliberately separate. Scanning is safe and idempotent; applying edits live
// published pages. Collapsing them into one endpoint is how a "preview" ends up writing.
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

function jobOf(sp: URLSearchParams): Job {
  return sp.get("job") === "prefix" ? "prefix" : "dead";
}

export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const job = jobOf(sp);
  const status = sp.get("status") ?? "pending";
  const target = sp.get("target");
  const limit = Math.min(Number(sp.get("limit") ?? 200) || 200, 5000);

  const { data: summary, error: se } = await supabaseAdmin.rpc("link_fixes_summary", { p_job: job });
  if (se) return NextResponse.json({ error: se.message }, { status: 500 });

  // ── Two groupings, because the two questions are different shapes ─────────────────────────────
  //
  //   by=page    auditing: which pages have dead links, and what is on each
  //   by=target  fixing: which links are dead, where they appear, and whether each occurrence is a
  //              hyperlink or a blog-resource card
  //
  // One dead URL can sit on forty pages. Forty rows for one decision is the wrong unit of work, which
  // is why fixing groups by target and auditing does not.
  const by = sp.get("by");
  if (by === "page" || by === "target") {
    const fn = by === "page" ? "link_fixes_by_page" : "link_fixes_by_target";
    const { data: grouped, error: ge } = await supabaseAdmin.rpc(fn, { p_job: job, p_status: status });
    if (ge) return NextResponse.json({ error: ge.message }, { status: 500 });
    return NextResponse.json({
      ok: true, job, status, by, writesEnabled: writesEnabled(),
      ...(summary as Record<string, unknown>),
      groups: grouped ?? [],
    });
  }

  let q = supabaseAdmin
    .from("link_fixes")
    .select("id, job, page_url, page_path, content_type, plural_api, entry_id, field_path, source, body_format, occurrence, array_index, raw, section, anchor, url, proposed_url, reason, confidence, status, old_value, new_value, error, applied_at, action")
    .eq("job", job).eq("status", status)
    .order("page_path", { ascending: true })
    .limit(limit);
  if (target) q = q.eq("url", target);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true, job, status, writesEnabled: writesEnabled(),
    ...(summary as Record<string, unknown>), rows: data ?? [],
  });
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const job = jobOf(sp);
  const from = sp.get("from")?.trim();
  const to = sp.get("to")?.trim();
  if (job === "prefix" && (!from || !to)) {
    return NextResponse.json({ error: "A prefix job needs ?from= and ?to=." }, { status: 400 });
  }
  // Refuse a rename that would rewrite links into a prefix nothing serves. Cheap to check, and the
  // alternative is queueing hundreds of rewrites to a 404.
  if (job === "prefix" && from === to) {
    return NextResponse.json({ error: "from and to are the same." }, { status: 400 });
  }
  // Link-audit bridge params arrive in the body: which dead targets to queue fixes for, and
  // which pages the audit saw them on. Query-only callers behave exactly as before.
  const body = await req.json().catch(() => ({})) as { urls?: unknown; pages?: unknown };
  const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 100) : [];
  const urls = strings(body.urls);
  const pages = strings(body.pages);

  const result = await scanForFixes({
    job,
    prefix: job === "prefix" ? { from: from!, to: to! } : undefined,
    batch: Math.min(Number(sp.get("batch") ?? 40) || 40, 400),
    refresh: sp.get("refresh") === "1",
    ...(urls.length ? { urls } : {}),
    ...(pages.length ? { pages } : {}),
  });
  return NextResponse.json({ ok: true, ...result });
}

export async function PATCH(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const session = await auth().catch(() => null);
  const actor = (session?.user?.email as string | undefined) ?? "api";

  const body = await req.json().catch(() => ({})) as {
    action?: "apply" | "skip" | "retarget" | "remove" | "unlink" | "relink" | "autofix";
    ids?: string[];
    proposedUrl?: string;
    section?: string;
    minScore?: number;
  };

  // Section-wide, not row-by-row: re-propose every pending replace-row under /<section>
  // against the LIVE sitemap and apply the confident matches. The directed auto-repair the
  // team asked for (Aug 31, "/features") — one click, everything below the bar stays pending.
  if (body.action === "autofix") {
    if (!body.section) return NextResponse.json({ error: "autofix needs a section, e.g. \"features\"." }, { status: 400 });
    try {
      const result = await autoFixSection(body.section, actor, {
        ...(typeof body.minScore === "number" ? { minScore: body.minScore } : {}),
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (e: unknown) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "autofix failed" }, { status: 409 });
    }
  }

  const ids = (body.ids ?? []).filter((x) => typeof x === "string").slice(0, 500);
  if (!ids.length) return NextResponse.json({ error: "No row ids given." }, { status: 400 });

  if (body.action === "skip") {
    await supabaseAdmin.from("link_fixes").update({ status: "skipped" }).in("id", ids);
    return NextResponse.json({ ok: true, skipped: ids.length });
  }

  // Mark rows to be REMOVED rather than repointed — and back again. Intent lives on the row so
  // the queue shows what Apply will do before anybody presses it. No category guard here: the
  // engine removes what each kind actually is (anchor keeps its text, a CTA button comes out
  // whole, a resource card is dropped), so every pending row is markable.
  if (body.action === "unlink" || body.action === "relink") {
    const next = body.action === "unlink" ? "remove" : "replace";
    const { error } = await supabaseAdmin.from("link_fixes")
      .update({ action: next }).in("id", ids).eq("status", "pending");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, marked: ids.length, action: next });
  }

  // "remove" is the one-shot variant (mark + apply in the same request) — kept for API callers
  // that don't want the two-step.
  if (body.action === "remove") {
    // Refuse BEFORE marking — a row left flagged "remove" that nothing then applies is the
    // exact dangling-intent state the old unlink button created.
    if (!writesEnabled()) {
      return NextResponse.json({
        error: "Writes are disabled. Set RENDER_LAB_WRITES=1 to let this edit live pages.",
      }, { status: 409 });
    }
    const { error } = await supabaseAdmin.from("link_fixes")
      .update({ action: "remove" }).in("id", ids).eq("status", "pending");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // falls through to the apply block below
  }

  if (body.action === "retarget") {
    const url = (body.proposedUrl ?? "").trim();
    if (!url) return NextResponse.json({ error: "retarget needs a proposedUrl." }, { status: 400 });
    await supabaseAdmin.from("link_fixes").update({ proposed_url: url }).in("id", ids);
    return NextResponse.json({ ok: true, retargeted: ids.length });
  }

  if (!writesEnabled()) {
    return NextResponse.json({
      error: "Writes are disabled. Set RENDER_LAB_WRITES=1 to let this edit live pages.",
    }, { status: 409 });
  }

  // relation_id/item_id MUST be here: applyBlogResourceFix's drift guard compares the card's
  // current blog id against row.relation_id, and an undefined (never selected) slipped past
  // its null-check — every resource-card apply bounced with "now points at blog N, not
  // undefined" and the team read it as "Strapi is broken" (measured: 18 stale rows, Aug 31).
  const { data: rows, error } = await supabaseAdmin
    .from("link_fixes")
    .select("id, job, plural_api, entry_id, field_path, source, body_format, occurrence, array_index, raw, url, proposed_url, content_type, page_path, anchor, action, relation_id, item_id")
    .in("id", ids).eq("status", "pending");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Sequential. Every apply is a Strapi read plus a write, and the whole point of the throttle in
  // strapiEntry is that these do not stack up.
  const results = [];
  const started = Date.now();
  for (const row of (rows ?? []) as unknown as FixRow[]) {
    if (Date.now() - started > 250_000) {
      results.push({ id: row.id, ok: false, message: "Ran out of time in this request — press apply again." });
      continue;
    }
    results.push(await applyFix(row, actor));
  }

  return NextResponse.json({
    ok: true,
    applied: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}

/** Preview a prefix rewrite without touching anything — used by the tab to show what "to" would do. */
export async function PUT(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { from?: string; to?: string; samples?: string[] };
  const from = (body.from ?? "").trim(), to = (body.to ?? "").trim();
  if (!from || !to) return NextResponse.json({ error: "from and to are required." }, { status: 400 });
  const samples = (body.samples ?? []).slice(0, 20);
  return NextResponse.json({
    ok: true,
    preview: samples.map((s) => ({ before: s, after: rewritePrefix(s, { from, to }) })),
  });
}
