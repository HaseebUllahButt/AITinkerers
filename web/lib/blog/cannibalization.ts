// Would this article compete with a page we already own?
//
// Implements the checkable parts of the house keyword-cannibalization standard as a PRE-DRAFT gate.
// Pre-draft is the point of it: every fix the standard offers after publication — consolidate,
// de-optimize, re-slug, 301 — costs weeks and equity, and all of them are avoided by not writing the
// competing page in the first place.
//
// ── What this was built to stop, measured ───────────────────────────────────────────────────────
//
// Of the first eleven posts the autopilot wrote, EIGHT declared a live feature page's exact head term
// as their primary keyword:
//
//     /blogs/ai-tattoo-generator-designs-artists-can   kw "ai tattoo generator"
//        vs /features/ai-tattoo-generator                                    ← the page that owns it
//     /blogs/ai-video-enhancer-what-it-fixes           kw "ai video enhancer"
//        vs /features/ai-video-enhancer
//     /blogs/how-to-unblur-an-image-with-ai            kw "how to unblur an image with ai"
//        vs /features/unblur-image
//     …and five more.
//
// This is cross-intent cannibalization: a transactional query, an informational page ranking for it,
// traffic that arrives and does not convert. The standard calls it the single biggest silent revenue
// leak on product-led sites, and our pipeline was producing it systematically rather than by accident
// — the coverage-gap candidate source is defined as "a feature page with no supporting article", so
// every candidate it offers arrives already pointing at a page that owns the term.
//
// Worth naming the second-order effect, because it explains why nothing caught this: the writer's
// `keyword_in_h1` gate REQUIRES the primary keyword in the H1 and repairs the draft until it is there.
// Given the feature page's head term as the keyword, that gate was enforcing the collision. Fixing the
// keyword before writing is what turns every downstream gate from an accomplice into a check.
//
// ── What this deliberately does NOT do ──────────────────────────────────────────────────────────
//
// The standard is emphatic that cannibalization is a DIAGNOSIS needing symptoms — flip-flopping URLs,
// split clicks, the wrong URL ranking — and that two URLs on one SERP can simply be double-serving,
// which is a win. Confirming a symptom needs 90 days of ranking-URL history, which is a Search Console
// integration this tool does not have.
//
// So this gate does not diagnose existing cannibalization. It answers the narrower question it CAN
// answer honestly: is the page we are about to create structurally born to compete with one we already
// have. That question needs no history, and it is the only one that can still be answered for free.
import { supabaseAdmin } from "@/lib/db/supabase";
import { serpAnalysis, serperEnabled } from "@/lib/writer/seoData";
import { pageType, type BlogPageType, type IntentTier } from "./pageTypes";

/** Which layer of the standard's stack a problem sits at, so the fix is unambiguous. */
export type Layer =
  | "L1-intent"
  | "L2-topic"
  | "L3-keyword"
  | "L4-on-page"
  | "L5-slug"
  | "L6-links";

export interface CannibalProblem {
  layer: Layer;
  /** Stable identifier, so a run's audit row can be grouped without parsing prose. */
  code: string;
  /**
   * `block`   — do not write this. There is no version of this article that does not compete.
   * `rewrite` — write it, but not at this keyword/angle. The subject is fine; the target is not.
   * `warn`    — worth knowing, not worth stopping for.
   */
  severity: "block" | "rewrite" | "warn";
  detail: string;
  /** The page this problem is about, when there is one. */
  against?: string;
}

export interface Owner {
  path: string;
  section: string;
  tier: IntentTier;
  /** The term this page reads as owning, in natural word order. */
  headTerm: string;
  /** Where it came from: the live sitemap, an unpublished draft, or a landing page in flight. */
  origin: "live" | "draft" | "landing";
}

export interface RequiredLink {
  path: string;
  anchor: string;
  why: string;
}

