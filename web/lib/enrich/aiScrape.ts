import { fetchPage } from "@/lib/extract/fetch";
import { llmChat } from "@/lib/providers/llm";
import { isRoleEmail, isPlaceholderEmail } from "./personFilter";

// Native "AI scrape" — the same idea as ScrapeGraphAI's extract, but done in-house with
// YOUR Claude access (via OPENROUTER_API_KEY) instead of ScrapeGraph's paid credits.
// Fetches a page, strips it to text + mailto links, and asks Claude for the author's email.

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

export function aiScrapeEnabled(): boolean {
  return !!OPENROUTER_KEY;
}

// Try the likeliest pages for a contact email, in order, until one yields.
// onError fires only on a real failure (missing key / LLM API error), not on "no email".
export async function aiScrapeEmail(name: string, host: string, onError?: (msg: string) => void): Promise<string | null> {
  if (!OPENROUTER_KEY) { onError?.("no OPENROUTER_API_KEY"); return null; }
  if (!host) return null;
  const clean = host.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const pages = [`https://${clean}/contact`, `https://${clean}/about`, `https://${clean}`];
  for (const url of pages) {
    const email = await scrapeOne(name, url, onError);
    if (email) return email;
  }
  return null;
}

async function scrapeOne(name: string, url: string, onError?: (msg: string) => void): Promise<string | null> {
  const fetched = await fetchPage(url).catch(() => null);
  if (!fetched) return null;

  const html = fetched.html;
  const mailtos = [...html.matchAll(/mailto:([^"'>\s?]+)/gi)].map((m) => m[1].toLowerCase());
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 6000);

  const prompt = `You are extracting a contact email from a web page for the writer named "${name}".
mailto links found on the page: ${mailtos.length ? mailtos.join(", ") : "none"}
Page text (truncated): ${text}

Return ONLY that writer's email address if it clearly appears, otherwise return exactly "NONE". No other words.`;

  // Model, output budget and timeout all come from llmChat so this file inherits the one
  // Opus-class default. Three things are deliberately NOT passed:
  //  - temperature: the frontier models 400 on any sampling param, and a 400 here reads exactly
  //    like "no email on this page" — the caller only ever sees null. Determinism is not worth
  //    losing every response for.
  //  - max_tokens: the old 30 was sized for a Haiku one-liner. On a reasoning model that budget
  //    is spent thinking and the answer comes back empty, so let the helper pick the frontier one.
  //  - timeout: the old 20s was the generic Haiku ceiling, not a considered limit for this step.
  const res = await llmChat({ prompt });
  // llmChat collapses HTTP errors, timeouts and network faults into null, so this step can no
  // longer say which one happened — but it still fires onError only on a real failure, never on
  // "the page had no email" (that path returns null below without calling onError).
  if (!res) { onError?.("OpenRouter request failed"); return null; }

  const out = res.content.trim().toLowerCase().replace(/^mailto:/, "");
  if (!out || out === "none") return null;
  if (!EMAIL_RE.test(out)) return null;
  // A model reading a page will happily hand back the page's own placeholder address, so this
  // needs the same guard as the regex scraper.
  if (isPlaceholderEmail(out)) return null;
  if (isRoleEmail(out)) return null; // reject generic inboxes (contact@, tips@, info@…)
  return out;
}
