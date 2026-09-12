// Slack digest for the daily broken-link audit. The findings list is rendered
// deterministically (links, authors, tags must be exact); the LLM only writes the short
// intro/summary line, with a plain fallback if the AI call fails. Author tagging uses an
// admin-maintained name→Slack-member-ID map (a webhook can't look up user IDs itself).
import { supabaseAdmin } from "@/lib/db/supabase";
import { redis } from "@/lib/redis";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { llmChat } from "@/lib/providers/llm";
import { HARD_BROKEN_REASONS, diffRunLinks } from "@/lib/linkaudit/run";
import { isGscConfigured, searchAnalytics, daysAgo } from "@/lib/indexing/gsc";

const WEBHOOK_KEY = "linkaudit:webhook";
const SLACKMAP_KEY = "linkaudit:slackmap";
const BOT_TOKEN_KEY = "linkaudit:bottoken";
const USERS_CACHE_KEY = "linkaudit:slackusers";

// ─── Webhook + author-map storage (webhook stored encrypted, never returned) ──────

export async function getWebhook(): Promise<string | null> {
  const r = redis();
  if (r) {
    const enc = await r.get<string>(WEBHOOK_KEY).catch(() => null);
    const dec = decryptSecret(enc);
    if (dec) return dec;
  }
  return process.env.SLACK_BROKEN_LINKS_WEBHOOK ?? null;
}

export async function setWebhook(url: string): Promise<void> {
  const r = redis();
  if (!r) throw new Error("Redis not configured — can't store the webhook");
  await r.set(WEBHOOK_KEY, encryptSecret(url.trim()));
}

export async function hasWebhook(): Promise<boolean> {
  return !!(await getWebhook());
}

export async function getSlackMap(): Promise<Record<string, string>> {
  const r = redis();
  if (!r) return {};
  const raw = await r.get<any>(SLACKMAP_KEY).catch(() => null);
  return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
}

export async function setSlackMap(map: Record<string, string>): Promise<void> {
  const r = redis();
  if (!r) throw new Error("Redis not configured");
  await r.set(SLACKMAP_KEY, JSON.stringify(map));
}

// ─── Bot token + workspace user directory (for automatic name→@mention) ──────────
// An incoming webhook can't list users; auto-tagging needs a bot token (xoxb-…, scope
// users:read). Stored encrypted, never returned. Directory cached 12h in Redis.

export async function setBotToken(token: string): Promise<void> {
  const r = redis();
  if (!r) throw new Error("Redis not configured");
  await r.set(BOT_TOKEN_KEY, encryptSecret(token.trim()));
  await r.del(USERS_CACHE_KEY).catch(() => {}); // new token → refetch directory
}

// Roll back a token that failed validation — never leave a broken token wedged in as
// "configured" (everything must keep working token-less until a good one arrives).
export async function clearBotToken(): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.del(BOT_TOKEN_KEY).catch(() => {});
  await r.del(USERS_CACHE_KEY).catch(() => {});
}

// Exported so lib/slack/post.ts can use chat.postMessage. The webhook cannot pick a channel or
// reply in a thread; this token is the only path that can.
//
// Falls back to SLACK_BOT_TOKEN the same way getWebhook() falls back to
// SLACK_BROKEN_LINKS_WEBHOOK — and for the same reason. The token is what every automated
// content-publish notification (a ready blog draft, a landing-page announcement, an Atlas
// draft) depends on to tag the right people and post into a thread. A secret that exists ONLY
// in Redis, entered once through a settings page, is one accidental cache flush away from every
// unattended cron silently reverting to the webhook — untagged, unthreaded — with nothing
// louder than a buried `error` field in a JSON response nobody is watching. An env var set
// alongside the other deploy-time secrets (FAL_KEY, STRAPI_API_TOKEN) survives that.
//
// The UI path still exists and is still worth using: saving through Site Audit → Broken links
// validates the token live (calls users.list before accepting it) and lets a non-engineer
// rotate it without a redeploy. Whichever is set wins; Redis is checked first only because it
// is where a live rotation lands.
export async function getBotToken(): Promise<string | null> {
  const r = redis();
  if (r) {
    const dec = decryptSecret(await r.get<string>(BOT_TOKEN_KEY).catch(() => null));
    if (dec) return dec;
  }
  return process.env.SLACK_BOT_TOKEN?.trim() || null;
}

