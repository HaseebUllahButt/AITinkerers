// SearchOps is intentionally pinned to one cheap answer model. A key or model configured
// elsewhere in the environment cannot turn an audit into an unexpected provider fan-out.
import { DEEPSEEK_MODEL } from "@/lib/providers/llm";

// Legacy ids remain because saved/demo audit results can contain them. ask() refuses them.
export type EngineId = "deepseek" | "claude" | "chatgpt" | "perplexity" | "gemini";

export interface Engine {
  id: EngineId;
  label: string;
  retrieval: boolean;
}

export const ENGINES: Engine[] = [
  { id: "deepseek", label: "DeepSeek 4.1 Flash", retrieval: false },
];

export interface EngineReply {
  engine: EngineId;
  content: string;
  citations: string[];
}

export interface EngineStatus {
  engine: EngineId;
  available: boolean;
  reason: string;
}

async function askDeepSeek(prompt: string): Promise<EngineReply | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key.length < 20) return null;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1600,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    return content ? { engine: "deepseek", content, citations: [] } : null;
  } catch {
    return null;
  }
}

export async function ask(engine: EngineId, prompt: string): Promise<EngineReply | null> {
  return engine === "deepseek" ? askDeepSeek(prompt) : null;
}

export function engineStatus(): EngineStatus[] {
  const available = Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.length > 20);
  return [{ engine: "deepseek", available, reason: available ? "" : "OPENROUTER_API_KEY is not set." }];
}

export function engineLabel(id: EngineId): string {
  return ENGINES.find((engine) => engine.id === id)?.label ?? id;
}
