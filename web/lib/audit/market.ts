// What a language model says about this site, and who it names instead.
//
// Two questions that look alike and are not:
//   KNOWS US   — ask a model directly. Tests what is in its training data.
//   FINDS US   — ask with web search on. Tests whether we are retrievable right now.
// A site can pass one and fail the other, and the fixes are different: the first is earned over
// months through mentions elsewhere, the second is usually a crawlability bug you can fix today.
// Collapsing them into one "AI visibility score" is what every other tool does and it hides the
// only actionable half.
import { llmChat, llmDiagnose, llmEnabled } from "@/lib/providers/llm";

export interface SitePrompt {
  /** The question a real buyer would type. */
  question: string;
  /** Why it was chosen — shown so nobody has to guess at the prompt set. */
  rationale: string;
}

export interface EngineAnswer {
  question: string;
  answer: string;
  /** Did the model name this brand at all? */
  mentionsBrand: boolean;
  /** Domains it named instead, in order of appearance. */
  namedDomains: string[];
  /** Brand-like names it mentioned, whether or not they have a domain in the text. */
  namedBrands: string[];
}

export interface Competitor {
  name: string;
  domain: string | null;
  /** How many of our prompts named it. The whole point: frequency, not a single reply. */
  mentions: number;
}

export interface MarketRead {
  enabled: boolean;
  brand: string;
  prompts: SitePrompt[];
  answers: EngineAnswer[];
  competitors: Competitor[];
  /** Share of prompts where the brand appeared. */
  mentionRate: number;
  /** The model's own read of demand. Explicitly an estimate, never presented as measured. */
  demand: DemandRead | null;
  note?: string;
}

export interface DemandRead {
  summary: string;
  /** Coarse band — a model cannot know real search volume, and a precise number would be a lie. */
  band: "niche" | "emerging" | "established" | "mainstream" | "unknown";
  drivers: string[];
  caveat: string;
}

