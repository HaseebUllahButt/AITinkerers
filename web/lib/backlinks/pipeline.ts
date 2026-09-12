// Backlink outreach pipeline. Reuses the EXISTING outreach system end to end: discovery finds
// linkable pages (v4 backlinkTargets), we save each as a real author/domain/article/contact +
// link it to a normal campaign + workflow, then email-finding, pitch-drafting, sending, and reply
// handling all run through the machinery that already exists. This module only adds the
// backlink-specific glue: a per-target campaign wrapper, the discovery→prospect bridge, a
// backlink-flavored pitch, and a "did the link actually go live" check.
import * as cheerio from "cheerio";
import PQueue from "p-queue";

import { supabaseAdmin } from "@/lib/db/supabase";
import {
  createCampaign, createWorkflow, createEmailTemplate, getEmailTemplate,
  upsertDomain, upsertAuthor, upsertArticle, linkArticleAuthor,
  linkAuthorsToCampaign, addWorkflowProspects, isSuppressed,
  upsertOutreachEmail, updateOutreachEmail, upsertLinkedinMessage, upsertWhatsappMessage,
} from "@/lib/db/queries";
import { runBacklinkTargets, normalizeKeywords, provenanceLabel } from "@/lib/backlinks/targets";
import type { Surface } from "@/lib/backlinks/serpSurfaces";
import { fetchRaw } from "@/lib/indexing/fetchRendered";
import { toPath } from "@/lib/indexing/template";
import { llmChat } from "@/lib/providers/llm";
import { extractByline, publicationName } from "./authorName";
import { extractReadability } from "@/lib/extract/readability";
import { clipArticleText, openerPrompt, openerFallback, relevancePrompt, ARTICLE_TEXT_STORE_MAX, OPENER_TEXT_BUDGET } from "./articleContext";
import { firstNameOf, fillTokens, ensurePersonalized } from "@/lib/email/personalize";
import { revisePitch } from "@/lib/email/pitchRevise";
import { generateNote } from "@/lib/email/linkedinNote";
import { generateWhatsappNote } from "@/lib/email/whatsappNote";
import { findArticleForDomain, looksLikeHomepage } from "./findArticle";
import { priorContactForHosts } from "./priorContact";
import { registrableDomain } from "@/lib/util/domain";

export interface BacklinkCampaign {
  id: string;
  campaign_id: string;
  workflow_id: string;
  template_id: string | null;
  /** Optional human name ("Backlink Campaign - Arham"). Null renders as target_path everywhere. */
  name: string | null;
  /** Who started it (079). Null = legacy/shared — ownership is never backfilled or re-stamped. */
  created_by: string | null;
  target_url: string;
  target_path: string;
  topic: string | null;
  status: string;
  /** 'article' pitches a specific piece; 'site' pitches the site itself. See scripts/084 and sitePitch. */
  pitch_mode?: "article" | "site" | null;
  /** The angle pitches are written from, in the owner's words ("never lead with payment, pitch the
   *  free tool"). Null = the stock paid angle. Set in the UI's Pitch angle dialog (scripts/099);
   *  honored by every initial draft, button-pressed or nightly. */
  pitch_angle?: string | null;
  /** Extra seed keywords for discovery, in the owner's words ("ai video editor", "text to video").
   *  Each one seeds the same query set the page's own topic does, so the prospect supply is not
   *  capped by whatever the page title happens to say (scripts/101). Null/empty = topic only. */
  keywords?: string[] | null;
  created_at: string;
}

export type Stage = "found" | "emailing" | "ready" | "sent" | "replied" | "won" | "lost";

/** The subject of the page, read off its slug. Null for the site root, which has no slug to read —
 *  callers must say what they want to happen rather than getting the words "our tool" in a subject
 *  line ("Paid collaboration on your our tool piece" is how that used to come out). */
function topicFromOrNull(path: string): string | null {
  const slug = path.split("/").filter(Boolean).pop() ?? "";
  return slug.replace(/[-_]+/g, " ").trim() || null;
}

function topicFrom(path: string): string {
  return topicFromOrNull(path) ?? "our tool";
}

// Outreach copy conventions for MODEL-written text, same as the workflow generator's sanitize:
// no em/en dashes (the most reliable AI tell) and no doubled spaces. Applied to the opener only —
// template text is the team's own wording and is left alone.
function sanitizeModelText(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ,/g, ",")
    .trim();
}

function normalizeTarget(input: string): { url: string; path: string } {
  const domain = "imagine.art";
  const path = toPath(input.startsWith("http") ? input : `https://${domain}${input.startsWith("/") ? "" : "/"}${input}`);
  return { url: `https://${domain}${path}`, path };
}

// ── Campaign wrapper ────────────────────────────────────────────────────────────
// A target page may carry SEVERAL campaigns (069): two people working the same money page keep
// separate prospect lists by naming their campaigns. Idempotency is therefore two-track:
//   with a name    → that name is the identity; same name returns the same campaign (DB-unique).
//   without a name → the OLDEST campaign for the path, which is exactly the row every existing
//                    caller resolved to back when the path was unique. A retry never duplicates.
export async function ensureBacklinkCampaign(
  targetInput: string,
  opts: { name?: string; createdBy?: string | null; keywords?: string[] } = {},
): Promise<BacklinkCampaign> {
  const { url, path } = normalizeTarget(targetInput);
  const name = opts.name?.trim() || null;
  const keywords = normalizeKeywords(opts.keywords);

  if (name) {
    const { data: byName } = await supabaseAdmin
      .from("backlink_campaigns").select("*").eq("name", name).limit(1);
    if (byName?.[0]) return byName[0] as BacklinkCampaign;
  } else {
    const { data: existing } = await supabaseAdmin
      .from("backlink_campaigns").select("*").eq("target_path", path)
      .order("created_at", { ascending: true }).limit(1);
    if (existing?.[0]) return existing[0] as BacklinkCampaign;
  }

  // No slug means no topic to read (the campaign targets the site itself — an "alternatives" round,
  // say, where the point is the brand rather than one money page). The pitch then talks about
  // ImagineArt rather than about a page, and the campaign's own name is what labels it.
  const pageTopic = topicFromOrNull(path);
  const label = name ?? path;
  // Seeding the discovery keywords with "our tool" would make every later search useless, so with no
  // slug the seeds are whatever the caller supplied — which is exactly when they supply them.
  const campaign = await createCampaign({ name: `[Backlinks] ${label}`, keywords: pageTopic ? [pageTopic] : keywords });
  const workflow = await createWorkflow({ campaign_id: campaign.id, name: `Backlink outreach — ${label}` });

  // The offer is stated in the subject and in the first line of the ask, not buried.
  //
  // The version this replaces asked "would you consider adding ImagineArt as an option?" and offered a
  // free account, assets, or data. To a publisher who sells placements that is not an incentive — it asks
  // them to work for nothing and makes the sender look like they do not know how the business works. The
  // measured result was a 0.4% win rate, and the target of 50 links a week is arithmetically unreachable
  // by volume (it would need ~12,500 sends against a ~3,430/week ceiling), so the rate is the only lever.
  //
  // No number is quoted, deliberately. Naming a figure first either overpays a small site or insults a
  // large one, and it hands away the negotiation before they have said what they want. Asking them to
  // name terms also qualifies them in one reply: a rate card back means yes-in-principle, and everything
  // after that is the negotiator's job.
  // Tokens, not baked values: {{first_name}} is the greeting (a full name there reads like a
  // mail merge), {{target_url}} makes the template portable instead of freezing this campaign's
  // URL into the row. Existing rows are rewritten to match by scripts/078_first_name_token.mjs —
  // the copy lives BOTH here and in stored email_templates rows (the 058 lesson).
  const subject = pageTopic ? `Paid collaboration on your ${pageTopic} piece` : `Paid collaboration on your article`;
  const body =
    `Hi {{first_name}},\n\n{{custom_line}}\n\n` +
    `I'll be direct, since I know you get a lot of these: we'd like to pay for a collaboration. ` +
    `ImagineArt is an AI image and video generator ({{target_url}}), and we'd like to be included in that piece. ` +
    `We have budget allocated for this and we're happy to work to your usual rate and terms.\n\n` +
    `If you're open to it, reply with what you charge and how you prefer to handle it, and I'll get it moving.\n\n` +
    `The piece I mean: {{article_link}}\n\nThanks,\nThe ImagineArt team`;
  // The old guidance said "(title given) … naming a detail a skim would miss" — with only a title
  // to work from, that is an instruction to fabricate, and the fabricated specifics are what the
  // team read as "generic and robotic". The prompt now carries extracted article text; the
  // guidance points at it and forbids anything beyond it. Stored rows are rewritten to match by
  // scripts/081_grounded_guidance.mjs (the copy lives BOTH here and in email_templates rows).
  const guidance =
    `This is PAID backlink outreach. Write ONLY a 1-2 sentence opener referencing the recipient's specific ` +
    `article. The prompt gives you extracted text from the piece: name a concrete detail from that text ` +
    `that a skim would miss, and nothing that is not in it. If no text is given, stay general rather than ` +
    `inventing anything. Warm and plain. Do NOT pitch, do NOT mention money, payment, budget or a rate, ` +
    `do NOT write the ask, links, greeting or sign-off — the template supplies all of that immediately ` +
    `after your sentences. Never open with "I hope this finds you well" or "I came across your article".`;
  const template = await createEmailTemplate({ name: `Backlink pitch — ${label}`, subject, body, guidance });

  const { data, error } = await supabaseAdmin
    .from("backlink_campaigns")
    // created_by only here, on INSERT: reusing an existing campaign (the returns above) must
    // never re-own it — the first person to start it keeps it.
    // keywords only on INSERT for the same reason as created_by: reusing an existing campaign must
    // not silently rewrite the seed list its owner chose (the UI's dialog is where that is edited).
    .insert({ campaign_id: campaign.id, workflow_id: workflow.id, template_id: template.id, name, target_url: url, target_path: path, topic: pageTopic, created_by: opts.createdBy ?? null, ...(keywords.length ? { keywords } : {}) })
    .select().single();
  if (error) throw error;
  return data as BacklinkCampaign;
}

