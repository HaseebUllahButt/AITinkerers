// Generate the Strapi metadata fields from a finished article body.
//
// A SEPARATE, cheap, non-streaming call — deliberately not folded into the body generation. If body
// and metadata came back as one structured object, a single `stop_reason: "max_tokens"` would make
// the whole JSON unparseable and lose a 2,500-word article, not just its meta description. Splitting
// them means the expensive artifact is already safely persisted before this runs.
//
// Structured outputs cannot enforce the two rules that actually block publishing: JSON Schema has no
// minLength/maxLength support here. So `title` ≥ 35 and `description` ≥ 120 are validated in code
// afterwards, with one bounded retry.
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicClient, baseWriterParams } from "./anthropic";
import type { WriterVoice, WriterBrief } from "@/lib/db/queries";

export interface StrapiMeta {
  title: string;
  slug: string;
  description: string;
  seo_title: string;
  seo_description: string;
  seo_keywords: string;
  tags: string;
  hero_cta_text?: string;
  hero_cta_url?: string;
}

/** Length rules live in the property descriptions (where the model reads them) AND in code (where
 *  they are actually enforced). Schema-level minLength is not supported for structured outputs. */
const META_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The article title. MUST be at least 35 characters — this is a hard publish requirement. Include the primary keyword. Sentence case." },
    slug: { type: "string", description: "URL slug: lowercase, hyphen-separated, no stop words padding. Derived from the title." },
    description: { type: "string", description: "Meta description. MUST be at least 120 characters — a hard publish requirement. One or two sentences that would make someone click from a search result." },
    seo_title: { type: "string", description: "Title tag, ideally under 60 characters so it is not truncated in results." },
    seo_description: { type: "string", description: "Search-result snippet, ideally under 160 characters." },
    seo_keywords: { type: "string", description: "Comma-separated keywords, primary keyword first." },
    tags: { type: "string", description: "Comma-separated topic tags, 3 to 6 of them." },
  },
  required: ["title", "slug", "description", "seo_title", "seo_description", "seo_keywords", "tags"],
  additionalProperties: false,
} as const;

export interface GenerateMetaResult {
  meta: StrapiMeta | null;
  /** Problems that survived the retry — surfaced rather than silently shipped. */
  problems: string[];
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null;
}

function checkLengths(m: StrapiMeta): string[] {
  const problems: string[] = [];
  if (!m.title || m.title.length < 35) problems.push(`title is ${m.title?.length ?? 0} chars, needs ≥35`);
  if (!m.description || m.description.length < 120) problems.push(`description is ${m.description?.length ?? 0} chars, needs ≥120`);
  if (!m.slug?.trim()) problems.push("slug is empty");
  return problems;
}

export async function generateMeta(
  body: string,
  voice: WriterVoice,
  brief: Partial<WriterBrief>,
): Promise<GenerateMetaResult> {
  const client = anthropicClient();
  if (!client) return { meta: null, problems: ["ANTHROPIC_API_KEY not set"], usage: null };

  const ask = (extra: string) => [
    `Primary keyword: ${brief.primary_keyword ?? "(none given)"}`,
    `Brand: ${voice.brand_name ?? ""}`,
    "",
    "Article:",
    body.slice(0, 20000),
    "",
    "Produce the publishing metadata for this article.",
    extra,
  ].join("\n");

  let usage: GenerateMetaResult["usage"] = null;
  const call = async (prompt: string) => {
    const res = await client.messages.create({
      // effort:"low" — this is a short extraction over text that already exists, not a reasoning
      // task, and it runs after every article so the cost adds up.
      ...baseWriterParams("low"),
      max_tokens: 2000,
      output_config: { effort: "low", format: { type: "json_schema", schema: META_SCHEMA } },
      messages: [{ role: "user", content: prompt }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    usage = {
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
      cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
    };
    if (res.stop_reason === "refusal") throw new Error("The model declined to generate metadata.");
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    if (!text) throw new Error("Empty metadata response.");
    return JSON.parse(text) as StrapiMeta;
  };

  try {
    let meta = await call(ask(""));
    let problems = checkLengths(meta);

    // One bounded retry, naming the exact shortfall. These two rules are the difference between a
    // publishable draft and a 400 from Strapi, so they are worth a second call — but only one.
    if (problems.length) {
      const retry = await call(ask(
        `Your previous attempt was rejected: ${problems.join("; ")}. ` +
        `These are hard requirements, not guidelines. Expand the affected fields with real substance, ` +
        `not padding.`,
      )).catch(() => null);
      if (retry) {
        const retryProblems = checkLengths(retry);
        if (retryProblems.length < problems.length) { meta = retry; problems = retryProblems; }
      }
    }

    // CTA is never model-invented: an invented URL becomes a broken button on a live page. Default
    // from the voice, overridden only by what the user actually asked for in the brief.
    meta.hero_cta_text = brief.cta_text ?? voice.default_cta_text ?? undefined;
    meta.hero_cta_url = brief.cta_url ?? voice.default_cta_url ?? undefined;

    return { meta, problems, usage };
  } catch (e: any) {
    return { meta: null, problems: [e?.message ?? "metadata generation failed"], usage };
  }
}
