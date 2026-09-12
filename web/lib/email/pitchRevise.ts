// AI rewrite of one outreach pitch, for the inline popover in the pitch editors.
//
// Same contract as the blog editor's revise (src/lib/writer/revise.ts, whose design note is the
// load-bearing decision): return the replacement and DO NOT write it. The person splices it into
// the editor they are looking at, reviews it, and saves through the normal route — so an AI edit
// is never the one change a human can't see before it lands, and the save still records THEM as
// the reviewer (an agent proposal a person read and saved is a human review; an unreviewed agent
// write is not, which is why Hermes' edit_pitches stamps "hermes@agent" instead).
//
// Runs on the writer stack (Anthropic SDK direct), not llmChat/OpenRouter — the two stacks are
// deliberately separate (see the warning atop src/lib/writer/anthropic.ts), and this is prose
// authoring in front of a waiting human.
import { anthropicClient, baseWriterParams } from "@/lib/writer/anthropic";
import { ensurePersonalized, firstNameOf } from "@/lib/email/personalize";
import { toneDirective } from "@/lib/email/pitchTones";

export interface PitchReviseInput {
  /** A preset id from PITCH_TONES. Optional; unknown ids are ignored rather than fatal. */
  tone?: string;
  /** What the person asked for, in their words. Optional: empty means "just improve it". */
  instruction?: string;
  /** The CURRENT on-screen text (possibly unsaved), not what the database holds. */
  subject: string;
  body: string;
  /** Best-effort grounding so the model can't drift from who/what the pitch is about. */
  context: {
    recipientName?: string | null;
    recipientPosition?: string | null;
    articleTitle?: string | null;
    articleUrl?: string | null;
    targetUrl?: string | null;
    domain?: string | null;
    /** Extracted text of THEIR article (articles.readability_text_excerpt). This is what lets a
     *  rewrite ADD a real specific instead of only rearranging the existing words — the facts
     *  list is a hard boundary, so without it "make it more specific" had nothing to draw on. */
    articleExcerpt?: string | null;
  };
}

export interface PitchReviseResult {
  ok: boolean;
  error?: string;
  subject?: string;
  body?: string;
}

// Outreach copy conventions, shared with the generators: no em/en dashes, no doubled spaces.
function sanitize(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ,/g, ",")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function hasPlaceholder(s: string): boolean {
  return /\[[^\]]{1,40}\]/.test(s) || /\{\{[^}]+\}\}/.test(s);
}

export async function revisePitch(input: PitchReviseInput): Promise<PitchReviseResult> {
  const client = anthropicClient();
  if (!client) return { ok: false, error: "ANTHROPIC_API_KEY is not set." };
  if (!input.body.trim()) return { ok: false, error: "There is no pitch text to rewrite." };

  const ctx = input.context;
  const known = [
    ctx.recipientName ? `- Recipient: ${ctx.recipientName}${ctx.recipientPosition ? ` (${ctx.recipientPosition})` : ""}` : "",
    ctx.domain ? `- Their site: ${ctx.domain}` : "",
    ctx.articleTitle ? `- Their article: "${ctx.articleTitle}"` : "",
    ctx.articleUrl ? `- Article URL (must stay in the body): ${ctx.articleUrl}` : "",
    ctx.targetUrl ? `- Our page (must stay in the body if present): ${ctx.targetUrl}` : "",
    ctx.articleExcerpt?.trim()
      ? `- What their article actually says (extracted from the page, may be truncated):\n"""\n${ctx.articleExcerpt.trim()}\n"""`
      : "",
  ].filter(Boolean).join("\n");

  const system = [
    "You are editing one COLD OUTREACH EMAIL that a person is looking at right now. You are a careful copy editor, not an author.",
    [
      "Return EXACTLY this format: a first line `SUBJECT: <the subject>`, a blank line, then the email body. Nothing else — no preamble, no explanation, no code fence.",
      "Keep the greeting, addressed to the same person. Keep every URL that is in the text unless the instruction says otherwise.",
      "Do not add any factual claim, name, number or detail that is not in the text or the facts list. NEVER name a price, rate or budget figure — pricing is negotiated later, by someone else.",
      "No bracketed placeholders like [name] and no {{tokens}} — this is final text, not a template.",
      "No em-dashes or en-dashes. Plain text, no markdown. Subject under 80 characters.",
      "Sound like a busy, direct person. Keep roughly the original length unless the instruction asks otherwise.",
    ].join("\n"),
  ].join("\n\n");

  // Tone first, then the person's own words — their instruction can sharpen or override the
  // preset. Neither given means "just improve it", same default as before tones existed.
  const asked = [toneDirective(input.tone), (input.instruction ?? "").trim()].filter(Boolean).join("\n");
  const instruction = asked || "Tighten it: cut filler and hedging, keep the specifics, make the ask unmissable.";
  const user = [
    `Rewrite this pitch according to the instruction:\n${instruction}`,
    known ? `Facts you may use (nothing beyond these):\n${known}` : "",
    `Current subject: ${input.subject || "(none)"}`,
    `Current body:\n${input.body}`,
  ].filter(Boolean).join("\n\n");

  try {
    const res = await client.messages.create({
      ...baseWriterParams("medium"),
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: user }],
    });

    if (res.stop_reason === "refusal") return { ok: false, error: "The model declined to make this edit." };
    // Never read content[0] blindly: with adaptive thinking, block 0 is a thinking block.
    const out = res.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!out) return { ok: false, error: "The model returned nothing." };
    if (res.stop_reason === "max_tokens") return { ok: false, error: "The reply was cut off. Try again." };

    // Strip one wrapping fence if the model added one despite the rules.
    let cleaned = out;
    const fenced = cleaned.match(/^```[a-zA-Z0-9]*\n([\s\S]*)\n```$/);
    if (fenced) cleaned = fenced[1].trim();

    // First line `SUBJECT: …`, blank line, body. A reply without the marker keeps the old subject.
    let subject = input.subject;
    let body = cleaned;
    const m = cleaned.match(/^subject:\s*(.+)\n+([\s\S]*)$/i);
    if (m) { subject = m[1].trim(); body = m[2].trim(); }

    subject = sanitize(subject).slice(0, 200);
    body = sanitize(body);
    if (!body) return { ok: false, error: "The rewrite came back empty." };
    if (hasPlaceholder(subject) || hasPlaceholder(body)) {
      return { ok: false, error: "The rewrite contained a placeholder. Nothing was changed — try a more specific instruction." };
    }

    // The same guarantee the generators run: greeting with the recipient's name, article URL in
    // the body — re-added if the rewrite dropped either.
    body = ensurePersonalized(body, {
      firstName: ctx.recipientName ? firstNameOf(ctx.recipientName) : null,
      articleUrl: ctx.articleUrl ?? null,
    });

    return { ok: true, subject, body };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "The rewrite failed." };
  }
}