export async function listBacklinkCampaigns(): Promise<(BacklinkCampaign & { stageCounts: Record<string, number>; total: number })[]> {
  // Both reads throw on error. `[]` here becomes "you have 0 campaigns" in the UI and in the
  // Hermes tool; worse, a failed inner read used to list REAL campaigns with fabricated
  // stageCounts of zero — the campaign's existence lending the zero credibility.
  const { data: camps, error: campsError } = await supabaseAdmin.from("backlink_campaigns").select("*").order("created_at", { ascending: false });
  if (campsError) throw campsError;
  const out = [];
  for (const c of (camps ?? []) as BacklinkCampaign[]) {
    const { data: rows, error: rowsError } = await supabaseAdmin.from("backlink_prospects").select("stage").eq("backlink_campaign_id", c.id);
    if (rowsError) throw rowsError;
    const stageCounts: Record<string, number> = {};
    for (const r of rows ?? []) stageCounts[(r as any).stage] = (stageCounts[(r as any).stage] ?? 0) + 1;
    out.push({ ...c, stageCounts, total: (rows ?? []).length });
  }
  return out;
}

// ── Discovery → real prospects (the bridge into the existing outreach tables) ──
//
// Two things happen here that decide how many prospects a press actually yields:
//
//   • The domains we already hold are handed to discovery as `excludeDomains`, so they are dropped
//     BEFORE its maxProspects slice. Without that, every press re-scored the same top 15 domains
//     and the loop below skipped all 15 as already-saved: "Found 0 new prospects", nothing wrong,
//     no way to tell from the outside. This is the fix for "Find more prospects finds nothing".
//   • The campaign's saved keywords (101) are added to the page's own topic as extra seeds, so a
//     campaign's supply is not limited to the four queries its page title happens to produce.
//     A one-off list can be passed per run without saving it.
export async function runBacklinkDiscovery(
  bl: BacklinkCampaign,
  opts: { maxProspects?: number; keywords?: string[] } = {},
): Promise<{
  found: number; saved: number; skipped: number; duplicates: number;
  keywords: string[]; queries: number; candidates: number; alreadyKnown: number;
  /** Saved prospects per SERP surface — how many came from the AI Overview, PAA, organic, … */
  bySurface: Partial<Record<Surface, number>>;
  aiOverview: { shown: number; checked: number };
  aiAnswers: { enginesUsed: string[]; unavailable: Array<{ engine: string; reason: string }>; citedDomains: number; resolvedToArticle: number; siteLevel: number };
  /** Candidates that could not be filed at all (a write or a fetch failed). Never merged into
   *  `skipped`, because "we chose not to" and "it broke" are different answers. */
  failed: number;
  notes: string[];
}> {
  // Domains already in this campaign — don't re-add, and don't let them crowd out the slice.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("backlink_prospects").select("domain").eq("backlink_campaign_id", bl.id);
  // A failed read here is not "no prospects yet": it would send an empty exclude list into
  // discovery and re-surface everything we already have. Say so instead of quietly repeating work.
  if (existingError) throw new Error(`Could not read this campaign's existing prospects (${existingError.message}) — discovery was not run, so nothing was duplicated.`);
  const seen = new Set((existing ?? []).map((r: any) => r.domain));

  const keywords = normalizeKeywords([...(bl.keywords ?? []), ...(opts.keywords ?? [])]);
  const report = await runBacklinkTargets({
    target: bl.target_url,
    maxProspects: opts.maxProspects ?? 15,
    keywords,
    excludeDomains: [...seen],
    // Discovery shares the 300s function with scoring and the per-prospect page fetches below,
    // so the search + AI phases get a named slice of it rather than all of it.
    timeBudgetMs: 120_000,
  });

  // Advisory: sites in this batch that another campaign already lists or already emailed.
  // Reported so the toast can say so; the save below is not gated on it.
  let duplicates = 0;
  try {
    const prior = await priorContactForHosts(
      [...new Set(report.prospects.map((p) => p.domain).filter(Boolean))],
      { excludeCampaignId: bl.id, excludeWorkflowId: bl.workflow_id },
    );
    duplicates = prior.size;
  } catch { /* advisory only */ }

  const queue = new PQueue({ concurrency: 4 });
  const authorIds: string[] = [];
  let saved = 0, skipped = 0, skippedSuppressed = 0, failed = 0;
  const bySurface: Partial<Record<Surface, number>> = {};
  // Why a prospect was dropped, deduped. This loop used to swallow every failure into `skipped++`
  // with no reason attached, so a save that failed for the SAME cause on all 15 prospects — a
  // missing column, a saturated database — was indistinguishable from 15 uninteresting sites.
  const skipReasons = new Set<string>();

  await Promise.all(report.prospects.map((p) => queue.add(async () => {
    try {
      if (seen.has(p.domain)) { skipped++; return; }
      if (await isSuppressed(p.domain)) { skipped++; skippedSuppressed++; return; }

      // Byline (real person) if we can find one; else a "<Publication> Editorial" pseudo-author.
      const raw = await fetchRaw(p.url);
      const byline = raw?.ok && raw.html ? extractByline(raw.html) : null;
      const fullName = byline ?? `${publicationName(p.domain)} Editorial`;
      // Second harvest from the same fetch: the page's readable text, stored on the article row so
      // the drafter can cite what the piece actually says (articleContext.ts). Spread-guarded —
      // a failed extraction must not null out content some other path already stored.
      const readable = raw?.ok && raw.html ? await extractReadability(raw.html, p.url).catch(() => null) : null;
      const articleText = clipArticleText(readable?.textContent, ARTICLE_TEXT_STORE_MAX);

      const domain = await upsertDomain(p.domain, { name: publicationName(p.domain) });
      const author = await upsertAuthor({ full_name: fullName, primary_domain_id: domain.id, source: "backlink", role: "writer" });
      const article = await upsertArticle({
        url_canonical: p.url, title: p.title || p.domain, domain_id: domain.id,
        ...(readable?.excerpt ? { excerpt: readable.excerpt } : {}),
        ...(articleText ? { readability_text_excerpt: articleText } : {}),
      });
      await linkArticleAuthor(article.id, author.id);
      authorIds.push(author.id);

      // WHERE this prospect came from, kept on the row rather than recomputed: the SERP surface
      // that named it (the AI Overview, a question block, or the plain organic list) and the query
      // that did it. This is what lets the list show "cited in Google's AI Overview" next to a
      // domain — the difference between a page Google quotes as the authority for our keyword and
      // one that merely ranks — and what lets a keyword be judged by the prospects it produced.
      const prov = report.provenance[p.url];
      // Surfaces arrive strongest-first, so [0] is the one worth reporting: counting every surface
      // a page appeared on would let one site inflate three tallies at once.
      const surface = (prov?.surfaces ?? [])[0];
      if (surface) bySurface[surface] = (bySurface[surface] ?? 0) + 1;

      const { error: saveError } = await supabaseAdmin.from("backlink_prospects").upsert({
        backlink_campaign_id: bl.id, author_id: author.id, domain: p.domain, prospect_url: p.url,
        angle: p.angle, score: p.composite, stage: "found", updated_at: new Date().toISOString(),
        ...(prov ? {
          discovery_source: (prov.surfaces ?? []).join(","),
          discovery_query: (prov.queries ?? [])[0] ?? null,
        } : {}),
      }, { onConflict: "backlink_campaign_id,author_id", ignoreDuplicates: true });
      // supabase-js returns errors, it does not throw them, so this branch is the only thing
      // standing between a failed write and a run that reports it as a save.
      if (saveError) { skipped++; failed++; skipReasons.add(`saving ${p.domain} failed: ${saveError.message}`); return; }
      saved++;
    } catch (e) {
      skipped++; failed++;
      skipReasons.add(e instanceof Error ? e.message : "unknown failure while filing a prospect");
    }
  })));

  if (authorIds.length) {
    await linkAuthorsToCampaign(bl.campaign_id, authorIds);
    await addWorkflowProspects(bl.workflow_id, authorIds);
  }
  const notes = [...report.notes];
  if (skippedSuppressed) notes.push(`${skippedSuppressed} candidate${skippedSuppressed === 1 ? " was" : "s were"} on the suppression list and were not filed.`);
  for (const r of [...skipReasons].slice(0, 3)) notes.push(r);
  if (skipReasons.size > 3) notes.push(`…and ${skipReasons.size - 3} other distinct failure${skipReasons.size - 3 === 1 ? "" : "s"} while filing prospects.`);

  return {
    found: report.prospects.length, saved, skipped, duplicates,
    keywords, queries: report.queries.length, candidates: report.candidatesFound,
    alreadyKnown: report.candidatesAlreadyKnown, bySurface,
    aiOverview: report.aiOverview, aiAnswers: report.aiAnswers, failed, notes,
  };
}

