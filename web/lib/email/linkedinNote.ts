// LinkedIn connection-request note generation, extracted verbatim from the workflow generator
// (api/workflows/[id]/generate-linkedin) so the backlink funnel can draft the same notes.
// A note is NOT an email pitch: 300-char platform cap, no links, no hard sell — a pitch body
// pasted into a connection request gets truncated mid-sentence and reads as spam.
import { llmChat } from "@/lib/providers/llm";
import { firstNameOf } from "@/lib/email/personalize";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
// LinkedIn caps connection-request notes at 300 characters. Stay comfortably under.
const MAX_CHARS = 280;
/** The platform's own limit — what a char counter should show against. */
export const LINKEDIN_NOTE_LIMIT = 300;

export interface NoteArticle { title?: string; excerpt?: string; readability_text_excerpt?: string; published_at?: string }

// Strip AI tells and clamp to LinkedIn's note limit without cutting mid-word.
function sanitize(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ,/g, ",")
    .replace(/\s+\n/g, "\n")
    .trim();
}
export function clampNote(text: string): string {
  const t = sanitize(text).replace(/\n{2,}/g, " ").trim();
  if (t.length <= MAX_CHARS) return t;
  const cut = t.slice(0, MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 200 ? cut.slice(0, lastSpace) : cut).replace(/[,.\s]+$/, "") + ".";
}
function hasPlaceholder(s: string): boolean {
  return /\[[^\]]{1,40}\]/.test(s) || /\{\{[^}]+\}\}/.test(s);
}

// A short, warm connection note. References their most recent article when we know it.
export async function generateNote(authorName: string, pubName: string, articles: NoteArticle[], guidance?: string): Promise<string> {
  const first = firstNameOf(authorName);
  const sorted = [...articles].sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  const leadTitle = (sorted[0]?.title ?? "").trim();
  const leadTopic = (sorted[0]?.excerpt ?? sorted[0]?.readability_text_excerpt ?? "").slice(0, 240).trim();

  const fallback = clampNote(
    leadTitle
      ? `Hi ${first}, I really enjoyed your piece "${leadTitle}". I work at Northwind (AI creative tools) and would love to connect and follow your work.`
      : `Hi ${first}, I've been following your writing${pubName && pubName !== "your work" ? ` at ${pubName}` : ""} and would love to connect. I work at Northwind building AI creative tools.`
  );
  if (!OPENROUTER_KEY || (!leadTitle && !leadTopic)) return fallback;

  const prompt = `Write a LinkedIn CONNECTION REQUEST note to ${authorName}, a writer at ${pubName}.

What we know about them:
- Recent article: ${leadTitle || "(unknown)"}
${leadTopic ? `- About: ${leadTopic}` : ""}

HARD RULES (follow ALL):
- Under ${MAX_CHARS} characters TOTAL (LinkedIn's hard limit). Count carefully. One or two short sentences.
- Start with "Hi ${first},".
- Reference their work specifically but briefly. NEVER invent details not listed above.
- NEVER use bracketed placeholders like [topic] or {{name}}.
- NEVER use em-dashes or en-dashes. Warm, human, not salesy. No hashtags, no emojis, no links.
- I'm from Northwind (AI creative tools). A light reason to connect is good; don't hard-pitch.${guidance ? `\n\nSENDER'S DIRECTION (obey, still under ${MAX_CHARS} chars):\n${guidance}` : ""}`;

  // No model pin, no temperature, no max_tokens, no timeout. All four were sized for Haiku and all
  // four break SILENTLY on the Opus-class default: a sampling param is a 400 on the frontier models,
  // a 160-token cap is eaten by thinking before the note exists, and 20s aborts a turn that thinks
  // first. Each one would surface here as an empty string and quietly ship the canned fallback, so
  // llmChat picks the frontier-safe budget/timeout instead. Don't put them back — clampNote already
  // enforces the 280-char shape that max_tokens 160 was standing in for.
  const res = await llmChat({ prompt });
  // Preserves the old throw-on-non-2xx contract: callers catch it and leave the note unwritten
  // (reporting the miss), rather than saving a generic fallback note over a transient failure.
  if (!res) throw new Error("OpenRouter request failed");
  const out = res.content.trim();
  return (!out || hasPlaceholder(out)) ? fallback : clampNote(out);
}
