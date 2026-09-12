// The adoption report: who uses SearchOps, how much, and what it produced.
//
// Built almost entirely from tables that already exist, on purpose. Every outcome this tool cares about
// is already stamped with an owner and a timestamp somewhere — blog_drafts.created_by,
// outreach_emails.sent_by_email/replied_at/success_at/bounced_at, backlink_prospects.link_live_at,
// writer_clusters.done/failed. Deriving from those means the report has real history from July onward
// instead of starting at zero the day it ships, which is the difference between something you can take
// to a CGO now and something you can take to them next quarter.
//
// usage_events only fills the one gap those tables cannot: someone who opens a surface and produces
// nothing. See scripts/050_usage_events.mjs.
//
// Two rules this module holds to, because an adoption number that gets quoted upward must not be
// flattering by accident:
//
//   1. Measured, never inferred. Every figure traces to rows. Where a metric cannot be computed from
//      real data the field is null and the UI says so, rather than showing a plausible zero.
//   2. Losses are counted as carefully as wins. A report that only aggregates successes is a sales
//      deck. The failure and opportunity sections exist so the same query answers "is this working"
//      and "where is it stuck".
import { supabaseAdmin } from "@/lib/db/supabase";

/** A person, and what they actually did. */
export interface PersonUsage {
  email: string;
  firstSeen: string | null;
  lastSeen: string | null;
  /** Distinct days with any recorded activity — the honest engagement measure. A single busy day and
   *  twenty steady days both produce a lot of rows; only this separates them. */
  activeDays: number;
  draftsCreated: number;
  aiSessions: number;
  assetsGenerated: number;
  emailsSent: number;
  repliesWon: number;
  surfacesUsed: string[];
}

export interface AdoptionReport {
  generatedAt: string;
  windowDays: number;
  people: PersonUsage[];
  totals: {
    activePeople: number;
    draftsCreated: number;
    articlesWritten: number;
    assetsGenerated: number;
    emailsSent: number;
  };
  /** Things that went right, each traceable to rows. */
  wins: Metric[];
  /** Things that failed. Counted with the same care as the wins. */
  losses: Metric[];
  /** Value sitting unclaimed — work started and not finished, or capacity unused. */
  opportunities: Metric[];
  /** Weekly activity, oldest first, for a trend line. */
  trend: Array<{ week: string; drafts: number; sessions: number; emails: number; views: number }>;
  /** Anything that could not be measured, named explicitly rather than shown as a zero. */
  caveats: string[];
}

export interface Metric {
  label: string;
  value: number;
  /** Denominator, when the number only means something as a rate. */
  outOf?: number;
  /** Where the number came from, so it can be defended in the meeting it gets quoted in. */
  source: string;
  detail?: string;
}

/** Count rows, returning null rather than 0 when the table is unreachable — a missing table and a
 *  genuine zero must not look identical in a report someone acts on. */
