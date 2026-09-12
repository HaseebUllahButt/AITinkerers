// The unattended blog pipeline: decide whether anything is worth writing, and if so write it.
//
// Same shape as the Atlas path (lib/blog/request.ts) on purpose — it creates a draft and a writer
// session, then hands off to the same worker. The only new thing here is the DECISION, because Atlas
// is told what to write and this has to work that out for itself.
//
// ── The decision must be able to say no, and usually will ───────────────────────────────────────
//
// This fires three times a day forever. A pipeline that always produces something produces filler on
// every quiet day, and filler on a domain that ranks is worse than silence: it competes with the
// pages we actually care about, and somebody has to notice and delete it. So `chooseTopic` is allowed
// — expected — to return null, and a skip is recorded as a SUCCESS with its reasoning.
//
// That is also why the judge is a model call over real rows rather than a score threshold. "Is this
// worth a post for ImagineArt right now" is an editorial question about novelty, intent and overlap
// with what we already rank for. A cutoff on a confidence field would answer a different, easier
// question and answer it wrong.
//
// ── Why it claims the row before writing ────────────────────────────────────────────────────────
//
// Three runs a day share one board. Without a claim, the 3pm run re-reads the same top candidate the
// 9am run is still writing and produces a second post on the same subject. The claim writes
// research_items.status='drafting' with decided_by='autopilot', which is the same column a person's
// decision uses — so one board shows both and the sweep already refuses to overwrite it (see the
// note on `status` in research/sweep.ts).
import { supabaseAdmin } from "@/lib/db/supabase";
import { acquireLock, releaseLock } from "@/lib/redis";
import { anthropicClient, baseWriterParams, writerEnabled } from "@/lib/writer/anthropic";
import { notionBacklog, notionConfigured, type NotionRow } from "@/lib/research/notion";
import { startBlogRequest } from "@/lib/blog/request";
import { getWebhook } from "@/lib/linkaudit/slack";
import { slackPost } from "@/lib/slack/post";
import { tagFor } from "@/lib/slack/tags";
import { linkOr } from "@/lib/appUrl";
import { describeTypes, describeAudiences, preferredType, pageType, HEAD_TERM_RULES, AVOID, THE_ONE_TEST } from "./pageTypes";
import { PRACTITIONERS, practitioner } from "./practitioner";
import { inventoryCandidates, geoCandidates, demandCandidates, type Candidate } from "./candidateSources";
import { checkCannibalization, ownedHeadTerms, summarise, type CannibalVerdict } from "./cannibalization";

/**
 * How many posts a day this may produce, across every slot.
 *
 * Six slots and a cap of six is not the same statement: the cap is what stops a retried or
 * manually-triggered run from stacking a seventh on top of a full day. Overridable with
 * BLOG_AUTOPILOT_DAILY_CAP, which is how the flow was trialled at one a day.
 */
function dailyCap(): number {
  const n = Number(process.env.BLOG_AUTOPILOT_DAILY_CAP);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : SLOTS.length;
}

/**
 * The nine scheduled slots, in order, as Pakistan local times.
 *
 * Kept here rather than only in vercel.json because two things read the ORDER: the type rotation (so
 * consecutive slots do not draw the same shape) and the model preference (which applies to the early
 * slots). A route deriving the slot from the clock cannot tell you it was the fourth of nine.
 *
 * Pakistan is UTC+5 year-round with no DST, so these never drift.
 */
export const SLOTS = ["09:00-PKT", "11:00-PKT", "13:00-PKT", "15:00-PKT", "17:00-PKT", "18:00-PKT",
  "19:00-PKT", "21:00-PKT", "22:00-PKT"] as const;

/** The same nine slots as UTC hours, matching vercel.json. Index-aligned with SLOTS. */
const SLOT_UTC_HOURS = [4, 6, 8, 10, 12, 13, 14, 16, 17] as const;

/** Zero-based position of a slot, or 0 for a manual run. */
export function slotIndex(slot: string): number {
  const i = SLOTS.indexOf(slot as (typeof SLOTS)[number]);
  return i >= 0 ? i : 0;
}

/**
 * Which slot a UTC hour belongs to.
 *
 * Exact-hour, then nearest-earlier within ONE hour. Exact alone would label a cron that fired late —
 * or a retry — as an unknown slot, which loses both the rotation position and the model preference.
 *
 * The window was two hours when the slots were 4/6/8/10/12/13 UTC and only one adjacent pair existed.
 * With 13, 14, 16 and 17 now in the list, a two-hour window would attribute the 14:00 run to the
 * 13:00 slot and the 17:00 run to the 16:00 one, silently collapsing three of the nine slots. One
 * hour is the largest window that cannot reach a neighbouring slot. Returns null past that, so a
 * genuinely off-schedule run is visibly off-schedule rather than misattributed.
 */
export function slotForHour(h: number): string | null {
  const exact = SLOT_UTC_HOURS.indexOf(h as (typeof SLOT_UTC_HOURS)[number]);
  if (exact >= 0) return SLOTS[exact];
  for (let i = SLOT_UTC_HOURS.length - 1; i >= 0; i--) {
    if (h > SLOT_UTC_HOURS[i] && h - SLOT_UTC_HOURS[i] <= 1) return SLOTS[i];
  }
  return null;
}

/**
 * How many of the day's early slots push for model coverage.
 *
 * ── Why this is no longer a "news" preference ───────────────────────────────────────────────────
 *
 * The original ask was one news post a day, and the reason behind it was that nothing was being written
 * about new model releases. The SEO team's guide then ruled out news RECAPS outright — we are not a news
 * site and will not win on speed — while asking for model guides and comparisons above every other type.
 *
 * Those are the same instruction once you separate the subject from the shape. A newly released model is
 * still the thing to cover; it gets covered as a guide with real generations in it, or as a comparison
 * against the version it replaces, rather than as a restatement of the announcement. So the early slots
 * push for MODEL COVERAGE, and the preference drops as soon as a model guide or comparison lands.
 *
 * Three slots, and it drops on success: one attempt a day, tried early, never forced.
 */
const MODEL_PREFERENCE_SLOTS = 3;

/** Off unless explicitly enabled, so deploying this does not start writing on its own. */
export function autopilotEnabled(): boolean {
  return process.env.BLOG_AUTOPILOT === "1";
}

/**
 * How stale a research item may be and still be worth a post.
 *
 * 14 days, because the board carries items nobody wrote about for weeks and "new model launched" is
 * not a story a fortnight later — writing it then produces a post that reads as behind. Deprecations
 * are the exception and get a longer window: a shutdown scheduled for next month is MORE worth
 * writing about as the date approaches, not less.
 */
const FRESH_DAYS = 14;
const FRESH_DAYS_RETIREMENT = 120;

// The Candidate shape now lives in candidateSources.ts, next to the four sources that build most of
// them, and is re-exported here so callers do not have to know which module owns it.
export type { Candidate } from "./candidateSources";

