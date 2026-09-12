// Render-mode classification (PRD R1, §2.1). Diffs raw (no-JS) vs rendered (post-JS) signals
// to decide how a template ships its primary content — the single most important indexing
// signal on a JS-heavy site, and one that GSC never surfaces directly.
//
// Why it matters: Google's first pass and EVERY major AI crawler (GPTBot, ClaudeBot,
// PerplexityBot) execute NO JavaScript. Content or SEO tags that appear only after client-side
// JS are invisible to them → "crawled – currently not indexed" and zero AI citations.
import type { OnPageSignals } from "./onpage";

export type RenderMode = "ssr" | "client-rendered" | "mixed" | "unknown";

export interface RenderModeResult {
  mode: RenderMode;
  /** Primary content or SEO-critical tags materialize only after JS. */
  jsGated: boolean;
  rawWords: number;
  renderedWords: number;
  /** Human-readable evidence for the verdict. */
  reasons: string[];
}

// A raw page below this word count has effectively no primary content pre-JS.
export const CONTENT_MIN_WORDS = 120;
// Rendered must add at least this ratio + absolute words to count as "JS injected content".
const JS_CONTENT_RATIO = 2;
const JS_CONTENT_ABS = 100;

export function classifyRenderMode(
  raw: OnPageSignals | null,
  rendered: OnPageSignals | null,
): RenderModeResult {
  const rawWords = raw?.wordCount ?? 0;
  const renderedWords = rendered?.wordCount ?? 0;
  const reasons: string[] = [];

  // Without a rendered pass we can't diff — caller decides how to treat unknown.
  if (!rendered) {
    return {
      mode: "unknown",
      jsGated: false,
      rawWords,
      renderedWords,
      reasons: ["no rendered HTML (Playwright disabled or fetch failed)"],
    };
  }
  if (!raw) {
    return {
      mode: "unknown",
      jsGated: false,
      rawWords,
      renderedWords,
      reasons: ["no raw HTML (fetch failed / non-200)"],
    };
  }

  // SEO-critical tags that exist ONLY after JS = js-gated regardless of body text.
  const tagGated: string[] = [];
  if (!raw.hasTitle && rendered.hasTitle) tagGated.push("title");
  if (!raw.canonical && rendered.canonical) tagGated.push("canonical");
  if (!raw.hasJsonLd && rendered.hasJsonLd) tagGated.push("json-ld");
  if (!raw.hasH1 && rendered.hasH1) tagGated.push("h1");

  const rawHasContent = rawWords >= CONTENT_MIN_WORDS;
  const jsInjectsContent =
    renderedWords >= rawWords * JS_CONTENT_RATIO &&
    renderedWords - rawWords >= JS_CONTENT_ABS;

  let mode: RenderMode;
  let jsGated = false;

  if (!rawHasContent && renderedWords >= CONTENT_MIN_WORDS) {
    mode = "client-rendered";
    jsGated = true;
    reasons.push(
      `primary content appears only after JS (raw ${rawWords}w → rendered ${renderedWords}w)`,
    );
  } else if (rawHasContent && jsInjectsContent) {
    mode = "mixed";
    jsGated = true;
    reasons.push(
      `raw has content but JS adds a large amount more (raw ${rawWords}w → rendered ${renderedWords}w)`,
    );
  } else {
    mode = "ssr";
    reasons.push(`primary content present in raw HTML (${rawWords}w)`);
  }

  if (tagGated.length > 0) {
    jsGated = true;
    reasons.push(`SEO tags present only after JS: ${tagGated.join(", ")}`);
    if (mode === "ssr") mode = "mixed";
  }

  return { mode, jsGated, rawWords, renderedWords, reasons };
}
