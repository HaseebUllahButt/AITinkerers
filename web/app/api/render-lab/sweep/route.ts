import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";

import { analyzePage, inScope, type Issue } from "@/lib/renderlab/analyze";
import { searchAnalytics, daysAgo, isGscConfigured } from "@/lib/indexing/gsc";
import { supabaseAdmin } from "@/lib/db/supabase";

// The daily refresh. Also what the page's "Re-scan" button calls.
//
// ── What this can and cannot measure, and why the difference is recorded ────────────────────────
//
// There is no Chromium on this runtime, so this cannot do the rendered pass. It CAN do everything
// else — the four crawler-identity fetches, the payload measurement, the raw-HTML tag checks and the
// Search Console lookup — and those are the checks that cover cloaking, which is the half that maps to
// an actual spam policy.
//
// So a refreshed row is a MERGE, not a replacement:
//
//   re-measured   cloaking, payload, raw tags, noindex, GSC coverage, impressions  → checked_at
//   carried over  everything derived from the render diff                          → rendered_at
//
// Overwriting instead of merging would silently delete the js-gating findings — the most valuable
// thing in the table — every night, and the page would look freshly swept while having lost the
// answer. Two timestamps because two measurements with two different ages cannot honestly share one.
export const maxDuration = 300;

/** Codes that only a rendered pass can produce. Carried forward when we cannot render. */
const RENDER_DERIVED = new Set([
  "js_gated_tags", "js_gated_content", "no_content_pre_js", "js_gated_links",
  "render_unavailable", "render_failed",
]);