/**
 * Pull the sweep's "do not cite this yet" note out of a summary and into its own field.
 *
 * ── Why this exists, measured ───────────────────────────────────────────────────────────────────
 *
 * The research sweep writes each summary for a HUMAN who is about to go and verify it, so it ends with
 * a warning: "a lead, not a citation. Confirm against the vendor's own page before writing", "cite the
 * changelog or docs, never the tweet", "the vendor's own announcement is still the citation".
 *
 * 305 of 371 open rows carry one of those. The judge was separately told a research candidate "needs a
 * real, dated, first-party source" — so it read every genuine launch as self-declared not-first-party
 * and declined it. Eleven consecutive runs picked a coverage gap; not one picked news.
 *
 * The inversion is the tell: the 63 rows WITHOUT a hedge are the worthless ones — bare model-hub
 * uploads, quantizations, adapters, single retiring version strings — which the judge is separately
 * told to reject by name. Every news row failed one test or the other, and there was no path through.
 *
 * A lead that needs confirming is not a lead to reject. It is a lead whose confirming happens at
 * writing time, by a writer that has `deep_research` and is already required to use it. So the note
 * moves to its own field, where it reads as an instruction rather than a verdict.
 */
function splitVerification(summary: string | null): { substance: string | null; verification: string | null } {
  if (!summary) return { substance: null, verification: null };
  // The markers the sweep actually writes (lib/research/signals.ts).
  const MARKER = /a lead, not a citation|never the tweet|still the citation|Confirm against the vendor|is a pointer/i;
  // Sentence-wise from the END, taking every trailing sentence that is a hedge.
  //
  // A single-sentence match is not enough: the web-research note is TWO sentences ("Found by web
  // research — a lead, not a citation. Confirm against the vendor's own page before writing."), and
  // moving only the last one leaves "a lead, not a citation" sitting in the summary — still reading as a
  // verdict, which is the whole thing this split exists to stop.
  const parts = summary.trim().match(/[^.!?]+[.!?]*/g) ?? [summary.trim()];
  let cut = parts.length;
  while (cut > 0 && MARKER.test(parts[cut - 1])) cut--;
  if (cut === parts.length) return { substance: summary.trim() || null, verification: null };
  return {
    substance: parts.slice(0, cut).join("").trim() || null,
    verification: parts.slice(cut).join("").trim() || null,
  };
}

export interface AutopilotOutcome {
  status: "drafted" | "skipped" | "failed";
  reason: string;
  candidates: number;
  subject?: string;
  draftId?: string;
  sessionId?: string;
  researchItemId?: string;
  notionPageId?: string;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * The head term of a slug — what a reader would search for, minus the shape words.
 *
 * `ai-faceless-video-generator` → `faceless-video`. Used to ask "is there a post about this thing",
 * not "is there a post at this slug", because a supporting article is almost never named after the
 * feature page it supports.
 */
function headTerm(slug: string): string {
  return slug
    .replace(/^(ai|the|best)-/i, "")
    .replace(/-(generator|maker|creator|tool|online|free|app|ai)$/i, "")
    .toLowerCase();
}

/** Slugs that are not real subjects: test fixtures, and comparison pages whose whole purpose is the
 *  head-to-head — a blog on the same match-up competes with the page instead of supporting it. */
function skipGapSlug(slug: string): boolean {
  return /(^|-)(test|dummy|demo|sample)(-|$)/i.test(slug) || /-vs-/i.test(slug);
}

/**
 * Pages we already own that have no article around them — the only renewable candidate source here.
 *
 * WHY THIS EXISTS, measured: the research board carries 260 open rows and the judge correctly
 * declined all of them, because that board is built for the LANDING radar. Its rows are
 * model-EXISTENCE signals — `MiniMax-H3-Motion-Adapter`, `SigLIP2-SO400M-Patch16-NaFlex-FlashPack`,
 * twenty OpenAI deprecation version strings — and none of those is a thing a person searches for. The
 * Notion blog backlog is the right shape and holds exactly four rows, two of them usable.
 *
 * So a pipeline running three times a day on those two sources declines forever. Correct, and
 * useless.
 *
 * A feature page with no supporting article is different: it is high intent by construction (we
 * already decided the term was worth a page), it is checkable rather than speculative, and there are
 * 441 of them. It is also the blog cluster shape the radar doc already describes —
 * how-to-use-X, X-overview, X-prompt-guide, X-pricing.
 */
export async function gapCandidates(limit = 40): Promise<{ candidates: Candidate[]; note: string | null }> {
  const url = process.env.STRAPI_URL?.trim().replace(/\/$/, "");
  const token = process.env.STRAPI_API_TOKEN?.trim();
  if (!url || !token) return { candidates: [], note: "Strapi is not configured, so coverage gaps were not computed." };

  async function readAll(path: string, maxPages = 8): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for (let p = 1; p <= maxPages; p++) {
      const res = await fetch(`${url}${path}&pagination[page]=${p}&pagination[pageSize]=100`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Strapi ${res.status} on ${path}`);
      const d = await res.json() as { data?: Array<Record<string, unknown>>; meta?: { pagination?: { pageCount?: number } } };
      const rows = d.data ?? [];
      if (!rows.length) break;
      out.push(...rows);
      if (p >= (d.meta?.pagination?.pageCount ?? 1)) break;
    }
    return out;
  }

  let pages: Array<Record<string, unknown>>;
  let blogs: Array<Record<string, unknown>>;
  try {
    [pages, blogs] = await Promise.all([
      readAll("/api/cluster-pages?fields[0]=slug&fields[1]=category&fields[2]=clusterPageTitle&publicationState=live"),
      readAll("/api/imagine-webs?fields[0]=slug&fields[1]=title&publicationState=live"),
    ]);
  } catch (e: unknown) {
    return { candidates: [], note: `Coverage gaps could not be computed: ${e instanceof Error ? e.message : "Strapi read failed"}` };
  }

  const attrs = (r: Record<string, unknown>) => (r.attributes ?? r) as Record<string, unknown>;
  // One string to search. Substring matching is deliberately loose: a false "already covered" costs
  // one skipped candidate out of hundreds, where a false gap costs a duplicate post.
  const haystack = blogs.map((b) => String(attrs(b).slug ?? "")).join(" ").toLowerCase();

  const gaps: Candidate[] = [];
  for (const r of pages) {
    const a = attrs(r);
    const slug = String(a.slug ?? "");
    if (!slug || skipGapSlug(slug)) continue;
    const ht = headTerm(slug);
    if (ht.length < 5) continue;
    if (haystack.includes(ht)) continue;
    gaps.push({
      kind: "gap",
      id: slug,
      subject: String(a.clusterPageTitle || slug),
      summary: `We have a ${a.category ?? "feature"} page at /${slug} with no article supporting it. `
        + `A post on this term would feed that page rather than compete with it.`,
      source: `Coverage gap — /${slug}`,
      sourceUrl: `https://www.imagine.art/features/${slug}`,
      date: null,
      modality: String(a.category ?? "") || null,
      confidence: null,
    });
  }

