// In-app deep research: the sidecar's /v1/research (hermes/capabilities.py research()) ported onto
// the writer's Anthropic stack, so cited research works wherever the app runs instead of depending
// on a separately-hosted box being configured. The port is deliberately faithful — same system
// prompt, same search budget, same block-walk — so an answer from here and an answer from the
// sidecar are the same product.
//
// Uses Anthropic's server-side web_search tool rather than our own search keys: it runs inside the
// model's own loop, and it returns citations as structured data, which is what makes `sources`
// trustworthy instead of a list scraped out of prose. The writer treats `sources` as a closed set
// for its no-invented-citations check, so a source list assembled from the answer text would
// defeat that check entirely.
import { anthropicClient, baseWriterParams } from "@/lib/writer/anthropic";

/** Caps thinking AND answer text together on this stack (see baseWriterParams) — sized above the
 *  sidecar's 4096 so adaptive thinking cannot starve the prose. */
const RESEARCH_MAX_TOKENS = 6000;
const MAX_WEB_SEARCHES = 6;

const RESEARCH_SYSTEM =
  "You are a research assistant for an SEO team at imagine.art, an AI image and video generation " +
  "product. Answer the question from web sources you actually searched.\n\n" +
  "Rules:\n" +
  "- Cite nothing you did not read. If the searches do not answer it, say so plainly.\n" +
  "- Facts, numbers and dates only from sources. Never estimate a figure and present it as found.\n" +
  "- Be brief and factual. No preamble, no emoji.\n" +
  "- If sources disagree, say they disagree and give both.";

export interface AppResearchResult {
  answer: string;
  sources: string[];
  model: string;
}
export interface AppResearchFailure {
  ok: false;
  error: string;
}

export async function appResearch(question: string, window?: string): Promise<AppResearchResult | AppResearchFailure> {
  const client = anthropicClient();
  if (!client) return { ok: false, error: "ANTHROPIC_API_KEY is not set" };
  const prompt = window ? `${question}\n\nRestrict to: ${window}.` : question;

  let resp;
  try {
    resp = await client.messages.create({
      ...baseWriterParams("medium"),
      max_tokens: RESEARCH_MAX_TOKENS,
      system: [{ type: "text", text: RESEARCH_SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_WEB_SEARCHES }],
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "research call failed" };
  }

  // Text blocks arrive interleaved with the searches, and the ones BEFORE the last search are the
  // model narrating its process — "I'll search for…", "Let me verify a couple of specifics". Only
  // the text after the final search result is the actual answer. Concatenating all of them puts
  // that narration into the caller's context, where it reads as content.
  const texts: Array<{ i: number; text: string; citations: unknown[] }> = [];
  const sources: string[] = [];
  let lastSearchAt = -1;

  resp.content.forEach((block, i) => {
    if (block.type === "text") {
      texts.push({ i, text: block.text, citations: (block as { citations?: unknown[] }).citations ?? [] });
    } else if (block.type === "web_search_tool_result" || block.type === "server_tool_use") {
      lastSearchAt = i;
      const content = (block as { content?: unknown }).content;
      for (const item of Array.isArray(content) ? content : []) {
        const u = (item as { url?: unknown })?.url;
        if (typeof u === "string" && u && !sources.includes(u)) sources.push(u);
      }
    }
  });

  let answerParts = texts.filter((t) => t.i > lastSearchAt);
  // A question answered without searching at all has no post-search text; fall back to everything
  // rather than returning an empty answer.
  if (!answerParts.some((t) => t.text.trim())) answerParts = texts;

  // Citations are the authoritative provenance — the URLs the model actually read, as opposed to
  // any URL it happened to type into the prose. Collected from the post-search blocks only.
  for (const t of texts) {
    if (t.i <= lastSearchAt) continue;
    for (const c of t.citations) {
      const u = (c as { url?: unknown })?.url;
      if (typeof u === "string" && u && !sources.includes(u)) sources.push(u);
    }
  }

  return {
    answer: answerParts.map((t) => t.text).filter((s) => s.trim()).join("\n\n").trim(),
    sources,
    model: resp.model,
  };
}
