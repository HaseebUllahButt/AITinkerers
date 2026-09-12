// Step 1 of the template-launch process: the dated radar.
//
// The premise is that the best day to publish a page about a model is the day it lands, and the only
// way to hit that is to have the page built beforehand. So this sweeps forward, not backward.
//
// WHY THESE SOURCES AND NOT A WEB SEARCH
//
// A search for "upcoming AI models" returns roundups, and a roundup is a pointer, never a citation —
// it fails the sourcing bar outright. The signal lives in machine-readable endpoints nobody polls:
//
//   Deprecation tables  the highest-yield source, and the surprising one. Image and video labs ship
//                       same-day (blog, weights and API together), so launches have almost no lead
//                       time. RETIREMENTS are announced months ahead, carry exact dates, and name the
//                       replacement — which is a better page anyway: certain publish window, real
//                       migration intent, and a sourced claim when the replacement is a model we run.
//   HuggingFace API     a lab uploads weights before or alongside the blog post. Free, no auth.
//   First-party RSS     OpenAI news, Google AI blog, HF blog, Replicate changelog. Dated, first-party.
//
// THE DATE DISTINCTION THAT MAKES THIS HONEST
//
// A HuggingFace upload is evidence a model EXISTS. It is not a launch date and it is not a spec. So
// every candidate carries `dateKind`:
//
//   scheduled  a real forward date from the source (a retirement, a preview→GA transition). Only these
//              can be bucketed into the 30-day window, because only these have a window.
//   observed   when the source item was published. Evidence, not a date. These are offered in their own
//              bucket that says exactly that, and cannot be shipped until someone confirms a date.
//
// Collapsing the two is how a page gets built for a launch that already happened, or never will.
//
// NOTHING HERE DECIDES ANYTHING. The output is a board for a person to read. See ./ledger for gate 3
// and the route for the gate that matters: a human picks which one ships.

import * as cheerio from "cheerio";
import { redis } from "@/lib/redis";
import { getLedgerCorpus, scoreSubject, type LedgerVerdict } from "./ledger";

export type Modality = "image" | "video" | "audio" | "avatar" | "llm" | "mcp" | "capability" | "retirement" | "other";

export type RadarBucket =
  /** Scheduled, 0–7 days out. The urgent ones. */
  | "this_week"
  /** Scheduled, 8–30 days out. Plan-ahead. */
  | "this_month"
  /** Scheduled, beyond 30 days. Listed for awareness, not offered. */
  | "parked"
  /** Dated evidence the thing exists, with no forward date. Needs one confirmed before it can ship. */
  | "unverified"
  /** The ledger already found a page for it. Shown so nobody re-suggests it. */
  | "covered";

export interface RadarCandidate {
  /** Stable across sweeps so a board can be re-read without the rows shuffling identity. */
  id: string;
  subject: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  sourceKind: "deprecation" | "huggingface" | "changelog" | "hackernews" | "reddit" | "x" | "webresearch";
  /** YYYY-MM-DD. A candidate with no date is not a candidate and never reaches this type. */
  date: string;
  dateKind: "scheduled" | "observed";
  /** Days from today. Negative for a past scheduled date; null when the date is only observed. */
  daysOut: number | null;
  modality: Modality;
  /** Which page type this becomes. Null means gate 2 failed and it was never offered. */
  pageType: string | null;
  /** The template the page-types rules point at, by what the page's OUTPUT is. */
  suggestedTemplate: string | null;
  bucket: RadarBucket;
  ledger: LedgerVerdict | null;
}

export interface RadarSource {
  name: string;
  url: string;
  ok: boolean;
  count: number;
  note: string | null;
}

export interface RadarSweep {
  runAt: string;
  /** The lookback for observed items. The forward window is fixed at 30 days by the process. */
  days: number;
  candidates: RadarCandidate[];
  sources: RadarSource[];
  /** Gate 2 rejections: dated and sourced, but not a page type we ship. */
  droppedIrrelevant: number;
  notes: string[];
  ledgerError: string | null;
}