  // ── Rotate, so three runs a day do not all see the same forty ──────────────────────────────────
  //
  // There are hundreds of gaps and the judge only ever sees a slice. A fixed slice means the same
  // pages are offered every run forever and the tail is never written. The offset moves with the day
  // and the hour, so the corpus is walked over time without needing to track a cursor.
  const total = gaps.length;
  if (total > limit) {
    const day = Math.floor(Date.now() / 86_400_000);
    const offset = ((day * 3 + Math.floor(new Date().getUTCHours() / 6)) * limit) % total;
    const rotated = [...gaps.slice(offset), ...gaps.slice(0, offset)].slice(0, limit);
    return { candidates: rotated, note: `${total} coverage gap(s) exist; showing ${limit} on a rotating window.` };
  }
  return { candidates: gaps, note: total ? `${total} coverage gap(s).` : null };
}

/**
 * Everything this run could legitimately write, already filtered down to the plausible.
 *
 * The filtering here is mechanical — covered, claimed, stale, wrong-surface. Nothing in this function
 * makes an editorial call; that is the judge's job, and mixing the two would hide the interesting
 * decision inside a pile of boolean checks.
 */
export async function gatherCandidates(): Promise<{ candidates: Candidate[]; notes: string[] }> {
  const notes: string[] = [];

  // ── The research board ──────────────────────────────────────────────────────────────────────
  //
  // coverage='open' only. 'covered' means a page or published post already exists, and 'drafting'
  // means something is being written right now — including by an earlier slot today.
  // Ordered by when we SAW it, not by item_date.
  //
  // item_date desc looked right and was wrong: 60 of 260 open rows are dated in the FUTURE —
  // scheduled deprecations and rumoured releases — so they sorted above everything and the first 120
  // rows were almost entirely OpenAI version strings while that morning's actual news sat below the
  // cut. last_seen is when the sweep found it, which is the recency that matters for news.
  const { data: items, error } = await supabaseAdmin
    .from("research_items")
    .select("id, subject, summary, source_name, source_url, source_kind, item_date, modality, route_confidence, surfaces, coverage, status, last_seen")
    .eq("coverage", "open")
    .eq("status", "open")
    .order("last_seen", { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) notes.push(`The research board could not be read: ${error.message}`);

  const research: Candidate[] = [];
  let stale = 0;
  let deprecations = 0;
  for (const it of items ?? []) {
    const surfaces = (it.surfaces ?? []) as string[];
    // Everything on this board earns a blog by the routing rule, so a row without one is a data
    // problem rather than a preference — skip it quietly rather than writing something unintended.
    if (surfaces.length && !surfaces.includes("blog")) continue;

    // ── Deprecation rows: at most two ─────────────────────────────────────────────────────────
    //
    // A vendor deprecation table yields one row per retiring VERSION STRING — 19 of them on the live
    // board (`gpt-4-0613`, `ft-babbage-002`, `o1-2024-12-17`). The sweep's own note says the value is
    // in the MIGRATION, which is one article, not nineteen. Left unbounded they crowd out every other
    // candidate and spend the judge's attention on strings nobody searches for.
    if (it.source_kind === "deprecation") {
      if (deprecations >= 2) continue;
      deprecations++;
    }

    const age = daysSince(it.item_date);
    const limit = it.modality === "retirement" ? FRESH_DAYS_RETIREMENT : FRESH_DAYS;
    // A future date is a scheduled event, not a stale one — `age` is negative and must not be read
    // as fresh-by-accident either, so it is bounded only on the past side.
    if (age !== null && age > limit) { stale++; continue; }
    const split = splitVerification(it.summary);
    research.push({
      kind: "research",
      id: it.id,
      subject: it.subject,
      summary: split.substance,
      verification: split.verification,
      source: it.source_name,
      sourceUrl: it.source_url,
      date: it.item_date,
      modality: it.modality,
      confidence: it.route_confidence,
    });
  }
  if (stale) notes.push(`${stale} board item(s) skipped as too old to be news.`);
  if (deprecations) notes.push("Deprecation rows capped at 2 — the migration is one article, not one per version string.");

  // ── The Notion backlog ──────────────────────────────────────────────────────────────────────
  //
  // Blog-cluster rows ONLY. The other database on that page plans FEATURE pages, and handing one of
  // those to a blog writer is the cannibalisation the SEO team reported — a blog and a feature page
  // on the same head term compete with each other. notion.ts already labels the two and flags the
  // overlap; this respects both rather than re-deriving them.
  if (notionConfigured()) {
    const bl = await notionBacklog({ limit: 60 }).catch((e: unknown) => ({
      rows: [] as NotionRow[], scanned: 0,
      reason: e instanceof Error ? e.message : "the Notion backlog could not be read",
    }));
    if (bl.reason) notes.push(`Notion: ${bl.reason}`);
    let dropped = 0;
    for (const r of bl.rows) {
      if (r.verdict !== "open") { dropped++; continue; }
      if (r.kind !== "blog") { dropped++; continue; }
      if (r.cannibalisation) { dropped++; continue; }
      research.push({
        kind: "notion",
        id: r.pageId,
        subject: r.subject,
        summary: r.note || null,
        source: `Notion — ${r.source}`,
        sourceUrl: r.url,
        date: null,
        modality: null,
        confidence: null,
        note: r.note || null,
      });
    }
    if (dropped) notes.push(`${dropped} Notion row(s) skipped — already shipped, feature-page intent, or flagged as cannibalising.`);
  } else {
    notes.push("Notion is not configured, so the backlog was not consulted.");
  }

  // ── The inventory sources ────────────────────────────────────────────────────────────────────
  //
  // Models we host with no guide, and obvious comparisons we have not written. These are the two types
  // the SEO team's guide asks for first, and neither was reachable from the three sources above — which
  // is why fourteen runs produced eleven how-tos and no comparisons at all.
  //
  // They also carry the least risk of the whole set: the subject is a page we already own, so a real
  // generation can go in the article by construction.
  // The inventory read comes first because two other things depend on its hosted-model list: the
  // Search Console join, and the check below for whether a research-board launch is something we run.
  const inv = await inventoryCandidates().catch(() => ({
    model: { candidates: [] as Candidate[], note: "Model guides could not be computed." },
    comparison: { candidates: [] as Candidate[], note: null },
    hostedSlugs: [] as string[],
  }));
  const { model, comparison, hostedSlugs } = inv;

  const [geo, demand, gaps] = await Promise.all([
    geoCandidates().catch(() => ({ candidates: [] as Candidate[], note: "Answer-engine gaps could not be read." })),
    demandCandidates(hostedSlugs).catch(() => ({ candidates: [] as Candidate[], note: "Search Console could not be read." })),
    gapCandidates().catch(() => ({ candidates: [] as Candidate[], note: "Coverage gaps could not be computed." })),
  ]);

  // ── A launch we do not host is not a candidate ────────────────────────────────────────────────
  //
  // The guide's one test decides this: an article has to be able to carry real ImagineArt output. We can
  // generate on a model we host and we cannot on one we do not, so a research-board launch is only
  // writable when it turns out to be something we run. Where it is, the model page travels with it as
  // the hub to link up to — and the judge is told to prefer those.
  //
  // ── A launch we do not host IS a candidate ────────────────────────────────────────────────────
  //
  // Reversed on an explicit editorial call (2026-09-08): covering models we do not host is worth real
  // user value and real domain authority, and a site that only writes about its own inventory ranks
  // for its own inventory and nothing else. The site's own history already agreed —
  // /blogs/chat-gpt-5-1-overview and /blogs/deepseek-vs-chatgpt are live pages about models we have
  // never run.
  //
  // GPT-6 Astra is what made the old rule visible: the sweep found it twenty-six times between
  // 2026-08-18 and 2026-09-08, including OpenAI's own announcement, and it never once became a
  // candidate the judge would take.
  //
  // What the piece owes instead is a brand reference that does work for the reader, and — for
  // anything we do not run — the honest boundary said out loud. That is enforced in the writing
  // (src/lib/blog/brand.ts), which is where it belongs, rather than by refusing the subject.
  //
  // A capability hub is still attached where one fits, because a page to link up to makes the piece
  // better. Not having one is no longer disqualifying.
  const CAPABILITY_HUBS: Array<{ match: RegExp; hub: string; why: string }> = [
    { match: /\b(gpt-?\d|astra|claude|gemini|llama|grok|deepseek|qwen|mistral|copilot|chatgpt)\b/i,
      hub: "/features/ai-chat", why: "a chat/LLM launch, answerable against our own AI Chat" },
    { match: /\b(agents?|agentic|mcp|computer[- ]use|browser[- ]use|codex)\b/i,
      hub: "/imagine-computer/ai-chat", why: "an agent launch, answerable against Imagine Computer" },
  ];

  // ── Not everything that names a model is a launch ─────────────────────────────────────────────
  //
  // Measured before this filter existed: the hub match alone qualified EIGHTY-SEVEN board rows
  // against twelve genuinely hosted ones, which would have swamped the judge and turned the schedule
  // into a wall of "X vs our chat". What it was catching:
  //
  //   "Claude Code weekly-limit change"            a policy change
  //   "Codex 0.153 (GPT-6-Astra integration)"      a dev-tool version bump
  //   "Grok 4.6 on Microsoft Foundry"              a distribution deal
  //   "Grok Bot (enterprise)" / "Grok Build (TUI)"  developer tooling
  //   "Introducing Runway Dev MCP. Connect to …"    a raw tweet, pasted whole as the subject
  //
  // None of those is an article for an image and video product. A flagship model launch is.
  const NOT_A_LAUNCH = new RegExp([
    "\\b(limit|quota|rate[- ]limit|pricing|price|policy|terms|deprecat|sunset|outage|incident)\\b",
    "\\b(cli|tui|sdk|api key|dev(eloper)? (platform|tools?|preview)|plugin|extension|integration)\\b",
    "\\b(enterprise|business tier|admin|compliance|soc ?2|procurement)\\b",
    "\\bon (microsoft|azure|aws|bedrock|vertex|foundry|openrouter)\\b",
    "\\b\\d+\\.\\d+\\.\\d+\\b",
  ].join("|"), "i");

  /** A subject that is a NAME, not a pasted sentence. A tweet is not a subject. */
  const looksLikeASubject = (subject: string): boolean => {
    const t = subject.trim();
    if (t.length > 80) return false;
    if (t.split(/\s+/).length > 11) return false;
    // Prose punctuation is the tell that this is a sentence somebody wrote, not a product name.
    return !/[.!?,;:]\s|\u2019|"|\u201c/.test(t);
  };

  /**
   * Still capped, for mix rather than for eligibility.
   *
   * Without a cap the bare hub match qualified 87 board rows against 12 hosted ones, which would
   * turn the schedule into a wall of other people's launches. 12 keeps them a real part of the diet
   * without crowding out the pages we own — and the judge still chooses.
   */
  const ANSWERABLE_CAP = 12;

  let hostedLaunches = 0;
  let answerableLaunches = 0;
  for (const c of research) {
    if (c.kind !== "research") continue;
    const probe = c.subject.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    // Both directions: the board's subject is often a sentence containing the model name ("Seedance 2.5
    // is now available in 1080p"), and sometimes shorter than our slug ("Wan 3.0" vs `wan-3-0-preview`).
    const hit = hostedSlugs.find((slug) => probe.includes(slug) || slug.startsWith(probe));
    if (hit) { c.hubPath = `/features/${hit}`; c.suggestsType = "model-guide"; hostedLaunches++; continue; }

    if (answerableLaunches >= ANSWERABLE_CAP) continue;
    // The noise filter stays. A policy change, a CLI version bump and a pasted tweet are still not
    // articles, whoever's model they are about.
    if (NOT_A_LAUNCH.test(c.subject) || !looksLikeASubject(c.subject)) continue;
    // A hub when one fits, and no hub is fine — see the note above.
    const cap = CAPABILITY_HUBS.find((h) => h.match.test(c.subject));
    if (cap) c.hubPath = cap.hub;
    c.notHosted = true;
    answerableLaunches++;
  }
  if (hostedLaunches) notes.push(`${hostedLaunches} board launch(es) are models we actually host, so they can carry real generations.`);
  if (answerableLaunches) {
    notes.push(
      `${answerableLaunches} board launch(es) are models we do NOT host. Writing about them is deliberate — `
      + "user value and domain authority — but each one owes the reader the boundary said plainly (this does "
      + "not run in ImagineArt) plus what we do offer for the same job. Never a recap of somebody else's "
      + "announcement.",
    );
  }

  for (const r of [model, comparison, geo, demand, gaps]) {
    if (r.note) notes.push(r.note);
    research.push(...r.candidates);
  }

  return { candidates: research, notes };
}

/** Subjects this pipeline has already drafted, so it does not circle back onto them. */
async function recentlyDrafted(days = 30): Promise<string[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await supabaseAdmin
    .from("blog_autopilot_runs")
    .select("subject")
    // 'failed' as well as 'drafted'. A subject whose run died is not a subject to try again on the
    // next slot: whatever killed it — an unfetchable required source, a validation wall — is a
    // property of that topic and will kill the retry the same way. Without this the pivot below
    // would hand the judge back the topic it just lost nineteen minutes to.
    .in("status", ["drafted", "failed"])
    .gte("started_at", since)
    .limit(80);
  return (data ?? []).map((r: { subject: string | null }) => r.subject).filter((s): s is string => !!s);
}

/** Draft titles already in SearchOps, written by anyone. The judge needs these to spot an overlap the
 *  board's own coverage check may have missed — it matches on tokens, and a differently-worded title
 *  about the same thing gets through. */
async function existingTitles(limit = 200): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("blog_drafts")
    .select("title")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r: { title: string | null }) => r.title).filter((t): t is string => !!t && t.length > 3);
}

