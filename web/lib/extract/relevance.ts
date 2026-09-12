// GenAI relevance scoring. scoreArticleRelevance() returns { relevant, score } where score is 0-100.
// Fails open on any API error so we never silently drop content.

import { llmChat, llmEnabled } from "@/lib/providers/llm";

const STRONG_SIGNALS = [
  "midjourney", "dall-e", "dalle", "stable diffusion", "chatgpt", "claude ai", "gemini",
  "openai", "anthropic", "llm", "generative ai", "gen ai", "genai", "ai art", "ai image",
  "text-to-image", "text to image", "diffusion model", "sora", "runway ml", "ideogram",
  "flux model", "ai video", "ai music", "ai writing", "udio", "suno", "pika labs",
  "leonardo ai", "adobe firefly", "gpt-4", "gpt4", "ai tool", "ai tools",
  "imagine.art", "imagineart", "kling ai", "luma ai", "heygen", "invideo",
];

const OFF_TOPIC = [
  "cryptocurrency", "bitcoin", "ethereum", "forex", "real estate listing",
  "recipe", "cooking tutorial", "fitness routine", "travel itinerary",
];

export interface RelevanceResult {
  relevant: boolean;
  score: number; // 0-100
}

export async function scoreArticleRelevance(title: string, snippet: string, abortSignal?: AbortSignal): Promise<RelevanceResult> {
  const combined = `${title} ${snippet}`.toLowerCase();

  // Hard off-topic: skip before any API call
  if (OFF_TOPIC.some((s) => combined.includes(s))) return { relevant: false, score: 0 };

  // No usable model at all — fall back to the keyword heuristic.
  //
  // This tested OPENROUTER_API_KEY directly, which is narrower than the truth: llmChat also serves
  // anthropic/* models straight from the direct-Anthropic fallback, so a deploy holding only
  // ANTHROPIC_API_KEY skipped the model entirely here and scored every article by keyword match.
  // llmEnabled() is the honest test of "can anything answer".
  if (!llmEnabled()) {
    const hits = STRONG_SIGNALS.filter((s) => combined.includes(s)).length;
    const score = Math.min(100, hits * 25 + 10);
    return { relevant: hits > 0, score };
  }

  // llmChat takes no external AbortSignal, so a run cancelled mid-request is no longer torn down
  // in flight — the caller re-checks abortSignal right after we return, so the outcome is the same,
  // just later. Cheap pre-check keeps the already-cancelled case exactly as fast as it was, and
  // returns the same value the old aborted fetch produced via the catch below.
  if (abortSignal?.aborted) return { relevant: true, score: 25 };

  try {
    const res = await llmChat({
      // No model pin: inherit DEFAULT_LLM_MODEL so there is one source of truth.
      // No temperature: this used to be 0, but the frontier models 400 on any sampling param, and a
      // 400 here costs the whole response. Per-article scoring is no longer deterministic — that is
      // the accepted trade, do not "restore" temperature.
      // No maxTokens: the old cap was 20, sized for Haiku emitting the one-line RELEVANT=/SCORE=
      // reply. On a reasoning model that budget bounds thinking too, so it returns empty and every
      // article silently falls through to the default score of 30. Let the helper pick the frontier
      // budget; the reply we parse is still one line.
      // No timeoutMs: 5s was a Haiku-speed ceiling. An Opus turn that thinks first blows past it,
      // and an abort is indistinguishable from "the model had no opinion".
      prompt: `You are scoring articles for a generative AI editorial outreach tool.

Rate this article on two things:
1. RELEVANT (yes/no): Is it a human-written editorial article specifically covering generative AI tools (image generators, text-to-video, LLMs, AI art tools, AI writing assistants, etc.)? NOT product pages, NOT general tech news unrelated to genAI.
2. SCORE (0-100): How valuable is this author for genAI editorial outreach? Consider: covers genAI tools in depth (listicles/reviews/comparisons score higher), writes regularly, genuine editorial voice.

Title: ${title.slice(0, 150)}
Excerpt: ${snippet.slice(0, 400)}

Reply in this exact format only: RELEVANT=YES SCORE=75
Replace YES with NO and adjust score accordingly if not relevant.`,
    });

    if (!res) {
      // Fallback to keyword heuristic on API error. llmChat collapses non-2xx and network/timeout
      // into a single null, so this branch now also absorbs what used to hit the catch below —
      // both failed open anyway, and the keyword score is strictly better informed than a flat 25.
      const hits = STRONG_SIGNALS.filter((s) => combined.includes(s)).length;
      return { relevant: hits > 0 || true, score: Math.min(100, hits * 20 + 15) };
    }

    const text = (res.content ?? "").trim();

    const relMatch = text.match(/RELEVANT=(YES|NO)/i);
    const scoreMatch = text.match(/SCORE=(\d+)/i);

    const relevant = relMatch ? relMatch[1].toUpperCase() === "YES" : true;
    const score = scoreMatch ? Math.min(100, Math.max(0, parseInt(scoreMatch[1], 10))) : 30;

    return { relevant, score };
  } catch {
    // llmChat swallows network/timeout itself and returns null, so this is now only a belt-and-
    // braces guard against a throw from the parsing below. Kept so the function can never reject
    // on a caller that has no try/catch of its own — fail open with a mid-range score.
    return { relevant: true, score: 25 };
  }
}