const WINDOW_DAYS = 30;

// ── classification ───────────────────────────────────────────────────────────

/**
 * Order is the whole design here, and it was wrong.
 *
 * The rules run top to bottom and the first match wins, so a rule that mixes an explicit modality
 * phrase with VENDOR NAMES claims anything that mentions the vendor. Measured on a live row:
 * "Grok Imagine Image 2.0 is now on Runway" was filed as VIDEO, because `runway` sat in the video
 * rule and matched before the word "Image" was ever considered. It is an image model.
 *
 * So explicit phrases go first — text says what it is — and vendor names are a weaker fallback
 * underneath, for the case where nothing explicit is stated at all.
 */
const MODALITY_RULES: Array<[RegExp, Modality]> = [
  [/(deprecat|retire|shutdown|shut down|sunset|discontinu|end of life|turned off)/i, "retirement"],

  // ── explicit: the text names the modality ──
  [/(text-to-video|image-to-video|video model|video generat\w*|\bvideo\b)/i, "video"],
  [/(text-to-image|image model|image generat\w*|\bimage\b)/i, "image"],
  [/(text-to-speech|text-to-audio|voice clon\w*|\baudio\b|\bvoice\b|\bmusic\b|\btts\b)/i, "audio"],
  [/(avatar|lipsync|lip.sync|talking.?head|digital human)/i, "avatar"],

  // LLMs. classifyModality had no bucket for these and src/lib/research/route.ts carried a comment
  // saying so, working around it with its own regex — which meant a text model was filed as "other"
  // alongside retirements and MCP servers, and the research board could not offer an LLM tab.
  [/\b(llm|large language model|language model|reasoning model|chat model|foundation model)\b/i, "llm"],
  // The optional word between vendor and number is load-bearing: labs name tiers, not just versions.
  // Measured on live rows — "Claude Opus 5", "GPT-5.6 Sol" and "Gemini 3.5 Pro" all ship that shape,
  // and `claude\s*\d` filed "Claude Opus 5" as "other".
  [/\b(gpt|claude|gemini|llama|qwen|grok|glm|ling|muse|command[- ]?r|nemotron)(?:[- ]?[a-z]+)?[- ]?\d/i, "llm"],
  [/\b(mistral|deepseek|kimi|moonshot|phi)\b/i, "llm"],

  // ── fallback: a vendor known for one modality, with nothing explicit said ──
  [/(\bveo\b|sora|runway|kling|hailuo|\bwan\b|\bltx\b|seedance|pika|luma)/i, "video"],
  [/(flux|imagen|seedream|ideogram|midjourney|nano.?banana|recraft|qwen-image)/i, "image"],
  [/(elevenlabs|suno|udio)/i, "audio"],

  [/\bmcp\b|model context protocol/i, "mcp"],
  [/(upscal|relight|inpaint|outpaint|background remov|super.?resolution|restyle|motion transfer)/i, "capability"],
];

export function classifyModality(text: string): Modality {
  return MODALITY_RULES.find(([re]) => re.test(text))?.[1] ?? "other";
}

/**
 * Gate 2, encoded: which page type does this become?
 *
 * "If you cannot name the page type, it is not a candidate." A general LLM release, a funding round or
 * a benchmark is real news and no page at all — returning null here is what keeps those off the board
 * rather than letting them pad it out.
 */
export function pageTypeFor(modality: Modality): string | null {
  switch (modality) {
    case "image":
    case "video":
      return "/apps/<model> and /features/ai-<x>-generator";
    case "audio":
      return "/music-studio/<slug>";
    case "avatar":
      return "/features/<avatar capability>";
    case "mcp":
      return "/mcp cluster page";
    case "capability":
      return "/features/ai-<x>-<verb>";
    case "retirement":
      return "/compare/<model>-alternative";
    // "llm" returns null on purpose, which is what it already did as "other" — this radar's gate 2
    // is about the page types THIS pipeline ships, and a text model is not one of them. The research
    // board routes LLMs to a landing page separately (see lib/research/route.ts), so naming the
    // bucket here changes what the board can show without changing what the radar offers.
    default:
      return null;
  }
}