// ── Draft backlink pitches for prospects that have an email OR a manual channel ──
// Email prospects get a `ready` pitch (queued for the send machinery). Manual-channel prospects —
// a contact form OR a LinkedIn profile, no address — get a `draft` pitch: written, visible in the
// funnel next to the channel link, and structurally unable to enter the send queue, because that
// channel is a human pasting/DMing by design. LinkedIn was left out of this at first and the
// funnel's own copy ("pitch is written overnight for manual send") promised what the loop didn't
// do — the team caught it on a DR 94 medium.com writer.
//
// TIME-BOUNDED, because each opener is one frontier-model call with a 90s timeout floor
// (llm.ts): 18 contactable prospects can cost 27 minutes worst-case, and the serverless
// function dies at 300s — measured as the "Write pitches spins for minutes, then errors"
// report. The loop drafts what fits in the budget and reports `remaining` honestly; the caller
// picks up exactly where it stopped, since a drafted prospect is never re-drafted. The "Write
// pitches" button does this itself — it keeps calling until `remaining` is 0, so one press covers
// the campaign (it used to say "press again", and people did, four or five times). The nightly
// cron resumes the same way. A prospect whose article text was never stored costs one extra fetch
// (12s ceiling) the first time — also inside the budget, also resumable.
// Stamped into a prospect's `angle` when the relevance gate holds its pitch, and checked on every
// later run so the same off-topic page is never re-judged (one model call, once). A human who
// disagrees clears the marker from the angle in the UI and the next run drafts normally.
export const OFF_TOPIC_MARKER = "off-topic for this campaign";

/**
 * The site-level pitch: a collaboration ask that names no article.
 *
 * ── When this shape is used ─────────────────────────────────────────────────────────────────────
 *
 * Everything else in this module pitches a PIECE: the relevance gate reads that page, the opener
 * quotes a detail a skim would miss, the template links to it. That shape exists because a generic
 * "let's collaborate" mail converts badly, and it is correct for "you published a roundup, please add
 * us".
 *
 * It is the wrong shape for the other real ask — "we'd like to pay for a guest post or a placement on
 * your site" — which has no article by definition. Before this, a campaign of donated domains had only
 * one path: re-file each domain onto some article and pitch that. Fine when the domain publishes on
 * our subject; useless when it does not, which was 24 of 46 on one measured campaign.
 *
 * In the default "auto" run this is where a prospect lands ONLY on an explicit off-topic VERDICT —
 * the relevance gate read the page and judged there is no article to pitch. It is still never the
 * fallback for a page that merely could not be READ: that failure keeps drafting the article shape
 * with a title-only opener, so grounded pitches cannot silently erode into generic ones and the
 * conversion difference between the two shapes stays measurable (draftedSite counts the split).
 *
 * ── What it claims: nothing it cannot know ─────────────────────────────────────────────────────
 *
 * No LLM call, and that is the design rather than a saving. There is nothing prospect-specific to say
 * that we actually know — we have a domain and no page read — so any "I loved your work on X" here
 * would be invented. The publication name comes from the domain, the rest is our own offer, and the
 * ask is for THEIR terms. Every sentence is true without reading anything.
 *
 * It also means this cannot time out: 53 prospects draft in the time one model call takes, which is
 * the failure that made draft_pitches unusable on large campaigns.
 */
export function sitePitch(input: {
  recipientName: string;
  domain: string;
  targetUrl: string;
}): { subject: string; body: string } {
  const publication = publicationName(input.domain);
  const first = firstNameOf(input.recipientName) || "there";
  const subject = `Paid content collaboration with ${publication}`;
  const body =
    `Hi ${first},\n\n` +
    `I'll be direct, since I know you get a lot of these: we'd like to pay for a content collaboration ` +
    `with ${publication}.\n\n` +
    `ImagineArt is an AI image and video generator (${input.targetUrl}). We're open to whatever suits ` +
    `how you work — a guest post we write to your brief and your standards, a sponsored piece, or a ` +
    `mention in something you already have planned. We have budget allocated for this and we're happy ` +
    `to work to your usual rate and terms.\n\n` +
    `If you're open to it, reply with what you charge and how you prefer to handle it, and I'll get it ` +
    `moving.\n\nThanks,\nThe ImagineArt team`;
  return { subject, body };
}

