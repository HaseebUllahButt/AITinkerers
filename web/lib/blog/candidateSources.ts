// Where blog topics come from, beyond the news board.
//
// ── Why these exist ────────────────────────────────────────────────────────────────────────────
//
// The autopilot had three sources: the research sweep, the Notion backlog, and coverage gaps against
// feature pages. Measured across the first fourteen runs that produced: eleven use-case how-tos, one
// "what is X" explainer, and no comparisons or model guides at all.
//
// That was not the judge being narrow. It was the SOURCES being narrow — a coverage gap describes a
// feature, so the obvious article about it is how to use that feature. The SEO team's blog-types guide
// asks for model guides and comparisons above all else, and neither of those was derivable from
// anything the pipeline could see.
//
// So the four sources here are chosen to make the guide's priority types actually reachable. Each one
// is an inventory question we can answer for free against data already in the system:
//
//   model       104 model pages we actually run. How many have a supporting guide?
//   comparison  17 /compare pages against 104 models. Which obvious pairings are missing?
//   geo         456 answer-engine checks. Which prompts got answered without mentioning us?
//   demand      Search Console. Which real queries earn impressions we are not serving properly?
//
// ── The rule every source here obeys ───────────────────────────────────────────────────────────
//
// A candidate is only offered if a real ImagineArt generation could go in the finished article — the
// guide's own one test. That is why `model` reads OUR model pages rather than the research board's 331
// known models: we can run a generation on a model we host, and we cannot on one we do not.
import { supabaseAdmin } from "@/lib/db/supabase";
import { isGscConfigured, searchAnalytics, daysAgo } from "@/lib/indexing/gsc";

/**
 * One thing the pipeline could write about.
 *
 * Defined here rather than in autopilot.ts so the sources do not have to import from the module that
 * imports them.
 */
export interface Candidate {
  kind: "research" | "notion" | "gap" | "model" | "comparison" | "geo" | "demand";
  id: string;
  subject: string;
  summary: string | null;
  source: string | null;
  sourceUrl: string | null;
  date: string | null;
  modality: string | null;
  confidence: string | null;
  /** Notion only: the plan already recorded against this row. */
  note?: string | null;
  /** What must be confirmed before citing. Held apart from `summary` — see splitVerification. */
  verification?: string | null;
  /** The page type this source implies, when it implies one. A hint to the judge, not a decision. */
  suggestsType?: string | null;
  /**
   * A model we do not run.
   *
   * Not a disqualifier — covering these is a deliberate editorial choice for user value and domain
   * authority. It travels so the WRITING knows: a piece about something we do not host owes the
   * reader the boundary said plainly, and must never imply the model runs in ImagineArt.
   */
  notHosted?: boolean;
  /** A page this article must link up to, when the source knows it. */
  hubPath?: string | null;
}

export interface SourceResult {
  candidates: Candidate[];
  note: string | null;
}

const EMPTY: SourceResult = { candidates: [], note: null };

/** Vendors whose model families we carry. Used to group versions and to name a model's maker. */
const VENDORS: Array<{ key: string; name: string }> = [
  { key: "nano-banana", name: "Google" },
  { key: "imagen", name: "Google" },
  { key: "veo", name: "Google" },
  { key: "gpt-image", name: "OpenAI" },
  { key: "sora", name: "OpenAI" },
  { key: "seedream", name: "ByteDance" },
  { key: "seedance", name: "ByteDance" },
  { key: "dreamina", name: "ByteDance" },
  { key: "kling", name: "Kuaishou" },
  { key: "hailuo", name: "MiniMax" },
  { key: "minimax", name: "MiniMax" },
  { key: "wan", name: "Alibaba" },
  { key: "flux", name: "Black Forest Labs" },
  { key: "runway", name: "Runway" },
  { key: "pixverse", name: "PixVerse" },
  { key: "luma", name: "Luma" },
  { key: "ideogram", name: "Ideogram" },
  { key: "recraft", name: "Recraft" },
  { key: "grok", name: "xAI" },
  { key: "imagineart", name: "ImagineArt" },
];