/**
 * The template, chosen by what the page's OUTPUT is rather than by what the subject is.
 *
 * Only a suggestion — the live catalogue is authoritative about what is actually deployed, and the
 * picker validates against it. Offering the suggestion here means the common case (a video model gets
 * the video template) does not depend on the operator remembering the mapping.
 *
 * Every arm below is the template the SHIPPED corpus actually uses for that modality, counted rather
 * than assumed. Measured over all 594 cluster-pages in Strapi:
 *
 *   video-templates.video-template-1  184 pages (145 with a video-shaped slug: runway-gen-4.5,
 *                                     hailuo-02, ai-faceless-video-generator, lucy-edit, …)
 *   templates.template-7              216 pages, and only 3 video-ish — it is the image/general
 *                                     workhorse (seedream-*, nano-banana-*, kling-Image-3-0)
 *   music-templates.music-template-1   89 pages
 *   comparison-templates.…-1           17 pages
 *   templates.template-1                0 pages
 *
 * That last line is why "video" changed. It used to return templates.template-1, which no shipped
 * page has ever used, so every video candidate the radar offered was steered onto an unproven
 * template while the 184-page house pattern sat one entry away in the same picker. It was not a
 * rendering failure — template-1 is registered and deployed, so nothing complained — which is
 * exactly why it survived: the suggestion was wrong in a way only the corpus could reveal.
 */
export function templateFor(modality: Modality): string | null {
  switch (modality) {
    case "video": return "video-templates.video-template-1";
    case "image": return "templates.template-7";
    case "mcp": return "mcp-template.mcp-template-1";
    case "audio": return "music-templates.music-template-1";
    case "retirement": return "comparison-templates.comparison-template-1";
    default: return null;
  }
}

function hashId(input: string): string {
  // FNV-1a. Not cryptographic — it only has to be stable and collision-free enough to key a board row.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function daysBetween(iso: string): number {
  const then = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(then)) return 0;
  return Math.round((then - Date.now()) / 86_400_000);
}

// ── source 1: deprecation tables ─────────────────────────────────────────────

const DEPRECATION_SOURCES = [
  { name: "OpenAI deprecations", url: "https://platform.openai.com/docs/deprecations" },
  { name: "Gemini API deprecations", url: "https://ai.google.dev/gemini-api/docs/deprecations" },
];

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const LONG_DATE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function parseDate(cell: string): string | null {
  const iso = cell.match(ISO_DATE);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const long = cell.match(LONG_DATE);
  if (long) {
    const m = MONTHS.indexOf(long[1].toLowerCase()) + 1;
    if (m > 0) return `${long[3]}-${String(m).padStart(2, "0")}-${String(Number(long[2])).padStart(2, "0")}`;
  }
  return null;
}

/**
 * Pull dated rows out of a deprecation table.
 *
 * Deliberately structural — it walks `<tr>` and requires one cell to parse as a date. A regex sweep over
 * the whole page text would happily pair a date in the changelog header with a model name from the nav.
 *
 * When the page is client-rendered there are no rows to find, and that is reported as a source that
 * could not be read rather than as a quiet zero. "The retirement table had nothing in it" and "we never
 * saw the retirement table" need completely different responses from a person.
 */
