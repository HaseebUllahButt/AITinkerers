// Where a launch is talked about before the changelog catches up: Hacker News, Reddit, X.
//
// ── These are SIGNALS, not sources ──────────────────────────────────────────────────────────────
//
// The radar's sourcing rule is that a candidate carries a citable, dated, first-party source, and
// it is the reason that board is trustworthy. A tweet is not that. Neither is an HN thread. They
// are POINTERS at a primary source — often days ahead of it, which is exactly their value, and
// never a substitute for it.
//
// So everything here is tiered `signal` (see tierOf in ./sweep) and lands on the board saying so.
// The person reading it is being told "somebody says this happened, nobody has confirmed it" —
// which is a genuinely useful row, and a very different row from a vendor deprecation table.
//
// ── Why the board was 100% HuggingFace before this ──────────────────────────────────────────────
//
// runRadar's sources are two deprecation tables, the HF API and five first-party RSS feeds. The
// feeds only fire when a lab actually blogs, and the deprecation tables change rarely — so on an
// ordinary weekday the only source producing rows was HuggingFace, and the board read as a list of
// Hub uploads rather than a picture of what happened.
//
// ── Cost ────────────────────────────────────────────────────────────────────────────────────────
//
// HN is free and needs no auth, so it always runs. Reddit and X go through Apify and cost credits,
// so they run only when APIFY_TOKEN is set and report themselves as "not configured" rather than
// failing when it is not. A missing token must never look like a quiet morning.
import { classifyModality, type RadarCandidate, type RadarSource } from "@/lib/research/radar";

export interface SignalSweep {
  rows: RadarCandidate[];
  sources: RadarSource[];
}