export async function draftBacklinkPitches(
  bl: BacklinkCampaign,
  /** `mode` forces ONE pitch shape for this run (the API / Hermes override). Omitted, the run is
   *  "auto": each prospect gets the article pitch when their page fits, and the site pitch when the
   *  relevance gate judged there is no article to pitch — so one press writes a pitch for every
   *  contactable prospect instead of stopping at the off-topic ones. A campaign stored as
   *  pitch_mode 'site' keeps its deterministic site-only run (that mode's point is zero model
   *  calls, so it cannot time out). */
  opts: { timeBudgetMs?: number; mode?: "article" | "site" } = {},
): Promise<{ drafted: number; draftedManual: number; draftedSite: number; draftedLinkedin: number; draftedWhatsapp: number; skippedNoEmail: number; skippedRecentContact: number; skippedOffTopic: number; skippedAngleRewrite: number; remaining: number; alreadyDrafted: number }> {
  const deadline = Date.now() + (opts.timeBudgetMs ?? 240_000);
  const mode: "article" | "site" | "auto" = opts.mode ?? (bl.pitch_mode === "site" ? "site" : "auto");
  // Not fetched for site-only runs: the site pitch is built in code and a stored article template's
  // guidance ("reference the recipient's specific article") would be actively wrong for it.
  const template = mode !== "site" && bl.template_id ? await getEmailTemplate(bl.template_id) : null;
  // BEST FIRST, and the order matters as much as the filter.
  //
  // This select had no ORDER BY, so Postgres returned prospects in whatever order it liked. That is
  // invisible when the whole list fits in the budget and decisive when it does not: a run that gets
  // through three pitches before its deadline drafted three ARBITRARY prospects, while the funnel
  // beside it listed the same campaign sorted by score. So the pitch that got written was routinely
  // not the one the person was looking at — reported as "it wrote a pitch for the wrong prospect",
  // which is exactly what it did.
  //
  // Same `score` DESC the funnel uses (see getFunnel), so what drafts first is what shows first.
  // `nullsFirst: false` keeps unscored prospects — Hunter unavailable, no confidence score — behind
  // the ones with real numbers instead of ahead of them.
  const { data: prospects } = await supabaseAdmin
    .from("backlink_prospects")
    .select("id, author_id, domain, prospect_url, stage, outreach_email_id, angle, score")
    .eq("backlink_campaign_id", bl.id)
    .in("stage", ["found", "emailing", "ready"])
    .order("score", { ascending: false, nullsFirst: false });
  const rows = (prospects ?? []) as any[];
  if (!rows.length) return { drafted: 0, draftedManual: 0, draftedSite: 0, draftedLinkedin: 0, draftedWhatsapp: 0, skippedNoEmail: 0, skippedRecentContact: 0, skippedOffTopic: 0, skippedAngleRewrite: 0, remaining: 0, alreadyDrafted: 0 };

  // Stitch author name / email / article title with separate queries (no FK-embed dependency).
  const authorIds = [...new Set(rows.map((r) => r.author_id))];
  const urls = [...new Set(rows.map((r) => r.prospect_url))];
  const { data: authors } = await supabaseAdmin.from("authors").select("id, full_name").in("id", authorIds);
  // owner_name rides along because the address is not always the byline's. Hunter's domain-search step
  // can return an editor or founder at the same publication — often the better contact for a link, since
  // they can actually place one — and the pitch has to be addressed to whoever it really goes to.
  // `form`, `linkedin` and `whatsapp` rows ride along to identify the manual-channel prospects.
  const { data: rawContacts, error: rawContactsError } = await supabaseAdmin.from("contacts").select("author_id, type, value, owner_name, owner_position").in("type", ["mailto", "form", "linkedin", "whatsapp"]).in("author_id", authorIds);
  if (rawContactsError) throw rawContactsError;
  const contacts = (rawContacts ?? []).filter((c: any) => c.type === "mailto");
  const manualAuthors = new Set((rawContacts ?? []).filter((c: any) => c.type === "form" || c.type === "linkedin" || c.type === "whatsapp").map((c: any) => c.author_id));
  const linkedinAuthors = new Set((rawContacts ?? []).filter((c: any) => c.type === "linkedin").map((c: any) => c.author_id));
  const whatsappAuthors = new Set((rawContacts ?? []).filter((c: any) => c.type === "whatsapp").map((c: any) => c.author_id));
  // Notes already written for this workflow — a note per (workflow, author) is drafted once, then
  // edited in the dialog or /emails. Separate from the pitch's own idempotency so linkedin-only
  // prospects whose email-shaped draft predates this feature get their note backfilled.
  const { data: existingNotes } = await supabaseAdmin
    .from("linkedin_messages").select("author_id").eq("workflow_id", bl.workflow_id).in("author_id", authorIds);
  const noteDrafted = new Set((existingNotes ?? []).map((n: any) => n.author_id));
  const { data: existingWaNotes } = await supabaseAdmin
    .from("whatsapp_messages").select("author_id").eq("workflow_id", bl.workflow_id).in("author_id", authorIds);
  const waNoteDrafted = new Set((existingWaNotes ?? []).map((n: any) => n.author_id));
  const { data: articles } = await supabaseAdmin.from("articles").select("url_canonical, title, excerpt, readability_text_excerpt").in("url_canonical", urls);
  const nameById = new Map((authors ?? []).map((a: any) => [a.id, a.full_name]));
  const emailById = new Map((contacts ?? []).map((c: any) => [c.author_id, c.value]));
  const ownerById = new Map(
    (contacts ?? []).filter((c: any) => c.owner_name).map((c: any) => [c.author_id, { name: c.owner_name as string, position: (c.owner_position ?? null) as string | null }]),
  );
  const titleByUrl = new Map((articles ?? []).map((a: any) => [a.url_canonical, a.title]));
  // What each piece actually says — stored at discovery since the grounding change; older
  // prospects get a one-time backfill fetch in the loop below.
  const textByUrl = new Map<string, string>((articles ?? []).map((a: any) => [a.url_canonical, (a.readability_text_excerpt || a.excerpt || "") as string]));

  // Cross-campaign suppression: now that a page can carry several campaigns (069), two of them can
  // legitimately hold the same author — but two pitches from the same company inside a month reads
  // as spam and burns the relationship for both. An author with an initial sent in the last 30
  // days, or queued right now, from ANY other workflow is skipped here, not silently mixed in.
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: elsewhere } = await supabaseAdmin
    .from("outreach_emails").select("author_id")
    .in("author_id", authorIds).eq("kind", "initial").neq("workflow_id", bl.workflow_id)
    .or(`sent_at.gte.${cutoff},status.in.(ready,scheduled)`);
  const recentlyPitched = new Set((elsewhere ?? []).map((r: any) => r.author_id));

  let drafted = 0, draftedManual = 0, draftedSite = 0, draftedLinkedin = 0, draftedWhatsapp = 0, skippedNoEmail = 0, skippedRecentContact = 0, skippedOffTopic = 0, skippedAngleRewrite = 0, remaining = 0, alreadyDrafted = 0;

  // The campaign's own angle, applied to a just-assembled draft BEFORE it is saved — so the first
  // thing a person reviews is already in their angle, instead of the stock paid ask they set the
  // angle to get away from. Runs through the SAME revisePitch as the popover and the workflow-wide
  // apply, so "the sample I confirmed" and "what the drafter writes tonight" cannot drift apart.
  //
  // Null on failure, and the caller SKIPS the prospect rather than saving the stock draft: the
  // owner said the default angle is wrong for this campaign, so shipping it anyway because a model
  // call failed would be the load-honesty bug in prose form. The prospect stays undrafted
  // (outreach_email_id never set), the skip is counted, and the next press retries it.
  const angle = bl.pitch_angle?.trim() || null;
  const applyAngle = async (
    subject: string, body: string,
    context: { recipientName?: string | null; domain?: string | null; articleTitle?: string | null; articleUrl?: string | null; targetUrl?: string | null; articleExcerpt?: string | null },
  ): Promise<{ subject: string; body: string } | null> => {
    if (!angle) return { subject, body };
    const out = await revisePitch({ instruction: angle, subject, body, context });
    if (!out.ok || !out.body) return null;
    return { subject: out.subject ?? subject, body: out.body };
  };

  // One site-shaped pitch, written and filed. Shared by site-only runs (every prospect) and auto
  // runs (the prospects the relevance gate judged to have no article to pitch).
  // With a pitch_angle set this costs one model call — the campaign owner traded "cannot time out"
  // for "written my way" explicitly, and the loop's budget checks still bound the run.
  const draftSitePitch = async (p: { id: string; author_id: string; domain: string }, recipientName: string, manualOnly: boolean) => {
    const stock = sitePitch({ recipientName, domain: String(p.domain), targetUrl: bl.target_url });
    const angled = await applyAngle(stock.subject, stock.body, {
      recipientName, domain: String(p.domain), targetUrl: bl.target_url,
    });
    if (!angled) { skippedAngleRewrite++; return; }
    const { subject, body } = angled;
    const oe = await upsertOutreachEmail({
      workflow_id: bl.workflow_id, author_id: p.author_id,
      // No template_id: the site pitch is built in code, not from a stored row, so pointing at the
      // article template would mislabel it in /emails and invite an edit that does nothing.
      subject, body, status: manualOnly ? "draft" : "ready",
    });
    await supabaseAdmin.from("backlink_prospects")
      .update({ stage: "ready", outreach_email_id: oe.id, updated_at: new Date().toISOString() })
      .eq("id", p.id);
    if (manualOnly) draftedManual++; else drafted++;
    draftedSite++;
  };

  for (const p of rows) {
    // A LinkedIn-only prospect ALSO gets a real LinkedIn note — clamped to the platform's 300-char
    // cap and stored in linkedin_messages, where the pitch dialog and /emails' LinkedIn mode read
    // it. The email-shaped pitch below still gets written (it serves the contact-form case and is
    // the reference wording), but it is unusable as a DM: unclamped and shaped like a letter.
    // Runs BEFORE the pitch's own already-drafted skip so pre-existing drafts are backfilled.
    // The email template's guidance is deliberately NOT passed — it writes bare openers ("do NOT
    // write greeting/ask"), which would corrupt a standalone note.
    if (linkedinAuthors.has(p.author_id) && !emailById.has(p.author_id)
        && !noteDrafted.has(p.author_id) && Date.now() < deadline) {
      const noteTitle = titleByUrl.get(p.prospect_url);
      // The note generator takes an excerpt too (generateNote slices it to its own budget). Stored
      // text only — no backfill fetch here; the note block also runs for already-drafted pitches,
      // and a fetch per LinkedIn prospect per night would be budget spent on a nicety.
      const noteText = textByUrl.get(p.prospect_url) ?? "";
      try {
        const note = await generateNote(
          nameById.get(p.author_id) ?? "there",
          publicationName(p.domain),
          noteTitle ? [{ title: noteTitle, ...(noteText ? { excerpt: noteText } : {}) }] : [],
        );
        await upsertLinkedinMessage({ workflow_id: bl.workflow_id, author_id: p.author_id, body: note });
        noteDrafted.add(p.author_id);
        draftedLinkedin++;
      } catch { /* reported by its absence; the nightly run retries, the pitch draft still lands */ }
    }
    // Same deal for WhatsApp-only prospects: a chat-sized first DM in whatsapp_messages, sent by
    // a person via the wa.me link. Same backfill-before-skip ordering, same no-guidance rule
    // (the email template's bare-opener guidance would corrupt a standalone message).
    if (whatsappAuthors.has(p.author_id) && !emailById.has(p.author_id)
        && !waNoteDrafted.has(p.author_id) && Date.now() < deadline) {
      const noteTitle = titleByUrl.get(p.prospect_url);
      // Grounded on the same stored text the LinkedIn note reads (generateWhatsappNote slices it
      // to its own budget) — a title-only DM is exactly the plausible-sounding opener the
      // grounding change removed.
      const noteText = textByUrl.get(p.prospect_url) ?? "";
      try {
        const note = await generateWhatsappNote(
          nameById.get(p.author_id) ?? "there",
          publicationName(p.domain),
          noteTitle ? [{ title: noteTitle, ...(noteText ? { excerpt: noteText } : {}) }] : [],
        );
        await upsertWhatsappMessage({ workflow_id: bl.workflow_id, author_id: p.author_id, body: note });
        waNoteDrafted.add(p.author_id);
        draftedWhatsapp++;
      } catch { /* same contract as the LinkedIn note above */ }
    }
    // A prospect whose pitch already exists is DONE here. This loop used to regenerate every
    // unsent pitch on every run — one model call per prospect per night — and, because
    // upsertOutreachEmail UPDATES the existing row's subject/body, it silently overwrote pitches
    // a person had reviewed and edited by hand. An existing pitch changes in the pitch dialog,
    // nowhere else. This is also what makes a budget-interrupted run resumable: the re-press
    // flies past the drafted ones straight to the leftovers.
    if (p.outreach_email_id) { alreadyDrafted++; continue; }
    // Budget check next: what doesn't fit is REPORTED, never silently dropped.
    if (Date.now() >= deadline) { remaining++; continue; }
    if (recentlyPitched.has(p.author_id)) { skippedRecentContact++; continue; }
    const hasEmail = emailById.has(p.author_id);
    // Manual channel: no address, but a stored contact form or LinkedIn. The pitch is worth
    // writing — a human pastes or DMs it — but it must land as `draft`, never `ready` (never
    // enters the send queue).
    const manualOnly = !hasEmail && manualAuthors.has(p.author_id);
    if (!hasEmail && !manualOnly) { skippedNoEmail++; continue; }
    const byline = nameById.get(p.author_id) ?? "there";
    const owner = ownerById.get(p.author_id);
    // Who the mail actually reaches. When the address belongs to someone else, greeting the byline would
    // open "Hi Sarah," to a different person — the one mistake a recipient cannot un-see.
    const recipientName = owner?.name ?? byline;

    // ── site-only run: no article, so none of the article machinery runs ──────────────────────────
    //
    // Before the off-topic skip on purpose. That verdict is a judgement about whether a PAGE matches
    // this campaign's subject, and in a site pitch there is no page — a domain that has nothing
    // published about AI video is still a perfectly good domain to buy a guest post on. Making it
    // skip here would hold back exactly the prospects this mode exists to reach: 24 of 46 on the
    // campaign that prompted it.
    //
    // Everything else still applies. No email is still no email, and the 30-day cross-campaign
    // suppression above still holds — two mails from us inside a month reads as spam whichever kind
    // they are.
    if (mode === "site") {
      await draftSitePitch(p, recipientName, manualOnly);
      continue;
    }

    const title = titleByUrl.get(p.prospect_url) || p.prospect_url;
    // Judged off-topic on an earlier run — no fetch, no model call either way. In an explicit
    // article run that still means skip. In auto it means precisely "no article to pitch", which is
    // what the site pitch exists for — so the prospect gets that instead of getting nothing.
    if (p.angle?.includes(OFF_TOPIC_MARKER)) {
      if (mode === "article") { skippedOffTopic++; continue; }
      await draftSitePitch(p, recipientName, manualOnly);
      continue;
    }

    // The opener still references the ARTICLE (that is the reason for writing), but the model is told who
    // it is addressing and how they relate to it, so it cannot claim "your article" to someone who did
    // not write it.
    const relation = owner
      ? `You are writing to ${owner.name}${owner.position ? ` (${owner.position})` : ""} at this publication. `
        + `The article was written by ${byline}, NOT by the person you are addressing — refer to it as their `
        + `publication's piece, never as "your article".`
      : `You are writing to ${byline}, who wrote the article.`;

    // The page's readable text: stored at discovery for new prospects; a prospect saved before the
    // grounding change gets ONE backfill fetch (12s ceiling in fetchRaw), persisted so tomorrow's
    // run reads it from the row. A failed read degrades to a title-only opener that the prompt
    // FORBIDS to invent specifics — missing knowledge stays visible as generality, it is never
    // papered over with plausible detail (the load-honesty rule, applied to prose).
    let articleText = textByUrl.get(p.prospect_url) ?? "";
    if (!articleText) {
      const raw = await fetchRaw(p.prospect_url).catch(() => null);
      const readable = raw?.ok && raw.html ? await extractReadability(raw.html, p.prospect_url).catch(() => null) : null;
      articleText = clipArticleText(readable?.textContent, ARTICLE_TEXT_STORE_MAX);
      if (articleText) {
        textByUrl.set(p.prospect_url, articleText);
        try {
          await upsertArticle({
            url_canonical: p.prospect_url,
            ...(readable?.excerpt ? { excerpt: readable.excerpt } : {}),
            readability_text_excerpt: articleText,
          });
        } catch { /* only the cache write failed; this opener still gets the text */ }
      }
      // The fetch may have eaten what was left of the budget — re-check before spending the model
      // call, or the worst case (fetch + opener, both started just under the wire) outlives the
      // route's own 300s.
      if (Date.now() >= deadline) { remaining++; continue; }
    }

    // RELEVANCE GATE. A grounded opener aimed at the wrong article converts to nothing: measured
    // sends pitched an AI image generator into a DNS-tools roundup and a product-roadmap guide —
    // flawless first paragraph, impossible ask. Judged only when the piece's text was actually
    // read (a title alone proves nothing either way), and FAIL-OPEN: only a confident leading NO
    // holds the pitch; a null (model down) or garbled verdict drafts as before. The verdict is
    // stamped into `angle` so the funnel shows WHY nothing was drafted and the prospect is never
    // re-judged; clearing the marker there is the human override.
    if (articleText) {
      const fit = await llmChat({
        maxTokens: 200,
        timeoutMs: 45_000,
        hardTimeout: true,
        prompt: relevancePrompt({ targetUrl: bl.target_url, title, articleText: clipArticleText(articleText, OPENER_TEXT_BUDGET) }),
      });
      const verdict = fit?.content?.trim() ?? "";
      if (/^no\b/i.test(verdict)) {
        // The verdict lands in `angle` either way — it is both the cache that stops re-judging and
        // the honest WHY THEM in the funnel. What happens next differs by mode: an explicit article
        // run holds the pitch; auto pitches the SITE instead — a paid guest post names no article,
        // so "this page is off-topic" is no objection to it.
        const reason = verdict.replace(/^no\b[\s—–:,.-]*/i, "").split("\n")[0].slice(0, 140);
        const note = `${OFF_TOPIC_MARKER} (${new Date().toISOString().slice(0, 10)}): ${reason || "no editorial fit"}`;
        await supabaseAdmin.from("backlink_prospects")
          .update({ angle: p.angle ? `${p.angle}; ${note}` : note, updated_at: new Date().toISOString() })
          .eq("id", p.id);
        if (mode === "article") { skippedOffTopic++; continue; }
        await draftSitePitch(p, recipientName, manualOnly);
        continue;
      }
      // The gate spent up to 45s of the shared budget — re-check before the opener call.
      if (Date.now() >= deadline) { remaining++; continue; }
    }

    // Hard 45s ceiling per opener: a slow frontier turn degrades to the canned fallback line
    // below instead of stalling the whole batch past the function's lifetime. The 90s floor
    // exists for callers that would rather wait.
    const opener = await llmChat({
      system: template?.guidance,
      maxTokens: 300,
      timeoutMs: 45_000,
      hardTimeout: true,
      prompt: openerPrompt({ relation, title, articleText: clipArticleText(articleText, OPENER_TEXT_BUDGET) }),
    });
    const customLine = sanitizeModelText(
      opener?.content?.trim() || openerFallback(titleByUrl.get(p.prospect_url), !!owner),
    );

    // Shared token filler + the deterministic guarantee. Note {{author_name}} is now the FULL
    // name (matching the workflow generator and PLACEHOLDER_DOCS); the greeting token is
    // {{first_name}} — 078 rewrites the stored backlink templates accordingly. Unknown tokens are
    // stripped rather than shipped, and ensurePersonalized re-adds greeting/article-link if a
    // hand-edited template lost them.
    const first = firstNameOf(recipientName);
    const vars = {
      first_name: first,
      author_name: String(recipientName),
      custom_line: customLine,
      article_link: p.prospect_url,
      article_title: titleByUrl.get(p.prospect_url) ?? "",
      target_url: bl.target_url,
    };
    // The subject goes through the filler too (it never used to — a token in a stored subject
    // shipped literally), so a template can lead with the piece itself: "…your {{article_title}}".
    const subject = fillTokens(template?.subject ?? "A resource for your piece", vars).trim() || "A resource for your piece";
    const filled = fillTokens(
      template?.body ?? "Hi {{first_name}},\n\n{{custom_line}}\n\n{{article_link}}",
      vars,
    );
    const body = ensurePersonalized(filled, { firstName: first, articleUrl: p.prospect_url });

    // The campaign's angle, applied to the assembled draft — grounded in the same recipient,
    // article and extracted text the opener just used, so the rewrite can keep the specifics.
    // A failed rewrite skips the prospect (see applyAngle) instead of saving the stock angle.
    const angled = await applyAngle(subject, body, {
      recipientName: String(recipientName), domain: String(p.domain),
      articleTitle: titleByUrl.get(p.prospect_url) ?? null, articleUrl: p.prospect_url,
      targetUrl: bl.target_url, articleExcerpt: articleText ? clipArticleText(articleText, OPENER_TEXT_BUDGET) : null,
    });
    if (!angled) { skippedAngleRewrite++; continue; }

    const oe = await upsertOutreachEmail({ workflow_id: bl.workflow_id, author_id: p.author_id, template_id: bl.template_id ?? undefined, subject: angled.subject, body: angled.body, status: manualOnly ? "draft" : "ready" });
    await supabaseAdmin.from("backlink_prospects").update({ stage: "ready", outreach_email_id: oe.id, updated_at: new Date().toISOString() }).eq("id", p.id);
    if (manualOnly) draftedManual++; else drafted++;
  }
  return { drafted, draftedManual, draftedSite, draftedLinkedin, draftedWhatsapp, skippedNoEmail, skippedRecentContact, skippedOffTopic, skippedAngleRewrite, remaining, alreadyDrafted };
}