function jsonFrom(text: string): any | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function domainsIn(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const d = m[1].toLowerCase().replace(/^www\./, "");
    // Strip the obvious non-answers: file extensions and the usual aggregators.
    if (/\.(png|jpe?g|svg|webp|gif|css|js|json|xml|txt|pdf)$/.test(d)) continue;
    if (/^(github|google|wikipedia|reddit|youtube|twitter|x|linkedin|facebook|medium|substack)\.com$/.test(d)) continue;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** Write the question set from what the page actually says, not from the domain name. */
export async function buildPrompts(opts: {
  brand: string;
  title: string;
  description: string;
  bodyExcerpt: string;
}): Promise<SitePrompt[]> {
  const fallback: SitePrompt[] = [
    { question: `What is ${opts.brand}?`, rationale: "Direct brand recall — does the model know it exists at all." },
    { question: `Best alternatives to ${opts.brand}`, rationale: "Surfaces the competitive set the model places it in." },
    { question: `Is ${opts.brand} any good?`, rationale: "Sentiment and whether it has enough presence to be judged." },
  ];
  if (!llmEnabled()) return fallback;

  const res = await llmChat({
    system:
      "You write evaluation prompts for measuring whether AI assistants know a product. " +
      "Return STRICT JSON only, no prose.",
    prompt:
      `A site describes itself as follows.\n\nBRAND: ${opts.brand}\nTITLE: ${opts.title}\n` +
      `DESCRIPTION: ${opts.description}\nPAGE TEXT (excerpt): ${opts.bodyExcerpt.slice(0, 2500)}\n\n` +
      "Write 5 questions a potential BUYER would genuinely type into ChatGPT while shopping for " +
      "this kind of product. At most one may name the brand — the rest must be category or " +
      "problem questions where this brand SHOULD come up if the model knows it. That is the test: " +
      "whether it gets named unprompted.\n\n" +
      'Return {"prompts":[{"question":"...","rationale":"..."}]}',
    maxTokens: 1200,
    timeoutMs: 45_000,
  });

  const parsed = jsonFrom(res?.content ?? "");
  const list = Array.isArray(parsed?.prompts) ? parsed.prompts : [];
  const cleaned = list
    .filter((p: any) => typeof p?.question === "string" && p.question.trim())
    .slice(0, 5)
    .map((p: any) => ({
      question: String(p.question).trim(),
      rationale: String(p.rationale ?? "").trim() || "Category question — the brand should surface unprompted.",
    }));
  return cleaned.length ? cleaned : fallback;
}

async function ask(question: string, brand: string): Promise<EngineAnswer | null> {
  const res = await llmChat({
    prompt:
      `${question}\n\nAnswer as you normally would for someone researching this. Name specific ` +
      "products and their websites where you can. If you are not aware of a product, do not invent one.",
    maxTokens: 900,
    timeoutMs: 45_000,
  });
  if (!res?.content) return null;

  const text = res.content;
  const hay = text.toLowerCase();
  const needle = brand.toLowerCase();
  return {
    question,
    answer: text,
    mentionsBrand: needle.length > 2 && hay.includes(needle),
    namedDomains: [...domainsIn(text), ...res.citations.flatMap((c) => domainsIn(c))].slice(0, 12),
    namedBrands: [],
  };
}

/** Rank the alternatives the model named across the whole prompt set. */
function tally(answers: EngineAnswer[], ownDomain: string): Competitor[] {
  const counts = new Map<string, number>();
  for (const a of answers) {
    for (const d of new Set(a.namedDomains)) {
      if (d === ownDomain || d.endsWith(`.${ownDomain}`)) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([domain, mentions]) => ({ name: domain.replace(/\.[a-z.]+$/, ""), domain, mentions }));
}

async function readDemand(brand: string, category: string): Promise<DemandRead | null> {
  if (!llmEnabled()) return null;
  const res = await llmChat({
    system: "You are a market analyst. Return STRICT JSON only, no prose.",
    prompt:
      `Category: ${category}\nBrand: ${brand}\n\n` +
      "Characterise search demand for this category. You cannot know real search volume, so do " +
      "NOT output a number — pick a band and justify it.\n\n" +
      '{"band":"niche|emerging|established|mainstream|unknown","summary":"2 sentences",' +
      '"drivers":["what moves demand"],"caveat":"what would make this read wrong"}',
    maxTokens: 900,
    timeoutMs: 45_000,
  });
  const p = jsonFrom(res?.content ?? "");
  if (!p) return null;
  const band = ["niche", "emerging", "established", "mainstream", "unknown"].includes(p.band) ? p.band : "unknown";
  return {
    band,
    summary: String(p.summary ?? "").trim(),
    drivers: Array.isArray(p.drivers) ? p.drivers.map(String).slice(0, 5) : [],
    caveat: String(p.caveat ?? "").trim() || "A model's read of demand is an opinion, not a measurement.",
  };
}

export async function readMarket(opts: {
  brand: string;
  domain: string;
  title: string;
  description: string;
  bodyExcerpt: string;
}): Promise<MarketRead> {
  const base: MarketRead = {
    enabled: false, brand: opts.brand, prompts: [], answers: [], competitors: [],
    mentionRate: 0, demand: null,
  };
  if (!llmEnabled()) {
    return { ...base, note: "No model key configured — set OPENROUTER_API_KEY or ANTHROPIC_API_KEY to run the market read." };
  }

  const prompts = await buildPrompts(opts);
  // Sequential on purpose: a burst of five is what trips provider rate limits, and this runs
  // inside one request budget where a 429 costs more than the extra seconds.
  const answers: EngineAnswer[] = [];
  for (const p of prompts) {
    const a = await ask(p.question, opts.brand);
    if (a) answers.push(a);
  }

  // A key can be present and still be dead. If every call came back empty, say why rather than
  // rendering an empty panel that looks like "the model had no opinion".
  if (!answers.length) {
    const diag = await llmDiagnose();
    return {
      ...base,
      prompts,
      note: diag.ok
        ? "A key is configured and reachable, but every prompt came back empty."
        : `The market read could not run. ${diag.reason}`,
    };
  }

  const category = opts.title || opts.description || opts.brand;
  const demand = await readDemand(opts.brand, category);

  return {
    enabled: true,
    brand: opts.brand,
    prompts,
    answers,
    competitors: tally(answers, opts.domain),
    mentionRate: answers.length ? answers.filter((a) => a.mentionsBrand).length / answers.length : 0,
    demand,
  };
}