/** Stable per-source ids, so re-sweeping does not reshuffle row identity. */
function hashId(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Days from today to a YYYY-MM-DD. Negative for the past. */
function daysBetween(iso: string): number {
  const then = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(then) ? 0 : Math.round((then - Date.now()) / 86_400_000);
}

/**
 * Does this item plausibly concern a model or product launch?
 *
 * Deliberately strict. An unanchored "AI" filter on any of these three returns commentary,
 * think-pieces and drama, which is how a signal source drowns the board it was meant to widen —
 * the X radar in the skill hit exactly that and measured 40/40 junk before the anchor was added.
 */
const LAUNCH_RE = /\b(launch(?:e[sd]|ing)?|releas(?:e[sd]?|ing)|announc(?:e[sd]|ing)|introduc(?:e[sd]|ing)|ship(?:ped|ping)?|unveil(?:ed|s)?|open[- ]?sourc(?:e[sd]|ing)|now available|available now|out now|preview|beta|waitlist|early access|deprecat(?:ed|ing|ion)|sunset(?:ting)?|shutting down|end[- ]of[- ]life)\b/i;
const SUBJECT_RE = /\b(model|llm|gpt|claude|gemini|llama|qwen|mistral|deepseek|grok|sora|veo|flux|midjourney|runway|luma|pika|kling|seedance|imagen|diffusion|text[- ]to[- ](?:image|video|speech|audio)|image[- ]to[- ]video|voice clon\w*|tts|image generat\w*|video generat\w*|weights|checkpoint|api)\b/i;

function looksLikeLaunch(text: string): boolean {
  return LAUNCH_RE.test(text) && SUBJECT_RE.test(text);
}

/**
 * The same question for Hacker News, which needs a different answer.
 *
 * On X the account IS the announcement, so "introducing…" phrasing is reliable. On HN a submitter
 * strips exactly that — the title is the product name. Measured against a live week: `AI model
 * release` with points>20 returned four stories and the announcement filter passed ZERO of them,
 * while the actual launches on the front page were titled "DeepSeek V4 Pro 0813", "Muse Glimmer:
 * 30B-parameter model…" and "Meta's new open-weight model…". Not one carries a launch verb.
 *
 * So a launch is also recognised by SHAPE. Each clause below was checked against real titles from
 * that week, including the ones that must NOT pass:
 *
 *   "Claude Code pricing: same tokens, same model, up to 40x the price"  — vendor, no version
 *   "The web server deployment model breaks at hobby scale"              — "model", other sense
 *   "Emergent Introspective Awareness in Large Language Models"          — a paper
 *   "Mark Zuckerberg attacks 'closed' AI rivals as Meta returns to open models"  — commentary
 */
// The negative lookbehind is not decoration. "Anthropic in Talks to Buy World Model AI Startup
// Decart for $6B" passed on its first live run: "$6B" reads as a parameter count and "Model" is
// right there in the title. A funding round is not a launch.
const PARAM_RE = /(?<![$£€])\b\d+(?:\.\d+)?\s?[bm]\b[- ]?(?:param|parameter)?/i;
const VENDOR_VERSION_RE = /\b(deepseek|qwen|claude|gpt|llama|mistral|gemini|grok|flux|sora|veo|kling|seedance|midjourney|minimax|moonshot|kimi|glm|phi|command[- ]?r|nemotron|hunyuan|wan)[\s-]?v?\d/i;
const OPEN_WEIGHTS_RE = /\bopen[- ](?:weights?|source)\b[^.]{0,40}\bmodel|\bopen[- ]weight\s+model\b/i;

function looksLikeLaunchHN(title: string): boolean {
  if (looksLikeLaunch(title)) return true;
  if (PARAM_RE.test(title) && /\bmodel|\bllm\b/i.test(title)) return true;
  if (VENDOR_VERSION_RE.test(title)) return true;
  return OPEN_WEIGHTS_RE.test(title);
}

// ── Hacker News ─────────────────────────────────────────────────────────────────────────────────

interface HnHit {
  objectID?: string;
  title?: string;
  url?: string;
  points?: number;
  num_comments?: number;
  created_at_i?: number;
}

/**
 * HN via Algolia. Free, unauthenticated, and the front page is a reasonable proxy for "the
 * industry noticed this today".
 *
 * A points floor rather than a raw firehose: an unvoted submission is one person's link, and the
 * whole reason to read HN here is that a crowd already judged it worth attention.
 *
 * NOTE this does not reuse src/lib/harvesters/hackernews.ts. That harvester answers a different
 * question — it finds PAGES to mine for author bylines in the backlink pipeline, and returns
 * RawHit. Wrapping it would mean converting shapes in both directions to share thirty lines of
 * fetch, and would couple the research board to the outreach pipeline's types.
 */
async function sweepHackerNews(days: number, minPoints = 20): Promise<{ rows: RadarCandidate[]; source: RadarSource }> {
  const since = Math.floor((Date.now() - days * 86_400_000) / 1000);
  const url = "https://hn.algolia.com/api/v1/search_by_date";
  const rows: RadarCandidate[] = [];

  // Broad queries with a high points floor, not narrow phrase queries. Algolia matches body text
  // too, so a phrase like "AI model release" mostly finds comment threads that mention those words;
  // the front page's actual launches were surfacing under plain "model". The points floor is what
  // does the filtering, and looksLikeLaunchHN does the rest.
  const queries = ["model", "AI model", "open source model"];
  let failures = 0;
  const byId = new Map<string, RadarCandidate>();

  await Promise.all(queries.map(async (q) => {
    const params = new URLSearchParams({
      query: q,
      tags: "story",
      hitsPerPage: "50",
      numericFilters: `created_at_i>${since},points>${minPoints}`,
    });
    try {
      const res = await fetch(`${url}?${params}`, {
        headers: { "User-Agent": "SearchOps-Research/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) { failures++; return; }
      const data = (await res.json().catch(() => null)) as { hits?: HnHit[] } | null;
      for (const hit of data?.hits ?? []) {
        const title = (hit.title ?? "").trim();
        if (!title || !looksLikeLaunchHN(title)) continue;
        if (byId.has(String(hit.objectID))) continue;
        const at = (hit.created_at_i ?? 0) * 1000;
        if (!at) continue;
        // Keyed by story id: the three queries overlap heavily by design, and the same launch
        // surfacing under "model" and "AI model" is one row, not two.
        byId.set(String(hit.objectID), {
          id: hashId(`hn|${hit.objectID}`),
          subject: title,
          summary: `Hacker News — ${hit.points ?? 0} points, ${hit.num_comments ?? 0} comments. A crowd noticed it; the vendor's own announcement is still the citation.`,
          sourceName: "Hacker News",
          // The discussion, not the linked article: the thread is where the correction lives when
          // the headline overstates what shipped.
          sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          sourceKind: "hackernews",
          date: ymd(at),
          dateKind: "observed",
          daysOut: null,
          modality: classifyModality(title),
          pageType: null,
          suggestedTemplate: null,
          bucket: "unverified",
          ledger: null,
        });
      }
    } catch { failures++; }
  }));

  rows.push(...byId.values());
  return {
    rows,
    source: {
      name: "Hacker News",
      url,
      ok: failures < queries.length,
      count: rows.length,
      note: failures ? `${failures} of ${queries.length} queries failed.` : null,
    },
  };
}

// ── Apify-backed: Reddit and X ──────────────────────────────────────────────────────────────────

/**
 * Timeouts are a BUDGET, not a generosity.
 *
 * The sweep route dies at 300s and runRadar has already spent some of it, so these run in parallel
 * and the slowest one sets the cost. Measured on the first live run: Reddit hit a 180s ceiling and
 * dragged the whole sweep to exactly 180s while X had already finished. A signal source is a bonus
 * — losing it costs a few rows, and letting it eat the budget costs the entire board.
 */
async function apifyRun(actor: string, input: unknown, timeoutMs: number): Promise<unknown[] | { error: string }> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) return { error: "APIFY_TOKEN is not set" };
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${actor.replace("/", "~")}/run-sync-get-dataset-items?token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) return { error: `Apify returned ${res.status}` };
    const data = await res.json().catch(() => null);
    return Array.isArray(data) ? data : { error: "Apify returned a non-list body" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Apify call failed" };
  }
}

interface RedditItem { id?: string; title?: string; url?: string; body?: string; communityName?: string; upVotes?: number; createdAt?: string; parsedCommunityName?: string }

/**
 * Reddit — built, and OFF by default. Both routes in were measured and neither is usable inside a
 * 300s sweep:
 *
 *   Apify (trudax/reddit-scraper-lite)  did not finish in 60s, 180s OR 240s, on three subreddits
 *                                       with maxItems 30. The skill's own note says six subs took
 *                                       over two minutes; it is worse than that now.
 *   reddit.com/r/<sub>/new.json         403 on every subreddit. Reddit blocks unknown user agents.
 *
 * The honest options left are a Reddit OAuth app (a real credential and a real integration) or a
 * faster actor. Until one exists, running this every morning would put a permanently red source on
 * the board, which trains people to ignore source health — the one thing it is there for.
 *
 * Set RESEARCH_REDDIT=1 to turn it on once one of those is sorted. The code is complete and works;
 * it is only the latency that fails.
 */
async function sweepReddit(days: number): Promise<{ rows: RadarCandidate[]; source: RadarSource }> {
  const actor = process.env.APIFY_REDDIT_ACTOR?.trim() || "trudax/reddit-scraper-lite";
  const subs = (process.env.REDDIT_SUBS?.trim() || "LocalLLaMA,StableDiffusion,singularity")
    .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);
  const src = (ok: boolean, count: number, note: string | null): RadarSource =>
    ({ name: "Reddit", url: `https://reddit.com/r/${subs.join("+")}`, ok, count, note });

  const out = await apifyRun(actor, {
    startUrls: subs.map((s) => ({ url: `https://www.reddit.com/r/${s}/new/` })),
    maxItems: 40,
    skipComments: true,
    searchPosts: true,
  }, 60_000);
  if (!Array.isArray(out)) return { rows: [], source: src(false, 0, out.error) };

  const cutoff = Date.now() - days * 86_400_000;
  const rows: RadarCandidate[] = [];
  for (const raw of out as RedditItem[]) {
    const title = (raw.title ?? "").trim();
    if (!title || !looksLikeLaunch(title)) continue;
    const at = Date.parse(raw.createdAt ?? "");
    if (!at || at < cutoff) continue;
    const sub = raw.parsedCommunityName ?? raw.communityName ?? "reddit";
    rows.push({
      id: hashId(`reddit|${raw.id ?? raw.url ?? title}`),
      subject: title,
      summary: `r/${sub} — ${raw.upVotes ?? 0} upvotes. Community chatter, not an announcement; confirm against the vendor before writing.`,
      sourceName: `Reddit r/${sub}`,
      sourceUrl: raw.url ?? `https://reddit.com/r/${sub}`,
      sourceKind: "reddit",
      date: ymd(at),
      dateKind: "observed",
      daysOut: null,
      modality: classifyModality(`${title} ${raw.body ?? ""}`),
      pageType: null,
      suggestedTemplate: null,
      bucket: "unverified",
      ledger: null,
    });
  }
  return { rows, source: src(true, rows.length, null) };
}