// ── Sync funnel stages from the reused outreach_emails (sent / replied) ────────
export async function refreshStages(blId: string): Promise<void> {
  const { data: prospects } = await supabaseAdmin
    .from("backlink_prospects")
    .select("id, author_id, stage, link_live_at, outreach_email_id")
    .eq("backlink_campaign_id", blId);
  const rows = (prospects ?? []) as any[];
  const emailIds = rows.map((p) => p.outreach_email_id).filter(Boolean);
  const { data: emails } = emailIds.length
    ? await supabaseAdmin.from("outreach_emails").select("id, status, sent_at, replied_at").in("id", emailIds)
    : { data: [] };
  const emailById = new Map((emails ?? []).map((e: any) => [e.id, e]));

  // Manual-channel sends: a LinkedIn note a person marked as DM'd (080), or a WhatsApp message
  // they marked as sent (082). The email row for these prospects is a status='draft' dead end by
  // design, so without this the stage could never leave "ready" no matter how many DMs went out.
  const { data: bl } = await supabaseAdmin.from("backlink_campaigns").select("workflow_id").eq("id", blId).maybeSingle();
  const { data: sentNotes } = bl?.workflow_id
    ? await supabaseAdmin.from("linkedin_messages").select("author_id").eq("workflow_id", bl.workflow_id).not("sent_at", "is", null)
    : { data: [] };
  const { data: sentWaNotes } = bl?.workflow_id
    ? await supabaseAdmin.from("whatsapp_messages").select("author_id").eq("workflow_id", bl.workflow_id).not("sent_at", "is", null)
    : { data: [] };
  const dmedAuthors = new Set([...((sentNotes ?? []) as any[]), ...((sentWaNotes ?? []) as any[])].map((n) => n.author_id));

  for (const p of rows) {
    // link_live_at records the FIRST sighting and survives a later loss — so 'lost' (set by the
    // decay re-check when a won link disappears) must not be bounced back to 'won' here.
    if (p.link_live_at) { if (p.stage !== "won" && p.stage !== "lost") await setStage(p.id, "won"); continue; }
    const e = p.outreach_email_id ? emailById.get(p.outreach_email_id) : null;
    if (!e) continue;
    let stage: Stage | null = null;
    if (e.replied_at) stage = "replied";
    else if (e.sent_at || e.status === "sent") stage = "sent";
    // A draft-status pitch whose note was DM'd IS sent — by hand, on another channel. Replies to
    // DMs are invisible to IMAP, so 'replied' stays out of reach; the link check still drives won.
    else if (e.status === "draft" && dmedAuthors.has(p.author_id)) stage = "sent";
    else if (e.status === "ready" || e.status === "scheduled" || e.status === "draft") stage = "ready";
    if (stage && stage !== p.stage) await setStage(p.id, stage);
  }
}

async function setStage(id: string, stage: Stage): Promise<void> {
  await supabaseAdmin.from("backlink_prospects").update({ stage, updated_at: new Date().toISOString() }).eq("id", id);
}

/** Decay bookkeeping as a pure decision, so the selfcheck can assert the two-strike rule without
 *  a network. A won link is re-checked once its last look is older than the cadence; a check that
 *  fails to see the link (page loads without it, OR the page itself is gone — a removed article
 *  removes the link) is one strike; two CONSECUTIVE strikes demote to 'lost'. Two, not one,
 *  because strikes land a full cadence apart and a transient outage must not erase a real win.
 *  A sighting at any point resets the count (and un-loses a recovered link). */
