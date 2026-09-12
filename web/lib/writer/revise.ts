// Shorten or rewrite a piece of an existing draft.
//
// This is the editor's inline AI, not the writing agent. The differences are deliberate:
//  - No session, no phase, no approval gate. The human already has the text on screen, has selected
//    exactly what they want changed, and reviews the result immediately. The agent's approval gate
//    exists because it writes 2,000 words unattended; this writes a paragraph you are looking at.
//  - No research tools. Rewriting prose must not go and find new facts, because a new fact would
//    arrive with no source and quietly break the provenance guarantee the article was validated
//    under. The prompt forbids adding claims, and shortening can only remove.
//  - Same voice, same typography rules. A shortened paragraph that reintroduces em dashes would make
//    the editor the one hole in a rule enforced everywhere else.
import { anthropicClient, baseWriterParams } from "./anthropic";
import { voiceBannedWords, voiceBannedPhrases } from "./voice";
import { autoFixTypography } from "./validate";
import type { WriterVoice } from "@/lib/db/queries";

export type ReviseMode = "shorten" | "rewrite";

export interface ReviseInput {
  mode: ReviseMode;
  /** The exact text to replace. For a whole-body rewrite, the whole body. */
  text: string;
  /** shorten: the word count to aim for. */
  target_words?: number;
  /** rewrite: what the user asked for, in their words. */
  instruction?: string;
  /** Surrounding prose, for continuity. Never returned, never edited. */
  before?: string;
  after?: string;
  voice: WriterVoice | null;
}

export interface ReviseResult {
  ok: boolean;
  error?: string;
  text?: string;
  words_before?: number;
  words_after?: number;
  /** Typographic fixes applied after the model returned. Shown so the edit is not a black box. */
  fixes?: string[];
  usage?: { input_tokens: number; output_tokens: number } | null;
}

export function wordsIn(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** A sensible default target: a quarter shorter, floored so "shorten" on a short selection doesn't
 *  propose something absurd. Pure, so the selfcheck can pin the arithmetic. */
export function defaultShortenTarget(words: number): number {
  if (words <= 12) return Math.max(5, words - 2);
  return Math.max(10, Math.round((words * 0.75) / 5) * 5);
}

function voiceRules(voice: WriterVoice | null): string {
  if (!voice) return "";
  const banned = [...voiceBannedWords(voice), ...voiceBannedPhrases(voice)];
  const lines: string[] = [];
  if (voice.brand_name) lines.push(`Brand: ${voice.brand_name}.`);
  if (banned.length) lines.push(`Never use these words or phrases: ${banned.join(", ")}.`);
  lines.push("No em dashes or en dashes as clause separators. At most one exclamation mark.");
  return lines.join("\n");
}

const COMMON_RULES = [
  "Return ONLY the replacement text. No preamble, no explanation, no code fence, no quotation marks around it.",
  "Keep the markdown structure of the original: if it starts with a heading, the replacement starts with the same heading; keep list formatting, links and image lines intact unless the instruction says otherwise.",
  "Do not add any new factual claim, statistic, product name, date or citation that is not already in the text you were given. You have no sources here and an unsourced claim would break this article's fact-checking.",
  "Keep every existing link exactly as it is unless removing the sentence that contains it.",
].join("\n");

export async function reviseText(input: ReviseInput): Promise<ReviseResult> {
  const client = anthropicClient();
  if (!client) return { ok: false, error: "ANTHROPIC_API_KEY is not set." };

  const text = input.text ?? "";
  if (!text.trim()) return { ok: false, error: "Nothing selected to change." };
  const before = wordsIn(text);

  let task: string;
  if (input.mode === "shorten") {
    const target = Math.max(1, Math.round(input.target_words ?? defaultShortenTarget(before)));
    if (target >= before) {
      return { ok: false, error: `That is already ${before} words, which is at or under ${target}.` };
    }
    task = [
      `Shorten the text below from ${before} words to about ${target} words (within 10%).`,
      "Cut the weakest material: repetition, hedging, filler, restated points. Keep the specifics,",
      "the numbers and the links. The result must still read as finished prose, not notes.",
    ].join("\n");
  } else {
    const instruction = (input.instruction ?? "").trim();
    if (!instruction) return { ok: false, error: "Say what you want changed." };
    task = [
      "Rewrite the text below according to this instruction:",
      instruction,
      "",
      `Keep the length close to the original (${before} words) unless the instruction asks otherwise.`,
    ].join("\n");
  }

  const context = [
    input.before?.trim() ? `Text immediately BEFORE the part you are changing (do not return this):\n${input.before.slice(-1200)}` : "",
    input.after?.trim() ? `Text immediately AFTER the part you are changing (do not return this):\n${input.after.slice(0, 1200)}` : "",
  ].filter(Boolean).join("\n\n");

  const system = [
    "You are editing one part of a published-quality article. You are a careful copy editor, not an author.",
    voiceRules(input.voice),
    COMMON_RULES,
  ].filter(Boolean).join("\n\n");

  try {
    // effort "medium": this is a bounded rewrite of text the user is looking at, not a 2,000-word
    // authoring run, and the latency is in front of a waiting human.
    const res = await client.messages.create({
      ...baseWriterParams("medium"),
      max_tokens: 8000,
      system,
      messages: [{
        role: "user",
        content: [task, context, "", "The text to replace:", text].filter(Boolean).join("\n\n"),
      }],
    });

    if (res.stop_reason === "refusal") {
      return { ok: false, error: "The model declined to make this edit." };
    }
    // Never read content[0] blindly: with adaptive thinking, block 0 is a thinking block.
    const out = res.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!out) return { ok: false, error: "The model returned nothing." };
    if (res.stop_reason === "max_tokens") {
      return { ok: false, error: "The reply was cut off. Select a smaller piece and try again." };
    }

    // Models like to wrap a whole answer in a fence even when told not to. Strip one outer fence,
    // but only if it wraps the ENTIRE output — a genuine code block inside the prose must survive.
    let cleaned = out;
    const fenced = cleaned.match(/^```[a-zA-Z0-9]*\n([\s\S]*)\n```$/);
    if (fenced) cleaned = fenced[1];

    const fixed = autoFixTypography(cleaned);
    return {
      ok: true,
      text: fixed.text,
      words_before: before,
      words_after: wordsIn(fixed.text),
      fixes: fixed.violations.map((v) => v.detail),
      usage: res.usage
        ? { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }
        : null,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "The edit failed." };
  }
}
