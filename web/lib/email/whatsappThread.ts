// WhatsApp VENDOR-THREAD helpers: parse a pasted chat export into messages, decide which side
// said what, and draft the next reply. Sibling of whatsappNote.ts (the cold first-DM generator);
// this file is about running negotiations with vendors the team already knows, mostly in Roman
// Urdu (docs/WHATSAPP_CHANNEL_PLAN.md).
//
// Parsing is deterministic-first: WhatsApp's own "export chat" format is machine-shaped, so a
// regex handles it and stays selfcheckable. The LLM is only the fallback for freeform pastes,
// and drafting throws on model failure rather than shipping a canned line — a canned fallback
// mid-negotiation would put words in the negotiator's mouth.
import { llmChat } from "@/lib/providers/llm";
import { toneDirective, langDirective, type PitchToneId, type PitchLangId } from "@/lib/email/pitchTones";

export interface ParsedWaMessage {
  sender: string;
  body: string;
  /** ISO from the export's local timestamp, UTC-constructed. Phone-local time stored as if UTC:
   *  ordering within the paste is exact, interleaving with live-logged rows can be hours off,
   *  and that trade is taken knowingly — exports carry no timezone to do better with. */
  at: string | null;
}

// One message start in either export dialect:
//   iOS:     [22/08/2026, 14:03:11] Ali Vendor: message
//   Android: 22/08/26, 14:03 - Ali Vendor: message   (or "2:03 PM" in US-locale phones)
// Lines that match no header are continuations of the previous message; header lines with no
// "Name: " part are system notices (encryption banner, "You added X") and are dropped.
const WA_HEADER = /^\[?(\d{1,4}[/.\-]\d{1,2}[/.\-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*([AaPp]\.?[Mm]\.?)?\]?\s*(?:-\s*)?(.*)$/;
const WA_SENDER = /^([^:]{1,60}?):\s([\s\S]*)$/;

/** Local export timestamp → ISO. Day-first by default (PK phones); flips to month-first only
 *  when the day slot is impossible as a day. UTC-constructed so the result is byte-identical on
 *  any machine — the selfcheck depends on that. Null for impossible dates. */
export function parseWaTimestamp(date: string, time: string, ampm?: string | null): string | null {
  const dParts = date.split(/[/.\-]/).map((n) => parseInt(n, 10));
  if (dParts.length !== 3 || dParts.some((n) => Number.isNaN(n))) return null;
  let [a, b, y] = dParts;
  if (a > 31 || (a > 999 && b <= 12)) [a, b, y] = [dParts[2], dParts[1], dParts[0]]; // yyyy-mm-dd export
  let day = a, month = b;
  if (month > 12 && day <= 12) [day, month] = [month, day]; // US-locale phone: mm/dd
  if (y < 100) y += 2000;
  const tParts = time.split(":").map((n) => parseInt(n, 10));
  let h = tParts[0] ?? 0;
  const min = tParts[1] ?? 0, s = tParts[2] ?? 0;
  if (ampm) { const pm = /p/i.test(ampm); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  if (month < 1 || month > 12 || day < 1 || day > 31 || h > 23 || min > 59) return null;
  const dt = new Date(Date.UTC(y, month - 1, day, h, min, s));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** Deterministic parse of a WhatsApp "export chat" paste. Null when the text isn't export-shaped
 *  (then it's either a freeform paste for the LLM splitter, or a single verbatim message). */
export function parseWaExport(text: string): { messages: ParsedWaMessage[]; senders: string[] } | null {
  const messages: ParsedWaMessage[] = [];
  let current: ParsedWaMessage | null = null;
  for (const line of text.split("\n")) {
    const h = line.match(WA_HEADER);
    const s = h ? h[4].match(WA_SENDER) : null;
    if (h && s) {
      if (current) messages.push(current);
      current = { sender: s[1].trim(), body: s[2], at: parseWaTimestamp(h[1], h[2], h[3]) };
    } else if (h && !s) {
      if (current) messages.push(current); // system notice ends the previous message and is dropped
      current = null;
    } else if (current) {
      current.body += `\n${line}`;
    }
  }
  if (current) messages.push(current);
  if (messages.length === 0) return null;
  for (const m of messages) m.body = m.body.trim();
  const senders = [...new Set(messages.map((m) => m.sender))];
  return { messages: messages.filter((m) => m.body), senders };
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, "");

/** Which of the export's senders is the vendor — pure containment match against how we know
 *  them ("Ali" matches "Ali Backlinks Bhai"). Null when no sender matches: the caller escalates
 *  to the LLM rather than this function guessing, because a swapped direction files the vendor's
 *  words as ours and poisons every draft grounded on the thread. */
export function matchVendorSender(senders: string[], vendorName: string): string | null {
  const v = squash(vendorName);
  if (!v) return null;
  const hits = senders.filter((s) => { const q = squash(s); return q.includes(v) || v.includes(q); });
  return hits.length === 1 ? hits[0] : null;
}

/** LLM tiebreak for when no export sender matches the vendor's saved name (phones save vendors
 *  under anything — "Ali Guest Post Wala"). Returns one of `senders` verbatim, or null when the
 *  model is unavailable or answers outside the list — the caller then refuses the paste rather
 *  than filing messages under a guessed side. */
export async function identifyVendorSenderLLM(senders: string[], vendorName: string, sample: string): Promise<string | null> {
  if (senders.length < 2) return senders[0] ?? null;
  const res = await llmChat({
    prompt: `A WhatsApp chat export has these participants: ${senders.map((s) => `"${s}"`).join(", ")}.
One of them is a backlink vendor our team knows as "${vendorName}"; the other side is our own team member. From the excerpt below (they may write Roman Urdu), decide which PARTICIPANT NAME is the vendor — the one selling guest posts/links, quoting prices, being asked for rates.

Excerpt:
"""${sample.slice(0, 3_000)}"""

Answer with exactly one participant name from the list, nothing else.`,
  });
  if (!res) return null;
  const w = res.content.trim().replace(/^["']|["']$/g, "");
  return senders.find((s) => squash(s) === squash(w)) ?? senders.find((s) => squash(w).includes(squash(s))) ?? null;
}

/** LLM fallback for a freeform paste (not export-shaped): split into messages and sides.
 *  Null when the model is unavailable or returns something unusable — callers surface that as
 *  "couldn't read this paste", never as an empty thread. */
export async function splitPastedChat(text: string, vendorName: string): Promise<Array<{ direction: "inbound" | "outbound"; body: string }> | null> {
  const t = text.trim().slice(0, 12_000);
  if (!t) return null;
  const res = await llmChat({
    prompt: `Below is a WhatsApp conversation pasted from a phone, between our team and a backlink vendor called ${vendorName}. It may be in Roman Urdu, English, or both.

Split it into individual messages, in order, and label each with who sent it: "vendor" (${vendorName}) or "us" (our team). Drop timestamps, system notices and reaction lines. Keep each message's text verbatim.

Answer with ONLY a JSON array, no prose: [{"from":"vendor","text":"..."},{"from":"us","text":"..."}]

Conversation:
"""${t}"""`,
  });
  if (!res) return null;
  try {
    const raw = res.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
    if (!Array.isArray(arr)) return null;
    const out = arr
      .filter((m: any) => m && typeof m.text === "string" && m.text.trim() && (m.from === "vendor" || m.from === "us"))
      .map((m: any) => ({ direction: (m.from === "vendor" ? "inbound" : "outbound") as "inbound" | "outbound", body: String(m.text).trim() }));
    return out.length ? out : null;
  } catch {
    return null;
  }
}

function hasPlaceholder(s: string): boolean {
  return /\[[^\]]{1,40}\]/.test(s) || /\{\{[^}]+\}\}/.test(s);
}

/** Chat messages don't get the email clamp — but AI tells still go, and a multi-paragraph essay
 *  is not a WhatsApp reply. Soft-shaped, never truncated: the human edits before sending. */
export function shapeWaReply(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ", ").replace(/[ \t]{2,}/g, " ").replace(/ ,/g, ",").replace(/\n{3,}/g, "\n\n").trim();
}

/** The name to use to a vendor's FACE, which is not the same thing as the name we file them under.
 *  Null unless a person on the team vouched for it (migration 095).
 *
 *  WhatsApp's pushname is a display string the account holder types into their own profile, and
 *  vendors routinely set it to a persona or a business tagline. Trusting it is what made the
 *  negotiator open with "Hello Katie, hope you're doing well" to a vendor the team knows as Ali
 *  Ahmed: "Katie Grose" was simply what his WhatsApp profile said. */
export function addressableName(vendor: { name: string; name_confirmed?: boolean }): string | null {
  if (!vendor.name_confirmed) return null;
  const n = tidyPersonName(vendor.name);
  // A confirmed placeholder is still a placeholder; nobody is called "WhatsApp +923001234567".
  if (!n || /^WhatsApp \+/i.test(n)) return null;
  return n;
}

// How people actually file vendors in a phone: "ali Ahmed Vendor", "Umer SEO", "Shahid guest post",
// "Touheed bhai 2". Those are the right label for a contact list and the wrong thing to say out
// loud — nobody greets someone with "Hello ali Ahmed Vendor". The saved name stays exactly as the
// phone has it everywhere it is DISPLAYED; this trims it only for the sentence we send.
const ROLE_TAGS = new Set([
  "vendor", "vendors", "seller", "seo", "gp", "gps", "backlink", "backlinks", "link", "links",
  "insertion", "outreach", "guest", "post", "posts", "bhai", "bro", "sir", "ji", "sahab",
  "new", "old", "official", "whatsapp", "wa", "contact", "number", "site", "sites", "website", "websites",
]);

/** A saved contact name reduced to the part that is a name. Conservative on purpose: it strips
 *  only trailing/leading filing tags and bare digits, and gives up (returning the original) the
 *  moment stripping would leave nothing — mangling someone's name is worse than a clumsy greeting.
 *  Also fixes a lower-case first letter, because "ali" is a typing habit, not a spelling. */
export function tidyPersonName(raw: string): string {
  const original = raw.trim().replace(/\s+/g, " ");
  if (!original) return "";
  const words = original.split(" ");
  const strippable = (w: string) => {
    const bare = w.toLowerCase().replace(/[^a-z0-9]/g, "");
    return !bare || ROLE_TAGS.has(bare) || /^\d+$/.test(bare);
  };
  while (words.length > 1 && strippable(words[words.length - 1])) words.pop();
  while (words.length > 1 && strippable(words[0])) words.shift();
  // Everything looked like a tag ("Guest Post Vendor"): that is a label, not a person, and the
  // caller is better off with no name than with a fragment of one.
  if (words.length === 1 && strippable(words[0])) return "";
  const kept = words.join(" ");
  return kept.replace(/^([a-z])/, (c) => c.toUpperCase());
}

export interface WaDraftInput {
  /** Null when we have no name we can stand behind — see addressableName. */
  vendorName: string | null;
  transcript: Array<{ direction: "inbound" | "outbound"; body: string }>;
  /** Free-text steer from the person about what this reply should do ("counter at 40", "ask TAT"). */
  instruction?: string | null;
  lang?: PitchLangId | null;
  tone?: PitchToneId | null;
}

/** The whole instruction the model gets for a vendor reply. Split out from the call so the naming
 *  rule is assertable without a model: the bug it exists to stop (greeting a vendor by the persona
 *  on their WhatsApp profile) lives in this string, not in the network round trip. */
export function waDraftPrompt(input: WaDraftInput): string {
  const recent = input.transcript.slice(-40).map((m) => `${m.direction === "inbound" ? "THEM" : "US"}: ${m.body.slice(0, 500)}`);
  // Newest messages matter most — trim from the top if the transcript is still huge.
  while (recent.length > 2 && recent.join("\n").length > 9_000) recent.shift();
  const language = langDirective(input.lang)
    ?? "Match the language and register the conversation is already in (Roman Urdu stays Roman Urdu).";
  const steer = [toneDirective(input.tone), input.instruction?.trim() || null].filter(Boolean).join("\n");

  // With no vouched name, the reply must not carry one. Naming someone wrong is worse than not
  // naming them: it tells the vendor they are a record in a system that never checked. The
  // exception is a name they typed themselves in the thread, which is the same thing a person
  // reading the chat would use.
  const who = input.vendorName
    ? `${input.vendorName}, a backlink vendor we already work with`
    : "a backlink vendor we already work with";
  const naming = input.vendorName
    ? `- You may address them as ${input.vendorName}. Use it sparingly, the way a person texting would.`
    : "- Do NOT address them by name, and do not invent one. We only hold the display name they set on their own WhatsApp profile, which is often a brand or a persona rather than what they are called. The one exception: if they stated their own name in the conversation above, that name is fine to use.";

  return `Draft the NEXT WhatsApp message from our team to ${who}. This is a live price/terms negotiation in a chat we will send by hand.

The conversation so far, oldest first:
${recent.join("\n") || "(no messages yet — this opens the conversation)"}

HARD RULES (follow ALL):
- One chat message: short, usually one to three sentences. No greeting unless the thread has gone quiet, no sign-off ever.
${naming}
- ${language}
- NEVER invent a price, site, URL, metric or deadline that is not in the conversation above${steer ? " or in the sender's direction below" : ""}. If the vendor asked something we can't answer from the thread, the reply should ask or defer, not guess.
- NEVER use em-dashes or en-dashes, bracketed placeholders like [site], hashtags, or bullet points.${steer ? `\n\nSENDER'S DIRECTION (obey):\n${steer}` : ""}

Answer with the message text only.`;
}

/** Propose the next outbound message in a vendor thread. A PROPOSAL, never written anywhere —
 *  same contract as revisePitch: the human edits and the send moment is theirs (wa.me, Phase 1).
 *  Throws on model failure; there is no honest canned line for the middle of a negotiation. */
export async function draftWhatsappReply(input: WaDraftInput): Promise<string> {
  // Frontier-safe call shape (see llm.ts): no model pin, no sampling params, no tight caps.
  const res = await llmChat({ prompt: waDraftPrompt(input) });
  if (!res) throw new Error("The model didn't answer. Nothing was drafted — try again.");
  const out = shapeWaReply(res.content);
  if (!out || hasPlaceholder(out)) throw new Error("The model returned an unusable draft. Nothing was saved — try again.");
  return out;
}