export interface Judgement {
  /** Index into the candidate array, or null for "nothing here is worth writing". */
  pick: number | null;
  reason: string;
  /** The angle to write, when it picked something. Not the subject restated. */
  angle?: string;
  primaryKeyword?: string;
  /** A key from pageTypes. Decides the keyword shape, the slug shape and the intent tier. */
  pageType?: string;
  /** Practitioner posts only: the role from src/lib/blog/practitioner.ts. */
  persona?: string;
}

const JUDGE_SYSTEM = `You decide whether ImagineArt should publish a blog post right now, about what, and in what form.

ImagineArt is an AI creative suite: image generation, video generation, audio/music, avatars, and an
"Imagine Computer" side covering chat models, agents and MCP. It hosts over a hundred named models —
Nano Banana, Seedream, Seedance, Kling, Hailuo, Wan, FLUX, Veo, Sora, Runway and its own ImagineArt
models. It publishes at imagine.art: feature and model pages under /features and /apps, comparisons
under /compare, articles under /blogs.

## THE TEST THAT DECIDES EVERYTHING

${THE_ONE_TEST}

Apply it first, to every candidate, before you think about search volume or timing. An article that
would read identically with another company's name substituted has no reason to exist on this blog. It
is the reason to prefer a model we host over a model in the news, and a comparison we can actually run
over a category we can only describe.

## NEVER write these

${AVOID.map((a, i) => `${i + 1}. ${a}`).join("\n")}

These are not soft preferences. A candidate that can only become one of these is a candidate to decline,
and rephrasing does not rescue it — "Understanding vector art" is the same banned article as "What is
vector art".

## Where candidates come from

- [model] — a model we HOST that has no article about it. The strongest source: the subject is a page we
  already own, so real generations, a real side-by-side and a real credit cost can all go in the piece.
- [comparison] — two models we host with no page comparing them. One prompt, both models, outputs side
  by side. We have 17 comparison pages against more than a hundred models.
- [geo] — a prompt an answer engine answered WITHOUT mentioning us, and the competitors it cited
  instead. Proven demand, already being served by somebody else.
- [demand] — a real Search Console query with real impressions that nothing of ours ranks well for.
- [notion] — somebody on the team already did the keyword research. A strong signal.
- [gap] — a feature page we own with no supporting article. Reliable, no timing pressure.
- [research] — the news sweep. Treat a launch as writable ONLY if the summary says we host the model
  (it will name the model page). If we do not host it, we cannot put a real generation in the article,
  so it fails the test above — decline it, or take it only as one side of a comparison against a model
  we do host.

For [research] specifically: do NOT decline a candidate because its source is a tweet, a Hacker News
thread or a web-research lead rather than the vendor's own page. Almost every row says so about itself,
because the sweep writes that note for the person who will verify it. Verification happens at WRITING
time — the writer has a research tool and is required to confirm every specification against the
vendor's own model card. "Needs confirming" is a step, not a disqualification. What you are judging is
whether the subject is real and whether we can write it with our own evidence.

Reject a non-event outright: a bare model-hub upload, a third-party quantization, a fine-tune, an
adapter, a single retiring version string, a benchmark screenshot, a funding round, org news.

## The head-term rule — this is not optional

${HEAD_TERM_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n")}

A [gap], [model] or [comparison] candidate names a page we own. That page's term is the one thing your
primary keyword may not be. The point of the article is to send authority TO that page: if it targets
the same query, the two compete, the informational page often wins, and the traffic lands somewhere it
cannot convert. You will be given the terms already owned. Pick a genuinely different query.

## Choosing the form

Pick a pageType. Each one owes specific evidence, and the evidence is what you are committing the
writer to producing:

${describeTypes()}

Vary it across the day. Nine how-tos cover one intent nine times and leave the comparison and
model-guide intent — where readers actually choose a tool — unserved.

For audience-roundup and use-case, the audience must be a REAL job somebody puts on a CV, and the
piece must be built on what that role actually buys on. Pick from this roster rather than inventing a
demographic — a title naming an audience the body never serves is the failure mode of the whole type:

${describeAudiences()}

## The bar

Choose AT MOST ONE candidate. It must clear all of these:
- Passes the test at the top of this prompt.
- Genuinely about what ImagineArt does. Funding, org news, policy and general developer tooling are
  industry news, not posts for this site.
- Serves a real search intent: do a thing, choose between things, get more out of a model, serve an
  audience.
- Nothing in the existing titles already covers it. A sharper angle on an existing post is fine; the
  same post again is not.

Choosing nothing is a good outcome when the alternative is filler — filler on a domain that ranks
competes with the pages that matter. But [model], [comparison], [geo] and [gap] do not depend on news,
so a quiet news day is not a reason to decline.

Reply with ONLY a JSON object, no prose and no code fence:
{"pick": <index or null>, "pageType": "<one key from the list above>", "reason": "<one or two
sentences, plain English>", "angle": "<the specific article to write, as a working title>",
"primaryKeyword": "<the head term — and NOT a term already owned>",
"persona": "<practitioner posts ONLY: the role, from the list below>"}

When pageType is "practitioner", also name the persona — the role whose day this feature actually
changes. You are choosing it rather than the writer because you can see the subject and it cannot see
your reasoning; a mismatch (an interior designer writing about thumbnail CTR) is the one thing that
makes the piece read as invented. Pick from:
${PRACTITIONERS.map((p) => `  ${p.key} — ${p.role}`).join("\n")}

Omit "pageType", "angle", "primaryKeyword" and "persona" when pick is null.`;