interface XItem { id?: string; text?: string; url?: string; createdAt?: string; likeCount?: number; retweetCount?: number; author?: { userName?: string } }

/**
 * The accounts that announce first. Narrow on purpose and for a measured reason: the skill's
 * version of this found that an unanchored forward-looking query returned 40/40 junk — crypto and
 * gaming accounts saying "coming soon" outranked OpenAI's own launch post and buried it entirely.
 */
const X_ACCOUNTS = [
  "OpenAI", "GoogleDeepMind", "AnthropicAI", "runwayml", "LumaLabsAI", "bfl_ml",
  "Ideogram_ai", "krea_ai", "pika_labs", "AlibabaQwen", "MiniMax__AI", "midjourney",
  "StabilityAI", "fal", "replicate",
];

async function sweepX(days: number): Promise<{ rows: RadarCandidate[]; source: RadarSource }> {
  const actor = process.env.APIFY_X_ACTOR?.trim() || "apidojo/tweet-scraper";
  const since = ymd(Date.now() - days * 86_400_000);
  const src = (ok: boolean, count: number, note: string | null): RadarSource =>
    ({ name: "X", url: "https://x.com", ok, count, note });

  const out = await apifyRun(actor, {
    searchTerms: [`(${X_ACCOUNTS.map((a) => `from:${a}`).join(" OR ")}) since:${since} -filter:replies`],
    sort: "Latest",
    maxItems: 80,
    tweetLanguage: "en",
  }, 120_000);
  if (!Array.isArray(out)) return { rows: [], source: src(false, 0, out.error) };

  // A free Apify plan answers 200 with ten `{noResults:true}` rows rather than an error — the
  // actor's own readme says API access needs a paid plan. Reporting that as "0 found" would read
  // as a quiet week on every single sweep, forever.
  const items = (out as (XItem & { noResults?: boolean })[]).filter((t) => !t.noResults);
  if (!items.length && out.length) {
    return { rows: [], source: src(false, 0, "the actor returned only noResults rows — the Apify plan does not allow API runs") };
  }

  const rows: RadarCandidate[] = [];
  for (const t of items) {
    const text = (t.text ?? "").trim();
    if (!text || !looksLikeLaunch(text)) continue;
    const at = Date.parse(t.createdAt ?? "");
    if (!at) continue;
    const who = t.author?.userName ?? "unknown";
    rows.push({
      id: hashId(`x|${t.id ?? t.url ?? text.slice(0, 80)}`),
      // Links stripped BEFORE truncating. A tweet ends in a t.co URL, and cutting at 160 characters
      // left rows titled "…Try it now at the link below. https:" — a dangling protocol reads as a
      // rendering bug. The link is already on the row as its source.
      subject: text.replace(/https?:\/\/\S*/g, "").replace(/\s+/g, " ").trim().slice(0, 130),
      summary: `@${who} on X — ${t.likeCount ?? 0} likes. First-party account, but a post is a pointer: cite the changelog or docs, never the tweet.`,
      sourceName: `X @${who}`,
      sourceUrl: t.url ?? "https://x.com",
      sourceKind: "x",
      date: ymd(at),
      dateKind: "observed",
      daysOut: null,
      modality: classifyModality(text),
      pageType: null,
      suggestedTemplate: null,
      bucket: "unverified",
      ledger: null,
    });
  }
  return { rows, source: src(true, rows.length, null) };
}

