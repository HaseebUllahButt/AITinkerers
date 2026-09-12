// Ask the AI answer engines a question and read back what they cited.
//
// This is the reusable half of what used to be the GEO Growth Agent: the per-engine callers
// (Perplexity via OpenRouter, ChatGPT, Gemini, Google AI Overview via Serper) and the availability
// resolver. The agent's report builder went with the feature; backlink prospecting kept the engines,
// because "which domains does an answer engine cite for this question" is a prospect list.
import PQueue from "p-queue";

import { llmChat, llmEnabled } from "@/lib/providers/llm";
/** The AI answer engines we fan out to. Inlined when the Growth Agents' types module went with the
 *  feature — this is the only member of it anything still needs. */
export type GeoEngineId = "perplexity" | "chatgpt" | "gemini" | "google_aio";
import { meteredKey } from "@/lib/providers/policy";



const BRAND_ALIASES = ["imagineart", "imagine.art", "imagine art"];
// Hosts you can't realistically earn an editorial mention on — excluded from actionable gaps.
const NON_EDITORIAL = /(^|\.)(youtube|twitter|x|facebook|instagram|pinterest|tiktok|linkedin|reddit|quora|google|apple)\.com$/i;

function mentions(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}
function domainOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export interface EngineAnswer { content: string; citations: string[]; surface?: string }

// ── Engine adapters ─────────────────────────────────────────────────────────────
// Each returns the answer text + cited URLs, or null when the engine gave no usable answer.

async function askPerplexity(prompt: string, model: string): Promise<EngineAnswer | null> {
  const res = await llmChat({ model, prompt, maxTokens: 600, temperature: 0.2, timeoutMs: 30_000 });
  if (!res || !res.content) return null;
  return { content: res.content, citations: res.citations };
}

async function askChatGpt(prompt: string): Promise<EngineAnswer | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.length < 20) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      // Search-preview models browse the web and return url_citation annotations. They don't
      // accept a temperature param, so we omit it.
      body: JSON.stringify({
        model: "gpt-4o-mini-search-preview",
        messages: [{ role: "user", content: prompt }],
        web_search_options: {},
        max_tokens: 700,
      }),
      signal: AbortSignal.timeout(35_000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    const content: string = msg.content ?? "";
    if (!content) return null;
    const citations: string[] = Array.isArray(msg.annotations)
      ? msg.annotations.map((a: any) => a?.url_citation?.url ?? a?.url).filter((u: unknown): u is string => typeof u === "string" && u.startsWith("http"))
      : [];
    return { content, citations };
  } catch {
    return null;
  }
}

async function askGemini(prompt: string): Promise<EngineAnswer | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.length < 20) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
        }),
        signal: AbortSignal.timeout(35_000),
      },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const cand = data.candidates?.[0];
    const content: string = (cand?.content?.parts ?? []).map((p: any) => p?.text).filter(Boolean).join(" ");
    if (!content) return null;
    // Grounding chunks carry the real source domain in web.title; web.uri is a Google redirect,
    // so prefer the title when it's domain-shaped.
    const chunks: any[] = cand?.groundingMetadata?.groundingChunks ?? [];
    const citations: string[] = chunks
      .map((c) => {
        const title = (c?.web?.title ?? "").trim();
        if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title)) return `https://${title}`;
        return typeof c?.web?.uri === "string" ? c.web.uri : "";
      })
      .filter(Boolean);
    return { content, citations };
  } catch {
    return null;
  }
}

// Google's AI Overview when present, else the featured snippet (answerBox) — both are Google's
// own algorithmic answer surface. Returns null when neither is shown (we don't invent one from
// plain organic results).
async function askGoogleAio(prompt: string): Promise<EngineAnswer | null> {
  const key = meteredKey(process.env.SERPER_API_KEY);
  if (!key || key.length < 10) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: prompt, gl: "us", hl: "en" }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const aio = data.aiOverview;
    if (aio && (aio.snippet || aio.text || Array.isArray(aio.textBlocks))) {
      const text: string = aio.snippet || aio.text ||
        (Array.isArray(aio.textBlocks) ? aio.textBlocks.map((b: any) => b?.snippet ?? "").join(" ") : "");
      const refs: string[] = Array.isArray(aio.references)
        ? aio.references.map((r: any) => r?.link ?? r?.url).filter((u: unknown): u is string => typeof u === "string" && u.startsWith("http"))
        : [];
      if (text) return { content: text, citations: refs, surface: "AI Overview" };
    }
    const box = data.answerBox;
    if (box && (box.snippet || box.answer)) {
      const text: string = box.answer || box.snippet || "";
      const link: string | undefined = box.link || box.source;
      return { content: text, citations: link && link.startsWith("http") ? [link] : [], surface: "featured snippet" };
    }
    return null; // Google showed no AI Overview or featured snippet for this query.
  } catch {
    return null;
  }
}

export interface EngineDef {
  id: GeoEngineId;
  label: string;
  available: boolean;
  reason?: string;
  ask: (prompt: string) => Promise<EngineAnswer | null>;
}

// Exported because the backlink discovery agent asks the same engines the same way — which pages
// do the AI answers cite for our keywords — and a second copy of these adapters would drift from
// this one the first time an API changed its citation shape (./aiCitations.ts).
export function resolveEngines(perplexityModel: string, selected?: GeoEngineId[]): EngineDef[] {
  const openai = process.env.OPENAI_API_KEY;
  const gemini = process.env.GEMINI_API_KEY;
  const serper = meteredKey(process.env.SERPER_API_KEY);
  const all: EngineDef[] = [
    {
      id: "perplexity", label: "Perplexity",
      available: llmEnabled(), reason: llmEnabled() ? undefined : "OPENROUTER_API_KEY not set",
      ask: (p) => askPerplexity(p, perplexityModel),
    },
    {
      id: "chatgpt", label: "ChatGPT",
      available: !!openai && openai.length >= 20, reason: !!openai && openai.length >= 20 ? undefined : "OPENAI_API_KEY not set",
      ask: askChatGpt,
    },
    {
      id: "gemini", label: "Gemini",
      available: !!gemini && gemini.length >= 20, reason: !!gemini && gemini.length >= 20 ? undefined : "GEMINI_API_KEY not set",
      ask: askGemini,
    },
    {
      id: "google_aio", label: "Google AI Overview",
      available: !!serper && serper.length >= 10, reason: !!serper && serper.length >= 10 ? undefined : "SERPER_API_KEY not set",
      ask: askGoogleAio,
    },
  ];
  return selected?.length ? all.filter((e) => selected.includes(e.id)) : all;
}