export function decayDecision(input: {
  linkLiveAt: string | null; linkCheckedAt: string | null; linkMisses: number;
  cadenceDays: number; now: number;
}): "skip-fresh" | "recheck" | "check-new" {
  if (!input.linkLiveAt) return "check-new";
  const lastLook = input.linkCheckedAt ?? input.linkLiveAt;
  const age = input.now - Date.parse(lastLook);
  return age >= input.cadenceDays * 86_400_000 ? "recheck" : "skip-fresh";
}

// ── "Did the link actually go live — and is it STILL live?" ────────────────────
// Non-won prospects are crawled for a first sighting, exactly as before. Won prospects are no
// longer trusted forever: each is re-crawled on a cadence (default weekly), and the two-strike
// rule above demotes quietly-removed links to 'lost' instead of leaving phantom wins on the
// board. The cron's own header used to call that hole out; this closes it.
/**
 * Give every homepage-only prospect a real article to be pitched about.
 *
 * The missing step between "I have a list of domains" and outreach. A prospect filed from a domain has
 * the homepage as its article, so the relevance gate reads a front page, correctly refuses, and the
 * campaign stalls with everything marked off-topic — 43 of 46 on one measured campaign.
 *
 * Three things happen per prospect, and all three are needed for it to actually become pitchable:
 *
 *   1. the article URL is replaced with a real piece on that domain (findArticleForDomain)
 *   2. the piece's text is fetched and STORED, so the gate and the opener read the real page
 *   3. the stale off-topic verdict is cleared from `angle`
 *
 * (3) is not tidying. The verdict is stamped as text and the drafter skips on its presence alone —
 * "the prospect is never re-judged; clearing the marker there is the human override". Re-filing the URL
 * without clearing it changes which page is stored and leaves the prospect just as skipped, which is the
 * shape of the bug this is meant to end.
 *
 * A domain with nothing on the subject is left exactly as it was, with the reason recorded. That is a
 * real answer — the site is not a fit — and inventing a match for it would put the pitch back in front
 * of the gate that already said no.
 *
 * Nothing here writes a pitch or sends anything.
 */
export async function refileProspectArticles(
  bl: BacklinkCampaign,
  opts: { timeBudgetMs?: number; limit?: number } = {},
): Promise<{
  scanned: number; refiled: number; noArticleFound: number; alreadyArticle: number; remaining: number;
  details: Array<{ domain: string; from: string; to: string | null; title?: string; reason?: string }>;
}> {
  const deadline = Date.now() + (opts.timeBudgetMs ?? 240_000);
  // A campaign aimed at the site rather than one page has no slug to read a topic from, so its own
  // name is the next best description of what it is about. "our tool" as a search term finds nothing.
  const topic = bl.topic?.trim() || topicFromOrNull(bl.target_path) || bl.name?.trim() || topicFrom(bl.target_path);
  const out = {
    scanned: 0, refiled: 0, noArticleFound: 0, alreadyArticle: 0, remaining: 0,
    details: [] as Array<{ domain: string; from: string; to: string | null; title?: string; reason?: string }>,
  };

  const { data: rows } = await supabaseAdmin
    .from("backlink_prospects")
    .select("id, domain, prospect_url, stage, angle, score")
    .eq("backlink_campaign_id", bl.id)
    .in("stage", ["found", "emailing", "ready"])
    .order("score", { ascending: false, nullsFirst: false });
  const all = (rows ?? []) as Array<Record<string, any>>;
  out.scanned = all.length;

  // Every URL already in use on this campaign, so two prospects are not re-filed onto one article —
  // two pitches quoting the same piece to different people at the same publication reads as a mailshot.
  const taken = new Set(all.map((r) => String(r.prospect_url)));

  const targets = all.filter((r) => looksLikeHomepage(String(r.prospect_url)));
  out.alreadyArticle = all.length - targets.length;
  const limit = Math.max(1, Math.min(opts.limit ?? targets.length, targets.length));

  for (const [i, p] of targets.entries()) {
    if (i >= limit) { out.remaining++; continue; }
    // Budget checked BEFORE the work, and what does not fit is reported rather than dropped: this runs
    // a search and a page fetch per prospect, and the caller can press again.
    if (Date.now() >= deadline) { out.remaining++; continue; }

    const from = String(p.prospect_url);
    const found = await findArticleForDomain({ domain: String(p.domain), topic, exclude: taken })
      .catch((e) => ({ best: null, considered: 0, reason: e instanceof Error ? e.message : "search failed" }));
    if (!found.best) {
      out.noArticleFound++;
      out.details.push({ domain: String(p.domain), from, to: null, reason: found.reason ?? "no article found" });
      continue;
    }
    const url = found.best.url;
    taken.add(url);

    // Store the piece's text now. The drafter can backfill it later, but doing it here means the
    // relevance gate judges the real page on the very next run instead of spending its own budget.
    let articleText = "";
    try {
      const raw = await fetchRaw(url);
      const readable = raw?.ok && raw.html ? await extractReadability(raw.html, url).catch(() => null) : null;
      articleText = clipArticleText(readable?.textContent, ARTICLE_TEXT_STORE_MAX);
      await upsertArticle({
        url_canonical: url,
        title: found.best.title || readable?.title || url,
        ...(readable?.excerpt ? { excerpt: readable.excerpt } : {}),
        ...(articleText ? { readability_text_excerpt: articleText } : {}),
      });
    } catch {
      // The URL is still the better target even if this read failed; the drafter fetches on demand.
      await upsertArticle({ url_canonical: url, title: found.best.title || url }).catch(() => {});
    }

    // Drop the off-topic verdict, keep everything else somebody wrote there.
    const kept = String(p.angle ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s && !s.includes(OFF_TOPIC_MARKER));
    kept.push(`article URL re-filed ${new Date().toISOString().slice(0, 10)} from the homepage to "${found.best.title.slice(0, 90)}"`);

    await supabaseAdmin.from("backlink_prospects")
      .update({ prospect_url: url, angle: kept.join("; "), updated_at: new Date().toISOString() })
      .eq("id", p.id);

    out.refiled++;
    out.details.push({ domain: String(p.domain), from, to: url, title: found.best.title });
  }

  return out;
}

export async function verifyBacklinks(
  bl: BacklinkCampaign,
  opts: { recheckWonAfterDays?: number } = {},
): Promise<{ checked: number; live: number; rechecked: number; lost: number }> {
  const cadenceDays = opts.recheckWonAfterDays ?? 7;
  const { data: prospects } = await supabaseAdmin
    .from("backlink_prospects")
    .select("id, prospect_url, outreach_email_id, link_live_at, link_checked_at, link_misses, stage")
    .eq("backlink_campaign_id", bl.id);
  const queue = new PQueue({ concurrency: 4 });
  let checked = 0, live = 0, rechecked = 0, lost = 0;
  await Promise.all(((prospects ?? []) as any[]).map((p) => queue.add(async () => {
    const decision = decayDecision({
      linkLiveAt: p.link_live_at, linkCheckedAt: p.link_checked_at,
      linkMisses: p.link_misses ?? 0, cadenceDays, now: Date.now(),
    });
    if (decision === "skip-fresh") { live++; return; }
    const isRecheck = decision === "recheck";
    if (isRecheck) rechecked++; else checked++;

    const raw = await fetchRaw(p.prospect_url);
    const nowIso = new Date().toISOString();
    const $ = raw?.ok && raw.html ? cheerio.load(raw.html) : null;
    let found = false;
    $?.("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      try { if (toPath(new URL(href, p.prospect_url).toString()) === bl.target_path && new URL(href, p.prospect_url).host.includes("imagine.art")) found = true; } catch { /* ignore */ }
    });

    if (found) {
      live++;
      await supabaseAdmin.from("backlink_prospects").update({
        stage: "won", link_live_at: p.link_live_at ?? nowIso, link_checked_at: nowIso, link_misses: 0, updated_at: nowIso,
      }).eq("id", p.id);
      if (!p.link_live_at && p.outreach_email_id) {
        await updateOutreachEmail(p.outreach_email_id, { success_at: nowIso, success_link: p.prospect_url, success_notes: "Backlink verified live by crawler." });
      }
      return;
    }
    if (isRecheck) {
      const misses = (p.link_misses ?? 0) + 1;
      const newlyLost = misses >= 2 && p.stage !== "lost";
      if (newlyLost) lost++;                    // `lost` reports NEW demotions only
      else if (p.stage !== "lost") live++;      // one strike: still on the board, flagged for next look
      await supabaseAdmin.from("backlink_prospects").update({
        ...(misses >= 2 ? { stage: "lost" } : {}), link_checked_at: nowIso, link_misses: misses, updated_at: nowIso,
      }).eq("id", p.id);
    }
    // A never-won prospect with no link stays as it was — same as before.
  })));
  return { checked, live, rechecked, lost };
}