// Reuses getBotToken() rather than a second Redis read, so this can never disagree with the
// value chat.postMessage actually uses — the two reporting different answers is exactly the
// inconsistency that made the missing env fallback hard to notice in the first place.
export async function hasBotToken(): Promise<boolean> {
  return !!(await getBotToken());
}

export interface SlackUser { id: string; names: string[] }

export async function fetchSlackUsers(): Promise<SlackUser[]> {
  const r = redis();
  if (r) {
    const cached = await r.get<any>(USERS_CACHE_KEY).catch(() => null);
    if (cached) return typeof cached === "string" ? JSON.parse(cached) : cached;
  }
  const token = await getBotToken();
  if (!token) return [];
  const users: SlackUser[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) { // safety cap: 10 × 200 members
    const params = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
    const res = await fetch(`https://slack.com/api/users.list?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) break;
    const data = await res.json();
    if (!data.ok) break;
    for (const m of data.members ?? []) {
      if (m.deleted || m.is_bot || m.id === "USLACKBOT") continue;
      const names = [m.real_name, m.profile?.real_name, m.profile?.display_name, m.name]
        .filter(Boolean).map((n: string) => n.trim()).filter((n: string) => n.length > 1);
      if (names.length > 0) users.push({ id: m.id, names: [...new Set(names)] });
    }
    cursor = data.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  if (r && users.length > 0) await r.set(USERS_CACHE_KEY, JSON.stringify(users), { ex: 60 * 60 * 12 }).catch(() => {});
  return users;
}

// ─── Fuzzy name matching ──────────────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// Match a page-author name against the workspace directory. Tiered: exact normalized name →
// all author tokens present in a user's name → small edit distance. Ambiguity (two different
// users matching a tier) returns null — never ping the wrong person.
export function fuzzyMatchUser(author: string, users: SlackUser[]): string | null {
  const a = norm(author);
  if (!a || a.length < 3) return null;
  const aTokens = a.split(" ").filter((t) => t.length > 1);
  const tiers: ((userName: string) => boolean)[] = [
    (n) => n === a,
    (n) => aTokens.length >= 2 && aTokens.every((t) => n.split(" ").some((w) => w === t || w.startsWith(t))),
    (n) => Math.abs(n.length - a.length) <= 3 && editDistance(n, a) <= 2,
  ];
  for (const matches of tiers) {
    const hits = new Set<string>();
    for (const u of users) {
      if (u.names.some((name) => matches(norm(name)))) hits.add(u.id);
    }
    if (hits.size === 1) return [...hits][0];
    if (hits.size > 1) return null; // ambiguous — safer to show the plain name
  }
  return null;
}

// Resolve a set of author names to member IDs: manual map wins, then fuzzy directory match.
export async function resolveAuthorIds(authors: string[]): Promise<Record<string, string>> {
  const map = await getSlackMap();
  const users = await fetchSlackUsers().catch(() => [] as SlackUser[]);
  const out: Record<string, string> = {};
  for (const author of authors) {
    const manual = map[author] ?? map[author.toLowerCase()];
    const id = manual ?? (users.length > 0 ? fuzzyMatchUser(author, users) : null);
    if (id) out[author] = id;
  }
  return out;
}

// ─── Digest composition ────────────────────────────────────────────────────────

interface Finding {
  page_url: string; page_author: string | null;
  link_url: string; anchor_text: string | null; context_text: string | null;
  reason: string; http_status: number | null;
  location_hint?: string | null;
  pages_seen?: number | null;
  resolved_at?: string | null;
  page_listed?: boolean | null;
  draft_target?: boolean | null;
}

const REASON_LABEL: Record<string, string> = {
  "http-404": "404", "http-410": "410 gone", "soft-404": "soft 404 (page says not found)", "homepage-redirect": "redirects to homepage",
  "http-5xx": "500 error on our own site", "dead-page": "dead page listed in the sitemap",
  "redirect-chain": "redirect chain", "temp-redirect": "temporary redirect (302)",
  "js-only-link": "only exists after JavaScript", "render-failed": "couldn't render",
};

// Redirect hygiene is a quality report, not breakage — rendered in its own section, never
// counted as broken, never @-pinging a writer.
const REDIRECT_REASONS = new Set(["redirect-chain", "temp-redirect"]);

// JS-links detector rows: hidden-but-working links and unrendered pages are visibility
// problems, not breakage — own sections. (A hidden link that is ALSO dead files under its
// real broken reason and lands in the broken section like any other finding.)
const JS_REASONS = new Set(["js-only-link", "render-failed"]);

// `resolved` comes from resolveAuthorIds(): manual map first, then fuzzy directory match.
function authorTag(author: string | null, resolved: Record<string, string>): string {
  if (!author) return "_no author on file_";
  const id = resolved[author];
  return id ? `<@${id}>` : author;
}

// Only quote surrounding text when it reads like prose. Links in navs/footers sit between
// short Titlecase labels ("Privacy Policy Terms & Conditions Help Center Career") — quoting
// that is noise, so those get no quote line; the link text alone identifies them.
function isProseContext(ctx: string): boolean {
  const words = ctx.split(/\s+/).filter(Boolean);
  if (words.length < 8 || ctx.length < 50) return false;
  const capitalized = words.filter((w) => /^[A-Z&|·•>-]/.test(w)).length;
  return capitalized / words.length < 0.5;
}

// Ask the LLM to pinpoint WHERE on the page a link sits, from its anchor + surrounding text —
// "the 'View All' button in the Northwind for Teams section" beats a raw text quote,
// especially when the same anchor text ("View All") appears many times on one page.
// Exported: the run's finalize step computes this once per broken link and persists it
// (findings.location_hint) so the page AND the digest show the same human explanation.
export async function aiLocateFinding(f: Pick<Finding, "page_url" | "anchor_text" | "link_url" | "context_text">): Promise<string | null> {
  try {
    // No model/temperature/max_tokens/timeout here on purpose. This used to pin Haiku with
    // temperature 0, a 60-token cap and a 12s abort; on a frontier model temperature is a hard
    // 400, and 60 tokens is swallowed whole by thinking before a single word of answer. Both
    // fail as an empty string, which this function reads as "no location" — invisible forever.
    // The output guard below (length < 170) is what actually keeps the phrase short.
    // Bounded, unlike the intro call below. This one runs in two sequential loops — up to 30 per
    // audit in run.ts and up to MAX_AI_LOCATIONS more while composing the digest — so the helper's
    // 90s frontier floor would put the worst case at 45 minutes inside a request that has a few
    // hundred seconds to live. `hardTimeout` trades a missing location hint (the digest already
    // renders fine without one) for a bounded runtime. Parallelising these loops would let the
    // bound go back up; until then, cap it.
    const res = await llmChat({
      timeoutMs: 20_000,
      hardTimeout: true,
      prompt: `A broken link was found on the page ${new URL(f.page_url).pathname}.
Link text: "${f.anchor_text || "(none — likely an icon or image link)"}"
Broken URL: ${f.link_url}
${f.context_text ? `Text surrounding the link on the page: "${f.context_text}"` : "No readable surrounding text was captured — the link probably sits in the site header, footer, or a social-icons row."}

In ONE short phrase (max 18 words), tell a writer in plain human words exactly where on the page this link sits, e.g. "the 'View All' button next to the Northwind for Teams category heading" or "the YouTube icon in the site footer's social links". Reply with ONLY the phrase. No placeholders, no quotes around the whole phrase.`,
    });
    if (!res) return null; // same degradation as the old non-2xx/abort path: no hint, plain digest
    const out = res.content.trim().replace(/^["']|["']$/g, "");
    return out && out.length < 170 && !/\[[^\]]+\]/.test(out) ? out : null;
  } catch {
    return null;
  }
}

// Group findings by broken link so a site-wide dead nav link is one entry, not hundreds.
// EVERY broken link and EVERY page it appears on goes in the digest — nothing truncated —
// split into "Authored" first (actionable per writer) then "No author", with continuous
// numbering. Long digests are split across multiple Slack posts by the caller.
const MAX_AI_LOCATIONS = 12; // live AI-locate cap for older runs; new runs have persisted hints
async function renderFindings(findings: Finding[], resolved: Record<string, string>, tags?: Record<string, string>, opts?: { pagesRun?: boolean }): Promise<string> {
  const byLink = new Map<string, Finding[]>();
  for (const f of findings) {
    (byLink.get(f.link_url) ?? byLink.set(f.link_url, []).get(f.link_url)!).push(f);
  }
  // A link-group is "authored" when any page it sits on has a known author.
  const authored: Array<[string, Finding[]]> = [];
  const unauthored: Array<[string, Finding[]]> = [];
  for (const entry of byLink.entries()) {
    (entry[1].some((f) => f.page_author) ? authored : unauthored).push(entry);
  }

  const lines: string[] = [];
  let aiCalls = 0;
  let n = 0;
  const renderGroup = async ([link, fs]: [string, Finding[]]) => {
    n++;
    const first = fs[0];
    const label = REASON_LABEL[first.reason] ?? first.reason;
    const tag = tags?.[link] ? ` · ${tags[link]}` : "";
    // pages_seen is the crawl-wide count; the rows below are capped samples of it.
    const seen = first.pages_seen && first.pages_seen > fs.length
      ? `  — seen on ${first.pages_seen} pages site-wide (${fs.length} shown)` : "";
    lines.push(`*${n}.* ${link}  _(${label}${tag})_${seen}`);
    // Prefer the hint persisted at capture/finalize; live AI call only for older runs.
    const location = first.location_hint ?? (opts?.pagesRun ? null : (aiCalls < MAX_AI_LOCATIONS ? (aiCalls++, await aiLocateFinding(first)) : null));
    if (location) lines.push(`   📍 ${location}`);
    // Page-sweep rows are the page itself (page_url = link_url) — an "on <page>" line under
    // each would just repeat the URL, so sweeps render the group line + hint only.
    if (!opts?.pagesRun) {
      for (const f of fs) {
        const ctx = (f.context_text ?? "").slice(0, 160);
        lines.push(`   ↳ on <${f.page_url}|${new URL(f.page_url).pathname}> — by ${authorTag(f.page_author, resolved)}${f.anchor_text ? ` — link text: "${f.anchor_text.slice(0, 60)}"` : ""}`);
        if (!location && ctx && isProseContext(ctx)) lines.push(`      _"…${ctx}…"_`);
      }
    }
    lines.push("--------------------"); // divider between entries for readability
  };

  if (opts?.pagesRun) {
    lines.push(`:boom: *Broken pages (${byLink.size})* — the sitemap lists them; they don't answer as pages`);
    for (const g of byLink.entries()) await renderGroup(g);
    return lines.join("\n");
  }

  if (authored.length > 0) {
    lines.push(`:writing_hand: *Authored pages (${authored.length} broken link${authored.length === 1 ? "" : "s"})*`);
    for (const g of authored) await renderGroup(g);
  }
  if (unauthored.length > 0) {
    if (authored.length > 0) lines.push("");
    lines.push(`:page_facing_up: *Pages without an author (${unauthored.length} broken link${unauthored.length === 1 ? "" : "s"})*`);
    for (const g of unauthored) await renderGroup(g);
  }
  return lines.join("\n");
}

// Split a long digest into Slack-friendly posts on line boundaries — Slack visually
// truncates very long single messages, so ~3500 chars per post keeps every link readable.
function chunkForSlack(text: string, maxLen = 3500): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > maxLen && cur) { chunks.push(cur); cur = ""; }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Renamed off "haiku": the model is no longer pinned here, it comes from DEFAULT_LLM_MODEL.
async function aiIntro(stats: { pages: number; links: number; broken: number; authors: string[] }): Promise<string | null> {
  // temperature 0.5 dropped — frontier models 400 on any sampling param, and a 400 costs the
  // whole intro (caller falls back to the flat stats sentence). The mild variety it bought is
  // not worth that. The 120-token cap and 15s abort are gone for the same reason: on a model
  // that thinks first they truncate to "" / abort, which is indistinguishable from a refusal.
  const res = await llmChat({
    prompt: `Write a 1-2 sentence friendly Slack intro for a daily broken-link report on northwind.example. Stats: ${stats.pages} pages crawled, ${stats.links} links checked, ${stats.broken} broken links found${stats.authors.length ? `, affected authors: ${stats.authors.join(", ")}` : ""}. Plain text, no markdown headers, no emojis beyond one at most, no placeholders. Just the intro sentence(s), nothing else.`,
  });
  if (!res) return null; // caller substitutes the deterministic one-line summary
  const out = res.content.trim();
  return out && !/\[[^\]]+\]/.test(out) ? out : null;
}

