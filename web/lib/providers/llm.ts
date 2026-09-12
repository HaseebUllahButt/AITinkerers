// Shared OpenRouter chat helper for the SEO agents. Every caller is pinned to DeepSeek below;
// model arguments remain accepted only so legacy call sites do not need a mechanical rewrite.
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
export const DEEPSEEK_MODEL = "deepseek/deepseek-v4.1-flash";

/** The only model this helper is allowed to call. */
export const DEFAULT_LLM_MODEL = DEEPSEEK_MODEL;

/**
 * Anthropic's current frontier family REMOVED the sampling parameters: a non-default
 * `temperature`/`top_p`/`top_k` is a 400, not a warning. Haiku 4.5 (the previous default here)
 * still accepts them, which is why this file could always send `temperature: 0.2` and be fine.
 *
 * That makes the model swap a silent-failure trap rather than a loud one: llmChat returns null on
 * any non-2xx, and all ~20 call sites treat null as "degrade to the heuristic path". A 400 on every
 * request would therefore look exactly like "the LLM had nothing to add" — no error, no log, ~20
 * features quietly falling back forever. Hence: only send sampling params to models that take them.
 */
function acceptsSamplingParams(model: string): boolean {
  const m = model.toLowerCase();
  const frontier = ["opus-5", "opus-4-8", "opus-4-7", "opus-4-6", "sonnet-5", "sonnet-4-6", "fable-5", "mythos-5"];
  return !frontier.some((f) => m.includes(f));
}

/**
 * The second half of the same trap. `max_tokens` bounds thinking AND the answer together on a
 * reasoning model, so the old 400-token default — sized for a one-line Haiku classification —
 * gets consumed by thinking and returns an empty or truncated string. Also silent: `content`
 * comes back as "", which most callers read as "no opinion".
 *
 * An explicit `maxTokens` is honoured as-is on sampling-capable models — the caller knows its own
 * output shape. On a frontier model it is treated as a FLOOR, not a ceiling, because the number was
 * almost always chosen against Haiku: values like 40 or 60 are smaller than the thinking that now
 * precedes the answer, so honouring them literally returns "" on every call. Raising the floor here
 * fixes ~6 existing call sites (pageQuality 40, authorScoring 60, internalLinks 60×2,
 * backlinks/pipeline 140, contentRefresh 700) and every future one, rather than relying on each
 * author to remember. A caller that genuinely wants a hard cap on a reasoning model should say so
 * by pinning a sampling-capable model.
 */
const FRONTIER_MIN_OUTPUT = 4000;

function outputBudget(model: string, requested?: number): number {
  if (acceptsSamplingParams(model)) return requested ?? 400;
  return Math.max(requested ?? 0, FRONTIER_MIN_OUTPUT);
}

/**
 * Same floor logic for the request timeout, with one deliberate escape hatch.
 *
 * `hardTimeout: true` means "I would rather lose this answer than overrun" — for sequential loops
 * inside a bounded serverless budget. `aiLocateFinding` runs up to 30 times per audit and
 * `aiExtractAuthor` once per blog page; at a 90s ceiling those loops can outlive the function
 * itself (30 × 90s = 45 min against a 210s chunk budget), turning a cosmetic enrichment into an
 * outage. Those call sites pass a small explicit timeout AND `hardTimeout`, and accept that a slow
 * turn degrades to the existing null fallback.
 */
const FRONTIER_MIN_TIMEOUT_MS = 90_000;

function timeoutFor(model: string, requested?: number, hard?: boolean): number {
  if (requested != null && hard) return requested;
  if (acceptsSamplingParams(model)) return requested ?? 20_000;
  return Math.max(requested ?? 0, FRONTIER_MIN_TIMEOUT_MS);
}

export function llmEnabled(): boolean {
  const k = process.env.OPENROUTER_API_KEY;
  return !!k && k.length > 20;
}

/**
 * Why the last call failed, in words.
 *
 * llmChat returns null for every failure — a dead key, a bad model id and "the model had nothing
 * to say" are indistinguishable to a caller. That ambiguity is what let ~20 features degrade
 * silently for days (see the note above). This makes one small real call and reports what actually
 * came back, so a feature can tell a person WHY its panel is empty instead of showing nothing.
 */
