// Share of voice across answer engines.
//
// The question this answers: when a buyer asks an assistant about this category, how often does
// the answer name US versus each competitor? That is a share, not a score — it only means
// something relative to the other names in the same answer.
//
// Three rules the maths follows, because getting any of them wrong produces a confident lie:
//   1. An engine that failed is EXCLUDED, never counted as a non-mention. A dead key would
//      otherwise read as a collapse in visibility.
//   2. A brand is counted once per answer, not once per occurrence. Otherwise whoever is described
//      at greatest length wins, which measures verbosity rather than preference.
//   3. The prompt set is fixed and dated, so two runs are comparable. One reply is not a trend.
import PQueue from "p-queue";

import { llmChat, llmEnabled } from "@/lib/providers/llm";

import { isGenericName } from "./generic-words";

import { ask, ENGINES, engineLabel, engineStatus, type EngineId, type EngineStatus } from "./engines";

export interface SyntheticPrompt {
  question: string;
  /** What buying stage this question belongs to — a set skewed to one intent measures one thing. */
  intent: "discovery" | "comparison" | "evaluation" | "problem";
}

export interface BrandRef {
  name: string;
  /** Null for a brand the model named without a URL. */
  domain: string | null;
  /** True for the site being audited. */
  isUs: boolean;
}

export interface PromptRun {
  question: string;
  intent: SyntheticPrompt["intent"];
  engine: EngineId;
  /** Brand names found in this one answer, deduplicated. */
  mentioned: string[];
  excerpt: string;
}

export interface BrandShare {
  brand: string;
  domain: string | null;
  isUs: boolean;
  /** Answers naming this brand, out of all successful answers. */
  mentions: number;
  share: number;
  /** Per engine, so a brand strong in one and absent from another is visible. */
  byEngine: Record<string, number>;
}

export interface ShareOfVoice {
  ran: boolean;
  prompts: SyntheticPrompt[];
  enginesUsed: EngineId[];
  engineStatuses: EngineStatus[];
  runs: PromptRun[];
  /** Successful answers, the denominator for every share below. */
  answersCounted: number;
  brands: BrandShare[];
  ourShare: number;
  note?: string;
}

function jsonFrom(text: string): any | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a === -1 || b === -1) return null;
  try {
    return JSON.parse(body.slice(a, b + 1));
  } catch {
    return null;
  }
}

/**
 * Write the question set.
 *
 * Synthetic on purpose: real query logs describe who already finds you, which is the wrong
 * denominator for a visibility measurement. These are the questions a buyer who has never heard
 * of you would ask, spread across intents so the number is not an artifact of one phrasing.
 */
export async function synthesizePrompts(opts: {
  brand: string;
  category: string;
  bodyExcerpt: string;
  count?: number;
}): Promise<SyntheticPrompt[]> {
  const n = opts.count ?? 8;
  const fallback: SyntheticPrompt[] = [
    { question: `What are the best ${opts.category} tools?`, intent: "discovery" },
    { question: `Best alternatives to ${opts.brand}`, intent: "comparison" },
    { question: `How do I choose a ${opts.category} provider?`, intent: "evaluation" },
    { question: `What should I use for ${opts.category}?`, intent: "problem" },
  ];
  if (!llmEnabled()) return fallback;

  const res = await llmChat({
    system: "You design market-research prompt sets. Return STRICT JSON only, no prose.",
    prompt:
      `CATEGORY: ${opts.category}\nA site in this category describes itself as: ` +
      `${opts.bodyExcerpt.slice(0, 2000)}\n\n` +
      `Write ${n} questions a prospective buyer would type into an AI assistant while researching ` +
      "this category. CRITICAL: do NOT name any specific brand, including the one described above — " +
      "the measurement is which brands the assistant volunteers on its own. Spread them across " +
      "intents: discovery (what exists), comparison (x vs y in general terms), evaluation (how to " +
      "choose), problem (I need to accomplish X).\n\n" +
      '{"prompts":[{"question":"...","intent":"discovery|comparison|evaluation|problem"}]}',
    maxTokens: 1500,
    timeoutMs: 45_000,
  });

  const parsed = jsonFrom(res?.content ?? "");
  const list = Array.isArray(parsed?.prompts) ? parsed.prompts : [];
  const valid = new Set(["discovery", "comparison", "evaluation", "problem"]);
  const cleaned: SyntheticPrompt[] = list
    .filter((p: any) => typeof p?.question === "string" && p.question.trim())
    .slice(0, n)
    .map((p: any) => ({
      question: String(p.question).trim(),
      intent: valid.has(p.intent) ? p.intent : "discovery",
    }));
  return cleaned.length ? cleaned : fallback;
}

