// What do we make from this? The one decision the research board exists to answer.
//
// The rule, as given:
//
//   "if its an llm, image, or video model, or audio model, it gets a landing page, otherwise it gets
//    a blog. everything mentioned above always gets a blog"
//
// So it is not either/or. EVERY candidate worth surfacing is worth a blog post. A model release —
// LLM, image, video or audio — ALSO earns a landing page, because a named model is a thing people
// search for by name and the page that owns that name is worth having.
//
// That resolves two examples that looked contradictory. GPT Work is a product built on models, so:
// blog. GPT Cyber is a model, so: landing page AND blog. An earlier reading of this rule asked "can
// Northwind host it?", which put GPT Cyber in the blog column and disagreed with the brief. Hosting
// is not the question. Being a model is.
//
// An uncertain candidate still gets its blog — nothing is lost — and simply does not get the landing
// page. That asymmetry is deliberate: a missed landing page is recoverable next week, while a
// landing page for something that turns out not to be a model dilutes the /apps namespace and ships
// a CTA with nowhere to go.
import { classifyModality, type Modality } from "@/lib/research/radar";

export type Surface = "landing" | "blog";

export interface RoutingVerdict {
  /** Always includes "blog". Includes "landing" when this is a model release. */
  surfaces: Surface[];
  /** Stated on the row, because a rule nobody can see is one nobody trusts. */
  reason: string;
  /** How sure the landing-page half is. The blog half is never in doubt. */
  confidence: "high" | "medium" | "low";
  modality: Modality;
  /** True when this is a model release — the thing that earns the landing page. */
  isModel: boolean;
}

/** Modalities that ARE model releases by definition. */
const MODEL_MODALITIES: Modality[] = ["image", "video", "audio", "avatar"];

/**
 * LLMs, which classifyModality has no bucket for — it was written for the landing radar, where a
 * chat model was out of scope. Under this rule an LLM release earns a landing page like any other
 * model, so it needs detecting explicitly.
 *
 * Version-shaped names carry most of the signal ("GPT-5", "Claude 4.5", "Llama 4"), because that is
 * how these are announced.
 */
const IS_LLM = /\b(llm|large language model|language model|foundation model|reasoning model|gpt[- ]?\d|claude\s*\d|gemini\s*\d|llama\s*\d|mistral|qwen\s*\d|deepseek|grok\s*\d|phi[- ]?\d|command[- ]r)\b/i;

/**
 * A PRODUCT built on models, not a model release. The GPT Work side of the line.
 *
 * "agent" and "assistant" are the words most likely to over-match, so they are paired with product
 * nouns rather than left bare — plenty of model announcements mention agents without being one.
 */
const IS_PRODUCT = /\b(office|productivity suite|spreadsheet|email client|word processor|browser|ide|code editor|coding (agent|assistant)|developer tool(kit)?|operating system|enterprise suite|crm|helpdesk|workspace app|robotics|self[- ]driving|pricing change|funding round|raises \$)\b/i;

/** The shape of a model announcement, independent of modality wording. */
const IS_MODEL_SHAPED = /\b(model|checkpoint|weights|lora|diffusion|\d+\s?[bB] param|open[- ]weights?|text[- ]to[- ](image|video|audio|speech|music)|image (generation|generator)|video (generation|generator)|voice (clone|model)|tts|text[- ]to[- ]speech|lip[- ]?sync|upscal|inpaint|outpaint|img2img|i2v|t2v)\b/i;

export function routeCandidate(input: {
  subject: string;
  summary?: string | null;
  /** The landing radar already decided this one is a page type we ship. */
  hostedHint?: boolean;
}): RoutingVerdict {
  const text = `${input.subject} ${input.summary ?? ""}`;
  const modality = classifyModality(text);
  // The blog is never in question. Only whether a landing page joins it.
  const both: Surface[] = ["landing", "blog"];
  const blogOnly: Surface[] = ["blog"];

  if (input.hostedHint) {
    return { surfaces: both, isModel: true, confidence: "high", modality,
      reason: "The landing radar already recognises this as a page type we ship." };
  }

  // Product beats everything: "GPT Work" must not earn a page because the word GPT sat next to
  // something that parses like a model name.
  if (IS_PRODUCT.test(text)) {
    return { surfaces: blogOnly, isModel: false, confidence: "high", modality,
      reason: "A product built on models rather than a model release. Worth a post; no page of its own." };
  }

  if (IS_LLM.test(text)) {
    return { surfaces: both, isModel: true, confidence: "high", modality,
      reason: "An LLM release. Gets a landing page in its own name, and a blog post." };
  }

  if (MODEL_MODALITIES.includes(modality)) {
    return { surfaces: both, isModel: true, confidence: IS_MODEL_SHAPED.test(text) ? "high" : "medium", modality,
      reason: `A ${modality} model release. Gets a landing page in its own name, and a blog post.` };
  }

  if (IS_MODEL_SHAPED.test(text)) {
    return { surfaces: both, isModel: true, confidence: "medium", modality,
      reason: "Reads as a model release even though the modality is not stated outright." };
  }

  if (modality === "retirement") {
    return { surfaces: both, isModel: false, confidence: "medium", modality,
      reason: "A retirement creates migration intent, and the page that catches it is a comparison page." };
  }

  return { surfaces: blogOnly, isModel: false, confidence: "low", modality,
    reason: "No sign this is a model release, so it is industry news: a post, not a page. Flip it if that is wrong." };
}