export interface CannibalVerdict {
  verdict: "proceed" | "rewrite" | "block";
  problems: CannibalProblem[];
  /** The keyword as proposed. */
  proposedKeyword: string;
  /** The page whose term this would have taken, when there is one. The link target. */
  owner: Owner | null;
  /** Everything else close enough to matter. */
  neighbours: Owner[];
  /** Hub-and-spoke links this article is required to carry. */
  requiredLinks: RequiredLink[];
  /** Overlap tests actually run. Empty is not "no overlap" — it is "not measured". */
  overlap: Array<{ against: string; keywordA: string; keywordB: string; sharedUrls: number; pct: number; reading: string }>;
  /** Rendered rules for the writer's brief. */
  directives: string[];
  /** What could not be checked, so a clean verdict is never mistaken for a complete one. */
  notes: string[];
  checkedAt: string;
}

// ── Tokenising ────────────────────────────────────────────────────────────────────────────────────
//
// The standard's own slug-audit routine: strip stop words, split on separators, sort the tokens. Token
// sorting is what catches reorders, modifier stacking and stop-word variants in one pass — the three
// collision shapes a human reviewer reads straight past because each slug looks fine alone.

/**
 * Words that carry no discriminating information in OUR url space.
 *
 * The standard's list plus `ai`, which is ours and is measured rather than assumed: `ai` appears in the
 * leaf of most feature slugs, so keeping it makes every pair look more similar than it is, and
 * `/features/unblur-image` would not match a post about unblurring an image with AI. Removing it is what
 * makes that real collision visible.
 */
const STOP = new Set([
  // The standard's own list.
  "the", "a", "an", "of", "for", "to", "in", "and", "your", "best", "top", "free", "online",
  // Two additions, both measured rather than assumed.
  //
  //   "ai"   appears in the leaf of most feature slugs, so keeping it makes every pair look more alike
  //          than it is — and `/features/unblur-image` would not match a post about unblurring an image
  //          with AI, which is a real collision we shipped.
  //   "with" is a pure connective and never distinguishes two of our pages.
  //
  // Nothing else. An earlier version also stripped how/what/tool/guide/use, and the cost was immediate:
  // "best ai video tools 2026" reduced to the single token "video" and matched /features/video-to-video,
  // which owns nothing of the sort. Over-stripping does not make the check stricter, it makes the keys
  // generic — and a generic key claims collisions that are not there.
  "ai", "with",
]);

/** `/features/ai-tattoo-generator` → `generator tattoo`. Order-independent identity of a page. */
export function tokenKey(input: string): string {
  // Deduplicated, because a repeated token silently broke the subset test: `/features/video-to-video`
  // reduced to "video video", and "agentic video" contains a "video" for each of them, so the owner
  // read as a subset of a page it has nothing to do with.
  return [...new Set(tokensOf(input))].sort().join(" ");
}

function tokensOf(input: string): string[] {
  return String(input ?? "")
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/, "")
    .split("?")[0]
    .replace(/\.(html?|php)$/, "")
    .split(/[/\s\-_.]+/)
    .filter((t) => t && !STOP.has(t) && !/^20\d\d$/.test(t));
}

/** The leaf as a readable term: `/features/ai-tattoo-generator` → `ai tattoo generator`. */
function headTermOf(path: string): string {
  const leaf = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return leaf.split("-").filter(Boolean).join(" ");
}

