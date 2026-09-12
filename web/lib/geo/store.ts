// Reads and writes for the GEO tables.
import { supabaseAdmin } from "@/lib/db/supabase";
import { AI_BOTS, identifyBot, type AiBot } from "./bots";
import { AI_REFERRERS, identifyReferrer } from "./referrers";

export interface IngestLine {
  /** Raw User-Agent. A line with no bot match and no AI referrer is dropped. */
  user_agent?: string | null;
  referrer?: string | null;
  path?: string | null;
  status?: number | null;
  host?: string | null;
  ip?: string | null;
  country?: string | null;
  /** ISO timestamp. Defaults to now when a log format does not carry one. */
  at?: string | null;
}

export interface IngestResult {
  received: number;
  bot_hits: number;
  referrals: number;
  /** Lines that were neither an AI crawler nor an AI referral — the overwhelming majority. */
  ignored: number;
  unknown_bots: string[];
}

/**
 * Take a batch of access-log lines and keep only the two kinds we care about.
 *
 * Filtering happens HERE rather than at the sender, because the sender is a log drain on another
 * project and pushing our taxonomy into its config would mean redeploying northwind.example every time a new
 * AI crawler appears. The trade is bandwidth: we accept every line and throw most away. That is the
 * right side of the trade — a missed crawler is invisible for months, and bytes are cheap.
 */
export async function ingestLines(lines: IngestLine[]): Promise<IngestResult> {
  const out: IngestResult = { received: lines.length, bot_hits: 0, referrals: 0, ignored: 0, unknown_bots: [] };
  const hits: Array<Record<string, unknown>> = [];
  const refs: Array<Record<string, unknown>> = [];
  const unknown = new Set<string>();

  for (const l of lines) {
    const at = l.at && !Number.isNaN(Date.parse(l.at)) ? new Date(l.at).toISOString() : new Date().toISOString();
    const path = (l.path ?? "").slice(0, 2000) || "/";
    const bot = identifyBot(l.user_agent);

    if (bot) {
      hits.push({
        bot: bot.key, user_agent: (l.user_agent ?? "").slice(0, 500), path,
        status: typeof l.status === "number" ? l.status : null,
        host: l.host ?? null, ip: l.ip ?? null, hit_at: at,
      });
      continue;
    }

    const ref = identifyReferrer(l.referrer);
    if (ref) {
      refs.push({
        engine: ref.engine, referrer: (l.referrer ?? "").slice(0, 1000),
        landing_path: path, country: l.country ?? null, hit_at: at,
      });
      continue;
    }

    // An unrecognised agent that still looks like a robot. Collected and reported so a NEW AI crawler
    // shows up as a name to add rather than as silence — the failure mode this whole surface exists to
    // prevent is a crawler we never knew to look for.
    const ua = (l.user_agent ?? "").toLowerCase();
    if (ua && /bot|crawler|spider|gpt|ai\b|llm/.test(ua)) unknown.add((l.user_agent ?? "").slice(0, 120));
    out.ignored += 1;
  }

  if (hits.length) {
    const { error } = await supabaseAdmin.from("geo_bot_hits").insert(hits);
    if (error) throw error;
    out.bot_hits = hits.length;
  }
  if (refs.length) {
    const { error } = await supabaseAdmin.from("geo_referrals").insert(refs);
    if (error) throw error;
    out.referrals = refs.length;
  }
  out.unknown_bots = [...unknown].slice(0, 25);
  return out;
}

export interface BotStatus extends AiBot {
  hits: number;
  last_seen: string | null;
  /** Distinct paths fetched — a bot that only ever hits "/" is not really reading the site. */
  paths: number;
  /** Any non-2xx we served it. A 403 to a retrieval bot is the worst finding on this page. */
  blocked: number;
}

/**
 * Crawler access, one row per known bot INCLUDING the ones with no hits.
 *
 * Absence is the finding, so the zero rows have to be rendered. A dashboard that lists only what it
 * saw cannot tell you that OAI-SearchBot has never once visited — which is precisely the thing worth
 * knowing, and precisely what a GROUP BY over a hits table silently omits.
 */
export async function botStatus(days = 30): Promise<BotStatus[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("geo_bot_hits").select("bot,path,status,hit_at").gte("hit_at", since).limit(50_000);
  if (error) throw error;

  const byBot = new Map<string, { hits: number; last: string | null; paths: Set<string>; blocked: number }>();
  for (const r of data ?? []) {
    const k = r.bot as string;
    const e = byBot.get(k) ?? { hits: 0, last: null, paths: new Set<string>(), blocked: 0 };
    e.hits += 1;
    e.paths.add(r.path as string);
    const s = r.status as number | null;
    if (typeof s === "number" && s >= 400) e.blocked += 1;
    const t = r.hit_at as string;
    if (!e.last || t > e.last) e.last = t;
    byBot.set(k, e);
  }

  return AI_BOTS.map((b) => {
    const e = byBot.get(b.key);
    return {
      ...b,
      hits: e?.hits ?? 0,
      last_seen: e?.last ?? null,
      paths: e ? e.paths.size : 0,
      blocked: e?.blocked ?? 0,
    };
  });
}

export interface ReferralSummary {
  engine: string;
  /** The product's own capitalisation — "ChatGPT", not a title-cased key. */
  label: string;
  visits: number;
  last_seen: string | null;
  top_paths: Array<{ path: string; visits: number }>;
}

export async function referralSummary(days = 30): Promise<{ total: number; engines: ReferralSummary[] }> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("geo_referrals").select("engine,landing_path,hit_at").gte("hit_at", since).limit(50_000);
  if (error) throw error;

  const byEngine = new Map<string, { visits: number; last: string | null; paths: Map<string, number> }>();
  for (const r of data ?? []) {
    const k = r.engine as string;
    const e = byEngine.get(k) ?? { visits: 0, last: null, paths: new Map<string, number>() };
    e.visits += 1;
    const p = r.landing_path as string;
    e.paths.set(p, (e.paths.get(p) ?? 0) + 1);
    const t = r.hit_at as string;
    if (!e.last || t > e.last) e.last = t;
    byEngine.set(k, e);
  }

  const engines = [...byEngine.entries()]
    .map(([engine, e]) => ({
      engine,
      label: AI_REFERRERS.find((r) => r.engine === engine)?.label ?? engine,
      visits: e.visits, last_seen: e.last,
      top_paths: [...e.paths.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([path, visits]) => ({ path, visits })),
    }))
    .sort((a, b) => b.visits - a.visits);

  return { total: data?.length ?? 0, engines };
}