async function sweepDeprecations(src: { name: string; url: string }): Promise<{ rows: RadarCandidate[]; source: RadarSource }> {
  const rows: RadarCandidate[] = [];
  let html = "";
  try {
    const res = await fetch(src.url, {
      headers: { "User-Agent": `Summit-TemplateLaunch/1.0 (+${process.env.APP_URL ?? "https://imagine.art"})` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return { rows, source: { name: src.name, url: src.url, ok: false, count: 0, note: `HTTP ${res.status}` } };
    }
    html = await res.text();
  } catch (e) {
    return {
      rows,
      source: { name: src.name, url: src.url, ok: false, count: 0, note: e instanceof Error ? e.message : "fetch failed" },
    };
  }

  const $ = cheerio.load(html);
  const trs = $("tr").toArray();
  for (const tr of trs) {
    const cells = $(tr).find("td").toArray().map((td) => $(td).text().replace(/\s+/g, " ").trim());
    if (cells.length < 2) continue;
    const dateCell = cells.find((c) => parseDate(c));
    if (!dateCell) continue;
    const date = parseDate(dateCell)!;
    const rest = cells.filter((c) => c !== dateCell).join(" — ").slice(0, 240);
    if (!rest) continue;
    const days = daysBetween(date);
    // Past retirements are history, not radar. Gate 1 is applied here rather than at render time so a
    // stale row can never reach the board at all.
    if (days < 0) continue;
    const subject = rest.split(" — ")[0].slice(0, 90);
    const modality = classifyModality(`${subject} deprecation`);
    rows.push({
      id: hashId(`${src.url}|${date}|${subject}`),
      subject,
      summary: rest,
      sourceName: src.name,
      sourceUrl: src.url,
      sourceKind: "deprecation",
      date,
      dateKind: "scheduled",
      daysOut: days,
      modality: modality === "other" ? "retirement" : modality,
      pageType: null,
      suggestedTemplate: null,
      bucket: "parked",
      ledger: null,
    });
    if (rows.length >= 20) break;
  }

  return {
    rows,
    source: {
      name: src.name,
      url: src.url,
      ok: true,
      count: rows.length,
      note: trs.length === 0
        ? "No table rows in the served HTML — this page renders client-side. Read it by hand; it is the highest-yield source."
        : rows.length === 0
          ? `${trs.length} table rows, none with a future date.`
          : null,
    },
  };
}

// ── source 2: HuggingFace ────────────────────────────────────────────────────

/** Labs that actually ship generative image/video/audio weights, plus the two quantizers whose uploads
 *  reliably trail a real release by hours — nobody quantizes a model that does not exist. */
const LABS = [
  "black-forest-labs", "stabilityai", "Qwen", "Lightricks", "tencent", "genmo",
  "ByteDance-Seed", "Wan-AI", "THUDM", "rhymes-ai", "HiDream-ai", "Kwai-Kolors",
  "briaai", "playgroundai", "fal", "unsloth",
];
const PIPELINES = ["text-to-image", "text-to-video", "image-to-video", "text-to-speech", "text-to-audio"];

interface HfModel { id?: string; createdAt?: string; likes?: number; downloads?: number; pipeline_tag?: string }

/**
 * Is this repo a re-packaging of a model that already exists?
 *
 * The pipeline queries return the 25 newest uploads per tag with no quality floor, and most of what
 * is newest on the Hub at any moment is somebody's quantization. A real board showed six rows of
 * which four were exactly this — `gooya-v1-ONNX-int4` AND `gooya-v1-ONNX-fp16` as two separate
 * candidates, plus `fish-speech-s2-pro-nf4`. None of them are launches; they are formats of a
 * launch, and the launch itself is what earns a page.
 *
 * Filtering by NAME rather than by likes/downloads is deliberate. A traction floor would kill the
 * genuine same-day upload the radar exists to catch, which by definition has zero of both. A name
 * carrying `int4` is a derivative no matter how popular it gets.
 */
export function isDerivativeUpload(repoId: string): boolean {
  const name = repoId.split("/").pop() ?? repoId;
  return /(?:^|[-_.])(onnx|gguf|ggml|mlx|awq|gptq|eetq|int2|int3|int4|int8|fp4|fp8|fp16|bf16|nf4|q[2-8](?:_[a-z0-9]+)*|[248]bit|quantized|quantization|lora|dora|distill(?:ed)?|merge[ds]?|abliterated|uncensored|finetune[ds]?|ft)(?:[-_.]|$)/i.test(name);
}

async function sweepHuggingFace(cutoff: number): Promise<{ rows: RadarCandidate[]; source: RadarSource }> {
  const seen = new Map<string, RadarCandidate>();
  let failures = 0;

  const fetchJson = async (url: string): Promise<HfModel[] | null> => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      return r.ok ? ((await r.json()) as HfModel[]) : null;
    } catch { return null; }
  };

  const add = (m: HfModel, why: string, trusted: boolean) => {
    if (!m.id) return;
    if (isDerivativeUpload(m.id)) return;
    // A traction floor, but ONLY for the pipeline sweep.
    //
    // The LABS query asks known labs what they uploaded, so a zero-download repo from
    // black-forest-labs is exactly the same-day launch this radar exists to catch and must never be
    // filtered. The PIPELINE query asks the Hub for its newest text-to-image repos and gets
    // whatever anyone pushed — a live board carried "Model-name", "Qanvas" and "aros-bb6ce9db-Ana",
    // all with 0 likes and 0 downloads, above real news.
    //
    // Anything genuinely notable from an unknown org clears this within hours; the placeholder
    // uploads never do. The cost is a few hours of lead time on an unknown org's real launch, paid
    // to stop the board reading as noise.
    if (!trusted && (m.likes ?? 0) < 3 && (m.downloads ?? 0) < 100) return;
    const created = Date.parse(m.createdAt ?? "");
    if (!created || created < cutoff) return;
    if (seen.has(m.id)) return;
    const date = new Date(created).toISOString().slice(0, 10);
    const modality = classifyModality(`${m.id} ${m.pipeline_tag ?? ""}`);
    seen.set(m.id, {
      id: hashId(`hf|${m.id}`),
      subject: m.id.split("/").pop() ?? m.id,
      summary: `${why}. ${m.likes ?? 0} likes, ${(m.downloads ?? 0).toLocaleString()} downloads. Weights on the Hub — evidence the model exists, not a launch date and not a spec.`,
      sourceName: "HuggingFace",
      sourceUrl: `https://huggingface.co/${m.id}`,
      sourceKind: "huggingface",
      date,
      dateKind: "observed",
      daysOut: null,
      modality,
      pageType: null,
      suggestedTemplate: null,
      bucket: "unverified",
      ledger: null,
    });
  };

  await Promise.all([
    ...LABS.map(async (org) => {
      const j = await fetchJson(`https://huggingface.co/api/models?author=${encodeURIComponent(org)}&sort=createdAt&direction=-1&limit=10`);
      if (!j) { failures++; return; }
      for (const m of j) add(m, `Upload by ${org}`, true);
    }),
    ...PIPELINES.map(async (p) => {
      const j = await fetchJson(`https://huggingface.co/api/models?filter=${encodeURIComponent(p)}&sort=createdAt&direction=-1&limit=25`);
      if (!j) { failures++; return; }
      for (const m of j) add(m, `New ${p} model`, false);
    }),
  ]);

  const rows = [...seen.values()];
  return {
    rows,
    source: {
      name: "HuggingFace",
      url: "https://huggingface.co/api/models",
      ok: failures < LABS.length + PIPELINES.length,
      count: rows.length,
      note: failures ? `${failures} of ${LABS.length + PIPELINES.length} queries failed.` : null,
    },
  };
}

