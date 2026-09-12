// How fast blog content gets drafted, before and after SearchOps's blog pipeline existed.
//
// Two systems hold half the answer each, and neither alone is honest:
//
//   Strapi (`imagine-webs`)  every blog entry ever created, going back to 2023-10. This is the ONLY
//                            record of the pre-SearchOps baseline, because SearchOps did not exist.
//   SearchOps (`blog_drafts`)   what the tool has produced since 2026-07-24. Most of it has not reached
//                            Strapi yet, so counting Strapi alone reports SearchOps's output as zero.
//
// ── The double-count that makes a naive version wrong ───────────────────────────────────────────
//
// A SearchOps draft that has been synced EXISTS IN BOTH TABLES. Adding the two series together counts it
// twice and inflates exactly the period the report is about. So the unique figure is
// `strapiCreated + (summitDrafts - summitSynced)` per month — Strapi is authoritative for anything
// that reached it, and SearchOps contributes only what has not.
//
// ── Why per-day and not per-month ──────────────────────────────────────────────────────────────
//
// The current month is partial. Comparing 20 elapsed days against 31-day months understates the
// present by a third, which would hide a real gain — or, if the numbers ran the other way, invent one.
// Every rate here is per-day for that reason, and the month's own day count travels with it so a
// reader can check.
//
// ── Drafting is not publishing, and the report says so ─────────────────────────────────────────
//
// Measured: 45 of 58 SearchOps drafts are still `local_only`. Drafting throughput more than doubled while
// the PUBLISHING rate did not move, because the drafts are queued for human review. That is the most
// useful thing in this report — the bottleneck moved from writing to reviewing — and reporting the
// gain without it would be a chart that flatters the tool and misleads the reader.
import { supabaseAdmin } from "@/lib/db/supabase";
import { blogType } from "@/lib/strapi/client";

/** When SearchOps's blog pipeline started producing drafts. Derived from the data, not hardcoded — see
 *  `summitStart` in the result, which reports the earliest draft actually found. */
const FALLBACK_START = "2026-07-24";

export interface MonthPoint {
  /** `YYYY-MM`. */
  month: string;
  /** Days in the month, or days ELAPSED when it is the current one. */
  days: number;
  /** Entries created directly in the CMS. Pre-SearchOps this is the whole picture. */
  strapiCreated: number;
  /** Drafts SearchOps produced. */
  summitDrafts: number;
  /** Of those, how many reached the CMS — subtracted out to avoid counting them twice. */
  summitSynced: number;
  /** strapiCreated + (summitDrafts - summitSynced). */
  unique: number;
  /** unique / days, rounded to 2dp. */
  perDay: number;
  /** True once SearchOps's pipeline was running for any part of this month. */
  summitEra: boolean;
}

export interface DraftingRateReport {
  months: MonthPoint[];
  summitStart: string;
  before: { from: string; to: string; items: number; days: number; perDay: number };
  after: { from: string; to: string; items: number; days: number; perDay: number };
  /** Percent change in per-day drafting rate. Positive is faster. */
  changePct: number;
  /** The month with the highest per-day rate in the whole series, so a claim of "best ever" is checked. */
  bestMonth: { month: string; perDay: number };
  /** The caveat, as numbers rather than prose. */
  review: { summitTotal: number; synced: number; awaitingReview: number; syncFailed: number };
  generatedAt: string;
  /** Anything that could not be read. Non-empty means the figures below are partial, not zero. */
  problems: string[];
}