/** Does this answer name the brand? Matches the name or its domain, word-bounded. */
function namesBrand(answer: string, brand: BrandRef): boolean {
  const hay = answer.toLowerCase();
  if (brand.domain && hay.includes(brand.domain.toLowerCase())) return true;
  const name = brand.name.toLowerCase().trim();
  if (name.length < 3) return false;
  // A name that is also an ordinary word cannot be matched as prose — "English" would score a
  // mention in any answer that happens to discuss language. Its domain is the only safe signal,
  // and that was already checked above.
  if (isGenericName(name)) return false;
  // Word boundaries, so "Ada" does not match "Adapter".
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(hay);
}

export async function measureShareOfVoice(opts: {
  brand: string;
  domain: string;
  category: string;
  bodyExcerpt: string;
  /** Competitors discovered earlier, so the same names are tracked across every prompt. */
  competitors: { name: string; domain: string | null }[];
  promptCount?: number;
}): Promise<ShareOfVoice> {
  const statuses = engineStatus();
  const usable = statuses.filter((s) => s.available).map((s) => s.engine);

  const empty: ShareOfVoice = {
    ran: false, prompts: [], enginesUsed: [], engineStatuses: statuses, runs: [],
    answersCounted: 0, brands: [], ourShare: 0,
  };

  if (!usable.length) {
    return { ...empty, note: "No answer engine is configured. " + statuses.map((s) => s.reason).filter(Boolean).join(" ") };
  }

  const prompts = await synthesizePrompts({
    brand: opts.brand,
    category: opts.category,
    bodyExcerpt: opts.bodyExcerpt,
    count: opts.promptCount ?? 5,
  });

  const tracked: BrandRef[] = [
    { name: opts.brand, domain: opts.domain, isUs: true },
    ...opts.competitors.slice(0, 8).map((c) => ({ name: c.name, domain: c.domain, isUs: false })),
  ];

  // Every prompt against every engine. Sequential per engine, engines in parallel: the providers
  // rate-limit per key, and a burst across one key is what trips them.
  const runs: PromptRun[] = [];
  let failures = 0;

  // Every (engine, prompt) pair is independent, so they all go at once behind one bound. Fully
  // sequential took minutes; unbounded trips provider rate limits, which would show up as engine
  // failures and quietly shrink the denominator.
  const queue = new PQueue({ concurrency: 6 });
  await Promise.all(
    usable.flatMap((engine) =>
      prompts.map((p) =>
        queue.add(async () => {
          const reply = await ask(engine, p.question);
          if (!reply) {
            failures++;
            return; // Rule 1: a failed call is excluded, never a zero.
          }
          const haystack = `${reply.content}\n${reply.citations.join("\n")}`;
          runs.push({
            question: p.question,
            intent: p.intent,
            engine,
            // Rule 2: once per answer, not once per occurrence.
            mentioned: tracked.filter((b) => namesBrand(haystack, b)).map((b) => b.name),
            excerpt: reply.content.slice(0, 320),
          });
        }),
      ),
    ),
  );

  if (!runs.length) {
    return {
      ...empty,
      prompts,
      note: `Every engine call failed (${failures} attempts). The keys are present but were rejected — check them before reading anything into an empty result.`,
    };
  }

  const answersCounted = runs.length;
  const enginesUsed = [...new Set(runs.map((r) => r.engine))];

  const brands: BrandShare[] = tracked
    .map((b) => {
      const hits = runs.filter((r) => r.mentioned.includes(b.name));
      const byEngine: Record<string, number> = {};
      for (const e of enginesUsed) {
        const forEngine = runs.filter((r) => r.engine === e);
        byEngine[e] = forEngine.length ? hits.filter((h) => h.engine === e).length / forEngine.length : 0;
      }
      return {
        brand: b.name,
        domain: b.domain,
        isUs: b.isUs,
        mentions: hits.length,
        share: hits.length / answersCounted,
        byEngine,
      };
    })
    .sort((a, b) => b.share - a.share);

  return {
    ran: true,
    prompts,
    enginesUsed,
    engineStatuses: statuses,
    runs,
    answersCounted,
    brands,
    ourShare: brands.find((b) => b.isUs)?.share ?? 0,
    note: failures ? `${failures} engine call(s) failed and were excluded from the denominator.` : undefined,
  };
}

export { engineLabel, ENGINES };