// ── source 3: first-party feeds ──────────────────────────────────────────────

const FEEDS = [
  { name: "OpenAI", url: "https://openai.com/news/rss.xml" },
  { name: "Google AI", url: "https://blog.google/technology/ai/rss/" },
  { name: "HuggingFace blog", url: "https://huggingface.co/blog/feed.xml" },
  { name: "Replicate changelog", url: "https://replicate.com/changelog/rss" },
  // Runway is gone from this list, not broken in it. They rebranded runwayml.com → runway.com and
  // dropped RSS altogether: /news/rss.xml, /feed.xml, /rss.xml and /blog/rss.xml all 308 to
  // runway.com and 404 there, and the news page advertises no feed. It had been reporting HTTP 404
  // on every sweep, which is a red source nobody can fix — the worst kind, because it teaches
  // people to ignore the source-health list.
  //
  // Runway is still covered: @runwayml is in the X account list (lib/research/signals.ts) and is
  // actively producing rows. Signal rather than primary, so it needs confirming before it is
  // written from — which is the correct trade for a vendor that stopped publishing a feed.
];

const stripTags = (s: string) =>
  s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();

async function sweepFeed(feed: { name: string; url: string }, cutoff: number): Promise<{ rows: RadarCandidate[]; source: RadarSource }> {
  let xml = "";
  try {
    const r = await fetch(feed.url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (!r.ok) return { rows: [], source: { name: feed.name, url: feed.url, ok: false, count: 0, note: `HTTP ${r.status}` } };
    xml = await r.text();
  } catch (e) {
    return { rows: [], source: { name: feed.name, url: feed.url, ok: false, count: 0, note: e instanceof Error ? e.message : "fetch failed" } };
  }

  const rows: RadarCandidate[] = [];
  // Both RSS `<item>` and Atom `<entry>`, because these five feeds are not all the same format.
  for (const block of xml.split(/<item[\s>]|<entry[\s>]/).slice(1, 41)) {
    const title = stripTags(block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const link = (block.match(/<link[^>]*href="([^"]+)"/) ?? block.match(/<link[^>]*>([\s\S]*?)<\/link>/))?.[1]?.trim() ?? feed.url;
    const rawDate = block.match(/<(?:pubDate|published|updated)>([\s\S]*?)<\/(?:pubDate|published|updated)>/)?.[1] ?? "";
    const parsed = Date.parse(rawDate);
    // No date is out. "Soon" is not a window, and an undated item cannot clear gate 1.
    if (!title || !parsed || parsed < cutoff) continue;
    const modality = classifyModality(title);
    rows.push({
      id: hashId(`${feed.name}|${link}|${title}`),
      subject: title.slice(0, 110),
      summary: `${feed.name} — first-party post.`,
      sourceName: feed.name,
      sourceUrl: link,
      sourceKind: "changelog",
      date: new Date(parsed).toISOString().slice(0, 10),
      dateKind: "observed",
      daysOut: null,
      modality,
      pageType: null,
      suggestedTemplate: null,
      bucket: "unverified",
      ledger: null,
    });
  }
  return { rows, source: { name: feed.name, url: feed.url, ok: true, count: rows.length, note: null } };
}

// ── the sweep ────────────────────────────────────────────────────────────────

function bucketFor(c: RadarCandidate): RadarBucket {
  if (c.dateKind === "observed") return "unverified";
  const d = c.daysOut ?? 0;
  if (d <= 7) return "this_week";
  if (d <= WINDOW_DAYS) return "this_month";
  return "parked";
}

/**
 * Run the whole radar: sweep, classify, apply gate 2, then run gate 3 on every survivor.
 *
 * Gate 3 runs here rather than at render time on purpose. The process says a candidate is checked
 * BEFORE it is offered — a board that shows a covered subject as available has already spent the
 * person's attention on a page that cannot be built.
 */
export async function runRadar(opts: { days?: number } = {}): Promise<RadarSweep> {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 60);
  const cutoff = Date.now() - days * 86_400_000;
  const notes: string[] = [];

  const results = await Promise.all([
    ...DEPRECATION_SOURCES.map(sweepDeprecations),
    sweepHuggingFace(cutoff),
    ...FEEDS.map((f) => sweepFeed(f, cutoff)),
  ]);

  const sources = results.map((r) => r.source);
  const all = results.flatMap((r) => r.rows);

  // Gate 2 — if we cannot name the page type, it is not a candidate.
  const relevant: RadarCandidate[] = [];
  let droppedIrrelevant = 0;
  for (const c of all) {
    const pageType = pageTypeFor(c.modality);
    if (!pageType) { droppedIrrelevant++; continue; }
    relevant.push({ ...c, pageType, suggestedTemplate: templateFor(c.modality), bucket: bucketFor(c) });
  }

  // Gate 3 — the ledger, on every survivor, against one corpus read.
  const corpus = await getLedgerCorpus();
  const candidates = relevant.map((c) => {
    const ledger = scoreSubject(c.subject, corpus);
    return {
      ...c,
      ledger,
      bucket: ledger.verdict === "CLEAR" ? c.bucket : ("covered" as RadarBucket),
    };
  });

  // Buckets in reading order; then by date, in whichever direction is useful for that bucket. A stated
  // future date sorts SOONEST first (that is the urgency), an observed date sorts NEWEST first (that is
  // the freshness). One direction for both would bury the thing that lands on Tuesday.
  const rank: Record<RadarBucket, number> = { this_week: 0, this_month: 1, unverified: 2, parked: 3, covered: 4 };
  candidates.sort((a, b) => {
    if (rank[a.bucket] !== rank[b.bucket]) return rank[a.bucket] - rank[b.bucket];
    const cmp = a.date.localeCompare(b.date);
    return a.dateKind === "scheduled" ? cmp : -cmp;
  });

  const offerable = candidates.filter((c) => c.bucket !== "covered" && c.bucket !== "parked").length;
  if (offerable === 0) {
    notes.push("Nothing offerable this sweep. That is a normal result — a quiet week is quiet. Do not promote a roundup rumour to fill the board.");
  } else if (offerable < 4) {
    notes.push(`Only ${offerable} offerable candidate${offerable === 1 ? "" : "s"}. The board is thin; an honest four beats a padded twelve.`);
  }
  if (!candidates.some((c) => c.dateKind === "scheduled")) {
    notes.push("No candidate carries a forward date. Everything here is evidence something exists, not evidence of when it lands — confirm a date against the vendor's own post before shipping any of it.");
  }

  return {
    runAt: new Date().toISOString(),
    days,
    candidates,
    sources,
    droppedIrrelevant,
    notes,
    ledgerError: corpus.error,
  };
}

// ── the board, kept ──────────────────────────────────────────────────────────
//
// A sweep is ~15 outbound requests and a full ledger read, so it is not something to re-run on every
// page load. More importantly the board has to SURVIVE: the process is "present the candidates and
// stop", which means the person may come back to it hours later, and a board that regenerated itself in
// between is a different board — they would be choosing from a list nobody vetted.
//
// Redis rather than a table because there is no candidates table to write to and this is genuinely
// ephemeral state: once a candidate is chosen it becomes a research_items row, which IS durable. When
// Redis is absent (local dev) the board simply is not kept, and callers sweep fresh — degraded, not
// broken, same posture as every other redis() caller in this app.

const BOARD_KEY = "landing:radar:board";
const BOARD_TTL_SECONDS = 60 * 60 * 12;

export async function saveRadarBoard(sweep: RadarSweep): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.set(BOARD_KEY, JSON.stringify(sweep), { ex: BOARD_TTL_SECONDS }).catch(() => {});
}

export async function loadRadarBoard(): Promise<RadarSweep | null> {
  const r = redis();
  if (!r) return null;
  const raw = await r.get<unknown>(BOARD_KEY).catch(() => null);
  if (!raw) return null;
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as RadarSweep;
  } catch {
    return null;
  }
}

/** True when the board is old enough that the dates on it may have moved past. */
export function boardIsStale(sweep: RadarSweep): boolean {
  return Date.now() - Date.parse(sweep.runAt) > 6 * 60 * 60 * 1000;
}