export async function postToSlack(text: string): Promise<{ ok: boolean; error?: string }> {
  const webhook = await getWebhook();
  if (!webhook) return { ok: false, error: "No Slack webhook configured" };
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `Slack HTTP ${res.status}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "post failed" };
  }
}

// "Which section first?" — broken links grouped by first path segment, ranked by the search
// traffic behind each section when GSC is configured (the roadmap's explicit tie-breaker:
// by traffic, not by count), by affected-page count otherwise. Null when there's only one
// section — a ranking of one is noise.
async function sectionSummary(fs: Finding[]): Promise<string | null> {
  if (fs.length === 0) return null;
  const sectionOf = (url: string) => {
    try { const seg = new URL(url).pathname.split("/").filter(Boolean)[0]; return seg ? `/${seg}` : "/"; } catch { return "/"; }
  };
  const bySection = new Map<string, { links: Set<string>; pages: Set<string> }>();
  for (const f of fs) {
    const s = bySection.get(sectionOf(f.page_url)) ?? { links: new Set<string>(), pages: new Set<string>() };
    s.links.add(f.link_url); s.pages.add(f.page_url);
    bySection.set(sectionOf(f.page_url), s);
  }
  if (bySection.size < 2) return null;

  // Best-effort traffic weights; searchAnalytics returns [] on any failure, and [] must not
  // render as "0 clicks" next to every section — no data means no click numbers at all.
  let clicks: Map<string, number> | null = null;
  if (isGscConfigured()) {
    const rows = await searchAnalytics({ startDate: daysAgo(28), endDate: daysAgo(1), dimensions: ["page"], rowLimit: 5000 });
    if (rows.length > 0) {
      clicks = new Map();
      for (const r of rows) {
        const section = sectionOf(r.keys[0] ?? "");
        clicks.set(section, (clicks.get(section) ?? 0) + r.clicks);
      }
    }
  }
  const ranked = [...bySection.entries()].sort((a, b) =>
    clicks ? (clicks.get(b[0]) ?? 0) - (clicks.get(a[0]) ?? 0) : b[1].pages.size - a[1].pages.size);
  const lines = ranked.map(([section, s]) => {
    const c = clicks?.get(section);
    return `• *${section}* — ${s.links.size} broken link${s.links.size === 1 ? "" : "s"} on ${s.pages.size} page${s.pages.size === 1 ? "" : "s"}${c != null ? ` · ${c.toLocaleString()} clicks/28d` : ""}`;
  });
  return `:dart: *Where to fix first${clicks ? " (ranked by search traffic)" : ""}*\n${lines.join("\n")}`;
}

// Run-over-run comparison for the digest: what's new, what persists, what got fixed, and
// which "new" links are actually regressions (an older run saw them verified fixed).
async function runComparison(run: { id: string; started_at: string; kind?: string | null }, curLinks: string[]): Promise<{ summary: string; tags: Record<string, string> } | null> {
  const { data: prevRun } = await supabaseAdmin
    .from("link_audit_runs").select("id").eq("status", "completed")
    .eq("kind", run.kind ?? "links") // link crawls diff against link crawls, sweeps against sweeps
    .neq("id", run.id).lt("started_at", run.started_at)
    .order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (!prevRun) return null;
  const { data: prevRows } = await supabaseAdmin
    .from("link_audit_findings").select("link_url, reason").eq("run_id", prevRun.id);
  const prev = [...new Set((prevRows ?? []).filter((r) => HARD_BROKEN_REASONS.has(r.reason)).map((r) => r.link_url as string))];
  const d = diffRunLinks(prev, curLinks);

  let regressed = new Set<string>();
  if (d.newLinks.length > 0) {
    const { data: reg } = await supabaseAdmin
      .from("link_audit_findings").select("link_url")
      .in("link_url", d.newLinks.slice(0, 100)).not("resolved_at", "is", null);
    regressed = new Set((reg ?? []).map((r) => r.link_url as string));
  }

  const tags: Record<string, string> = {};
  for (const l of d.newLinks) tags[l] = regressed.has(l) ? "REGRESSED — was fixed before" : "NEW";
  const parts = [
    `${d.newLinks.length} new`,
    `${d.persisting.length} persisting`,
    `${d.fixed.length} fixed since last run :white_check_mark:`,
  ];
  if (regressed.size > 0) parts.push(`:rotating_light: ${regressed.size} regression${regressed.size === 1 ? "" : "s"}`);
  return { summary: `:mag: vs last run: ${parts.join(" · ")}`, tags };
}

// The redirect-hygiene section: alive-but-badly-plumbed links. The traced chain lives in
// location_hint (stamped at capture time), so this renders without any network calls.
function renderRedirectIssues(rs: Finding[]): string {
  const byLink = new Map<string, Finding[]>();
  for (const f of rs) (byLink.get(f.link_url) ?? byLink.set(f.link_url, []).get(f.link_url)!).push(f);
  const lines: string[] = [`:twisted_rightwards_arrows: *Redirect hygiene (${byLink.size})* — working, but worth a proper 301`];
  let n = 0;
  for (const [link, fs] of byLink) {
    n++;
    lines.push(`*${n}.* ${link}  _(${REASON_LABEL[fs[0].reason] ?? fs[0].reason})_`);
    if (fs[0].location_hint) lines.push(`   ↳ ${fs[0].location_hint}`);
    lines.push(`   ↳ linked from <${fs[0].page_url}|${(() => { try { return new URL(fs[0].page_url).pathname; } catch { return fs[0].page_url; } })()}>`);
  }
  return lines.join("\n");
}

// Links whose broken target still exists in the CMS as an unpublished draft. Compact on
// purpose: this is an editorial queue (publish the post, or drop the link), not a list a
// writer walks page by page — the full rows live in the site-audit panel.
function renderDraftTargets(fs: Finding[]): string {
  const byLink = new Map<string, Finding[]>();
  for (const f of fs) (byLink.get(f.link_url) ?? byLink.set(f.link_url, []).get(f.link_url)!).push(f);
  const pages = new Set(fs.map((f) => f.page_url)).size;
  const lines = [
    `:construction: *Links to unpublished drafts (${byLink.size} link${byLink.size === 1 ? "" : "s"} on ${pages} page${pages === 1 ? "" : "s"})* — each target still exists in the CMS as a draft: publish it, or remove/replace the link`,
  ];
  const ranked = [...byLink.entries()].sort((a, b) => (b[1][0].pages_seen ?? b[1].length) - (a[1][0].pages_seen ?? a[1].length));
  let n = 0;
  for (const [link, group] of ranked.slice(0, 12)) {
    n++;
    const seen = group[0].pages_seen ?? group.length;
    lines.push(`*${n}.* ${link} — linked from ${seen} page${seen === 1 ? "" : "s"}`);
  }
  if (byLink.size > 12) lines.push(`…and ${byLink.size - 12} more — the full list is in the site-audit panel.`);
  return lines.join("\n");
}

// Findings on pages the live sitemap does not list (drafts, retired URLs still reachable via
// links). The page is the unit of work here — fix or retire IT before polishing its links.
function renderUnlistedPages(fs: Finding[]): string {
  const byPage = new Map<string, Finding[]>();
  for (const f of fs) (byPage.get(f.page_url) ?? byPage.set(f.page_url, []).get(f.page_url)!).push(f);
  const lines = [
    `:ghost: *Findings on unlisted pages (${byPage.size} page${byPage.size === 1 ? "" : "s"})* — not in the sitemap, but still reachable via links; decide the page's fate before fixing its links`,
  ];
  let n = 0;
  for (const [pageUrl, group] of [...byPage.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
    n++;
    const path = (() => { try { return new URL(pageUrl).pathname || "/"; } catch { return pageUrl; } })();
    lines.push(`*${n}.* <${pageUrl}|${path}> — ${group.length} finding${group.length === 1 ? "" : "s"} (${[...new Set(group.map((f) => REASON_LABEL[f.reason] ?? f.reason))].slice(0, 3).join(", ")})`);
  }
  if (byPage.size > 10) lines.push(`…and ${byPage.size - 10} more page(s) — the full list is in the site-audit panel.`);
  return lines.join("\n");
}

