// Voice profiles: the per-brand half of the writing agent's system prompt.
//
// Renders into `system[1]`, the second prompt-cache breakpoint. The critical property of
// renderVoiceSystem() is that it is BYTE-DETERMINISTIC for a given prompt_revision — the same voice
// must produce the identical string on every request, or the cache silently stops hitting.
//
// Two things in this file exist purely to guarantee that:
//   1. Word/phrase lists are sorted, lowercased, trimmed and deduped before joining. A `text[]`
//      round-trip through Postgres does not promise a stable order.
//   2. sitemap_links is rendered field-by-field, sorted by url — never JSON.stringify'd. `jsonb`
//      does not preserve key order, so stringifying it would produce a different prefix at random
//      and there would be no error to notice.
import type { WriterVoice } from "@/lib/db/queries";

export interface SitemapLink {
  url: string;
  category?: string | null;
  description?: string | null;
  /** Pre-approved CTA button copy for this page, e.g. "Generate Background For Fashion Videos" for
   *  /ai-fashion-studio. When present, a ```CTA block pointing at this url should reuse this text
   *  verbatim rather than the model composing its own — it is copy the team already signed off on. */
  cta_text?: string | null;
}

/** Normalise a stored word list into a stable, comparable form. */
function normalizeList(list: string[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const v = String(raw).trim().toLowerCase();
    if (v) seen.add(v);
  }
  return [...seen].sort();
}

export function voiceBannedWords(v: Pick<WriterVoice, "banned_words">): string[] {
  return normalizeList(v.banned_words);
}
export function voiceBannedPhrases(v: Pick<WriterVoice, "banned_phrases">): string[] {
  return normalizeList(v.banned_phrases);
}

/** Parse the jsonb column defensively — Upstash/Supabase can hand back a string or an object, and a
 *  hand-edited row could contain anything. Bad entries are dropped rather than throwing at request
 *  time, because a malformed link list must not take the writer offline. */
export function voiceSitemap(v: Pick<WriterVoice, "sitemap_links">): SitemapLink[] {
  const raw = v.sitemap_links;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  const out: SitemapLink[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const url = String((item as any).url ?? "").trim();
    if (!url) continue;
    out.push({
      url,
      category: (item as any).category ? String((item as any).category).trim() : null,
      description: (item as any).description ? String((item as any).description).trim() : null,
      cta_text: (item as any).cta_text ? String((item as any).cta_text).trim() : null,
    });
  }
  // Sort by url so the rendered block is stable regardless of insertion order.
  return out.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/**
 * Build the voice half of the system prompt.
 *
 * Deliberately contains NO timestamp, no id, no revision number and no counts derived from mutable
 * state. Adding any of those would change the bytes on every request and kill the cache.
 */
export function renderVoiceSystem(v: WriterVoice): string {
  const parts: string[] = [];

  parts.push(`═══ BRAND VOICE: ${v.name} ═══`);
  if (v.brand_name) parts.push(`Brand: ${v.brand_name}`);
  parts.push("");
  parts.push("Follow this voice exactly. Where it disagrees with the workflow document about style,");
  parts.push("this document wins.");
  parts.push("");
  parts.push(v.tone_doc.trim());

  if (v.workflow_rules?.trim()) {
    parts.push("");
    parts.push("─── Additional rules for this voice ───");
    parts.push(v.workflow_rules.trim());
  }

  const words = voiceBannedWords(v);
  const phrases = voiceBannedPhrases(v);
  if (words.length || phrases.length) {
    parts.push("");
    parts.push("─── Banned words and phrases ───");
    parts.push("These are checked mechanically after you write, and a match sends the section back");
    parts.push("to you to rewrite. They are banned in prose, headings and anchor text. They are NOT");
    parts.push("flagged inside a URL, inside code, or inside text you are quoting from a source.");
    if (words.length) {
      parts.push("");
      parts.push("Never use these words:");
      for (const w of words) parts.push(`  - ${w}`);
    }
    if (phrases.length) {
      parts.push("");
      parts.push("Never use these phrases:");
      for (const p of phrases) parts.push(`  - ${p}`);
    }
    parts.push("");
    parts.push("When you reach for one of these, the problem is usually upstream: the idea is not");
    parts.push("clear yet. Go back and name the specific thing you actually mean.");
  }

  const links = voiceSitemap(v);
  if (links.length) {
    parts.push("");
    parts.push("─── Internal link database ───");
    parts.push("Pick 3 to 5 per article, only where a reader would genuinely benefit from clicking.");
    parts.push("You may ONLY link to URLs in this list. Anything else is treated as fabricated.");
    parts.push("");
    for (const l of links) {
      const bits = [l.url];
      if (l.category) bits.push(`[${l.category}]`);
      // Colon, not an em dash: this line is rendered into a prompt that tells the model never to
      // use em dashes, and one appearing 36 times in its own instructions is a mixed signal.
      if (l.description) bits.push(`: ${l.description}`);
      if (l.cta_text) bits.push(`(approved CTA text: "${l.cta_text}")`);
      parts.push(`  ${bits.join(" ")}`);
    }

    parts.push("");
    parts.push("─── Inserting a CTA inside the body ───");
    parts.push("A CTA that lives inside the body (not the single required hero CTA) is a fenced code");
    parts.push('block with the language tag "CTA" containing exactly one JSON object with "text" and');
    parts.push('"url", nothing else in the fence. Example:');
    parts.push("");
    parts.push("```CTA");
    parts.push(JSON.stringify({ text: "Generate Background For Fashion Videos", url: "https://www.imagine.art/ai-fashion-studio" }));
    parts.push("```");
    parts.push("");
    parts.push("Rules:");
    parts.push("  - url must be one of the URLs in the internal link database above. Never invent one —");
    parts.push("    an invented CTA target is a broken button on a live page.");
    parts.push('  - If the target link above has an "approved CTA text", use it verbatim. Otherwise write');
    parts.push("    a short imperative action phrase naming the outcome, not the mechanism (\"Generate My");
    parts.push('    Headshot", not "Click Here" or "Learn More").');
    parts.push("  - One CTA block per body location is enough. Do not stack two in the same section.");
    parts.push("  - This is separate from an ordinary inline markdown link — use a plain link when the");
    parts.push("    sentence is just citing or referencing a page, and this fenced block only for a");
    parts.push("    stop-and-click moment such as the outline's designated conclusion CTA.");
  }

  parts.push("");
  parts.push("─── Defaults for this voice ───");
  parts.push(`Target word count when unspecified: ${v.default_word_count}`);
  if (v.default_cta_text && v.default_cta_url) {
    parts.push(`Default call to action: "${v.default_cta_text}" → ${v.default_cta_url}`);
    parts.push("Use that CTA unless the user supplies a different one. Do not invent a CTA URL.");
  }
  const hosts = normalizeList(v.allowed_link_hosts);
  if (hosts.length) {
    parts.push(`Our own domains (for a CTA or internal link): ${hosts.join(", ")}`);
  }

  return parts.join("\n");
}

/** Approximate token size, for the cache-minimum sanity check in the probe script. */
export function voiceSystemApproxTokens(v: WriterVoice): number {
  return Math.round(renderVoiceSystem(v).length / 4);
}

/** Columns whose change must bump `prompt_revision`, because they alter the cached prompt.
 *  Renaming a voice or editing its description must NOT invalidate the cache. */
export const PROMPT_BEARING_FIELDS = [
  "tone_doc", "banned_words", "banned_phrases", "workflow_rules", "sitemap_links", "brand_name",
  "default_word_count", "default_cta_text", "default_cta_url", "allowed_link_hosts",
] as const;