/** Jaccard, for "close but not the same". */
function similarity(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

function isSubset(sub: string, sup: string): boolean {
  const S = new Set(sup.split(" ").filter(Boolean));
  const parts = sub.split(" ").filter(Boolean);
  return parts.length > 0 && parts.every((t) => S.has(t));
}

// ── The URL inventory ─────────────────────────────────────────────────────────────────────────────

/**
 * Sections whose pages are transactional — the pages that must win a tool query.
 *
 * Measured against the live sitemap: 40 `/features/*`, 77 `/apps/*`, and 138 rows flagged `is_money`
 * (136 of them under /features). The root-level tool pages — `/ai-image-generator`, `/bg-remover`,
 * `/image-studio` — are each their own single-page section, so a section allow-list alone would miss
 * them; the tool-noun test below catches those.
 */
const TRANSACTIONAL_SECTIONS = new Set(["features", "apps"]);
const COMMERCIAL_SECTIONS = new Set(["compare"]);
const TOOL_NOUN = /(generator|maker|creator|editor|remover|enhancer|converter|studio|shorts|workflow|design)$/;

function tierOf(path: string, section: string, isMoney: boolean): IntentTier {
  if (section === "blogs" || section === "announcements") return "informational";
  if (COMMERCIAL_SECTIONS.has(section)) return "commercial";
  if (isMoney || TRANSACTIONAL_SECTIONS.has(section)) return "transactional";
  const segments = path.replace(/^\/|\/$/g, "").split("/");
  if (segments.length === 1 && TOOL_NOUN.test(segments[0])) return "transactional";
  return "navigational";
}

interface Inventory {
  owners: Owner[];
  /** Set when the inventory is incomplete, so a clean verdict can say so. */
  problems: string[];
}

/**
 * Every page we own or are about to own.
 *
 * Three sources, because a check against live URLs alone would let two runs on the same day pick
 * overlapping terms — neither is published, so neither is in the sitemap, and both look clear.
 *
 *   site_urls      1,501 live pages. Paged: the client's default limit is 1,000 and silently truncates,
 *                  which would have hidden a third of the sitemap from every check.
 *   blog_drafts    written but not published. The 45 sitting in review are exactly the pages a new
 *                  draft is most likely to collide with.
 *   landing_pages  transactional pages in flight, with a DECLARED primary keyword — the only place in
 *                  this system where a keyword is stated rather than inferred from a slug.
 */
async function inventory(): Promise<Inventory> {
  const problems: string[] = [];
  const owners: Owner[] = [];

  const live: Array<{ path: string; section: string | null; is_money: boolean | null }> = [];
  for (let page = 0; page < 4; page++) {
    const from = page * 1000;
    const { data, error } = await supabaseAdmin
      .from("site_urls")
      .select("path, section, is_money")
      .range(from, from + 999);
    if (error) { problems.push(`The live sitemap could not be read: ${error.message}`); break; }
    live.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  for (const r of live) {
    const path = String(r.path ?? "");
    if (!path || path === "/") continue;
    const section = String(r.section ?? "");
    owners.push({
      path, section,
      tier: tierOf(path, section, !!r.is_money),
      headTerm: headTermOf(path),
      origin: "live",
    });
  }

  const { data: drafts, error: de } = await supabaseAdmin
    .from("blog_drafts")
    .select("slug, title, seo_keywords, created_at")
    .order("created_at", { ascending: false })
    .limit(300);
  if (de) problems.push(`Unpublished drafts could not be read: ${de.message}`);
  for (const d of drafts ?? []) {
    const slug = String(d.slug ?? "").trim();
    if (!slug) continue;
    // The declared primary keyword beats the slug when there is one: `seo_keywords` is comma-separated
    // and its FIRST entry is the primary. That is the field the collision actually lives in.
    const declared = String(d.seo_keywords ?? "").split(",")[0]?.trim();
    owners.push({
      path: `/blogs/${slug}`,
      section: "blogs",
      tier: "informational",
      headTerm: declared || headTermOf(slug),
      origin: "draft",
    });
  }

  const { data: lps, error: le } = await supabaseAdmin
    .from("landing_pages")
    .select("primary_keyword, target_path, strapi_slug")
    .limit(400);
  if (le) problems.push(`Landing pages could not be read: ${le.message}`);
  for (const l of lps ?? []) {
    const kw = String(l.primary_keyword ?? "").trim();
    const path = String(l.target_path ?? "").trim() || (l.strapi_slug ? `/${l.strapi_slug}` : "");
    if (!kw && !path) continue;
    owners.push({
      path: path || `(landing page: ${kw})`,
      section: "features",
      tier: "transactional",
      headTerm: kw || headTermOf(path),
      origin: "landing",
    });
  }

  return { owners, problems };
}

// ── The SERP overlap test ─────────────────────────────────────────────────────────────────────────

/**
 * The standard's most reliable diagnostic, and the only one here that costs money.
 *
 * Two live SERP pulls, count the shared URLs in the top ten. ≥70% means Google treats the two strings
 * as one query, and two pages is one too many.
 *
 * Only called when the two terms are CLOSE BUT DIFFERENT. When the token keys are identical the answer
 * is 100% by construction and paying for it would tell us nothing; when they are far apart the tokens
 * have already answered. That narrow band is where the tokens genuinely cannot decide — and keeping the
 * call to that band is what makes running this six times a day affordable.
 */
async function overlapTest(a: string, b: string): Promise<{ sharedUrls: number; pct: number; reading: string } | null> {
  if (!serperEnabled()) return null;
  const [sa, sb] = await Promise.all([serpAnalysis(a), serpAnalysis(b)]);
  if (!sa || !sb) return null;
  const top = (s: typeof sa) => new Set(s.organic.slice(0, 10).map((o) => o.link.replace(/\/+$/, "")));
  const A = top(sa), B = top(sb);
  if (!A.size || !B.size) return null;
  let shared = 0;
  for (const u of A) if (B.has(u)) shared++;
  const pct = Math.round((shared / 10) * 100);
  // The standard's bands, verbatim.
  const reading =
    pct >= 70 ? "Google treats these as one query. Two pages is one too many."
    : pct >= 40 ? "Same topic, different emphasis. One page with a section for the second angle."
    : pct >= 20 ? "Related but distinct. Two pages are fine if they are tightly differentiated and interlinked."
    : "Different topics. No conflict.";
  return { sharedUrls: shared, pct, reading };
}

// ── The check ─────────────────────────────────────────────────────────────────────────────────────

export interface CannibalInput {
  /** The primary keyword this article intends to target. The thing actually being checked. */
  primaryKeyword: string;
  /** Which kind of article, from pageTypes. Decides the intent tier the matrix reads. */
  pageTypeKey: string;
  /** Optional, checked when present. */
  proposedTitle?: string | null;
  proposedSlug?: string | null;
  /** Set false to skip the paid SERP call — used where a cheap structural answer is enough. */
  useSerp?: boolean;
  /**
   * A link this article must carry regardless of what the check finds.
   *
   * Exists because the hub link would otherwise disappear at exactly the wrong moment. A coverage-gap
   * candidate is BY DEFINITION about a feature page, so the supporting article must link up to it — but
   * once the keyword has been retargeted away from that page's head term, the check correctly finds no
   * owner, and a requirement derived only from the owner would evaporate on the re-check. The article
   * would then be safely non-competing and also no longer supporting anything, which is half a fix.
   *
   * So the caller states it. The gap source knows its own feature page; the check does not have to
   * rediscover it.
   */
  mustLinkTo?: RequiredLink | null;
}

/**
 * Run the gate.
 *
 * Never throws. A gate that can fail closed on a Supabase blip would stop the pipeline writing
 * anything; a gate that fails OPEN silently would let the thing it exists to prevent straight through.
 * So a read failure produces a `warn` and a note naming what went unchecked, and the caller decides —
 * which is the same shape the landing rail's blocker check settled on for the same reason.
 */
export async function checkCannibalization(input: CannibalInput): Promise<CannibalVerdict> {
  const kw = String(input.primaryKeyword ?? "").trim();
  const type: BlogPageType | null = pageType(input.pageTypeKey);
  const out: CannibalVerdict = {
    verdict: "proceed",
    problems: [],
    proposedKeyword: kw,
    owner: null,
    neighbours: [],
    requiredLinks: [],
    overlap: [],
    directives: [],
    notes: [],
    checkedAt: new Date().toISOString(),
  };

  if (input.mustLinkTo?.path) out.requiredLinks.push(input.mustLinkTo);

  if (!kw) {
    out.verdict = "rewrite";
    out.problems.push({
      layer: "L3-keyword", code: "no_keyword", severity: "rewrite",
      detail: "No primary keyword was proposed, so nothing can be checked for a collision. A page with "
        + "no declared target is how two pages end up with the same one.",
    });
    return out;
  }
  if (!type) {
    out.notes.push(`"${input.pageTypeKey}" is not a known page type, so the intent tier could not be read `
      + "and the intent matrix was skipped. The keyword and slug checks below still ran.");
  }

  const { owners, problems: invProblems } = await inventory().catch((e: unknown) => ({
    owners: [] as Owner[],
    problems: [`The URL inventory could not be built: ${e instanceof Error ? e.message : "unknown"}`],
  }));
  out.notes.push(...invProblems);
  if (!owners.length) {
    out.problems.push({
      layer: "L2-topic", code: "inventory_unavailable", severity: "warn",
      detail: "Nothing could be read back about the pages we already own, so this article was NOT checked "
        + "for a collision. Treat a clean result here as unmeasured, not as clear.",
    });
    return out;
  }

  const kwKey = tokenKey(kw);
  const proposedTier: IntentTier = type?.tier ?? "informational";

  // ── L1/L3: who already owns this term ─────────────────────────────────────────────────────────
  const scored = owners
    .map((o) => {
      const oKey = tokenKey(o.headTerm || o.path);
      return { o, oKey, sim: similarity(kwKey, oKey), exact: oKey === kwKey, covers: isSubset(oKey, kwKey) };
    })
    .filter((s) => s.oKey && (s.exact || s.covers || s.sim >= 0.5))
    // Transactional first: when a term is claimed by both a feature page and an old post, the feature
    // page is the one whose ownership matters, and reporting the post instead would send the fix to the
    // wrong page.
    .sort((a, b) => {
      const rank = (t: IntentTier) => (t === "transactional" ? 0 : t === "commercial" ? 1 : 2);
      return rank(a.o.tier) - rank(b.o.tier) || b.sim - a.sim;
    });

  out.neighbours = scored.slice(0, 8).map((s) => s.o);

  // ── Why ownership needs TWO tokens ────────────────────────────────────────────────────────────
  //
  // A one-token key is not an identity, it is a word. `/features/video-to-video` reduces to "video",
  // and by the subset test alone that page would claim ownership of every keyword containing the word
  // video — measured, it claimed both "agentic video" and "best ai video tools 2026". Requiring two
  // meaningful tokens is what separates a page that owns a term from a page that shares a noun with it.
  //
  // The similarity floor does the same job from the other end: the owner's term has to be most of what
  // the proposal is about, not an incidental phrase inside a longer one.
  const enough = (s: { oKey: string }) => s.oKey.split(" ").filter(Boolean).length >= 2;
  // ── Why a comparison keyword is exempt from the ownership test ────────────────────────────────
  //
  // The standard is explicit that a feature page and a comparison page do NOT conflict — one is
  // transactional, the other commercial — provided the comparison does not lead with the bare head term.
  // "seedance 2.5 vs seedance 2.0 mini" is a different query from "seedance 2.5", and Google returns a
  // different SERP for it.
  //
  // Without this exemption the token test fires on every comparison we could ever write: the owner's
  // tokens are a subset of any keyword that names it as one side. Measured — the judge picked a
  // Seedance-2.5-vs-2.0-Mini comparison, which is precisely the shape the SEO guide asks for most, and
  // the gate sent it off to be retargeted. That is a model call spent to make a good article worse.
  //
  // The title rule below still applies, which is the proviso the standard attaches.
  const comparative = /\b(vs\.?|versus|alternatives?|compared to)\b/i.test(kw);
  const hardOwner = comparative
    ? undefined
    : scored.find(
        (s) => enough(s) && (s.exact || (s.covers && s.sim >= 0.5)) && s.o.tier === "transactional",
      );

  // Still worth linking to, and still worth saying out loud: the article names a page we own, so the
  // link up to it is what makes the pair complementary rather than merely non-competing.
  if (comparative) {
    const named = scored.find((s) => enough(s) && (s.exact || s.covers) && s.o.tier === "transactional");
    if (named) {
      out.owner = named.o;
      if (!out.requiredLinks.some((l) => l.path === named.o.path)) {
        out.requiredLinks.push({
          path: named.o.path, anchor: named.o.headTerm,
          why: `${named.o.path} is one side of this comparison and owns "${named.o.headTerm}". A comparison `
            + "and a feature page do not compete, but only if the comparison links to it rather than "
            + "standing in for it.",
        });
      }
    }
  }
  const sameTierTwin = scored.find(
    (s) => enough(s) && s.exact && s.o.tier === proposedTier && s.o.origin !== "landing",
  );

  // A proposal that reduces to one token cannot be judged structurally either — it is a category, not a
  // target. Said out loud rather than passed silently, because "no collision found" on a key like
  // "video" is not a finding.
  if (kwKey.split(" ").filter(Boolean).length < 2) {
    out.problems.push({
      layer: "L3-keyword", code: "keyword_too_generic", severity: "warn",
      detail: `"${kw}" reduces to a single meaningful token, so it is a category rather than a target and `
        + "no structural collision check on it means much. Pick a keyword with a qualifier the SERP "
        + "actually distinguishes.",
    });
  }

  // §3.1 — two pages built for the same intent. There is no angle that fixes this; the fix is to
  // improve the page that exists.
  if (sameTierTwin && proposedTier === "informational") {
    out.problems.push({
      layer: "L1-intent", code: "same_intent_duplicate", severity: "block",
      against: sameTierTwin.o.path,
      detail: `${sameTierTwin.o.path} already targets "${sameTierTwin.o.headTerm}", which is the same intent `
        + `at the same tier as this. Two pages built for one intent compete however differently they are `
        + `worded — the move is to improve that page, not to add a second one.`,
    });
  }

  // §3.2 — the one this gate exists for.
  if (hardOwner) {
    out.owner = hardOwner.o;
    const sev = proposedTier === "transactional" ? "block" : "rewrite";
    out.problems.push({
      layer: "L1-intent", code: "cross_intent_head_term", severity: sev,
      against: hardOwner.o.path,
      detail: `"${kw}" is the head term ${hardOwner.o.path} already owns — a ${hardOwner.o.tier} page. `
        + `Targeting it from a ${proposedTier} article is cross-intent cannibalization: the query is `
        + `transactional, the ranking page would be informational, and the traffic arrives without `
        + `converting. Keep the subject and move the target down-funnel.`,
    });
    // §6.2 rules 2 and 3 — the spoke links up on the hub's term, and that is what tells Google which
    // of the two pages the site itself considers canonical for it.
    if (!out.requiredLinks.some((l) => l.path === hardOwner.o.path)) {
      out.requiredLinks.push({
        path: hardOwner.o.path,
        anchor: hardOwner.o.headTerm,
        why: `${hardOwner.o.path} owns "${hardOwner.o.headTerm}". Linking up to it on that exact anchor is `
          + "what makes this article support that page instead of competing with it.",
      });
    }
  }

  // ── L3: the overlap test, in the band where tokens cannot decide ──────────────────────────────
  // Same §12.1 exemption as the ownership test above, and for the same reason: "veo 4 vs veo 3.1 lite"
  // measured 50% overlap against the bare "veo 3.1 lite", which the standard's bands would read as
  // "one page, with a section for the secondary angle". That reading is right for two pages of the same
  // kind and wrong for a comparison against the model page it names — those are different tiers and the
  // standard says they coexist. A comparison is still tested against other COMMERCIAL pages, which is
  // where a real second-comparison conflict would show up.
  const near = scored.find((s) =>
    !s.exact && s.sim >= 0.5 && s.o.tier !== "navigational"
    && !(comparative && s.o.tier === "transactional"));
  if (near && input.useSerp !== false) {
    const res = await overlapTest(kw, near.o.headTerm).catch(() => null);
    if (res) {
      out.overlap.push({ against: near.o.path, keywordA: kw, keywordB: near.o.headTerm, ...res });
      if (res.pct >= 70) {
        out.problems.push({
          layer: "L2-topic", code: "serp_overlap_high", severity: "block",
          against: near.o.path,
          detail: `${res.pct}% of the top ten is the same for "${kw}" and "${near.o.headTerm}" (${near.o.path}). `
            + `${res.reading}`,
        });
      } else if (res.pct >= 40) {
        out.problems.push({
          layer: "L2-topic", code: "serp_overlap_medium", severity: "rewrite",
          against: near.o.path,
          detail: `${res.pct}% SERP overlap with "${near.o.headTerm}" (${near.o.path}). ${res.reading} `
            + "Either pick a target that diverges further, or write this as a section on the page that exists.",
        });
      }
    } else {
      out.notes.push(
        `The SERP overlap against "${near.o.headTerm}" could not be measured`
        + `${serperEnabled() ? " (the SERP lookup failed)" : " (SERPER_API_KEY is unset)"}, so the `
        + "tokens are the only evidence for that pair.",
      );
    }
  }

  // ── L5: the slug ──────────────────────────────────────────────────────────────────────────────
  const slug = String(input.proposedSlug ?? "").trim().toLowerCase();
  if (slug) {
    const sKey = tokenKey(slug);
    const collide = owners.find((o) => tokenKey(o.path) === sKey && o.path !== `/blogs/${slug}`);
    if (collide) {
      out.problems.push({
        layer: "L5-slug", code: "slug_token_collision", severity: "rewrite",
        against: collide.path,
        detail: `/blogs/${slug} and ${collide.path} reduce to the same tokens once stop words and order are `
          + "removed. Same tokens, same intent — one of them is the other with the words moved around.",
      });
    }
    // §7.3 rule 3, and §15: a dated slug guarantees an annual choice between a redirect chain and a
    // self-cannibal. The date belongs in the title and in dateModified, where it can be updated.
    if (/(^|-)(20\d\d)(-|$)/.test(slug)) {
      out.problems.push({
        layer: "L5-slug", code: "dated_slug", severity: "rewrite",
        detail: `"${slug}" carries a year. Next year this page either gets re-slugged — a redirect to `
          + "maintain forever — or is left to compete with its own successor. Put the year in the title "
          + "and refresh the page in place.",
      });
    }
    if (slug !== slug.toLowerCase() || /[^a-z0-9-]/.test(slug)) {
      out.problems.push({
        layer: "L5-slug", code: "slug_charset", severity: "warn",
        detail: `"${slug}" is not lowercase-and-hyphens. Case and separator variants resolve as two URLs `
          + "for one page.",
      });
    }
  }

  // ── L4: the title ─────────────────────────────────────────────────────────────────────────────
  //
  // The head term may appear in the body of a supporting article — that is where the link to the owner
  // lives. What it may not do is OPEN the title, because the leading position is the strongest claim a
  // page can make about which query it is for.
  const title = String(input.proposedTitle ?? "").trim();
  if (title && out.owner) {
    const head = out.owner.headTerm.toLowerCase();
    const opening = title.toLowerCase().slice(0, head.length + 4);
    if (head && opening.startsWith(head)) {
      out.problems.push({
        layer: "L4-on-page", code: "title_leads_with_head_term", severity: "rewrite",
        against: out.owner.path,
        detail: `The title opens with "${out.owner.headTerm}", which is ${out.owner.path}'s term. Lead with `
          + "what this article uniquely does; the head term can appear later, in the sentence that links "
          + "to the page that owns it.",
      });
    }
  }

  // ── The verdict ───────────────────────────────────────────────────────────────────────────────
  if (out.problems.some((p) => p.severity === "block")) out.verdict = "block";
  else if (out.problems.some((p) => p.severity === "rewrite")) out.verdict = "rewrite";

  out.directives = renderDirectives(out, type);
  return out;
}

/**
 * The verdict as instructions, for the writer's brief.
 *
 * Rendered here rather than at the call site so every path that starts an article — autopilot, Atlas,
 * a person in Summer — briefs the writer identically. The wording is aimed at the model: what to do,
 * not what went wrong.
 */
function renderDirectives(v: CannibalVerdict, type: BlogPageType | null): string[] {
  const out: string[] = [];
  if (v.owner) {
    out.push(
      `${v.owner.path} already owns "${v.owner.headTerm}" and must stay the page that ranks for it. `
      + `This article supports that page. Do not use "${v.owner.headTerm}" as the primary keyword, and do `
      + `not open the title or the H1 with it.`,
    );
  }
  for (const l of v.requiredLinks) {
    out.push(`Link to ${l.path} using "${l.anchor}" as the anchor text, in the body, once. ${l.why}`);
  }
  if (type) {
    out.push(`This is a ${type.label.toLowerCase()}: ${type.brief}`);
    out.push(`The primary keyword must take the shape: ${type.keywordShape}`);
  }
  for (const p of v.problems) {
    if (p.severity === "warn") out.push(`Worth knowing: ${p.detail}`);
  }
  if (v.overlap.length) {
    for (const o of v.overlap) {
      out.push(`Measured: "${o.keywordA}" and "${o.keywordB}" share ${o.sharedUrls} of the top ten results (${o.pct}%). ${o.reading}`);
    }
  }
  return out;
}

/**
 * The terms a transactional page already owns, for briefing the judge BEFORE it proposes one.
 *
 * Prevention beats correction here for a plain reason: the gate can only reject a keyword the judge has
 * already chosen, and rejecting is a wasted decision plus a second model call. Handing over the list up
 * front means the collision usually never gets proposed. The gate stays as the backstop, because a list
 * in a prompt is a hint and a check is a check.
 *
 * Ordered longest-first: the specific terms are the ones a judge is most likely to reach for, and if the
 * list has to be truncated the generic ones are the ones worth losing.
 */
export async function ownedHeadTerms(limit = 220): Promise<string[]> {
  const { owners } = await inventory().catch(() => ({ owners: [] as Owner[], problems: [] }));
  const terms = new Set<string>();
  for (const o of owners) {
    if (o.tier !== "transactional") continue;
    const t = o.headTerm.trim();
    // Two tokens minimum, same reason as the ownership test: a one-word term is a noun, not a claim.
    if (t.split(/\s+/).filter(Boolean).length < 2) continue;
    terms.add(t);
  }
  return [...terms].sort((a, b) => b.length - a.length).slice(0, limit);
}

/** One line a person can read in Slack or an audit row. */
export function summarise(v: CannibalVerdict): string {
  if (v.verdict === "proceed") {
    return v.notes.length
      ? `No collision found, but ${v.notes.length} thing(s) could not be checked.`
      : "No collision with anything we already own.";
  }
  const worst = v.problems.filter((p) => p.severity === (v.verdict === "block" ? "block" : "rewrite"));
  return `${v.verdict === "block" ? "Blocked" : "Needs a different target"}: ${worst[0]?.detail ?? "unspecified"}`;
}