export async function llmDiagnose(): Promise<{ ok: boolean; reason: string }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (key && key.length > 20) {
    try {
      const res = await fetch(OPENROUTER, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_LLM_MODEL, messages: [{ role: "user", content: "ok" }], max_tokens: 16 }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return { ok: true, reason: "" };
      const body = (await res.text()).slice(0, 200);
      if (res.status === 401) return { ok: false, reason: `OpenRouter rejected the key (401). ${body}` };
      return { ok: false, reason: `OpenRouter returned HTTP ${res.status}. ${body}` };
    } catch (e) {
      return { ok: false, reason: `OpenRouter request failed: ${e instanceof Error ? e.message : "unknown error"}` };
    }
  }
  return { ok: false, reason: "OPENROUTER_API_KEY is not set." };
}

export interface LlmResult {
  content: string;
  citations: string[];
}

export async function llmChat(opts: {
  model?: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Treat `timeoutMs` as an absolute ceiling instead of a floor. For sequential loops inside a
   *  bounded serverless budget, where overrunning is worse than losing the answer. */
  hardTimeout?: boolean;
}): Promise<LlmResult | null> {
  const key = process.env.OPENROUTER_API_KEY;
  // All callers are intentionally pinned here. A feature cannot select a more expensive model by
  // passing `opts.model`; the option remains in the public shape for compatibility with old code.
  const model = DEEPSEEK_MODEL;
  if (!key || key.length < 20) return null;
  try {
    const messages = [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: opts.prompt },
    ];
    const res = await fetch(OPENROUTER, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: outputBudget(model, opts.maxTokens),
        // Omitted entirely on the frontier models — sending it at all is a 400. An explicit
        // temperature from a caller is still dropped for those models rather than honoured,
        // because a 400 loses the whole response and determinism is not worth that trade.
        ...(acceptsSamplingParams(model) ? { temperature: opts.temperature ?? 0.2 } : {}),
      }),
      // Third instance of the same trap: a 20s ceiling was right for Haiku, but an Opus turn that
      // thinks first routinely runs longer. An abort lands in the catch below and also returns
      // null, so an under-sized timeout is indistinguishable from "the model declined to answer".
      //
      // Floored rather than defaulted, for the same reason as the output budget — existing callers
      // passing 5s/12s/20s picked those against Haiku. The floor is deliberately NOT applied when a
      // caller opts out via `hardTimeout`: a few hot loops call this sequentially dozens of times
      // inside a bounded serverless budget, where a long ceiling stalls the whole chunk. Those sites
      // must be able to trade a lost answer for a bounded runtime.
      signal: AbortSignal.timeout(timeoutFor(model, opts.timeoutMs, opts.hardTimeout)),
    });
    // Any non-2xx — the 402 credit wall above all — falls through to Anthropic rather than
    // silently degrading twenty features at once. Timeouts/aborts land in the catch below and
    // stay null: their time budget is already spent, a second slow call would double it.
    if (!res.ok) return null;
    const data: any = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    const content: string = msg.content ?? "";
    // Citations arrive in one of a few shapes depending on the model/provider:
    //  - OpenAI-style annotations: message.annotations[].url_citation.url  (Perplexity via OpenRouter today)
    //  - a top-level `citations` string[]  (older Perplexity)
    //  - per-choice `citations`
    const fromAnnotations: string[] = Array.isArray(msg.annotations)
      ? msg.annotations.map((a: any) => a?.url_citation?.url ?? a?.url).filter(Boolean)
      : [];
    const fromTopLevel: string[] = Array.isArray(data.citations) ? data.citations : [];
    const fromChoice: string[] = Array.isArray(data.choices?.[0]?.citations) ? data.choices[0].citations : [];
    const citations: string[] = [...fromAnnotations, ...fromTopLevel, ...fromChoice].filter(
      (u: unknown): u is string => typeof u === "string" && u.startsWith("http"),
    );
    return { content, citations };
  } catch {
    return null;
  }
}
