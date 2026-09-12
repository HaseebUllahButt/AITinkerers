// WhatsApp DM generation + number/link helpers, mirroring linkedinNote.ts (the one note
// generator per manual channel). A WhatsApp message is NOT an email pitch and NOT a LinkedIn
// note: there is no platform cap and no connection gate — one message lands directly in their
// chat, so it carries a light ask up front instead of "would love to connect". It still must
// read like a person typing on a phone: short, plain, no links in the first message (a cold
// first DM with a URL is what gets reported as spam and blocks the number).
//
// Sending is manual BY DESIGN — a human taps the wa.me link and sends from their own WhatsApp.
// There is no API here on purpose: Meta's Business Platform requires recipient opt-in for
// business-initiated messages and has paused marketing templates to US numbers outright, so the
// only honest automation is drafting the words and opening the chat.
import { llmChat } from "@/lib/providers/llm";
import { firstNameOf } from "@/lib/email/personalize";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
// No platform limit — this cap is editorial. Longer than this stops reading as a chat message.
const MAX_CHARS = 450;
/** What the char counter should show against (soft — nothing truncates at send time). */
export const WHATSAPP_NOTE_LIMIT = 500;

export interface WaNoteArticle { title?: string; excerpt?: string; readability_text_excerpt?: string; published_at?: string }

/** E.164-ish digits from whatever a person pastes or a page carries: "+1 (555) 010-2030",
 *  "https://wa.me/15550102030", "00923001234567" all → "15550102030"-style strings.
 *  Null when what's left can't be a real international number — callers must treat that as
 *  "not saved", never save a mangled value. Pure, for the selfcheck. */
export function normalizeWaNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Percent-escapes first ("%2B" is an encoded "+"): stripped as non-digits they would INJECT
  // their hex digits into the number, which is how "+92…" quietly becomes "292…".
  let digits = String(raw).replace(/%[0-9a-fA-F]{2}/g, " ").replace(/\D+/g, "");
  // International call prefix pasted verbatim ("00" + country code) — the wa.me form drops it.
  if (digits.startsWith("00")) digits = digits.slice(2);
  // E.164 is 8-15 digits with country code; under 8 is a local number we can't dial from here.
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/** The click-to-chat URL, optionally with the message prefilled — one tap on a phone opens the
 *  conversation with the text already typed. Null propagates from a bad number. */
export function waLink(numberOrRaw: string | null | undefined, text?: string): string | null {
  const digits = normalizeWaNumber(numberOrRaw);
  if (!digits) return null;
  return `https://wa.me/${digits}${text?.trim() ? `?text=${encodeURIComponent(text.trim())}` : ""}`;
}

// Strip AI tells; keep it chat-shaped (single paragraph, no doubled spaces).
function sanitize(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ,/g, ",")
    .replace(/\s+\n/g, "\n")
    .trim();
}
export function clampWaNote(text: string): string {
  const t = sanitize(text).replace(/\n{2,}/g, "\n").trim();
  if (t.length <= MAX_CHARS) return t;
  const cut = t.slice(0, MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 300 ? cut.slice(0, lastSpace) : cut).replace(/[,.\s]+$/, "") + ".";
}
function hasPlaceholder(s: string): boolean {
  return /\[[^\]]{1,40}\]/.test(s) || /\{\{[^}]+\}\}/.test(s);
}

// A short, warm first DM. Grounded the same way as everything since the fabrication fix: it may
// reference ONLY the title/excerpt we actually hold, and the fallback claims nothing about the
// piece beyond quoting its real title.
export async function generateWhatsappNote(authorName: string, pubName: string, articles: WaNoteArticle[], guidance?: string): Promise<string> {
  const first = firstNameOf(authorName);
  const sorted = [...articles].sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  const leadTitle = (sorted[0]?.title ?? "").trim();
  const leadTopic = (sorted[0]?.excerpt ?? sorted[0]?.readability_text_excerpt ?? "").slice(0, 240).trim();

  const fallback = clampWaNote(
    leadTitle
      ? `Hi ${first}, I read your piece "${leadTitle}" and wanted to reach out about it. I'm with Northwind (AI creative tools) and we'd love to talk about a collaboration on that page. Is this a good place to chat?`
      : `Hi ${first}, I came across your writing${pubName && pubName !== "your work" ? ` at ${pubName}` : ""} and wanted to reach out. I'm with Northwind (AI creative tools) and we'd love to talk about a collaboration. Is this a good place to chat?`
  );
  if (!OPENROUTER_KEY || (!leadTitle && !leadTopic)) return fallback;

  const prompt = `Write a first WHATSAPP MESSAGE to ${authorName}, a writer at ${pubName}. It opens a cold chat, so it must explain in one breath who is writing and why, without reading as broadcast spam.

What we know about them:
- Recent article: ${leadTitle || "(unknown)"}
${leadTopic ? `- About: ${leadTopic}` : ""}

HARD RULES (follow ALL):
- Under ${MAX_CHARS} characters TOTAL. Two to four short sentences, one paragraph, chat register.
- Start with "Hi ${first},".
- Reference their work specifically but briefly. NEVER invent details not listed above.
- Say you're from Northwind (AI creative tools) and want to talk about a collaboration on their piece. Do not name money or terms.
- End with a short question so replying is easy.
- NO links or URLs. NEVER use bracketed placeholders like [topic] or {{name}}.
- NEVER use em-dashes or en-dashes. No hashtags, no emojis, no "I hope this finds you well".${guidance ? `\n\nSENDER'S DIRECTION (obey, still under ${MAX_CHARS} chars):\n${guidance}` : ""}`;

  // Same frontier-safe call shape as generateNote: no model pin, no sampling params, no tight
  // token/timeout caps — each of those breaks silently on the Opus-class default and would ship
  // the canned fallback over a healthy model. clampWaNote enforces the length.
  const res = await llmChat({ prompt });
  // Throw-on-failure contract shared with generateNote: callers leave the note unwritten and the
  // nightly run retries, rather than saving a generic fallback over a transient failure.
  if (!res) throw new Error("OpenRouter request failed");
  const out = res.content.trim();
  return (!out || hasPlaceholder(out)) ? fallback : clampWaNote(out);
}