// Four fetches of a ~1.3 MB page each, plus a Search Console call. Measured at ~2.2s per page, so this
// bound is what keeps a run inside the function ceiling with room to spare rather than being killed
// halfway and leaving the cursor where it started.
const BATCH = 90;

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

  const sp = req.nextUrl.searchParams;
  const batch = Math.min(Number(sp.get("batch") ?? BATCH) || BATCH, 200);
  const only = sp.get("urls");

  // ── What to look at ───────────────────────────────────────────────────────────────────────────
  //
  // Oldest-checked first, so the daily run walks the whole corpus over about a fortnight rather than
  // re-measuring the same first ninety pages every night and never reaching the tail.
  let targets: Array<{ url: string; path: string }> = [];
  if (only) {
    const wanted = only.split(/[\n,]+/).map((u) => u.trim()).filter(Boolean).slice(0, 200);
    const { data } = await supabaseAdmin.from("site_urls").select("url, path").in("url", wanted);
    targets = (data ?? []).filter((r) => r.path && inScope(r.path));
  } else {
    const { data: known } = await supabaseAdmin
      .from("render_audit").select("url, path").order("checked_at", { ascending: true }).limit(batch);
    targets = known ?? [];

    // Anything in the sitemap that has never been checked goes first — a page with no row at all is a
    // bigger gap than a page whose row is a fortnight old.
    if (targets.length < batch) {
      const seen = new Set<string>();
      for (let from = 0; ; from += 1000) {
        const { data } = await supabaseAdmin.from("render_audit").select("url").range(from, from + 999);
        for (const r of data ?? []) seen.add(r.url);
        if ((data ?? []).length < 1000) break;
      }
      const sitemap: Array<{ url: string; path: string }> = [];
      for (let from = 0; ; from += 1000) {
        const { data } = await supabaseAdmin.from("site_urls").select("url, path").range(from, from + 999);
        sitemap.push(...(data ?? []) as Array<{ url: string; path: string }>);
        if ((data ?? []).length < 1000) break;
      }
      const fresh = sitemap.filter((s) => s.path && inScope(s.path) && !seen.has(s.url));
      targets = [...fresh.slice(0, batch - targets.length), ...targets];
    }
  }
  if (!targets.length) return NextResponse.json({ ok: true, checked: 0, note: "Nothing in scope to refresh." });

  // Traffic for every page in one query rather than one per URL — it is a property-wide report, so a
  // single call already contains them all.
  const traffic = new Map<string, { clicks: number; impressions: number; position: number }>();
  if (isGscConfigured()) {
    const rows = await searchAnalytics({
      startDate: daysAgo(90), endDate: daysAgo(2), dimensions: ["page"], rowLimit: 25000,
    }).catch(() => null);
    for (const r of rows ?? []) {
      const k = String(r.keys?.[0] ?? "").replace(/\/+$/, "");
      if (k) traffic.set(k, { clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, position: r.position ?? 0 });
    }
  }

  // The render-derived findings we are about to carry forward.
  const { data: priorRows } = await supabaseAdmin
    .from("render_audit")
    .select("url, issues, rendered_words, rendered_bytes, word_ratio, word_delta, existing_mode, js_gated_tags, js_gated_links, rendered_at")
    .in("url", targets.map((t) => t.url));
  const prior = new Map((priorRows ?? []).map((r) => [r.url as string, r]));

  let checked = 0, cloaked = 0, critical = 0;
  const started = Date.now();

  // Six at a time: the pages are over a megabyte each and this is network-bound, so concurrency buys
  // real throughput here. Sequential would not finish the batch inside the budget.
  const queue = [...targets];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      // Stop taking new work rather than being killed mid-write: a run that ends cleanly leaves the
      // cursor advanced by however much it finished, and tomorrow picks up from there.
      if (Date.now() - started > 250_000) return;

      const f = await analyzePage(t.url, t.path, {
        skipRender: true,
        traffic: traffic.get(t.url.replace(/\/+$/, "")) ?? null,
      });
      const p = prior.get(t.url);

      // Merge: our fresh no-JS issues, minus the placeholder that says we could not render, plus the
      // render-derived issues the previous run established.
      const fresh = (f.issues as Issue[]).filter((i) => !RENDER_DERIVED.has(i.code));
      const carried = ((p?.issues ?? []) as Issue[]).filter((i) => RENDER_DERIVED.has(i.code));
      const issues = [...fresh, ...carried];
      const worst = issues.some((i) => i.severity === "critical") ? "critical"
        : issues.some((i) => i.severity === "warn") ? "warn"
        : issues.length ? "info" : null;
      const weight = Math.log1p(f.impressions ?? 0) + 1;
      const rank = worst === "critical" ? 3 : worst === "warn" ? 2 : worst === "info" ? 1 : 0;

      const { error } = await supabaseAdmin.from("render_audit").upsert({
        url: f.url, path: f.path, section: f.section, checked_at: f.checkedAt,
        http_status: f.httpStatus, agents: f.agents, cloaked: f.cloaked,
        raw_words: f.rawWords, raw_bytes: f.rawBytes, bytes_per_word: f.bytesPerWord,
        gsc: f.gsc, impressions: f.impressions, clicks: f.clicks, position: f.position,
        // Carried, not recomputed. Null here would delete the js-gating answer every night.
        rendered_words: p?.rendered_words ?? null,
        rendered_bytes: p?.rendered_bytes ?? null,
        word_ratio: p?.word_ratio ?? null,
        word_delta: p?.word_delta ?? null,
        existing_mode: p?.existing_mode ?? null,
        js_gated_tags: p?.js_gated_tags ?? [],
        js_gated_links: p?.js_gated_links ?? null,
        rendered_at: p?.rendered_at ?? null,
        issues, worst, priority: Math.round(rank * weight * 100) / 100,
      }, { onConflict: "url" });
      if (!error) {
        checked++;
        if (f.cloaked) cloaked++;
        if (worst === "critical") critical++;
      }
    }
  }));

  return NextResponse.json({
    ok: true, checked, cloaked, critical,
    seconds: Math.round((Date.now() - started) / 1000),
    note: "Cloaking, payload, raw tags and Search Console were re-measured. The render diff was carried "
      + "forward from the last local sweep — this runtime has no headless browser.",
  });
}

// Vercel's scheduler issues GET.
export async function GET(req: NextRequest) { return POST(req); }