// ── Web research: the same engine Summer answers "anything coming up?" with ──────────────────────

interface ResearchRow {
  subject?: string;
  summary?: string;
  url?: string;
  date?: string;
  vendor?: string;
  timing?: string;
}

/**
 * A model loop with server-side web search, asked for ROWS rather than prose.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 *
 * Asked "anything coming up?", Summer produced a table naming Astra/GPT-6, GPT-5.6, Gemini 4, Grok
 * 4.7, Grok 5, Claude Opus 5, Muse Spark and Qwen3.8 Max — with ship states and roadmap timing. Not
 * one of those came from the board, because none of them are in a machine-readable feed: they live
 * in reporting, keynote coverage and vendor roadmaps. That answer came from deep_research.
 *
 * Grok 4.6 is the case that proves it. It shipped, the board never saw it, and Summer only mentioned
 * it in passing inside another row's notes. The feeds cannot fix that — xAI has no RSS the radar
 * reads and the Hub has no xAI weights — so the source that DID find it has to be a source.
 *
 * ── Why it is a signal, not a citation ──────────────────────────────────────────────────────────
 *
 * The answers carry real URLs, and some of those URLs are first-party. But nothing here has checked
 * WHICH, and a roundup cited as though it were a changelog is the exact failure the board's sourcing
 * rule exists to prevent. So these land tiered `signal`: genuinely useful leads, confirmed by a
 * person before a word is written.
 *
 * ── Both windows, because the question has two halves ───────────────────────────────────────────
 *
 * "What happened last week" and "what lands this month" are different searches with different
 * phrasings, and one prompt asking for both gets a thin answer to each. Two calls, run together.
 */