// ── Wins the campaign boards can't see ─────────────────────────────────────────
// verifyBacklinks only crawls backlink_prospects.prospect_url — but most of the funnel's real
// wins were closed through PLAIN workflows with no prospect row at all. Measured 2026-08-18:
// three live imagine.art links from replied threads (wireflow.ai, abyssale.com, a Substack),
// of which two were invisible to every board because no backlink campaign held the author.
// This sweep closes that hole: every author who ever REPLIED to an initial that has no recorded
// success gets their stored article pages re-crawled for a live imagine.art link, and a sighting
// stamps success_at/success_link on the thread — the same fields the inbox and sending pages
// already badge. ANY imagine.art path counts (a /workflow link won off a Freepik piece is a real
// win even though no campaign targets /workflow). Idempotent via the success_at IS NULL filter.
export async function sweepRepliedWins(
  opts: { timeBudgetMs?: number } = {},
): Promise<{ checked: number; won: number; unreachable: number; remaining: number }> {
  const deadline = Date.now() + (opts.timeBudgetMs ?? 60_000);
  // Every read here THROWS on error (the caller records the failed night): a failed read that
  // returned zeros would be indistinguishable from "no wins anywhere" — the load-honesty rule.
  const { data: replied, error: repliedError } = await supabaseAdmin
    .from("outreach_emails")
    .select("id, author_id")
    .eq("kind", "initial").not("replied_at", "is", null).not("sent_at", "is", null).is("success_at", null);
  if (repliedError) throw repliedError;
  const repliedRows = (replied ?? []) as Array<{ id: string; author_id: string | null }>;
  const emailByAuthor = new Map(repliedRows.filter((r) => r.author_id).map((r) => [r.author_id as string, r.id]));
  if (!emailByAuthor.size) return { checked: 0, won: 0, unreachable: 0, remaining: 0 };

  const authorIds = [...emailByAuthor.keys()];
  const { data: aa, error: aaError } = await supabaseAdmin.from("article_authors").select("author_id, article_id").in("author_id", authorIds);
  if (aaError) throw aaError;
  const aaRows = (aa ?? []) as Array<{ author_id: string; article_id: string }>;
  const artIds = [...new Set(aaRows.map((x) => x.article_id))];
  const artsRes = artIds.length
    ? await supabaseAdmin.from("articles").select("id, url_canonical").in("id", artIds)
    : { data: [], error: null };
  if (artsRes.error) throw artsRes.error;
  const urlById = new Map(((artsRes.data ?? []) as Array<{ id: string; url_canonical: string }>).map((a) => [a.id, a.url_canonical]));
  const pages = aaRows
    .map((x) => ({ url: urlById.get(x.article_id) as string, authorId: x.author_id }))
    .filter((p) => !!p.url);
  // Shuffled, because the set outgrows one night's budget: with a stable order every run would
  // re-crawl the same head and the tail would never be looked at. Random order makes nightly
  // coverage even out; a win missed tonight is caught on a later pass.
  for (let i = pages.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pages[i], pages[j]] = [pages[j], pages[i]];
  }

  const queue = new PQueue({ concurrency: 4 });
  let checked = 0, won = 0, unreachable = 0, remaining = 0;
  const wonAuthors = new Set<string>();
  await Promise.all(pages.map((page) => queue.add(async () => {
    // Budget check per page: what doesn't fit tonight is REPORTED and swept tomorrow.
    if (Date.now() >= deadline) { remaining++; return; }
    if (wonAuthors.has(page.authorId)) return; // one live sighting per author is the win
    const raw = await fetchRaw(page.url);
    checked++;
    if (!raw?.ok || !raw.html) { unreachable++; return; }
    const $ = cheerio.load(raw.html);
    let target: string | null = null;
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      try { if (new URL(href, page.url).host.includes("imagine.art")) target = href; } catch { /* ignore */ }
    });
    if (!target) return;
    wonAuthors.add(page.authorId);
    won++;
    await updateOutreachEmail(emailByAuthor.get(page.authorId)!, {
      success_at: new Date().toISOString(),
      success_link: page.url,
      success_notes: `imagine.art link (${target}) found live by the replied-authors sweep.`,
    });
  })));
  return { checked, won, unreachable, remaining };
}

/** How much to trust an email address, derived from how it was obtained.
 *
 *  This is the distinction that decides who gets emailed first. `sourced` means the address was found
 *  somewhere real — on their article page, a social profile, or via Blitz from their LinkedIn.
 *  `verified` means it was CONSTRUCTED from a domain pattern but Reoon then confirmed the mailbox
 *  accepts mail. `guess` means constructed and never confirmed, or confirmed only as catch-all —
 *  which is where bounces come from, and why these sort last rather than being silently mixed in.
 *
 *  Kept as a pure function of `source` so the ordering can never disagree with the badge shown. */
export type EmailTrust = "sourced" | "verified" | "guess" | "none";

export function emailTrust(source: string | null): EmailTrust {
  if (!source) return "none";
  if (source === "pattern-verified") return "verified";
  // "page-scrape-unmatched": found on the author's page but matching neither the byline nor the
  // page's own domain — probably somebody else's address (cascade step 1). Guess-level, so the
  // send gate holds it, exactly like a constructed pattern.
  if (source === "pattern" || source === "pattern-catchall" || source === "page-scrape-unmatched") return "guess";
  return "sourced";
}

/** Rank order for EmailTrust, highest first. Used as a sort key, so it lives next to the type. */
export const EMAIL_TRUST_RANK: Record<EmailTrust, number> = { sourced: 3, verified: 2, guess: 1, none: 0 };

/** The best way to reach an author, from their stored contact types. An email is the machine's
 *  channel; a contact form or a social profile is a HUMAN's channel — surfaced so a prospect
 *  without an address reads as "reachable, manually" instead of silently unreachable, which is
 *  what ~13 of 15 prospects in a measured campaign actually were. Pure, for the selfcheck. */
export type ContactChannel = "email" | "whatsapp" | "form" | "linkedin" | "social" | "none";

export function contactChannel(types: string[]): ContactChannel {
  const set = new Set(types);
  if (set.has("mailto")) return "email";
  // WhatsApp beats the other manual routes: a chat lands directly with the person, where a
  // contact form is a queue and a LinkedIn note waits behind a connection accept.
  if (set.has("whatsapp")) return "whatsapp";
  if (set.has("form")) return "form";
  if (set.has("linkedin")) return "linkedin";
  if (set.has("twitter") || set.has("instagram") || set.has("mastodon") || set.has("author_page") || set.has("youtube")) return "social";
  return "none";
}