/** True when a feature slug names a specific model rather than a capability. */
function modelSlug(slug: string): boolean {
  if (VENDORS.some((v) => slug.includes(v.key))) return true;
  // A version token is the other reliable tell: `pixverse-v6`, `hailuo-02`, `recraft-v-4`.
  return /(^|-)v?\d+([-.]\d+)*($|-)/.test(slug);
}

function vendorOf(slug: string): string | null {
  return VENDORS.find((v) => slug.includes(v.key))?.name ?? null;
}

/** `seedream-5-0-pro` → `seedream`. The family, so versions of one model group together. */
function familyOf(slug: string): string {
  const v = VENDORS.find((x) => slug.includes(x.key));
  if (v) return v.key;
  return slug.split("-").filter((t) => !/^v?\d+([-.]\d+)*$/.test(t)).slice(0, 2).join("-");
}

/**
 * `nano-banana-2-lite` → `Nano Banana 2 Lite`, `imagineart-1-5-pro` → `ImagineArt 1.5 Pro`.
 *
 * Two things a naive title-caser gets wrong, and both showed up in the first run of this source:
 *
 *   Version numbers are split across slug segments. `wan-2-6-flash` came out as "Wan 2 6 Flash" and
 *   `imagineart-1-5-pro` as "Imagineart 1 5 Pro". Consecutive all-digit segments are one version number
 *   and rejoin with a dot.
 *
 *   Brand casing is not title case. "Ai" is not a word, and "Imagineart" is not how the company writes
 *   its own name — a model guide whose title misspells the product is not publishable.
 */
const CASING: Record<string, string> = {
  ai: "AI", imagineart: "ImagineArt", pixverse: "PixVerse", gpt: "GPT", openai: "OpenAI",
  xai: "xAI", minimax: "MiniMax", bytedance: "ByteDance", o3: "o3", o1: "o1", hd: "HD",
  "3d": "3D", api: "API", mcp: "MCP", tts: "TTS", sdxl: "SDXL", ui: "UI",
};

function titleise(slug: string): string {
  const parts = slug.split("-").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i];
    if (/^\d+$/.test(w)) {
      // Absorb the run of digit-only segments that follows: 5,0 → "5.0".
      const run = [w];
      while (i + 1 < parts.length && /^\d+$/.test(parts[i + 1])) { run.push(parts[++i]); }
      out.push(run.join("."));
      continue;
    }
    out.push(CASING[w.toLowerCase()] ?? (w.charAt(0).toUpperCase() + w.slice(1)));
  }
  return out.join(" ");
}

/**
 * A sortable version number from a slug: `seedream-5-0-pro` → 5.0, `hailuo-02` → 2, none → 0.
 *
 * Needed because comparison pairing has to know which version is NEWER. Alphabetical adjacency produced
 * "Google Veo vs Google Veo 2" — a two-generation-old model against its successor, which nobody is
 * choosing between — while the pairing a reader actually wants is the newest against the one just below
 * it.
 */
function versionOf(slug: string): number {
  const m = slug.match(/(\d+)(?:[-.](\d+))?/);
  if (!m) return 0;
  return Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0);
}

/**
 * Slugs that are a model name PLUS a capability phrase, e.g. `veo-3-1-ai-video-generator`.
 *
 * Excluded from comparison pairing: the page is a capability landing page that happens to name a model,
 * so "Veo 3 vs Veo 3.1 AI Video Generator" reads as a comparison against a page rather than a model.
 */
const CAPABILITY_TAIL = /-(ai-)?(video|image|photo|text|audio|music)-?(generator|maker|creator|editor|to-\w+)?$|-text-to-\w+$/;

interface Inventory {
  modelPages: Array<{ slug: string; path: string }>;
  comparePaths: string[];
  blogHaystack: string;
}

/**
 * The pages we own, grouped the three ways these sources need.
 *
 * One read, shared by the model and comparison sources — they ask about the same 1,501 rows and paying
 * twice for them on every slot would be the same mistake the report generator made.
 */
