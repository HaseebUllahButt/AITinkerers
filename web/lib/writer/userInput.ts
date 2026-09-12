// What the human actually typed, separated from what the machine injected into their turn.
//
// Every user turn this app sends is two blocks: `phaseDirective(...)` followed by the person's own
// text (see runTurn in agent.ts). Anything reading "what did the user ask for" therefore has to strip
// the directive first, or it will treat the app's own instructions as the operator's wishes and, in
// the URL case below, promote a URL the app itself printed into required reading.
//
// Why this exists at all: `must_follow` and `competitor_urls` were only ever populated if the model
// chose to pass them to save_brief. That is the same class of "we asked the model nicely" enforcement
// that produced the original complaint (a brief handed over in chat, links pasted in chat, both
// quietly ignored). A person who pastes a URL into the chat has expressed an intent that does not
// need a model's agreement to be real, so it is captured here in code instead.
import type { Anthropic } from "@anthropic-ai/sdk";
import { stripDirectives } from "./prompt";

/** The person's own words from one stored turn, with the injected `<phase>` directive removed. */
export function humanTextFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return (blocks as Anthropic.ContentBlockParam[])
    .filter((b): b is Anthropic.TextBlockParam => (b as { type?: string })?.type === "text")
    .map((b) => stripDirectives(b.text ?? ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Absolute http(s) URLs in a piece of text.
 *
 * Trailing punctuation is trimmed because a URL at the end of a sentence ("see https://x.com/post.")
 * would otherwise be recorded with the full stop attached, and then never match the fetched copy in
 * the ledger, leaving the outline gate permanently unsatisfiable. Closing brackets get the same
 * treatment for markdown-pasted links, but only when unbalanced, so a genuine `(...)` inside a URL
 * survives.
 */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
    let u = raw.replace(/[.,;:!?]+$/, "");
    while (/[)\]]$/.test(u) && countOf(u, "(") < countOf(u, ")")) u = u.slice(0, -1);
    while (u.endsWith("]") && countOf(u, "[") < countOf(u, "]")) u = u.slice(0, -1);
    if (u.length > "https://".length) out.push(u);
  }
  return out;
}

function countOf(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** Trailing-slash- and case-insensitive, matching the comparison the outline gate already uses. */
const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();

/**
 * Union of what is already required and what the person just pasted, preserving the original
 * insertion order and the exact spelling first seen. Returns null when nothing new arrived, so the
 * caller can skip a pointless database write on the overwhelming majority of turns.
 */
export function mergeRequiredSources(existing: string[] | undefined, incoming: string[]): string[] | null {
  const have = new Set((existing ?? []).map(norm));
  const added = incoming.filter((u) => {
    const k = norm(u);
    if (have.has(k)) return false;
    have.add(k);
    return true;
  });
  return added.length ? [...(existing ?? []), ...added] : null;
}