// Compose the digest text for a run WITHOUT posting — used by postAuditDigest and by
// anything that needs the full text (e.g. copying it into an email).
export async function composeAuditDigest(runId: string): Promise<{ text: string } | { error: string }> {
  const [{ data: run }, { data: findings }] = await Promise.all([
    supabaseAdmin.from("link_audit_runs").select("*").eq("id", runId).single(),
    supabaseAdmin.from("link_audit_findings").select("*").eq("run_id", runId).order("link_url"),
  ]);
  if (!run) return { error: "run not found" };

  // A page sweep or detector run reads differently: deterministic numbers, no AI intro
  // needed to dress up "1,501 pages, 3 broken".
  const pagesRun = run.kind === "pages";
  const jsRun = run.kind === "jslinks";

  const all = (findings ?? []) as Finding[];
  const redirects = all.filter((f) => REDIRECT_REASONS.has(f.reason));
  const jsOnly = all.filter((f) => f.reason === "js-only-link");
  const renderFailed = all.filter((f) => f.reason === "render-failed");
  const fsAll = all.filter((f) => f.reason !== "unreachable" && !REDIRECT_REASONS.has(f.reason) && !JS_REASONS.has(f.reason));
  // The team ask (Aug 31): the headline is broken links ON live sitemap pages. Links whose
  // target is an unpublished CMS draft are an editorial queue (publish or drop the link), and
  // findings on pages the sitemap doesn't list are a page-level cleanup — both real, both
  // rendered below, neither allowed to bury the list a writer actually works through.
  const splitApplies = !pagesRun && !jsRun;
  const draftFs = splitApplies ? fsAll.filter((f) => f.draft_target === true) : [];
  const unlistedFs = splitApplies ? fsAll.filter((f) => f.draft_target !== true && f.page_listed === false) : [];
  const fs = splitApplies ? fsAll.filter((f) => f.draft_target !== true && f.page_listed !== false) : fsAll;
  const authors = [...new Set(fs.map((f) => f.page_author).filter(Boolean))] as string[];
  // Auto-@: manual map overrides, then fuzzy match against the workspace directory.
  const resolved = await resolveAuthorIds(authors);
  const stats = { pages: run.pages_checked, links: run.links_checked, broken: run.broken_found, authors };

  // The run-over-run diff stays computed over ALL hard-broken links (drafts included) — a
  // draft link that leaves this list did so because somebody published or unlinked it, and
  // "fixed" must keep meaning that, not "we re-labeled it".
  const curLinks = [...new Set(fsAll.filter((f) => HARD_BROKEN_REASONS.has(f.reason)).map((f) => f.link_url))];
  // Comparison + section ranking are reporting extras — a failure in either must not cost the digest.
  const comparison = await runComparison(run, curLinks).catch(() => null);
  const sections = await sectionSummary(fs).catch(() => null);
  const intro = pagesRun
    ? `Sitemap page sweep: checked ${stats.pages} pages listed in the sitemap — ${stats.broken} broken, ${run.unreachable ?? 0} didn't answer.`
    : jsRun
      ? `JS-link detector: rendered ${stats.pages} pages with scripts executing — ${run.links_checked ?? 0} link(s) exist only after JavaScript runs (invisible to Google's first wave and every AI crawler), ${stats.broken} of them broken. ${run.unreachable ?? 0} page(s) couldn't be rendered.`
      : (await aiIntro(stats))
        ?? `Daily link audit for northwind.example: crawled ${stats.pages} pages, checked ${stats.links} links, found ${stats.broken} broken.`;

  let text = pagesRun
    ? `:mag_right: *northwind.example sitemap page sweep*\n${intro}`
    : jsRun
      ? `:eye: *northwind.example JS-link detector*\n${intro}`
      : `:link: *northwind.example link audit*\n${intro}`;
  if (comparison) text += `\n${comparison.summary}`;
  // Measured coverage (links runs, spider mode): what the sitemap gave, what links revealed
  // beyond it, what the sitemap lists that nothing links to, what only Google knows about.
  const cov = run.coverage as { sitemap: number; discovered: number; orphans: number; orphanSample?: string[]; gscUnreached: number; gscSample?: string[] } | null;
  if (cov && !pagesRun) {
    const bits = [`${cov.sitemap.toLocaleString()} sitemap pages`];
    if (cov.discovered > 0) bits.push(`+${cov.discovered} unlisted page${cov.discovered === 1 ? "" : "s"} discovered via links and crawled too`);
    text += `\n:world_map: Coverage: ${bits.join(" ")}`;
    if (cov.orphans > 0) text += ` · ${cov.orphans} sitemap page${cov.orphans === 1 ? "" : "s"} nothing links to${cov.orphanSample?.length ? ` (e.g. ${cov.orphanSample.slice(0, 3).join(", ")})` : ""}`;
    if (cov.gscUnreached > 0) text += ` · ${cov.gscUnreached} URL${cov.gscUnreached === 1 ? "" : "s"} Google knows that the crawl couldn't reach${cov.gscSample?.length ? ` (e.g. ${cov.gscSample.slice(0, 3).join(", ")})` : ""}`;
  }
  if (sections) text += `\n\n${sections}`;
  if (fs.length > 0) {
    text += `\n\n${await renderFindings(fs, resolved, comparison?.tags, { pagesRun })}`;
  } else if (jsRun) {
    text += jsOnly.length > 0
      ? `\n\nNo broken links among them — but the hidden ones below still can't be discovered by any non-rendering crawler.`
      : `\n\nEvery link on every rendered page already exists in the raw HTML. :white_check_mark:`;
  } else {
    text += pagesRun
      ? `\n\nEvery page in the sitemap answers correctly. :white_check_mark:`
      : draftFs.length > 0 || unlistedFs.length > 0
        ? `\n\nNo broken links on live sitemap pages. :white_check_mark: The sections below are the editorial queues.`
        : `\n\nAll clean today — no broken links found. :white_check_mark:`;
  }
  if (draftFs.length > 0) text += `\n\n${renderDraftTargets(draftFs)}`;
  if (unlistedFs.length > 0) text += `\n\n${renderUnlistedPages(unlistedFs)}`;
  if (jsOnly.length > 0) {
    const byPage = new Map<string, Finding[]>();
    for (const f of jsOnly) (byPage.get(f.page_url) ?? byPage.set(f.page_url, []).get(f.page_url)!).push(f);
    const lines = [`:see_no_evil: *Links that only exist after JavaScript (${jsOnly.length} on ${byPage.size} page${byPage.size === 1 ? "" : "s"})* — working, but invisible to non-rendering crawlers; anything they alone link to risks becoming an orphan`];
    let n = 0;
    for (const [pageUrl, group] of byPage) {
      n++;
      const path = (() => { try { return new URL(pageUrl).pathname || "/"; } catch { return pageUrl; } })();
      lines.push(`*${n}.* <${pageUrl}|${path}> — ${group.length} hidden link${group.length === 1 ? "" : "s"}: ${group.slice(0, 5).map((f) => f.link_url).join(", ")}${group.length > 5 ? ` +${group.length - 5} more` : ""}`);
    }
    text += `\n\n${lines.join("\n")}`;
  }
  if (renderFailed.length > 0) {
    text += `\n\n:warning: ${renderFailed.length} page${renderFailed.length === 1 ? "" : "s"} couldn't be rendered — their JS-only links are UNVERIFIED this run (listed in the panel).`;
  }
  if (redirects.length > 0) text += `\n\n${renderRedirectIssues(redirects)}`;
  if (pagesRun && fs.length > 0) text += `\n\n_Dead pages are queued in Render Lab → Dead URLs for a 410 / redirect decision._`;
  return { text };
}

// Compose + post the digest for a completed run. Posts an "all clean" note when nothing
// broke, so the daily outline always arrives.
export async function postAuditDigest(runId: string): Promise<{ ok: boolean; error?: string }> {
  const composed = await composeAuditDigest(runId);
  if ("error" in composed) return { ok: false, error: composed.error };

  // Post ALL of it — split across sequential messages when long, never truncated.
  const chunks = chunkForSlack(composed.text);
  let res: { ok: boolean; error?: string } = { ok: true };
  for (let i = 0; i < chunks.length; i++) {
    const prefix = i > 0 ? `:link: _(continued ${i + 1}/${chunks.length})_\n` : "";
    res = await postToSlack(prefix + chunks[i]);
    if (!res.ok) break;
  }
  if (res.ok) {
    await supabaseAdmin.from("link_audit_runs").update({ slack_posted_at: new Date().toISOString() }).eq("id", runId);
  }
  return res;
}
