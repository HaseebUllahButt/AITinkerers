import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { supabaseAdmin } from "@/lib/db/supabase";

// Read the bot-render audit. The SWEEP that fills this table is scripts/render_sweep.mts and is
// deliberately not callable from here — the render diff needs a headless Chromium that does not exist
// on this runtime, so a route that offered to run it could only ever produce half the findings while
// looking like it had produced all of them.
export const maxDuration = 30;

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
  const section = sp.get("section");
  const worst = sp.get("worst");
  const code = sp.get("code");
  // 60 by default because the layout shows fewer, larger rows; up to 5,000 because a CSV export of
  // "everything matching my filters" is a real request and capping it at the display size would hand
  // somebody 60 of 271 rows in a file called "all findings".
  const limit = Math.min(Number(sp.get("limit") ?? 60) || 60, 5000);

  let q = supabaseAdmin
    .from("render_audit")
    .select("url, path, section, checked_at, rendered_at, http_status, cloaked, raw_words, raw_bytes, rendered_words, word_ratio, word_delta, bytes_per_word, existing_mode, js_gated_tags, js_gated_links, gsc, impressions, clicks, position, issues, worst, priority")
    .order("priority", { ascending: false })
    .limit(limit);
  if (section === "blogs" || section === "features") q = q.eq("section", section);
  if (worst) q = q.eq("worst", worst);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Filtering by issue code in SQL would need a jsonb containment operator the client does not expose
  // cleanly; the row cap is 500, so doing it here costs nothing and keeps the query readable.
  const rows = code
    ? (data ?? []).filter((r) => ((r.issues ?? []) as Array<{ code: string }>).some((i) => i.code === code))
    : (data ?? []);

  // ── The summary, in one round trip ────────────────────────────────────────────────────────────
  //
  // This used to be four count queries plus a paged scan of every row, folding the jsonb in JS.
  // Measured at 1.9-2.1s per page load for an answer Postgres produces itself in milliseconds — the
  // aggregation is a group-by over jsonb_array_elements, which is the database's job. See migration 088.
  //
  // It also fixes what the JS version got wrong: it counted only the LIMITED page of rows, so at
  // limit=3 it reported "js_gated_tags: 3 pages" as confidently as the true corpus-wide 41.
  const { data: summary, error: se } = await supabaseAdmin.rpc("render_audit_summary");
  if (se) return NextResponse.json({ error: se.message }, { status: 500 });

  return NextResponse.json({ ok: true, ...(summary as Record<string, unknown>), rows });
}