function daysInMonth(month: string, today: Date): number {
  const [y, m] = month.split("-").map(Number);
  if (y === today.getUTCFullYear() && m === today.getUTCMonth() + 1) return today.getUTCDate();
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Every blog entry's creation DATE, straight from the CMS. Paged, because there are ~830.
 *
 * Dates, not month buckets, and that distinction is a bug this function already had: SearchOps started
 * on the 24th, so a month bucket for July cannot be split into before/after. Summing the July bucket
 * into the "after" column put 23 days of pre-SearchOps work there and overstated the headline rate by
 * 15% (4.00/day against a true 3.48). Keeping the dates costs one array of ~830 strings.
 */
async function strapiCreatedDates(problems: string[]): Promise<string[]> {
  const url = process.env.STRAPI_URL?.trim().replace(/\/$/, "");
  const token = process.env.STRAPI_API_TOKEN?.trim();
  const out: string[] = [];
  if (!url || !token) {
    problems.push("Strapi is not configured, so the pre-SearchOps baseline could not be read.");
    return out;
  }
  // publicationState=preview so unpublished entries count too — this measures DRAFTING, and an
  // entry somebody created and never published is still work that happened.
  const base = `${url}/api/${blogType()}?fields[0]=createdAt&publicationState=preview`;
  for (let page = 1; page <= 15; page++) {
    let d: { data?: Array<Record<string, unknown>>; meta?: { pagination?: { pageCount?: number } } };
    try {
      const res = await fetch(`${base}&pagination[page]=${page}&pagination[pageSize]=100`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) { problems.push(`Strapi answered ${res.status} on page ${page} of the blog history.`); break; }
      d = await res.json();
    } catch (e: unknown) {
      problems.push(`Strapi read failed on page ${page}: ${e instanceof Error ? e.message : "unknown"}`);
      break;
    }
    const rows = d.data ?? [];
    if (!rows.length) break;
    for (const r of rows) {
      const a = (r.attributes ?? r) as Record<string, unknown>;
      const created = String(a.createdAt ?? "");
      if (created.length >= 10) out.push(created);
    }
    if (page >= (d.meta?.pagination?.pageCount ?? 1)) break;
  }
  return out;
}

export async function buildDraftingRateReport(): Promise<DraftingRateReport> {
  const problems: string[] = [];
  const today = new Date();

  const [strapiDates, draftsRes] = await Promise.all([
    strapiCreatedDates(problems),
    supabaseAdmin
      .from("blog_drafts")
      .select("created_at, strapi_id, sync_state")
      .order("created_at", { ascending: true })
      .limit(5000),
  ]);
  if (draftsRes.error) problems.push(`SearchOps's drafts could not be read: ${draftsRes.error.message}`);
  const drafts = draftsRes.data ?? [];

  const summitByMonth = new Map<string, number>();
  const syncedByMonth = new Map<string, number>();
  for (const d of drafts) {
    const m = String(d.created_at ?? "").slice(0, 7);
    if (m.length < 7) continue;
    summitByMonth.set(m, (summitByMonth.get(m) ?? 0) + 1);
    if (d.strapi_id) syncedByMonth.set(m, (syncedByMonth.get(m) ?? 0) + 1);
  }

  const strapiByMonth = new Map<string, number>();
  for (const iso of strapiDates) {
    const m = iso.slice(0, 7);
    strapiByMonth.set(m, (strapiByMonth.get(m) ?? 0) + 1);
  }

  const summitStart = drafts.length ? String(drafts[0].created_at).slice(0, 10) : FALLBACK_START;
  const startMonth = summitStart.slice(0, 7);

  // Twelve months of history plus the SearchOps era. Further back the site published at a tenth of the
  // current rate and the chart's shape stops being about anything the team can act on.
  const allMonths = [...new Set([...strapiByMonth.keys(), ...summitByMonth.keys()])].sort();
  const cutoff = (() => {
    const d = new Date(today); d.setUTCMonth(d.getUTCMonth() - 12);
    return d.toISOString().slice(0, 7);
  })();
  const months: MonthPoint[] = allMonths.filter((m) => m >= cutoff).map((month) => {
    const days = daysInMonth(month, today);
    const strapiCreated = strapiByMonth.get(month) ?? 0;
    const summitDrafts = summitByMonth.get(month) ?? 0;
    const summitSynced = syncedByMonth.get(month) ?? 0;
    const unique = strapiCreated + Math.max(0, summitDrafts - summitSynced);
    return {
      month, days, strapiCreated, summitDrafts, summitSynced, unique,
      perDay: Math.round((unique / Math.max(days, 1)) * 100) / 100,
      summitEra: month >= startMonth,
    };
  });

  // ── Before / after ────────────────────────────────────────────────────────────────────────────
  //
  // "Before" ends at the last FULL month before SearchOps started, not at the start date itself. The
  // month SearchOps launched mid-way is neither one thing nor the other, and splitting it would put a
  // fortnight of pre-SearchOps work into the "after" column.
  const beforeMonths = months.filter((m) => m.month < startMonth);
  const beforeItems = beforeMonths.reduce((a, m) => a + m.unique, 0);
  const beforeDays = beforeMonths.reduce((a, m) => a + m.days, 0);
  const beforePerDay = beforeDays ? beforeItems / beforeDays : 0;

  const startMs = Date.parse(`${summitStart}T00:00:00Z`);
  const afterDays = Math.max(1, Math.round((today.getTime() - startMs) / 86_400_000));
  // Compared by DATE, not by month bucket. SearchOps started on the 24th, so summing the July bucket
  // here would put 23 days of pre-SearchOps work in the "after" column — measured, that overstated the
  // rate by 15%.
  const strapiAfter = strapiDates.filter((iso) => iso.slice(0, 10) >= summitStart).length;
  const summitAfter = drafts.filter((d) => String(d.created_at) >= summitStart).length;
  const syncedAfter = drafts.filter((d) => String(d.created_at) >= summitStart && d.strapi_id).length;
  const afterItems = strapiAfter + Math.max(0, summitAfter - syncedAfter);
  const afterPerDay = afterItems / afterDays;

  const best = months.reduce<{ month: string; perDay: number }>(
    (a, m) => (m.perDay > a.perDay ? { month: m.month, perDay: m.perDay } : a),
    { month: "—", perDay: 0 },
  );

  return {
    months,
    summitStart,
    before: {
      from: beforeMonths[0]?.month ?? "—",
      to: beforeMonths[beforeMonths.length - 1]?.month ?? "—",
      items: beforeItems, days: beforeDays,
      perDay: Math.round(beforePerDay * 100) / 100,
    },
    after: {
      from: summitStart, to: today.toISOString().slice(0, 10),
      items: afterItems, days: afterDays,
      perDay: Math.round(afterPerDay * 100) / 100,
    },
    changePct: beforePerDay > 0 ? Math.round((afterPerDay / beforePerDay - 1) * 100) : 0,
    bestMonth: best,
    review: {
      summitTotal: drafts.length,
      synced: drafts.filter((d) => d.strapi_id).length,
      awaitingReview: drafts.filter((d) => d.sync_state === "local_only").length,
      syncFailed: drafts.filter((d) => d.sync_state === "sync_failed").length,
    },
    generatedAt: new Date().toISOString(),
    problems,
  };
}