async function inventory(): Promise<Inventory | null> {
  const rows: Array<{ path: string; section: string | null }> = [];
  for (let page = 0; page < 4; page++) {
    const from = page * 1000;
    const { data, error } = await supabaseAdmin
      .from("site_urls").select("path, section").range(from, from + 999);
    if (error) return null;
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  if (!rows.length) return null;

  const modelPages: Array<{ slug: string; path: string }> = [];
  const comparePaths: string[] = [];
  const blogSlugs: string[] = [];
  for (const r of rows) {
    const path = String(r.path ?? "");
    const section = String(r.section ?? "");
    const slug = path.replace(/\/+$/, "").split("/").pop() ?? "";
    if (!slug) continue;
    if (section === "compare") { comparePaths.push(path); continue; }
    if (section === "blogs") { blogSlugs.push(slug); continue; }
    if ((section === "features" || section === "apps") && modelSlug(slug)) {
      modelPages.push({ slug, path });
    }
  }
  return { modelPages, comparePaths, blogHaystack: blogSlugs.join(" ").toLowerCase() };
}

/**
 * Models we run that have no article about them.
 *
 * The guide's type 3, and the reason this source is first: we host 104 model pages, every one of them
 * is something a reader can generate with today, and a guide about one can contain the real outputs and
 * real credit costs the guide demands. A model on the research board that we do NOT host cannot — which
 * is why this reads our own pages and not that board.
 */
export async function modelGuideCandidates(inv: Inventory | null, limit = 24): Promise<SourceResult> {
  if (!inv) return { candidates: [], note: "The site inventory could not be read, so model guides were not offered." };
  const out: Candidate[] = [];
  for (const m of inv.modelPages) {
    // Substring, deliberately loose: a false "already covered" costs one candidate out of a hundred,
    // where a false gap costs a duplicate post.
    if (inv.blogHaystack.includes(m.slug)) continue;
    const name = titleise(m.slug);
    const vendor = vendorOf(m.slug);
    out.push({
      kind: "model", id: m.slug, subject: `${name} guide`,
      summary: `We run ${name}${vendor ? ` (${vendor})` : ""} at ${m.path} and have no article about it. `
        + "A guide can carry real generations from it, a side-by-side against another model on the same "
        + "prompt, and its actual credit cost — none of which a competitor can copy.",
      source: `Model we host — ${m.path}`,
      sourceUrl: `https://www.imagine.art${m.path}`,
      date: null, modality: null, confidence: null,
      suggestsType: "model-guide", hubPath: m.path,
    });
  }
  return rotate(out, limit, "model guide");
}

/**
 * Obvious comparisons we have not written.
 *
 * Two shapes, both from the guide's own examples ("Nano Banana 2 vs Nano Banana Pro", "Seedance 2.5 vs
 * Seedance 2.0"):
 *
 *   version pairs   two versions of one family we host. The reader is choosing between them right now,
 *                   we can run one prompt on both, and neither side needs a competitor's cooperation.
 *   cross-vendor    two models of comparable purpose from different makers.
 *
 * 17 /compare pages against 104 models is the whole argument for this source.
 */
export async function comparisonCandidates(inv: Inventory | null, limit = 16): Promise<SourceResult> {
  if (!inv) return { candidates: [], note: null };
  const families = new Map<string, string[]>();
  for (const m of inv.modelPages) {
    if (CAPABILITY_TAIL.test(m.slug)) continue;
    const f = familyOf(m.slug);
    families.set(f, [...(families.get(f) ?? []), m.slug]);
  }
  const existing = inv.comparePaths.join(" ").toLowerCase();
  const out: Candidate[] = [];
  for (const [family, slugs] of families) {
    if (slugs.length < 2) continue;
    // Newest first, and only the top three. A family we host eight versions of does not generate seven
    // comparisons anybody wants — it generates one or two, between the versions a reader is actually
    // choosing between today. Unbounded adjacency produced 80 candidates, most of them between models
    // two generations stale.
    const ranked = [...slugs].sort((a, b) => versionOf(b) - versionOf(a)).slice(0, 3);
    for (let i = 0; i < ranked.length - 1; i++) {
      const a = ranked[i], b = ranked[i + 1];
      if (existing.includes(`${a}-vs-${b}`) || existing.includes(`${b}-vs-${a}`)) continue;
      if (inv.blogHaystack.includes(`${a}-vs-${b}`) || inv.blogHaystack.includes(`${b}-vs-${a}`)) continue;
      const A = titleise(a), B = titleise(b);
      if (A === B) continue;
      out.push({
        kind: "comparison", id: `${a}-vs-${b}`, subject: `${A} vs ${B}`,
        summary: `We host both ${A} and ${B} and have no page comparing them. The same prompt can be run `
          + `on each and the outputs shown side by side, which is the one thing a reader choosing between `
          + `two versions of ${titleise(family)} cannot get anywhere else.`,
        source: "Both models hosted — no /compare page exists",
        sourceUrl: `https://www.imagine.art/features/${a}`,
        date: null, modality: null, confidence: null,
        suggestsType: "comparison", hubPath: `/features/${a}`,
      });
    }
  }
  return rotate(out, limit, "model comparison");
}
/**
 * Prompts an answer engine answered without mentioning us, and who it cited instead.
 *
 * The strongest demand signal in the system and it was going unused. Each row is a question somebody
 * asked an AI, an answer that got given, and a list of the domains that got the citation. That is
 * proven intent plus a named competitor set — exactly the two inputs a comparison or a use-case guide
 * needs, and the competitor list means the article can be honest about who else is good.
 *
 * Grouped by prompt and ranked by how often we were absent, because one miss is noise and thirty is a
 * standing gap.
 */
export async function geoCandidates(limit = 12): Promise<SourceResult> {
  const { data, error } = await supabaseAdmin
    .from("geo_checks")
    .select("prompt, engine, answered, brand_mentioned, cited_domains, run_at")
    .order("run_at", { ascending: false })
    .limit(600);
  if (error) return { candidates: [], note: `Answer-engine checks could not be read: ${error.message}` };

  const byPrompt = new Map<string, { misses: number; total: number; cited: Set<string>; engines: Set<string> }>();
  for (const r of data ?? []) {
    if (!r.answered) continue; // an unanswered prompt says nothing about us
    const key = String(r.prompt ?? "").trim();
    if (!key) continue;
    const e = byPrompt.get(key) ?? { misses: 0, total: 0, cited: new Set<string>(), engines: new Set<string>() };
    e.total++;
    if (!r.brand_mentioned) {
      e.misses++;
      for (const d of (r.cited_domains ?? []) as string[]) if (d && !d.includes("imagine")) e.cited.add(d);
    }
    e.engines.add(String(r.engine ?? ""));
    byPrompt.set(key, e);
  }

  const out: Candidate[] = [...byPrompt.entries()]
    // Three misses, so a single bad sample cannot create a candidate.
    .filter(([, v]) => v.misses >= 3)
    .sort((a, b) => b[1].misses - a[1].misses)
    .map(([prompt, v]) => ({
      kind: "geo" as const, id: prompt.slice(0, 120), subject: prompt,
      summary: `Answer engines answered this ${v.total} time(s) and left ImagineArt out of ${v.misses} of them`
        + `${v.cited.size ? `, citing ${[...v.cited].slice(0, 6).join(", ")} instead` : ""}. Real demand, `
        + "already being answered by somebody else.",
      source: `Answer-engine gap — ${[...v.engines].filter(Boolean).join(", ") || "GEO checks"}`,
      sourceUrl: null, date: null, modality: null, confidence: null,
      // A prompt phrased as a question wants a workflow answer; one phrased as "best X" wants a
      // head-to-head. Only a hint — the judge decides.
      suggestsType: /^(what|how|can|why|which)\b/i.test(prompt) ? "use-case" : "comparison",
      hubPath: null,
    }));
  return { candidates: out.slice(0, limit), note: out.length ? `${out.length} answer-engine gap(s) where we were absent at least 3 times.` : null };
}

/**
 * Real queries earning impressions that no page of ours serves well.
 *
 * Search Console is the only source here that reports what people actually typed at us rather than what
 * we guessed they might. Queries are taken over 28 days with a position worse than 8 — high enough to
 * prove demand, low enough that the query is not already won.
 *
 * Fails quiet. GSC is a network call with a service account behind it, and an unavailable one must cost
 * the run nothing more than this source.
 */
export async function demandCandidates(hostedSlugs: string[] = [], limit = 14): Promise<SourceResult> {
  if (!isGscConfigured()) return { candidates: [], note: "Search Console is not configured, so real query demand was not consulted." };
  const rows = await searchAnalytics({
    startDate: daysAgo(28), endDate: daysAgo(1),
    dimensions: ["query"], rowLimit: 500,
  }).catch(() => null);
  if (!rows) return { candidates: [], note: "Search Console could not be read, so real query demand was not consulted." };

  const out: Candidate[] = rows
    .map((r) => ({ q: String(r.keys?.[0] ?? "").trim(), imp: r.impressions ?? 0, pos: r.position ?? 99, clicks: r.clicks ?? 0 }))
    .filter((r) => r.q && r.imp >= 50 && r.pos > 8)
    // Brand queries are not content gaps: we already own them and a post would cannibalise the pages
    // that rank.
    .filter((r) => !/imagine\s?art|imagineart/i.test(r.q))
    .sort((a, b) => b.imp - a.imp)
    .slice(0, limit)
    .map((r) => {
      // ── The join that makes this source usable ──────────────────────────────────────────────────
      //
      // Raw GSC queries are mostly other companies' brand names — "google flow", "pika", "flow ai" —
      // and offered bare they read as off-topic. But some of them name a model WE HOST, and that changes
      // the article completely: "pika" is 66k impressions for something at /features/pika-2-2, which is
      // a model guide we can fill with real generations. So the query is matched against our hosted
      // model slugs, and only the ones with no match are left as a competitor term.
      const probe = r.q.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const hosted = hostedSlugs.find((slug) => slug.startsWith(probe) || probe.startsWith(slug.split("-").slice(0, 2).join("-")));
      return {
        kind: "demand" as const, id: r.q, subject: r.q,
        summary: `${r.imp} impressions over 28 days at average position ${r.pos.toFixed(1)} with ${r.clicks} click(s). `
          + "Real measured demand that nothing of ours ranks properly for."
          + (hosted
              ? ` We host this at /features/${hosted}, so a guide can carry real generations from it.`
              : " This looks like another product's term — the honest article is a comparison against what "
                + "we do host, never a page pretending to be theirs."),
        source: "Search Console — 28 days",
        sourceUrl: null, date: null, modality: null, confidence: null,
        suggestsType: hosted ? "model-guide" : "comparison",
        hubPath: hosted ? `/features/${hosted}` : null,
      };
    });
  return { candidates: out, note: out.length ? `${out.length} query(ies) with real impressions and no page ranking well.` : null };
}

/**
 * Show a slice, and move the slice.
 *
 * Same reasoning as the coverage-gap source: there are far more candidates than the judge can be shown,
 * and a fixed slice means the same ones are offered every run forever while the tail is never written.
 * The offset moves with the day and the six-hour block, so the corpus is walked without tracking a
 * cursor anywhere.
 */
function rotate(all: Candidate[], limit: number, label: string): SourceResult {
  const total = all.length;
  if (!total) return EMPTY;
  if (total <= limit) return { candidates: all, note: `${total} ${label} candidate(s).` };
  const day = Math.floor(Date.now() / 86_400_000);
  const offset = ((day * 3 + Math.floor(new Date().getUTCHours() / 6)) * limit) % total;
  return {
    candidates: [...all.slice(offset), ...all.slice(0, offset)].slice(0, limit),
    note: `${total} ${label} candidate(s) exist; showing ${limit} on a rotating window.`,
  };
}

/**
 * The two inventory-derived sources, sharing one read — plus every hosted model slug.
 *
 * `hostedSlugs` is the FULL list and not the rotated slice, and that distinction was a bug: the caller
 * uses it to decide whether a research-board launch is something we run, and matching against the 24
 * models that happened to be in today's window instead of all 104 reported zero hosted launches. A
 * rotating window is right for what the judge is SHOWN and wrong for what a lookup is checked against.
 */
export async function inventoryCandidates(): Promise<{
  model: SourceResult; comparison: SourceResult; hostedSlugs: string[];
}> {
  const inv = await inventory().catch(() => null);
  const [model, comparison] = await Promise.all([modelGuideCandidates(inv), comparisonCandidates(inv)]);
  return { model, comparison, hostedSlugs: (inv?.modelPages ?? []).map((m) => m.slug) };
}