/**
 * Ask for a verdict. Returns pick=null on any failure, because "we could not decide" and "we decided
 * not to" both correctly result in no post — and inventing a pick out of a parse error is the one
 * outcome that puts unreviewed filler on the site.
 */
export async function chooseTopic(
  candidates: Candidate[],
  context: {
    existingTitles: string[];
    recentlyDrafted: string[];
    /** Terms feature, app and tool pages already own. The judge must not target one. */
    ownedTerms?: string[];
    /** True while the day still wants a model guide or comparison — see MODEL_PREFERENCE_SLOTS. */
    preferModel?: boolean;
    /** The shape this slot leans towards, so the day's six posts are not one shape six times. */
    preferredType?: string;
    /** Types already produced today, so the judge can see the day's spread rather than guess it. */
    typesToday?: string[];
  },
): Promise<Judgement> {
  if (!candidates.length) return { pick: null, reason: "Nothing on the board was open, fresh and blog-shaped." };
  const client = anthropicClient();
  if (!client) return { pick: null, reason: "The writer is not configured (ANTHROPIC_API_KEY unset), so nothing was judged." };

  const list = candidates.map((c, i) => {
    const bits = [
      `[${i}] (${c.kind}) ${c.subject}`,
      c.summary ? `    ${c.summary.slice(0, 400)}` : null,
      `    source: ${c.source ?? "unknown"}${c.date ? ` · dated ${c.date}` : " · no date"}${c.sourceUrl ? ` · ${c.sourceUrl}` : ""}`,
      c.modality || c.confidence ? `    modality: ${c.modality ?? "—"} · routing confidence: ${c.confidence ?? "—"}` : null,
      // Shown as a WRITING STEP, labelled as one. The same sentence sitting inside the summary is what
      // made eleven consecutive runs read every launch as uncitable and decline it.
      c.verification ? `    to confirm at writing time (not a reason to reject): ${c.verification}` : null,
      c.kind === "notion" ? "    from the planning backlog — somebody already decided this was worth writing" : null,
      c.hubPath ? `    we own the page for this: ${c.hubPath} — real generations from it can go in the article` : null,
      c.suggestsType ? `    this source suggests pageType: ${c.suggestsType}` : null,
    ].filter(Boolean);
    return bits.join("\n");
  }).join("\n\n");

  const owned = context.ownedTerms ?? [];
  const user = [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    "",
    context.preferModel
      ? "THIS SLOT PREFERS MODEL COVERAGE. Nothing today has covered a model yet. Prefer a [model] or "
        + "[comparison] candidate, and prefer a RECENTLY RELEASED one where the candidate list shows we "
        + "host it — a new model's value expires and a coverage gap's does not. If nothing there clears "
        + "the bar, take the best candidate from any source; a thin model guide is worse than a good "
        + "how-to."
      : "A model guide or comparison has already landed today, so treat every source on its merits.",
    context.preferredType
      ? `THIS SLOT LEANS TOWARDS: ${context.preferredType}. A preference, not a rule — pick another type `
        + "when today's candidates do not support this one."
      : null,
    context.typesToday?.length
      ? `ALREADY WRITTEN TODAY (types): ${context.typesToday.join(", ")}. Do not repeat one of these unless nothing else fits.`
      : null,
    "",
    `CANDIDATES (${candidates.length}):`,
    list,
    "",
    // The keyword map, as the constraint rather than as advice. The standard's own note is that a
    // uniqueness check on the primary keyword column is the cheapest prevention that exists; this is
    // that check, moved to before the writing instead of after it.
    "TERMS ALREADY OWNED BY A FEATURE, APP OR TOOL PAGE — your primaryKeyword must not be one of these,",
    "and must not simply be one of them with a filler word added:",
    owned.length ? owned.map((t) => `- ${t}`).join("\n") : "(none could be read)",
    "",
    "POSTS THAT ALREADY EXIST (titles only, most recent first):",
    context.existingTitles.length ? context.existingTitles.map((t) => `- ${t}`).join("\n") : "(none)",
    "",
    "THIS PIPELINE ALREADY DRAFTED THESE IN THE LAST 30 DAYS — do not pick them again:",
    context.recentlyDrafted.length ? context.recentlyDrafted.map((t) => `- ${t}`).join("\n") : "(none)",
  ].filter((l) => l !== null).join("\n");

  try {
    const res = await client.messages.create({
      // Low effort: this is a triage judgement over a supplied list, not authoring. The writing run
      // that follows is where the budget belongs.
      ...baseWriterParams("low"),
      max_tokens: 2000,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    // Text blocks only. Thinking is adaptive and on by default here, so the response carries
    // thinking blocks alongside the answer and concatenating everything would feed the parser the
    // model's reasoning as well as its JSON.
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("").trim();
    // Tolerate a fence even though the prompt forbids one — a refusal to parse would turn a good
    // verdict into a skip.
    const json = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const start = json.indexOf("{");
    const parsed = JSON.parse(start > 0 ? json.slice(start) : json) as Judgement;
    const pick = typeof parsed.pick === "number" && parsed.pick >= 0 && parsed.pick < candidates.length
      ? parsed.pick : null;
    // An unrecognised pageType falls back to the slot's preferred type rather than to nothing: the type
    // decides the keyword shape and the intent tier the cannibalization gate reads, and a missing tier
    // would quietly default the gate to "informational" for a piece that is not.
    const typeKey = pick === null
      ? undefined
      : pageType(String(parsed.pageType ?? ""))?.key ?? context.preferredType ?? "how-to";
    return {
      pick,
      reason: String(parsed.reason ?? "").trim() || (pick === null ? "Declined without a stated reason." : "Picked without a stated reason."),
      angle: pick === null ? undefined : String(parsed.angle ?? "").trim() || undefined,
      primaryKeyword: pick === null ? undefined : String(parsed.primaryKeyword ?? "").trim() || undefined,
      pageType: typeKey,
      // Validated against the roster, and only kept for a practitioner post. An unrecognised role
      // is dropped rather than passed through: practitionerNote() then lists every persona and asks
      // the writer to choose, which is a worse-but-working outcome — whereas an invented role name
      // would reach the writer as a persona with no friction, no vocabulary and no tell.
      persona: typeKey === "practitioner" ? practitioner(String(parsed.persona ?? ""))?.key : undefined,
    };
  } catch (e: unknown) {
    return { pick: null, reason: `The judge could not be reached or its answer could not be read (${e instanceof Error ? e.message : "unknown"}), so nothing was written.` };
  }
}

/**
 * Move the target without losing the subject.
 *
 * Called only when the gate said `rewrite` — the article is worth writing, at a different query. A
 * second model call rather than a mechanical transform, and that is a deliberate trade: the mechanical
 * version of "de-optimize this off the head term" is a string operation on a slug
 * ("ai tattoo generator" → "how to ai tattoo"), and a keyword nobody would ever type is worse than the
 * collision it avoids. The model has the owner's path, the exact term it may not use, and the type's
 * required shape, so this is a narrow rewrite and not a fresh judgement.
 *
 * Returns null on any failure, and the caller treats null as "skip this candidate". Never a silent
 * fallback to the original keyword: the whole point is that the original is known to collide.
 */
export async function reframe(input: {
  subject: string;
  angle: string;
  keyword: string;
  pageTypeKey: string;
  verdict: CannibalVerdict;
}): Promise<{ keyword: string; angle: string } | null> {
  const client = anthropicClient();
  if (!client) return null;
  const t = pageType(input.pageTypeKey);
  const owner = input.verdict.owner;

  const sys = `You retarget one article so it stops competing with a page the site already owns.

You are NOT re-deciding whether to write it. The subject is settled. Change only the primary keyword
and the working title, as little as possible, so that:

${HEAD_TERM_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n")}
3. The keyword is a query a person would actually type. A phrase assembled to dodge a rule is worse
   than the collision — if you cannot find a real query, say so.
4. It is still an article for imagine.art, about the same subject. Retargeting means moving the query
   down-funnel, not changing what the piece is about. If the type calls for named products, at least one
   side has to be a capability ImagineArt actually offers or a model it runs — a head-to-head between two
   competitors with ImagineArt absent is not a retarget, it is a different article for a different site.
${t ? `5. It takes the shape required for a ${t.label.toLowerCase()}: ${t.keywordShape}` : ""}

Reply with ONLY a JSON object, no prose and no fence:
{"keyword": "<the new primary keyword>", "angle": "<the new working title>"}

If there is no honest query that satisfies the rules, reply {"keyword": null, "angle": null} instead of
inventing one.`;

  const problems = input.verdict.problems
    .filter((pr) => pr.severity !== "warn")
    .map((pr) => `- ${pr.detail}`).join("\n");

  const user = [
    `Subject: ${input.subject}`,
    `Proposed title: ${input.angle}`,
    `Proposed primary keyword: ${input.keyword}   ← this is the problem`,
    "",
    owner
      ? `${owner.path} already owns "${owner.headTerm}" and must remain the page that ranks for it. This `
        + "article's job is to support it."
      : "",
    "",
    "What the check found:",
    problems,
    input.verdict.overlap.length
      ? "\nMeasured SERP overlap:\n" + input.verdict.overlap
          .map((o) => `- "${o.keywordA}" vs "${o.keywordB}": ${o.sharedUrls}/10 shared (${o.pct}%) — ${o.reading}`)
          .join("\n")
      : "",
  ].filter(Boolean).join("\n");

  try {
    const res = await client.messages.create({
      ...baseWriterParams("low"),
      max_tokens: 1200,
      system: sys,
      messages: [{ role: "user", content: user }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const json = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const start = json.indexOf("{");
    const parsed = JSON.parse(start > 0 ? json.slice(start) : json) as { keyword?: string | null; angle?: string | null };
    const keyword = String(parsed.keyword ?? "").trim();
    const angle = String(parsed.angle ?? "").trim();
    if (!keyword || !angle) return null;
    return { keyword, angle };
  } catch {
    return null;
  }
}

/**
 * Page types already produced today, and whether one of them was news.
 *
 * Reads the audit table rather than tracking state, so a manual run and a retried cron both count — the
 * question is "what has the site had today", not "what did the scheduler intend".
 */
async function producedToday(): Promise<{ types: string[]; modelCovered: boolean }> {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const { data } = await supabaseAdmin
    .from("blog_autopilot_runs")
    .select("page_type")
    .eq("status", "drafted")
    .gte("started_at", midnight.toISOString());
  const types = (data ?? []).map((r: { page_type: string | null }) => r.page_type).filter((t): t is string => !!t);
  return { types, modelCovered: types.includes("model-guide") || types.includes("comparison") };
}

/** Posts already drafted today, against the cap. */
async function draftedToday(): Promise<number> {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const { count } = await supabaseAdmin
    .from("blog_autopilot_runs")
    .select("id", { count: "exact", head: true })
    .eq("status", "drafted")
    .gte("started_at", midnight.toISOString());
  return count ?? 0;
}

async function record(row: Record<string, unknown>): Promise<void> {
  await supabaseAdmin.from("blog_autopilot_runs").insert({ ...row, finished_at: new Date().toISOString() })
    .then(() => {}, () => {}); // a lost audit row must never fail the run that produced a real draft
}

/**
 * One scheduled run, start to finish.
 *
 * Locked, because three slots plus a manual trigger can overlap and two runs judging the same board
 * at the same time would claim different rows and write two posts nobody asked for. The lock TTL is
 * generous: the writing itself happens in a separate invocation, so this function only holds it for
 * the judgement.
 */
export async function runAutopilot(opts: { slot?: string; force?: boolean } = {}): Promise<AutopilotOutcome> {
  const slot = opts.slot ?? "manual";

  if (!autopilotEnabled() && !opts.force) {
    return { status: "skipped", reason: "The autopilot is off (set BLOG_AUTOPILOT=1 to enable it).", candidates: 0 };
  }
  if (!writerEnabled()) {
    const out: AutopilotOutcome = { status: "failed", reason: "The writer is not configured (ANTHROPIC_API_KEY unset).", candidates: 0 };
    await record({ status: out.status, reason: out.reason, slot });
    return out;
  }

  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // acquireLock returns true when Redis is absent (local dev), so this cannot break a dev machine.
  const got = await acquireLock("blog:autopilot", 600, token).catch(() => true);
  if (!got) {
    return { status: "skipped", reason: "Another autopilot run is already in flight.", candidates: 0 };
  }

  try {
    const cap = dailyCap();
    const already = await draftedToday();
    if (already >= cap) {
      const out: AutopilotOutcome = {
        status: "skipped",
        reason: `Already drafted ${already} post(s) today and the cap is ${cap}.`,
        candidates: 0,
      };
      await record({ status: out.status, reason: out.reason, slot });
      return out;
    }

    const { candidates, notes } = await gatherCandidates();
    const idx = slotIndex(slot);
    const [titles, drafted, owned, today] = await Promise.all([
      existingTitles(), recentlyDrafted(), ownedHeadTerms(), producedToday(),
    ]);
    const preferModel = idx < MODEL_PREFERENCE_SLOTS && !today.modelCovered;
    const lean = preferModel ? "model-guide" : preferredType(idx).key;

    const verdict = await chooseTopic(candidates, {
      existingTitles: titles,
      recentlyDrafted: drafted,
      ownedTerms: owned,
      preferModel,
      preferredType: lean,
      typesToday: today.types,
    });

    if (verdict.pick === null) {
      const reason = [verdict.reason, ...notes].filter(Boolean).join(" ");
      await record({ status: "skipped", reason, candidates: candidates.length, slot });
      return { status: "skipped", reason, candidates: candidates.length };
    }

    const chosen = candidates[verdict.pick];

    // ── The cannibalization gate ───────────────────────────────────────────────────────────────────
    //
    // Runs after the judge and before the claim, which is the only place it can run: it needs a keyword
    // to check, and it has to finish before anything is written or any row is taken off the board.
    //
    // Three outcomes, and the middle one is the reason this is a gate and not a filter:
    //
    //   proceed  nothing we own competes. Write it.
    //   rewrite  the subject is good, the target is not. Retarget once and re-check. This is the common
    //            case for a [gap] candidate and it is not a failure — it is the pipeline doing the thing
    //            the standard asks for, which is to write the SUPPORTING article rather than a second
    //            page for a query a feature page already owns.
    //   block    there is no version of this that does not compete. Skip, and say against what.
    //
    // A re-check after the retarget, rather than trusting it: the model was told the rule, and a rule in
    // a prompt is a hint. Eight of the first eleven posts are what trusting the hint looks like.
    let keyword = verdict.primaryKeyword || chosen.subject;
    let angle = verdict.angle || chosen.subject;
    const typeKey = verdict.pageType ?? "how-to";
    let keywordWas: string | null = null;

    // Most sources know the page their article is meant to support: a [model] candidate is a model page,
    // a [comparison] is one of the two, a [gap] is a feature page. That link is the article's whole
    // reason to exist and it has to survive the retarget below — stated by the caller rather than
    // rediscovered by the check, because after retargeting there is deliberately no longer an ownership
    // collision for the check to find.
    const hubPath = chosen.hubPath
      ?? (chosen.kind === "gap" && chosen.sourceUrl ? new URL(chosen.sourceUrl).pathname : null);
    const hubLink = hubPath
      ? {
          path: hubPath,
          anchor: chosen.subject.toLowerCase().replace(/\s+(guide|vs\s.*)$/i, "").trim() || chosen.subject.toLowerCase(),
          why: "This article exists to support that page. Without the link it is a page about the same "
            + "subject with no relationship to the one that should rank.",
        }
      : null;

    let gate = await checkCannibalization({
      primaryKeyword: keyword, pageTypeKey: typeKey, proposedTitle: angle, mustLinkTo: hubLink,
    }).catch((e: unknown) => {
      // Fails open, loudly. A gate that can take the pipeline down becomes a gate somebody disables.
      const detail = e instanceof Error ? e.message : "unknown";
      return {
        verdict: "proceed" as const, problems: [], proposedKeyword: keyword, owner: null, neighbours: [],
        requiredLinks: hubLink ? [hubLink] : [], overlap: [],
        directives: hubLink ? [`Link to ${hubLink.path} using "${hubLink.anchor}" as the anchor text, in the body, once. ${hubLink.why}`] : [],
        notes: [`The cannibalization check could not run (${detail}), so this article was NOT checked.`],
        checkedAt: new Date().toISOString(),
      };
    });

    if (gate.verdict === "rewrite") {
      const moved = await reframe({ subject: chosen.subject, angle, keyword, pageTypeKey: typeKey, verdict: gate });
      if (moved) {
        keywordWas = keyword;
        keyword = moved.keyword;
        angle = moved.angle;
        gate = await checkCannibalization({
          primaryKeyword: keyword, pageTypeKey: typeKey, proposedTitle: angle, mustLinkTo: hubLink,
        }).catch(() => gate);
      }
    }

    if (gate.verdict !== "proceed") {
      // Skipped, not failed: the check worked. Recording the full verdict is what makes "why didn't it
      // write about X" answerable — the candidate, the term, and the page that already owns it.
      const reason = [
        `Chose "${chosen.subject}" but did not write it: ${summarise(gate)}`,
        keywordWas ? `Retargeting from "${keywordWas}" to "${keyword}" did not clear it.` : null,
        ...notes,
      ].filter(Boolean).join(" ");
      await record({
        status: "skipped", reason, candidates: candidates.length, subject: chosen.subject, slot,
        page_type: typeKey, keyword, keyword_was: keywordWas, cannibal: gate,
      });
      return { status: "skipped", reason, candidates: candidates.length, subject: chosen.subject };
    }

    // ── Claim it BEFORE writing ────────────────────────────────────────────────────────────────
    //
    // Between here and the draft landing there are minutes of model time in another invocation. An
    // unclaimed row is a row the next slot will pick again.
    if (chosen.kind === "research") {
      await supabaseAdmin.from("research_items")
        .update({ status: "drafting", decided_by: "autopilot", decided_at: new Date().toISOString() })
        .eq("id", chosen.id)
        .then(() => {}, () => {});
    }

    const type = pageType(typeKey);
    const started = await startBlogRequest({
      topic: angle,
      primary_keyword: keyword,
      blog_page_type: typeKey,
      persona: verdict.persona,
      not_hosted: chosen.notHosted === true,
      required_sources: chosen.sourceUrl ? [chosen.sourceUrl] : undefined,
      requested_by: `autopilot:${slot}`,
      // The judge's reasoning travels with the brief, so the writer knows WHY this was chosen and
      // what angle to take rather than restating the subject. Rendered into every turn's directive.
      must_follow: [
        `The article to write: ${angle}`,
        type ? `This is a ${type.label.toLowerCase()} — ${type.brief}` : null,
        `Why this was chosen: ${verdict.reason}`,
        chosen.summary ? `What the board recorded about it: ${chosen.summary}` : null,
        // The verification note travels as an INSTRUCTION now. It used to sit inside the summary, where
        // the judge read it as a reason to reject the candidate outright — which is why no news ever
        // got written. Here it is what it always was: a step before citing.
        chosen.verification ? `Before citing anything from the source: ${chosen.verification}` : null,
        chosen.sourceUrl
          ? `Confirm every specification and date against the primary source (${chosen.sourceUrl}) or the vendor's own page. Never state a spec only a third party claims.`
          : "There is no primary source on file for this — find the vendor's own announcement before stating any specification, and if you cannot, write about the capability rather than the numbers.",
        // The gate's output. Everything here is a measured statement about a page we own, so it belongs
        // in the directive that is re-rendered every turn rather than in a first message that decays.
        ...gate.directives,
        keywordWas
          ? `This article was retargeted from "${keywordWas}" to "${keyword}" because the first target `
            + "belonged to a page we already own. Do not drift back to it."
          : null,
        "Never invent a launch date, a benchmark, a review, a testimonial or a user number.",
      ].filter(Boolean).join("\n"),
    });

    if (!started.ok) {
      // Hand the row back. A failed start that left the row claimed would quietly remove a good
      // candidate from the board forever.
      if (chosen.kind === "research") {
        await supabaseAdmin.from("research_items")
          .update({ status: "open", decided_by: null, decided_at: null })
          .eq("id", chosen.id).then(() => {}, () => {});
      }
      const reason = `Chose "${chosen.subject}" but the writer would not start: ${started.error}`;
      await record({
        status: "failed", reason, candidates: candidates.length, subject: chosen.subject, slot,
        page_type: typeKey, keyword, keyword_was: keywordWas, cannibal: gate,
      });
      return { status: "failed", reason, candidates: candidates.length, subject: chosen.subject };
    }

    if (chosen.kind === "research") {
      await supabaseAdmin.from("research_items")
        .update({ draft_id: started.accepted.draft_id })
        .eq("id", chosen.id).then(() => {}, () => {});
    }

    await record({
      status: "drafted",
      reason: verdict.reason,
      candidates: candidates.length,
      subject: angle,
      page_type: typeKey,
      keyword,
      keyword_was: keywordWas,
      cannibal: gate,
      research_item_id: chosen.kind === "research" ? chosen.id : null,
      notion_page_id: chosen.kind === "notion" ? chosen.id : null,
      draft_id: started.accepted.draft_id,
      writer_session_id: started.accepted.request_id,
      slot,
    });

    // A short note that a run PICKED something. The draft-is-ready message comes later from the
    // writer itself (lib/blog/request.ts) — this one exists because minutes pass in between, and
    // "the 9am run chose X" is the thing that makes the pipeline legible while it works.
    //
    // Deliberately NOT posted on a skip. Three "nothing to write today" pings a day is how a channel
    // learns to ignore this bot; the skip is on the audit table for anyone who asks.
    if (process.env.BLOG_AUTOPILOT_ANNOUNCE_PICKS === "1" && (await getWebhook())) {
      const open = linkOr(`/drafts/${started.accepted.draft_id}`, "Follow it in SearchOps →");
      await slackPost([
        `:robot_face: *Autopilot — writing a post* (${slot})`,
        `${tagFor("blog")} — heads-up, no action yet.`,
        `*${angle}*`,
        `Why: ${verdict.reason}`,
        `Type: ${type?.label ?? typeKey} · keyword: ${keyword}${keywordWas ? ` (retargeted off "${keywordWas}")` : ""}`,
        `Chosen from ${candidates.length} candidate(s) · source: ${chosen.source ?? "—"}`,
        open,
        "_Nothing is published. A draft will land in SearchOps for review._",
      ].filter(Boolean).join("\n")).catch(() => {});
    }

    return {
      status: "drafted",
      reason: verdict.reason,
      candidates: candidates.length,
      subject: angle,
      draftId: started.accepted.draft_id,
      sessionId: started.accepted.request_id,
      researchItemId: chosen.kind === "research" ? chosen.id : undefined,
      notionPageId: chosen.kind === "notion" ? chosen.id : undefined,
    };
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : "the autopilot failed";
    await record({ status: "failed", reason, slot });
    return { status: "failed", reason, candidates: 0 };
  } finally {
    await releaseLock("blog:autopilot", token).catch(() => {});
  }
}
