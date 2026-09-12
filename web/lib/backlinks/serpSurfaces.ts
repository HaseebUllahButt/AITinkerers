// Everything on a Google result page that names a SOURCE — not just the ten blue links.
//
// Why this exists: backlink discovery ran on `webSearch`, which reads only the organic list
// (see the provider branches in ../search/webSearch.ts — the Serper one is literally `d.organic`).
// Google now answers a large share of buyer-intent queries above the organic results, in the AI
// Overview and in the expandable question blocks, and each of those answers CITES pages. Those
// citations are the strongest prospects on the page: Google already decided the page is
// authoritative enough to quote for this exact query, which is the same judgement we are trying to
// make when we score a prospect. Dropping them meant discovery ignored the best half of the SERP.
//
// One Serper request returns all of it, so reading the extra surfaces costs no extra credits —
// only the parsing below. That matters because Serper credits are one-time and non-renewing
// (2,500, no card), and `meteredKey` withholds the key entirely in free-only mode.
//
// Honest degradation, in the house style: a missing key is `null` (the caller says so in its
// notes), and a query where Google showed no AI Overview is reported as "Google showed none",
// never as "no opportunities". AI Overview presence is genuinely intermittent per query and per
// phrasing — the GEO agent tracks a rolling hit-rate for exactly this reason (./geo.ts) — so a
// single dry run is not evidence of absence.
import { meteredKey } from "@/lib/providers/policy";

/** Where a candidate URL was named. Ordered loosely by how strong a signal it is.
 *
 *  `ai_answer` is the one surface NOT read from a SERP: it comes from the answer engines in
 *  ./aiCitations.ts (Gemini's grounded search, Perplexity, ChatGPT). It lives in this union so
 *  every consumer — the score bonus, the badge, the funnel row — has one vocabulary for "how was
 *  this prospect found", rather than two that must be kept in step. */
export type Surface = "ai_overview" | "ai_answer" | "answer_box" | "people_also_ask" | "things_to_know" | "organic";

export const SURFACE_LABEL: Record<Surface, string> = {
  ai_overview: "cited in Google's AI Overview",
  ai_answer: "cited by an AI answer engine",
  answer_box: "cited in Google's featured snippet",
  people_also_ask: "cited in People Also Ask",
  things_to_know: "cited in Things to know",
  organic: "ranks organically",
};

export interface SurfaceHit {
  url: string;
  title: string;
  snippet: string;
  surface: Surface;
  /** For the question surfaces: the question Google asked. Real user language, useful as a pitch hook. */
  question?: string;
  /** Organic rank, when this hit came from the organic list. */
  position?: number;
}

export interface SurfaceResult {
  query: string;
  hits: SurfaceHit[];
  /** Google's own "what else are people searching" — the seed list for a second discovery hop. */
  relatedQueries: string[];
  /** The questions themselves, whether or not they carried a source link. */
  questions: string[];
  aiOverviewShown: boolean;
  notes: string[];
}

export function serpSurfacesEnabled(): boolean {
  return !!meteredKey(process.env.SERPER_API_KEY);
}

function isHttp(u: unknown): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

/**
 * Read every source-naming surface for one query. `null` means we could not ask at all (no key /
 * free-only mode / the request failed) — distinct from "asked and Google named nothing", which is
 * an empty `hits` with a note.
 *
 * `num: 20` for the same reason serpAnalysis uses it: page-two results are where the beatable,
 * pitchable pages usually are, and it is the same single credit as `num: 10`.
 */
