// The answer engines, behind one call.
//
// Share of voice only means something if the same question goes to several engines — they are
// trained and retrieved differently, and a brand can be strong in one and absent from another.
// Reporting a single blended number hides exactly the difference worth acting on.
//
// Every adapter returns null rather than throwing, and every failure is recorded with a reason:
// an engine that could not be reached must never be scored as "did not mention us", which would
// silently read as a visibility problem when it is a configuration problem.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type EngineId = "claude" | "chatgpt" | "perplexity" | "gemini";

export interface Engine {
  id: EngineId;
  label: string;
  /** Does it search the live web, or answer from training data? The two measure different things. */
  retrieval: boolean;
}

export const ENGINES: Engine[] = [
  { id: "claude", label: "Claude", retrieval: false },
  { id: "chatgpt", label: "ChatGPT", retrieval: true },
  { id: "perplexity", label: "Perplexity", retrieval: true },
  { id: "gemini", label: "Gemini", retrieval: false },
];

export interface EngineReply {
  engine: EngineId;
  content: string;
  citations: string[];
}

export interface EngineStatus {
  engine: EngineId;
  available: boolean;
  /** Why it is unavailable, in words, so an empty column is never mistaken for a zero. */
  reason: string;
}

const TIMEOUT = 45_000;

// ── Claude, direct ────────────────────────────────────────────────────────────
let _anthropic: Anthropic | null | undefined;
function anthropic(): Anthropic | null {
  if (_anthropic !== undefined) return _anthropic;
  const k = process.env.ANTHROPIC_API_KEY;
  _anthropic = k && k.length > 20 ? new Anthropic({ apiKey: k }) : null;
  return _anthropic;
}

async function askClaude(prompt: string): Promise<EngineReply | null> {
  // Direct first when a key is present — one less hop, and it is the canonical endpoint.
  const client = anthropic();
  if (client) {
    try {
      // No temperature: the current frontier models reject sampling parameters outright.
      const res = await client.messages.create(
        { model: "claude-opus-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] },
        { timeout: TIMEOUT },
      );
      const content = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      if (content) return { engine: "claude", content, citations: [] };
    } catch {
      // Fall through. A dead or revoked ANTHROPIC_API_KEY should not remove Claude from the
      // measurement when OpenRouter can serve the same model — losing an engine silently is
      // exactly what makes a share-of-voice number wrong rather than merely incomplete.
    }
  }
  // A reasoning model thinks before it writes, and that thinking counts against both the token
  // budget and the clock. 45s is ample for a chat model and not for this one — under concurrency
  // it was aborting every call, which the tally then read as "Claude declined to answer".
  return askOpenRouter("claude", "anthropic/claude-opus-5", prompt, 8000, 120_000);
}

// ── ChatGPT, with web search on ───────────────────────────────────────────────
let _openai: OpenAI | null | undefined;
function openai(): OpenAI | null {
  if (_openai !== undefined) return _openai;
  const k = process.env.OPENAI_API_KEY;
  _openai = k && k.length > 20 ? new OpenAI({ apiKey: k }) : null;
  return _openai;
}

async function askChatGpt(prompt: string): Promise<EngineReply | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.length < 20) return null;
  try {
    // The search-preview models browse and return url_citation annotations, which is what makes
    // this a retrieval measurement rather than a recall one. They reject `temperature`.
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini-search-preview",
        messages: [{ role: "user", content: prompt }],
        web_search_options: {},
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    const content: string = msg.content ?? "";
    if (!content) return null;
    const citations: string[] = Array.isArray(msg.annotations)
      ? msg.annotations
          .map((a: any) => a?.url_citation?.url ?? a?.url)
          .filter((u: unknown): u is string => typeof u === "string" && u.startsWith("http"))
      : [];
    return { engine: "chatgpt", content, citations };
  } catch {
    return null;
  }
}

// ── Perplexity and Gemini, through OpenRouter ────────────────────────────────
// maxTokens is per-model on purpose. On a reasoning model the budget covers thinking AND the
// answer, so a figure sized for a chat model is spent before a single visible word is produced —
// the call returns 200 with empty content and looks exactly like "the engine had nothing to say".
async function askOpenRouter(
  engine: EngineId,
  model: string,
  prompt: string,
  maxTokens = 1200,
  timeoutMs = TIMEOUT,
): Promise<EngineReply | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key.length < 20) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const content: string = data.choices?.[0]?.message?.content ?? "";
    if (!content) return null;
    // Sonar models return the URLs they retrieved from.
    const citations: string[] = Array.isArray(data.citations) ? data.citations.filter((c: unknown) => typeof c === "string") : [];
    return { engine, content, citations };
  } catch {
    return null;
  }
}

export async function ask(engine: EngineId, prompt: string): Promise<EngineReply | null> {
  switch (engine) {
    case "claude": return askClaude(prompt);
    case "chatgpt": return askChatGpt(prompt);
    case "perplexity": return askOpenRouter("perplexity", "perplexity/sonar", prompt);
    case "gemini": return askOpenRouter("gemini", "google/gemini-2.5-flash", prompt);
  }
}

/** Which engines can actually answer right now, and why the others cannot. */
export function engineStatus(): EngineStatus[] {
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 20);
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 20);
  const hasRouter = Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.length > 20);
  return [
    {
      engine: "claude",
      available: hasAnthropic || hasRouter,
      reason: hasAnthropic || hasRouter ? "" : "Neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY is set.",
    },
    { engine: "chatgpt", available: hasOpenAi, reason: hasOpenAi ? "" : "OPENAI_API_KEY is not set." },
    { engine: "perplexity", available: hasRouter, reason: hasRouter ? "" : "OPENROUTER_API_KEY is not set." },
    { engine: "gemini", available: hasRouter, reason: hasRouter ? "" : "OPENROUTER_API_KEY is not set." },
  ];
}

export function engineLabel(id: EngineId): string {
  return ENGINES.find((e) => e.id === id)?.label ?? id;
}