// ── Funnel data for the UI ─────────────────────────────────────────────────────
export async function getFunnel(blId: string): Promise<any> {
  // Every read in here throws on error. Null means exactly "no campaign with this id" — callers
  // print that sentence — and a PARTIAL failure is worse than a total one: prospects loading
  // while the contacts read fails used to render every prospect as unreachable, and a failed
  // attention read reported "nothing needs you" over a parked negotiation.
  const { data: bl, error: blError } = await supabaseAdmin.from("backlink_campaigns").select("*").eq("id", blId).maybeSingle();
  if (blError) throw blError;
  if (!bl) return null;
  await refreshStages(blId);
  const { data: prospects, error: prospectsError } = await supabaseAdmin
    .from("backlink_prospects")
    // outreach_email_id is REQUIRED here, not optional: the attention block below maps over
    // `p.outreach_email_id`, and while it was missing from this select every id was undefined, so
    // `emailIds` was always empty and the interventions / awaiting-payment / ai-paused counts silently
    // reported zero no matter what the negotiator had actually parked. It also joins the drafted pitch.
    .select("id, author_id, domain, prospect_url, angle, score, stage, link_live_at, outreach_email_id, discovery_source, discovery_query")
    .eq("backlink_campaign_id", blId)
    .order("score", { ascending: false });
  if (prospectsError) throw prospectsError;
  const pRows = (prospects ?? []) as any[];
  const authorIds = [...new Set(pRows.map((p) => p.author_id))];
  const authorsRes = authorIds.length ? await supabaseAdmin.from("authors").select("id, full_name").in("id", authorIds) : { data: [], error: null };
  if (authorsRes.error) throw authorsRes.error;
  const authors = authorsRes.data;
  // ALL contact types, not just mailto: the funnel now reports each prospect's best CHANNEL, so a
  // writer with a contact form or a LinkedIn but no address reads as manually-reachable rather
  // than dead. `source` and `confidence` come along because the UI ranks on email QUALITY, not
  // just presence: a scraped address and a constructed guess are not the same prospect.
  const contactsRes = authorIds.length
    ? await supabaseAdmin.from("contacts").select("author_id, type, value, source, confidence, owner_name, owner_position").in("author_id", authorIds)
    : { data: [], error: null };
  if (contactsRes.error) throw contactsRes.error;
  const allContacts = contactsRes.data;
  const contacts = (allContacts ?? []).filter((c: any) => c.type === "mailto");
  const typesByAuthor = new Map<string, string[]>();
  const channelValueByAuthor = new Map<string, { form?: string; linkedin?: string; whatsapp?: string }>();
  for (const c of (allContacts ?? []) as any[]) {
    typesByAuthor.set(c.author_id, [...(typesByAuthor.get(c.author_id) ?? []), c.type]);
    const cv = channelValueByAuthor.get(c.author_id) ?? {};
    if (c.type === "form" && !cv.form) cv.form = c.value;
    if (c.type === "linkedin" && !cv.linkedin) cv.linkedin = c.value;
    if (c.type === "whatsapp" && !cv.whatsapp) cv.whatsapp = c.value;
    channelValueByAuthor.set(c.author_id, cv);
  }

  // Domain Rating, looked up per host. Stored on `domains.dr` (Ahrefs), so the table can show and sort
  // on real authority rather than the article-count proxy baked into `scores.composite`.
  const hosts = [...new Set(pRows.map((p) => p.domain).filter(Boolean))];
  const domainsRes = hosts.length
    ? await supabaseAdmin.from("domains").select("host, dr").in("host", hosts)
    : { data: [], error: null };
  if (domainsRes.error) throw domainsRes.error;
  const domainRows = domainsRes.data;
  const drByHost = new Map((domainRows ?? []).map((d: any) => [d.host, d.dr]));

  // Cross-campaign duplicates: the same site sitting in ANOTHER campaign's list, or — stronger —
  // already emailed from anywhere. Two people working adjacent lists see the collision before a
  // second pitch goes out. A flag only; the send pipeline's own guards stay the enforcement.
  const prior = await priorContactForHosts(hosts, { excludeCampaignId: blId, excludeWorkflowId: bl.workflow_id });

  // The drafted pitch per prospect. The team could not find anywhere to read or edit what the AI had
  // written — the drafts existed as `ready` outreach_emails with no surface at all.
  const pitchIds = pRows.map((p) => p.outreach_email_id).filter(Boolean);
  const pitchesRes = pitchIds.length
    ? await supabaseAdmin.from("outreach_emails")
        .select("id, subject, body, status, sent_at, scheduled_at, edited_at, edited_by")
        .in("id", pitchIds)
    : { data: [], error: null };
  if (pitchesRes.error) throw pitchesRes.error;
  const pitchRows = pitchesRes.data;
  const pitchById = new Map((pitchRows ?? []).map((m: any) => [m.id, m]));

  // Drafted LinkedIn notes (linkedin-only prospects), keyed by author. Same table /emails'
  // LinkedIn mode reads, so an edit in either place is the same note.
  const notesRes = authorIds.length
    ? await supabaseAdmin.from("linkedin_messages").select("author_id, body, sent_at, sent_by").eq("workflow_id", bl.workflow_id).in("author_id", authorIds)
    : { data: [], error: null };
  if (notesRes.error) throw notesRes.error;
  const noteByAuthor = new Map(((notesRes.data ?? []) as any[]).map((n: any) => [n.author_id, n]));

  // Drafted WhatsApp first messages (whatsapp-only prospects), same keying as the notes.
  const waNotesRes = authorIds.length
    ? await supabaseAdmin.from("whatsapp_messages").select("author_id, body, sent_at, sent_by").eq("workflow_id", bl.workflow_id).in("author_id", authorIds)
    : { data: [], error: null };
  if (waNotesRes.error) throw waNotesRes.error;
  const waNoteByAuthor = new Map(((waNotesRes.data ?? []) as any[]).map((n: any) => [n.author_id, n]));

  const nameById = new Map((authors ?? []).map((a: any) => [a.id, a.full_name]));
  const emailById = new Map((contacts ?? []).map((c: any) => [c.author_id, c]));
  const rows = pRows.map((p) => {
    const c = emailById.get(p.author_id);
    const value = c?.value ? String(c.value).replace(/^mailto:/, "") : null;
    return {
      id: p.id, authorId: p.author_id, domain: p.domain, prospectUrl: p.prospect_url, angle: p.angle, score: p.score,
      stage: p.stage, author: nameById.get(p.author_id) ?? null, hasEmail: !!value,
      email: value, linkLiveAt: p.link_live_at,
      // How this prospect was found: the SERP surface that named it and the query that did. Null on
      // every prospect saved before 101, and on the ones added from a pasted list or a competitor's
      // backlink profile — which is why the UI shows a badge only when there is something to say.
      discoverySurfaces: String(p.discovery_source ?? "").split(",").filter(Boolean) as Surface[],
      discoveryLabel: provenanceLabel(String(p.discovery_source ?? "").split(",").filter(Boolean) as Surface[]),
      discoveryQuery: p.discovery_query ?? null,
      // The three signals the prospect list ranks on, surfaced separately rather than blended into one
      // opaque number — so a person can see WHY a prospect is near the top and disagree with it.
      dr: drByHost.get(p.domain) ?? null,
      emailSource: c?.source ?? null,
      emailConfidence: c?.confidence ?? null,
      emailTrust: emailTrust(c?.source ?? null),
      // The best route to this person. "form"/"linkedin"/"social" mean a HUMAN can reach them
      // even though the machine can't — the pitch is drafted and ready to paste.
      contactChannel: contactChannel(typesByAuthor.get(p.author_id) ?? []),
      formUrl: channelValueByAuthor.get(p.author_id)?.form ?? null,
      linkedinUrl: channelValueByAuthor.get(p.author_id)?.linkedin ?? null,
      // The DM-ready note (≤300 chars), when one has been drafted. Null = none yet.
      linkedinNote: noteByAuthor.get(p.author_id)?.body ?? null,
      // When a person recorded actually DMing it — what lets the stage advance past "Pitch ready".
      linkedinNoteSentAt: noteByAuthor.get(p.author_id)?.sent_at ?? null,
      linkedinNoteSentBy: noteByAuthor.get(p.author_id)?.sent_by ?? null,
      // The WhatsApp route: the stored wa.me link, and the drafted chat-sized message when one
      // exists. Same manual-send contract as the LinkedIn note.
      whatsappUrl: channelValueByAuthor.get(p.author_id)?.whatsapp ?? null,
      whatsappNote: waNoteByAuthor.get(p.author_id)?.body ?? null,
      whatsappNoteSentAt: waNoteByAuthor.get(p.author_id)?.sent_at ?? null,
      whatsappNoteSentBy: waNoteByAuthor.get(p.author_id)?.sent_by ?? null,
      // Who the address actually belongs to, when it is not the byline. A Hunter domain-search alt
      // contact — an editor or founder at the same publication. Shown so an operator reviewing the pitch
      // can see it is addressed to a different person on purpose.
      emailOwner: c?.owner_name ?? null,
      emailOwnerPosition: c?.owner_position ?? null,
      // Prior history with this domain OUTSIDE this campaign. Null = clean; otherCampaigns without
      // contactedAt = merely listed elsewhere; contactedAt = a send actually happened (or is queued).
      dup: prior.get(registrableDomain(p.domain)) ?? null,
      // The pitch itself, so it can be read and edited in place rather than existing invisibly.
      pitch: (() => {
        const m = p.outreach_email_id ? pitchById.get(p.outreach_email_id) : null;
        if (!m) return null;
        return {
          id: m.id, subject: m.subject, body: m.body, status: m.status,
          sentAt: m.sent_at ?? null, scheduledAt: m.scheduled_at ?? null,
          editedAt: m.edited_at ?? null, editedBy: m.edited_by ?? null,
          // Only an unsent pitch is editable. Editing a sent one would misrepresent what went out.
          editable: !m.sent_at && m.status !== "sent",
        };
      })(),
    };
  });
  const stageCounts: Record<string, number> = {};
  for (const r of rows) stageCounts[r.stage] = (stageCounts[r.stage] ?? 0) + 1;
  const channelCounts: Record<string, number> = {};
  for (const r of rows) channelCounts[r.contactChannel] = (channelCounts[r.contactChannel] ?? 0) + 1;

  // What is parked waiting on a person. This is the only part of the funnel a human MUST act on, so it
  // is computed here rather than left for the page to infer — a count the UI derives itself would
  // drift from what the negotiator actually did.
  const emailIds = pRows.map((p) => p.outreach_email_id).filter(Boolean);
  let attention = { interventions: [] as Array<{ id: string; type: string; ask: string | null; who: string | null }>, awaitingPayment: 0, aiPaused: 0 };
  if (emailIds.length) {
    const { data: mails, error: mailsError } = await supabaseAdmin
      .from("outreach_emails")
      .select("id, author_id, intervention_type, intervention_ask, negotiation_status, payment_status, ai_managed, replied_at")
      .in("id", emailIds);
    if (mailsError) throw mailsError; // else the attention block claims "nothing needs you"
    for (const m of ((mails ?? []) as any[])) {
      if (m.intervention_type) {
        attention.interventions.push({ id: m.id, type: m.intervention_type, ask: m.intervention_ask ?? null, who: nameById.get(m.author_id) ?? null });
      }
      // "agreed but not yet paid" is the payment-approval gate.
      if (m.negotiation_status === "agreed" && m.payment_status !== "paid") attention.awaitingPayment++;
      // A replied thread the AI is NOT managing will sit forever unless a person answers it.
      if (m.replied_at && !m.ai_managed) attention.aiPaused++;
    }
  }

  // What the sends have EARNED, as rates rather than positions. Stage counts show where prospects
  // sit right now; these are cumulative (sent_at/replied_at survive stage movement), so the numbers
  // stay comparable across days and campaigns. kind is initial-or-null: rows from before the kind
  // column (026) are initials too, and dropping them would understate every long-running campaign.
  const { data: perfRows, error: perfError } = await supabaseAdmin
    .from("outreach_emails")
    .select("sent_at, replied_at, bounced_at, negotiation_status, sender_email, sent_by_email")
    .eq("workflow_id", bl.workflow_id)
    .or("kind.eq.initial,kind.is.null")
    .not("sent_at", "is", null)
    .limit(5000);
  if (perfError) throw perfError; // a missing block must read as missing, never as "0 sent"
  const perf = { sent: 0, replied: 0, bounced: 0, agreed: 0 };
  const senderStats = new Map<string, { sent: number; replied: number }>();
  for (const m of (perfRows ?? []) as any[]) {
    perf.sent++;
    if (m.replied_at) perf.replied++;
    if (m.bounced_at) perf.bounced++;
    if (m.negotiation_status === "agreed") perf.agreed++;
    const sender = m.sent_by_email ?? m.sender_email ?? "server identity";
    const s = senderStats.get(sender) ?? { sent: 0, replied: 0 };
    s.sent++; if (m.replied_at) s.replied++;
    senderStats.set(sender, s);
  }
  const performance = {
    ...perf,
    won: rows.filter((r) => r.linkLiveAt).length,
    replyRate: perf.sent ? perf.replied / perf.sent : null,
    bySender: [...senderStats.entries()]
      .map(([sender, s]) => ({ sender, ...s }))
      .sort((a, b) => b.sent - a.sent),
  };

  return {
    campaign: bl, prospects: rows, stageCounts, channelCounts, total: rows.length, attention,
    dupCount: rows.filter((r) => r.dup).length,
    performance,
  };
}