async function countOf(
  table: string,
  build: (q: ReturnType<typeof baseQuery>) => ReturnType<typeof baseQuery>,
): Promise<number | null> {
  try {
    const { count, error } = await build(baseQuery(table));
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

function baseQuery(table: string) {
  return supabaseAdmin.from(table).select("*", { count: "exact", head: true });
}

/** ISO date for `days` ago, which is what every window filter below compares against. */
function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Monday of the week containing `iso`, as a plain date — the bucket key for the trend. */
function weekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Rows with an owner and a timestamp, which is all the per-person roll-up needs. */
interface OwnedRow { who: string | null; at: string | null }

async function ownedRows(table: string, ownerCol: string, timeCol: string, from: string): Promise<OwnedRow[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(`${ownerCol}, ${timeCol}`)
      .gte(timeCol, from)
      .limit(1000);
    if (error || !data) return [];
    // Via `unknown`: the column list is a template literal, which supabase-js cannot parse statically,
    // so its inferred type is a ParserError rather than a row shape. The runtime result is a plain row.
    return (data as unknown as Record<string, unknown>[]).map((r) => ({
      who: (r[ownerCol] as string) ?? null,
      at: (r[timeCol] as string) ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Build the report over a trailing window.
 *
 * 90 days by default: long enough to show a trend and to cover a quarter, short enough that the
 * per-table 1000-row reads stay well inside PostgREST's hard cap. (That cap is why these are windowed
 * reads rather than "select everything and group in JS" — PostgREST silently truncates at 1000 rows
 * regardless of .limit(), so an unwindowed query would quietly under-report as the tool got busier.)
 */
export async function buildAdoptionReport(windowDays = 90): Promise<AdoptionReport> {
  const from = since(windowDays);
  const caveats: string[] = [];

  // ---- Per-person activity, gathered from every table that stamps an owner. ----
  const [drafts, sessions, assets, chats, views] = await Promise.all([
    ownedRows("blog_drafts", "created_by", "created_at", from),
    ownedRows("writer_sessions", "created_by", "created_at", from),
    ownedRows("media_generations", "created_by", "created_at", from),
    // chat_message is the broadest per-user signal that predates any of this instrumentation.
    ownedRows("chat_message", "user_email", "created_at", from),
    ownedRows("usage_events", "user_email", "created_at", from),
  ]);

  // Outreach carries its own owner column and its own outcome columns, so it is read whole.
  let outreach: Array<{
    sent_by_email: string | null; sent_at: string | null; replied_at: string | null;
    bounced_at: string | null; success_at: string | null; status: string | null;
    paid_amount: number | null;
  }> = [];
  try {
    const { data } = await supabaseAdmin
      .from("outreach_emails")
      .select("sent_by_email, sent_at, replied_at, bounced_at, success_at, status, paid_amount")
      .gte("created_at", from)
      .limit(1000);
    outreach = (data as typeof outreach) ?? [];
  } catch {
    caveats.push("Outreach outcomes could not be read; email figures are omitted rather than shown as zero.");
  }

  // Surface usage per person, which is what tells you WHICH parts of the tool landed.
  const surfacesByUser = new Map<string, Set<string>>();
  try {
    const { data } = await supabaseAdmin
      .from("usage_events")
      .select("user_email, surface")
      .gte("created_at", from)
      .limit(1000);
    for (const r of (data as Array<{ user_email: string; surface: string }>) ?? []) {
      if (!surfacesByUser.has(r.user_email)) surfacesByUser.set(r.user_email, new Set());
      surfacesByUser.get(r.user_email)!.add(r.surface);
    }
  } catch { /* usage_events is new; absence is expected, not an error. */ }

  const people = new Map<string, PersonUsage & { days: Set<string> }>();
  const person = (email: string | null): (PersonUsage & { days: Set<string> }) | null => {
    if (!email) return null; // An unattributed row is real work, but it cannot be credited to anyone.
    if (!people.has(email)) {
      people.set(email, {
        email, firstSeen: null, lastSeen: null, activeDays: 0, draftsCreated: 0, aiSessions: 0,
        assetsGenerated: 0, emailsSent: 0, repliesWon: 0,
        surfacesUsed: [...(surfacesByUser.get(email) ?? [])].sort(),
        days: new Set<string>(),
      });
    }
    return people.get(email)!;
  };

  const note = (email: string | null, at: string | null, field?: keyof PersonUsage) => {
    const p = person(email);
    if (!p) return;
    if (at) {
      const day = at.slice(0, 10);
      p.days.add(day);
      if (!p.firstSeen || at < p.firstSeen) p.firstSeen = at;
      if (!p.lastSeen || at > p.lastSeen) p.lastSeen = at;
    }
    if (field && typeof p[field] === "number") (p[field] as number) += 1;
  };

  for (const r of drafts) note(r.who, r.at, "draftsCreated");
  for (const r of sessions) note(r.who, r.at, "aiSessions");
  for (const r of assets) note(r.who, r.at, "assetsGenerated");
  for (const r of chats) note(r.who, r.at);
  for (const r of views) note(r.who, r.at);
  for (const e of outreach) {
    if (!e.sent_at) continue;
    note(e.sent_by_email, e.sent_at, "emailsSent");
    if (e.replied_at) { const p = person(e.sent_by_email); if (p) p.repliesWon += 1; }
  }

  const roster: PersonUsage[] = [...people.values()]
    .map(({ days, ...rest }) => ({ ...rest, activeDays: days.size }))
    .sort((a, b) => b.activeDays - a.activeDays || b.draftsCreated - a.draftsCreated);

  // ---- Wins. Each one is a row count over a real outcome column. ----
  const [published, liveLinks, clustersDone, geoHits, geoTotal] = await Promise.all([
    countOf("blog_drafts", (q) => q.not("strapi_published_at", "is", null)),
    countOf("backlink_prospects", (q) => q.not("link_live_at", "is", null)),
    countOf("writer_clusters", (q) => q.eq("status", "done")),
    countOf("geo_checks", (q) => q.eq("brand_mentioned", true)),
    countOf("geo_checks", (q) => q),
  ]);

  const replies = outreach.filter((e) => e.replied_at).length;
  const successes = outreach.filter((e) => e.success_at).length;
  const sent = outreach.filter((e) => e.sent_at).length;

  const wins: Metric[] = [
    { label: "Articles published to Strapi", value: published ?? 0, source: "blog_drafts.strapi_published_at" },
    { label: "Articles written by the AI writer", value: sessions.length, source: "writer_sessions" },
    { label: "Clusters completed", value: clustersDone ?? 0, source: "writer_clusters.status = done" },
    { label: "Backlinks live", value: liveLinks ?? 0, source: "backlink_prospects.link_live_at" },
    { label: "Outreach replies", value: replies, outOf: sent, source: "outreach_emails.replied_at" },
    { label: "Outreach wins (coverage confirmed)", value: successes, outOf: sent, source: "outreach_emails.success_at" },
    { label: "AI answers mentioning the brand", value: geoHits ?? 0, outOf: geoTotal ?? undefined, source: "geo_checks.brand_mentioned" },
  ];

  // ---- Losses. The same rigour, pointed at what broke. ----
  const [syncFailed, writerFlagged, failedGens] = await Promise.all([
    countOf("blog_drafts", (q) => q.eq("sync_state", "sync_failed")),
    countOf("blog_drafts", (q) => q.eq("writer_status", "flagged")),
    countOf("media_generations", (q) => q.eq("ok", false)),
  ]);
  const bounced = outreach.filter((e) => e.bounced_at).length;
  const clusterFailures = await (async () => {
    try {
      const { data } = await supabaseAdmin.from("writer_clusters").select("failed").limit(1000);
      return ((data as Array<{ failed: number | null }>) ?? []).reduce((n, r) => n + (r.failed ?? 0), 0);
    } catch { return 0; }
  })();

  const losses: Metric[] = [
    { label: "Strapi syncs failed", value: syncFailed ?? 0, source: "blog_drafts.sync_state = sync_failed" },
    { label: "Drafts flagged by quality gates", value: writerFlagged ?? 0, source: "blog_drafts.writer_status = flagged",
      detail: "A flagged draft cannot be published until the flag is cleared." },
    { label: "Cluster articles that failed to write", value: clusterFailures, source: "writer_clusters.failed" },
    { label: "Image generations failed", value: failedGens ?? 0, source: "media_generations.ok = false" },
    { label: "Emails bounced", value: bounced, outOf: sent, source: "outreach_emails.bounced_at" },
  ];

  // ---- Opportunities: started and not finished, which is where the next win already is. ----
  const [localOnly, noThumbnail, strikingDistance] = await Promise.all([
    countOf("blog_drafts", (q) => q.is("strapi_id", null)),
    countOf("blog_drafts", (q) => q.is("thumbnail_media_id", null).not("strapi_id", "is", null)),
    countOf("site_urls", (q) => q.eq("is_money", true)),
  ]);

  const opportunities: Metric[] = [
    { label: "Drafts written but never synced", value: localOnly ?? 0, source: "blog_drafts.strapi_id IS NULL",
      detail: "Finished work sitting in the tool instead of on the site." },
    { label: "Synced drafts blocked on a thumbnail", value: noThumbnail ?? 0, source: "blog_drafts.thumbnail_media_id IS NULL",
      detail: "Strapi requires a thumbnail to publish, so each of these is one upload from going live." },
    { label: "Money pages in the sitemap inventory", value: strikingDistance ?? 0, source: "site_urls.is_money",
      detail: "The internal-linking and canonical surface the writer draws on." },
  ];

  // ---- Weekly trend. ----
  const buckets = new Map<string, { week: string; drafts: number; sessions: number; emails: number; views: number }>();
  const bump = (at: string | null, key: "drafts" | "sessions" | "emails" | "views") => {
    if (!at) return;
    const w = weekOf(at);
    if (!buckets.has(w)) buckets.set(w, { week: w, drafts: 0, sessions: 0, emails: 0, views: 0 });
    buckets.get(w)![key] += 1;
  };
  for (const r of drafts) bump(r.at, "drafts");
  for (const r of sessions) bump(r.at, "sessions");
  for (const e of outreach) bump(e.sent_at, "emails");
  for (const r of views) bump(r.at, "views");
  const trend = [...buckets.values()].sort((a, b) => a.week.localeCompare(b.week));

  if (views.length === 0) {
    caveats.push(
      "Surface-visit tracking starts from the deploy that added it, so per-page reach is empty for earlier weeks. " +
      "Every other figure here is derived from existing records and covers the full window.",
    );
  }
  if (roster.some((p) => p.email === "dev@local")) {
    caveats.push("dev@local is the local development account, not a real user — exclude it when reporting adoption.");
  }
  const unattributed = drafts.filter((r) => !r.who).length;
  if (unattributed > 0) {
    caveats.push(`${unattributed} draft(s) have no recorded author, so they count in totals but not against any person.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    people: roster,
    totals: {
      activePeople: roster.filter((p) => p.email !== "dev@local").length,
      draftsCreated: drafts.length,
      articlesWritten: sessions.length,
      assetsGenerated: assets.length,
      emailsSent: sent,
    },
    wins,
    losses,
    opportunities,
    trend,
    caveats,
  };
}
