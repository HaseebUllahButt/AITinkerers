// Generates diverse search queries via Claude so every discovery run explores new angles.
// Falls back to template queries if the API is unavailable.

import type { SeedTool } from "@/lib/types";
import { llmChat } from "@/lib/providers/llm";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";

async function askClaude(prompt: string): Promise<string> {
  // No model pin — inherits DEFAULT_LLM_MODEL so there's one source of truth for the swap.
  //
  // temperature is deliberately NOT passed. The old 0.9 was there to vary the query set run to
  // run, but the frontier models 400 on any sampling param, and llmChat returns null on non-2xx —
  // which this function would surface as "LLM down", silently pinning every discovery run to the
  // static fallback list forever. Variety now comes from the prompt (the AVOID list of recent
  // queries) rather than from sampling, so do not "restore" temperature here.
  //
  // max_tokens/timeout are also omitted on purpose. The old 800 was sized for the 30-line answer
  // alone; on a reasoning model max_tokens bounds thinking AND the answer, so 800 gets eaten by
  // thinking and returns a truncated list. The helper's frontier budget (4000) covers both. Same
  // for the old 15s ceiling, which was a Haiku-era number and would abort a thinking turn.
  const res = await llmChat({ prompt });
  if (!res) throw new Error("OpenRouter request failed");
  return res.content;
}

export async function generateDiscoveryQueries(seeds: SeedTool[], usedQueries: string[] = [], customKeywords?: string[]): Promise<string[]> {
  const competitors = seeds.filter((s) => s.category === "competitor").map((s) => s.name);
  const topics = seeds.filter((s) => s.category === "topic").map((s) => s.name);

  if (!OPENROUTER_KEY) return fallbackQueries(competitors);

  const usedSample = usedQueries.slice(-30).join("\n"); // show Claude recent ones to avoid repeats

  try {
    const toolList = competitors.slice(0, 20).join(", ");
    // Campaign custom keywords take priority over seed topics
    const topicList = customKeywords?.length
      ? customKeywords.join(", ")
      : topics.slice(0, 10).join(", ");

    const raw = await askClaude(`You are helping a generative AI company find NEW editorial writers and bloggers to pitch for coverage. We have already scraped the obvious "best AI video generator" mega-roundups a hundred times — those converge on the same 10 pages. Your job is to reach LONG-TAIL articles by writers we haven't found yet.

Generate exactly 30 FRESH, DIVERSE web search queries that surface human-written editorial articles about generative AI tools.
Tools to target: ${toolList}
Topics/Keywords: ${topicList || "generative ai, ai art, ai video, ai image generation, text to image, llm tools"}

Requirements:
- EDITORIAL articles only (reviews, comparisons, roundups, tutorials, "I tested X", opinion, case studies) — NOT product pages or press releases.
- Stay related to the Topics/Keywords, but MAXIMIZE diversity of angle so we hit different writers/publications. Deliberately spread across these dimensions:
  • Industry verticals: marketing/advertising, ecommerce, filmmaking, photography, game/3D art, education, real estate, social media, small business, agencies.
  • Job roles searching: "for marketers", "for content creators", "for designers", "for video editors", "for startups", "for solopreneurs".
  • Formats/platforms: substack, medium, personal blog, newsletter, "how I use", workflow write-ups, tutorials, case study, hands-on.
  • Regions/English variants: US, UK, India, Australia, Southeast Asia.
  • Time: include 2025 and 2026 variants.
- Mix single-tool and multi-tool and NO-tool (topic-only) queries. Include some "site:substack.com" / "site:medium.com" style queries.
- Vary the verbs: review, compared, I tried, hands-on, guide, workflow, why I switched, honest review, is it worth it.
- Each query on its own line, no numbering, no commentary, under 90 chars.
${usedSample ? `\nAVOID repeating or paraphrasing these already-used queries (find genuinely new angles):\n${usedSample}` : ""}

Output ONLY the 30 queries, one per line.`);

    const lines = raw.split("\n")
      .map((l) => l.trim().replace(/^\d+[\.\)]\s*/, "").replace(/^["']|["']$/g, ""))
      .filter((l) => l.length > 5 && l.length < 120 && !l.startsWith("//") && !l.startsWith("#"));

    const fresh = lines.filter((l) => {
      const norm = l.toLowerCase().trim();
      return !usedQueries.some((u) => u.toLowerCase().trim() === norm);
    });

    // Only fall back to the static template list when the LLM genuinely produced too few
    // fresh queries. On success, return the fresh ones alone — appending the ~70-query
    // fallback list here used to burn it as "used" every round even though harvesters only
    // ever search the first ~10 of a round's batch, so it was never actually searched, just
    // wasted (and unavailable as a real fallback later if the LLM call starts failing).
    if (fresh.length >= 10) return dedupe(fresh);
    return fallbackQueries(competitors);
  } catch (e) {
    console.warn("[generateDiscoveryQueries] Claude failed, using fallback:", (e as Error).message);
    return fallbackQueries(competitors);
  }
}

function fallbackQueries(tools: string[]): string[] {
  // Spread across verticals/roles/formats/regions so the fallback (used when the LLM is down)
  // still reaches diverse writers rather than the same saturated roundups.
  const base: string[] = [
    "best generative ai tools 2026", "ai image generator comparison review", "best ai video generator roundup 2026",
    "top ai art tools for creators 2026", "generative ai tools for designers", "ai image generation tools I tested",
    "best text to image ai 2026", "ai video tools comparison 2026", "generative ai workflow tutorial",
    "best ai tools for content creators", "ai video tools for marketers", "ai image tools for ecommerce",
    "ai tools for social media content", "ai video for youtube creators", "ai design tools for small business",
    "ai tools for filmmakers", "ai art workflow substack", "how I use ai video tools medium",
    "ai marketing tools case study", "best ai ad creative tools", "ai tools for agencies 2026",
    "hands on ai video generator review", "is ai video worth it honest review", "ai image generator for photographers",
    "ai tools for indie game art", "generative ai for video editors",
  ];
  for (const t of tools.slice(0, 14)) {
    base.push(`${t} review`, `${t} vs`, `${t} alternative`, `I tried ${t}`, `${t} for marketers`, `${t} tutorial`);
  }
  return dedupe(base);
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.toLowerCase().trim()))].map(
    (s) => s.charAt(0).toUpperCase() + s.slice(1)
  );
}