async function sweepWebResearch(): Promise<{ rows: RadarCandidate[]; source: RadarSource }> {
  const src = (ok: boolean, count: number, note: string | null): RadarSource =>
    ({ name: "Web research", url: "", ok, count, note });

  const { anthropicClient, baseWriterParams } = await import("@/lib/writer/anthropic");
  const client = anthropicClient();
  if (!client) return { rows: [], source: src(false, 0, "ANTHROPIC_API_KEY is not set") };

  const SHAPE =
    'Reply with ONLY a JSON array, no prose and no code fence. Each element: ' +
    '{"subject":"the model or product name, e.g. \\"Grok 4.6\\"","summary":"one sentence on what it is and its state",' +
    '"url":"the most authoritative URL you actually saw","date":"YYYY-MM-DD of the announcement or the expected date",' +
    '"vendor":"company","timing":"shipped|imminent|expected|rumoured"}. ' +
    'Only AI models, model families and generative-AI products. No funding rounds, no acquisitions, ' +
    'no benchmark commentary, no opinion pieces. If you are unsure of a date, give your best estimate ' +
    'rather than omitting the row. Aim for 12-20 rows. Include EVERY point release you find, including ' +
    'minor ones like a .6 or .7 bump — a small version bump is often the one that shipped.';

  const questions = [
    `Which AI models and generative-AI products were RELEASED OR ANNOUNCED in the last 7 days? Include LLMs, image, video and audio models from every major lab. ${SHAPE}`,
    `Which AI models and generative-AI products are EXPECTED, CONFIRMED OR STRONGLY RUMOURED to launch in the next 30 days? Include anything with a stated date, a waitlist, a preview, or a public commitment from the company. ${SHAPE}`,
  ];

  const byKey = new Map<string, RadarCandidate>();
  let failures = 0;

  await Promise.all(questions.map(async (q, qi) => {
    try {
      const resp = await client.messages.create({
        ...baseWriterParams("medium"),
        max_tokens: 8000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        messages: [{ role: "user", content: q }],
      });
      // The answer is the LAST text block: earlier ones are the model narrating its searches, and
      // concatenating them puts "I'll look that up" into the JSON parse.
      const texts = resp.content.flatMap((b) =>
        b.type === "text" && typeof (b as { text?: unknown }).text === "string" ? [(b as { text: string }).text] : []);
      const raw = texts.length ? texts[texts.length - 1] : "";
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start === -1 || end <= start) { failures++; return; }
      const parsed = JSON.parse(raw.slice(start, end + 1)) as ResearchRow[];
      if (!Array.isArray(parsed)) { failures++; return; }

      for (const r of parsed) {
        const subject = String(r.subject ?? "").trim();
        if (!subject) continue;
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date ?? "")) ? String(r.date) : ymd(Date.now());
        const timing = String(r.timing ?? "").toLowerCase();
        // A stated future date is a SCHEDULED date — the one thing the radar treats as shippable —
        // whereas "it shipped last week" is observed. Collapsing the two is how a page gets built
        // for a launch that already happened, so the distinction is preserved from the row itself.
        const scheduled = qi === 1 && (timing === "expected" || timing === "imminent") && date > ymd(Date.now());
        const key = subject.toLowerCase().replace(/[^a-z0-9.]+/g, "");
        if (byKey.has(key)) continue;
        byKey.set(key, {
          id: hashId(`web|${key}`),
          subject,
          summary: [
            String(r.summary ?? "").trim(),
            r.vendor ? `Vendor: ${r.vendor}.` : "",
            timing ? `State: ${timing}.` : "",
            "Found by web research — a lead, not a citation. Confirm against the vendor's own page before writing.",
          ].filter(Boolean).join(" "),
          sourceName: r.vendor ? `Web research (${r.vendor})` : "Web research",
          sourceUrl: /^https?:\/\//.test(String(r.url ?? "")) ? String(r.url) : "https://www.google.com/search?q=" + encodeURIComponent(subject),
          sourceKind: "webresearch",
          date,
          dateKind: scheduled ? "scheduled" : "observed",
          daysOut: scheduled ? daysBetween(date) : null,
          modality: classifyModality(`${subject} ${r.summary ?? ""}`),
          pageType: null,
          suggestedTemplate: null,
          bucket: scheduled ? "this_month" : "unverified",
          ledger: null,
        });
      }
    } catch { failures++; }
  }));

  const rows = [...byKey.values()];
  return {
    rows,
    source: src(
      failures < questions.length,
      rows.length,
      failures ? `${failures} of ${questions.length} research passes failed.` : null,
    ),
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────────────────────────

/**
 * Sweep every signal source. Never throws: one dead source degrades the board, it does not empty it.
 *
 * Reddit and X are skipped entirely without APIFY_TOKEN and report themselves as unconfigured, so
 * the sweep result can say "not set up" rather than showing zero and letting somebody conclude
 * nothing happened.
 */
export async function sweepSignals(days = 7): Promise<SignalSweep> {
  const apify = !!process.env.APIFY_TOKEN?.trim();
  // See sweepReddit: measured too slow to run inline, so it is opt-in rather than always-failing.
  const redditEnabled = apify && process.env.RESEARCH_REDDIT === "1";

  const [hn, reddit, x, web] = await Promise.all([
    sweepHackerNews(days).catch(() => ({
      rows: [] as RadarCandidate[],
      source: { name: "Hacker News", url: "", ok: false, count: 0, note: "sweep threw" } as RadarSource,
    })),
    redditEnabled ? sweepReddit(days).catch(() => ({
      rows: [] as RadarCandidate[],
      source: { name: "Reddit", url: "", ok: false, count: 0, note: "sweep threw" } as RadarSource,
    })) : Promise.resolve({
      rows: [] as RadarCandidate[],
      source: {
        name: "Reddit", url: "", ok: true, count: 0,
        // ok:true on purpose — off by choice is not a failure, and painting it red every morning
        // is how people learn to stop reading source health.
        note: apify
          ? "off by default: the actor does not finish inside the sweep budget (set RESEARCH_REDDIT=1 to try it)"
          : "APIFY_TOKEN is not set — Reddit was not swept",
      } as RadarSource,
    }),
    apify ? sweepX(days).catch(() => ({
      rows: [] as RadarCandidate[],
      source: { name: "X", url: "", ok: false, count: 0, note: "sweep threw" } as RadarSource,
    })) : Promise.resolve({
      rows: [] as RadarCandidate[],
      source: { name: "X", url: "", ok: false, count: 0, note: "APIFY_TOKEN is not set — X was not swept" } as RadarSource,
    }),
    // Web research is what finds the releases no feed carries — see sweepWebResearch. It is the
    // reason Grok 4.6 was missable at all.
    sweepWebResearch().catch(() => ({
      rows: [] as RadarCandidate[],
      source: { name: "Web research", url: "", ok: false, count: 0, note: "sweep threw" } as RadarSource,
    })),
  ]);

  return {
    rows: [...hn.rows, ...reddit.rows, ...x.rows, ...web.rows],
    sources: [hn.source, reddit.source, x.source, web.source],
  };
}