export async function serpSurfaces(query: string, signal?: AbortSignal): Promise<SurfaceResult | null> {
  const key = meteredKey(process.env.SERPER_API_KEY);
  if (!key || !query.trim()) return null;

  let d: any;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, gl: "us", hl: "en", num: 20 }),
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    d = await res.json();
  } catch {
    return null;
  }

  const hits: SurfaceHit[] = [];
  const notes: string[] = [];
  const questions: string[] = [];

  // ── AI Overview ───────────────────────────────────────────────────────────────
  // Serper exposes this under a few shapes depending on the query, and the references can carry
  // `link` or `url`. ./geo.ts already handles the same variance; mirror it rather than assume one
  // shape, because the shape that is missing is silently read as "no AI Overview".
  const aio = d.aiOverview ?? null;
  const aioText: string =
    aio?.snippet ?? aio?.text ??
    (Array.isArray(aio?.textBlocks) ? aio.textBlocks.map((b: any) => b?.snippet ?? "").join(" ").trim() : "") ?? "";
  const aioRefs: any[] = Array.isArray(aio?.references) ? aio.references : Array.isArray(aio?.sources) ? aio.sources : [];
  const aiOverviewShown = !!aio && (!!aioText || aioRefs.length > 0);
  for (const r of aioRefs) {
    const url = r?.link ?? r?.url;
    if (!isHttp(url)) continue;
    hits.push({
      url,
      title: String(r?.title ?? r?.source ?? ""),
      snippet: String(r?.snippet ?? aioText).slice(0, 300),
      surface: "ai_overview",
    });
  }
  if (!aiOverviewShown) {
    notes.push(`"${query}": Google showed no AI Overview (it varies by query and phrasing — not evidence there are none).`);
  } else if (!aioRefs.length) {
    notes.push(`"${query}": AI Overview shown but Serper returned no reference links for it, so nothing could be sourced from it.`);
  }

  // ── Featured snippet ──────────────────────────────────────────────────────────
  const box = d.answerBox;
  if (box && isHttp(box.link)) {
    hits.push({
      url: box.link,
      title: String(box.title ?? box.source ?? ""),
      snippet: String(box.snippet ?? box.answer ?? "").slice(0, 300),
      surface: "answer_box",
    });
  }

  // ── People Also Ask, and the "Things to know" block ───────────────────────────
  // These are the same thing structurally: a question, an answer, and the page the answer came
  // from. PAA is a documented Serper field and is what the blog writer already reads (for FAQ
  // headings, in ../writer/seoData.ts). "Things to know" is the newer panel Google renders on
  // broader queries; it is read OPPORTUNISTICALLY here because it is not a field Serper documents
  // — if a response happens to carry it under either spelling we use it, and if it never appears
  // we lose nothing, because PAA already covers the same "question → cited source" shape. The
  // note below is deliberately explicit so nobody reads its absence as a bug.
  const paa: any[] = Array.isArray(d.peopleAlsoAsk) ? d.peopleAlsoAsk : [];
  const ttk: any[] = Array.isArray(d.thingsToKnow) ? d.thingsToKnow
    : Array.isArray(d.things_to_know) ? d.things_to_know
    : [];
  for (const [rows, surface] of [[paa, "people_also_ask"], [ttk, "things_to_know"]] as Array<[any[], Surface]>) {
    for (const q of rows) {
      const question = String(q?.question ?? q?.title ?? "").trim();
      if (question) questions.push(question);
      const url = q?.link ?? q?.url;
      if (!isHttp(url)) continue;
      hits.push({
        url,
        title: String(q?.title ?? question),
        snippet: String(q?.snippet ?? q?.answer ?? "").slice(0, 300),
        surface,
        question: question || undefined,
      });
    }
  }
  if (!paa.length && !ttk.length) notes.push(`"${query}": no question blocks (People Also Ask / Things to know) on this SERP.`);

  // ── Organic ───────────────────────────────────────────────────────────────────
  // Same request, so these are free. Keeping them here means a Serper-backed query needs no second
  // call through webSearch for the plain results.
  for (const o of (Array.isArray(d.organic) ? d.organic : [])) {
    if (!isHttp(o?.link)) continue;
    hits.push({
      url: o.link,
      title: String(o.title ?? ""),
      snippet: String(o.snippet ?? "").slice(0, 300),
      surface: "organic",
      position: Number(o.position) || undefined,
    });
  }

  const relatedQueries: string[] = (Array.isArray(d.relatedSearches) ? d.relatedSearches : [])
    .map((r: any) => String(r?.query ?? "").trim())
    .filter(Boolean);

  return { query, hits, relatedQueries, questions: [...new Set(questions)], aiOverviewShown, notes };
}
