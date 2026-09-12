// The WhatsApp vendor negotiator — Phase 3 of docs/WHATSAPP_CHANNEL_PLAN.md.
//
// A deliberate SIBLING of lib/negotiation (the email negotiator), not a bolt-on: that machine is
// built around cold partners — link-exchange ladders, worthiness gates, mailbox signing — while
// here we are the BUYER, haggling price and terms with vendors we already know, in Roman Urdu,
// over chat. What the two share is the governing frame: settings.ai_autonomy as the master
// switch, per-thread ai_managed as the opt-out, max_thread_length as the runaway cap, ceilings
// from outreach_policies, and needs_human parking on the anchor row with intervention_* fields.
//
// Money rules (decided 2026-08-22):
//  - Currency is PER DEAL (deal_currency on the anchor), learned from the vendor's first
//    unambiguous quote. A price with no currency and none on file parks the thread — never guess.
//  - The ceiling (anchor.max_offer, else the vendors-workflow policy max_offer) is denominated in
//    settings.currency (USD by default). The AI closes a deal on its own ONLY when the deal
//    currency matches and the price is at or under the ceiling. In any other currency it may
//    haggle, but the final yes is a human's.
import { supabaseAdmin } from "@/lib/db/supabase";
import {
  getWhatsappThread, getWhatsappVendor, getOrCreateWaAnchor, insertWhatsappThreadMessages,
  upsertContact,
} from "@/lib/db/queries";
import { getNegotiationSettings } from "@/lib/negotiation/settings";
import { draftWhatsappReply, addressableName } from "@/lib/email/whatsappThread";
import { normalizeWaNumber } from "@/lib/email/whatsappNote";
import { sendWaText, waCloudEnabled, serviceWindowOpen } from "@/lib/whatsapp/cloudApi";
import { sendViaBridge, waBridgeEnabled, waBridgeSendEnabled } from "@/lib/whatsapp/bridge";
import { setWaSuggestion, clearWaSuggestionForAuthor } from "@/lib/db/queries";
import { llmChat } from "@/lib/providers/llm";

export const NEGOTIATOR_ACTOR = "negotiator@agent";

// ── Deterministic extraction (pure, selfchecked) ─────────────────────────────

/** A money figure in vendor chat: "$40", "40 usd", "40$", "Rs 5000", "5000 pkr", "5k",
 *  "5 hazar/hazaar". Currency null when the text doesn't say — the caller decides what
 *  ambiguity means (per the decision: park, never guess). */
export function extractWaPrice(text: string): { amount: number; currency: "USD" | "PKR" | null } | null {
  const t = text.toLowerCase();
  const num = (raw: string, mult = 1) => Math.round(parseFloat(raw.replace(/,/g, "")) * mult);
  let m = t.match(/(?:\$|usd\s?)\s?(\d[\d,]*(?:\.\d+)?)\s*k?/i);
  if (m) return { amount: num(m[1], /k\b/.test(m[0]) ? 1000 : 1), currency: "USD" };
  m = t.match(/(\d[\d,]*(?:\.\d+)?)\s?(?:\$|usd\b|dollar[s]?\b)/i);
  if (m) return { amount: num(m[1]), currency: "USD" };
  m = t.match(/(?:rs\.?|₨|pkr)\s?(\d[\d,]*(?:\.\d+)?)\s*k?/i);
  if (m) return { amount: num(m[1], /k\s*$/.test(m[0].trim()) ? 1000 : 1), currency: "PKR" };
  m = t.match(/(\d[\d,]*(?:\.\d+)?)\s?(?:rs\b|rupee?s?\b|rupay\b|pkr\b)/i);
  if (m) return { amount: num(m[1]), currency: "PKR" };
  m = t.match(/(\d[\d,]*(?:\.\d+)?)\s?(?:hazaa?r\b)/i); // "5 hazar" — PKR by idiom
  if (m) return { amount: num(m[1], 1000), currency: "PKR" };
  m = t.match(/\b(\d{1,3}(?:\.\d+)?)\s?k\b/i); // bare "5k" — amount clear, currency not
  if (m) return { amount: num(m[1], 1000), currency: null };
  return null;
}

export type WaPrice = { amount: number; currency: "USD" | "PKR" | null };

/** EVERY money figure in a message, in the order they appear. extractWaPrice answers "what price
 *  is this message quoting" and stops at the first — but OUR OWN counters name two, theirs and
 *  ours ("Bratgen pe 80$ note kar liya, par 60-65$ bana dein"), and the second one is the offer.
 *  Reading only the first is how the negotiator kept forgetting what it had already put on the
 *  table.
 *
 *  Built on extractWaPrice rather than beside it: each digit run is re-read with a little context
 *  either side, so there is one set of currency patterns in this file and no second copy to drift. */
export function extractWaPrices(text: string): WaPrice[] {
  const s = String(text ?? "");
  const out: WaPrice[] = [];
  const seen = new Set<string>();
  for (const m of s.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    // A window just wide enough for the currency marker on either side — "Rs "/"$" to the left,
    // "$"/" usd"/" hazar"/"k" to the right — and STOPPED at the neighbouring digit. Widening it
    // past another number would hand extractWaPrice two prices at once, and its currency
    // precedence (every USD pattern before every PKR one) would then answer for the wrong one:
    // "Rs 5000 ya 40$" read as a single slice returns 40 USD twice and loses the 5000.
    let l = at;
    while (l > 0 && at - l < 5 && !/\d/.test(s[l - 1])) l--;
    let r = end;
    while (r < s.length && r - end < 8 && !/\d/.test(s[r])) r++;
    const p = extractWaPrice(s.slice(l, r));
    if (!p) continue; // a bare number with no currency marker of its own ("60" in "60-65$")
    const key = `${p.amount}|${p.currency ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Every figure WE have put on the table — from the negotiator, the composer, or the person's own
 *  phone mirrored in. A number a human on our side named binds us at least as hard as one the AI
 *  named. */
export function pricesWeNamed(thread: Array<{ direction: string; body: string }>): WaPrice[] {
  const out: WaPrice[] = [];
  for (const m of thread) if (m.direction === "outbound") out.push(...extractWaPrices(m.body));
  return out;
}

/** Has the vendor just said yes to a number we ourselves named?
 *
 *  The rule a human negotiator never breaks: you are bound by the number you put in writing.
 *  Production broke it twice in one thread — we offered 80$, the vendor wrote "bratgen.io 80$ ok
 *  for this site", and the reply was "80$ note kar liya, par 60-65$ bana dein". They came back at
 *  65, got undercut again to 50-52, and finished by quoting 80 and then 100. Undercutting your own
 *  accepted offer does not save money, it reopens a deal that was closed.
 *
 *  Matched on the FIGURE, not the site: a thread covers several sites at once, and if they say a
 *  number we already offered then that is an acceptance whatever it is attached to. Also true when
 *  they come in below our lowest offer — nobody haggles a price better than the one they asked
 *  for. Currency-aware, and a currencyless figure ("65") compares against anything, because in
 *  these threads a bare number is the running currency. */
export function vendorMetOurNumber(theirs: WaPrice | null, ours: WaPrice[]): boolean {
  if (!theirs || !ours.length) return false;
  const comparable = ours.filter((o) => !o.currency || !theirs.currency || o.currency === theirs.currency);
  if (!comparable.length) return false;
  return comparable.some((o) => o.amount === theirs.amount)
    || theirs.amount <= Math.min(...comparable.map((o) => o.amount));
}

export function extractEmail(text: string): string | null {
  const m = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

// ── Classification ───────────────────────────────────────────────────────────

export type WaIntent = "price_quote" | "agree" | "decline" | "question" | "info" | "needs_human";

export interface WaClassification {
  intent: WaIntent;
  price: number | null;
  currency: "USD" | "PKR" | null;
  reason: string;
  /** For needs_human: what they literally want, shown to the person. */
  ask?: string;
  email: string | null;
}

/** Roman Urdu-aware heuristic backstop — never throws, used when the model is unavailable and as
 *  a strong-cue override on top of it. Exported pure for the selfcheck. */
export function classifyWaHeuristic(text: string): WaClassification {
  const t = text.toLowerCase();
  const priced = extractWaPrice(text);
  const email = extractEmail(text);
  const base = { price: priced?.amount ?? null, currency: priced?.currency ?? null, email, reason: "heuristic" };
  // Strong human cues first — anger/fraud accusations, legal-ish words, payment rails: a person's
  // territory in any language. (ecb86b8 discipline, Roman Urdu edition.)
  if (/\b(scam|fraud|dhoka|report|complaint|legal|fia\b|police)\b/.test(t)) return { intent: "needs_human", ...base, ask: "upset or accusing — a person must answer" };
  if (/\b(payment|advance|paise bhej|easypaisa|jazzcash|bank|iban|invoice|receipt|screenshot bhej)\b/.test(t)) return { intent: "needs_human", ...base, ask: "payment details / money movement" };
  if (/\b(call|voice note pe|phone pe baat|meeting)\b/.test(t)) return { intent: "needs_human", ...base, ask: "wants a call" };
  if (/\b(nahi ho ?sakta|nahi kar ?sakta|rehne d[eo]|nahi chahiye|not interested|mat karo|chor[o]? isko)\b/.test(t)) return { intent: "decline", ...base };
  if (/\b(done|final|pakka|theek hai|thik hai|deal|ho ?jayega|kar ?dete hain|manzoor|agreed?|ok(ay)? bhai)\b/.test(t) && !/\?\s*$/.test(t)) {
    return { intent: priced ? "price_quote" : "agree", ...base };
  }
  if (priced) return { intent: "price_quote", ...base };
  if (/\?\s*$|kya\b|kitna|kab tak|kaunsi|which|how much|kese|kaise/.test(t)) return { intent: "question", ...base };
  return { intent: "info", ...base };
}

/** LLM classification with the heuristic as both fallback and strong-cue override. */
export async function classifyWaMessage(text: string): Promise<WaClassification> {
  const h = classifyWaHeuristic(text);
  const out = await llmChat({
    prompt: `A backlink VENDOR (guest-post seller we regularly buy from) sent this WhatsApp message, likely in Roman Urdu. Classify it. Return ONLY compact JSON:
{"intent": one of ["price_quote","agree","decline","question","info","needs_human"], "price": number or null, "currency": "USD" or "PKR" or null, "reason": "<=10 words", "ask": "<=12 words, only when needs_human"}

Definitions:
- price_quote: they name a price or counter ("45 usd", "5k mein ho jayega", "Rs 8000 final").
- agree: they accept OUR last stated terms ("done bhai", "theek hai pakka", "chalo final").
- decline: they refuse or walk away ("nahi ho sakta", "rehne do").
- question: they ask something answerable from the conversation (TAT, niche, content side).
- info: updates, site lists, small talk, greetings.
- needs_human: money movement (payment, advance, easypaisa/jazzcash/bank), anger or scam/fraud accusations, legal talk, a phone call request, or anything a chat AI must not handle alone.
- currency: ONLY what the message itself says. "5k" alone is null — never infer.

Message:
"""${text.slice(0, 1500)}"""`,
  });
  if (!out) return h;
  try {
    const m = out.content.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : "");
    const intent: WaIntent = ["price_quote", "agree", "decline", "question", "info", "needs_human"].includes(j.intent) ? j.intent : h.intent;
    const cls: WaClassification = {
      intent,
      price: typeof j.price === "number" ? j.price : h.price,
      currency: j.currency === "USD" || j.currency === "PKR" ? j.currency : h.currency,
      reason: String(j.reason ?? "").slice(0, 60) || "model",
      ask: j.ask ? String(j.ask).slice(0, 120) : undefined,
      email: h.email,
    };
    // Deterministic strong cues outrank a mild model label — same discipline as the email
    // classifier's needs_human override.
    if (h.intent === "needs_human" && cls.intent !== "needs_human") return { ...cls, intent: "needs_human", ask: h.ask, reason: `cue: ${h.ask}` };
    return cls;
  } catch {
    return h;
  }
}

// ── Anchor parking (the needs_human convention, WA edition) ──────────────────

async function parkAnchor(anchorId: string, ask: string, reason: string, keepStatus?: string): Promise<void> {
  await supabaseAdmin.from("outreach_emails").update({
    ...(keepStatus ? {} : { negotiation_status: "needs_human" }),
    intervention_type: "other",
    intervention_ask: ask,
    intervention_reason: reason,
    intervention_at: new Date().toISOString(),
  }).eq("id", anchorId);
}

// ── The runner ───────────────────────────────────────────────────────────────

export interface WaNegotiatorResult {
  acted: "replied" | "parked" | "closed" | "skipped" | "suggested";
  detail: string;
  sentBody?: string;
  waMessageId?: string | null;
  anchorId?: string;
}

/** Answer the latest vendor message on one thread — called by the webhook after each ingest.
 *  Sends only when: settings.ai_autonomy is on, the anchor is ai_managed, the thread isn't
 *  parked/closed, the reply cap isn't hit, and the Cloud API + service window allow it.
 *  Everything it can't safely do parks the anchor for a person instead of guessing. */
export async function runWaNegotiator(authorId: string): Promise<WaNegotiatorResult> {
  const vendor = await getWhatsappVendor(authorId);
  if (!vendor) return { acted: "skipped", detail: "no such vendor" };
  const thread = await getWhatsappThread(authorId);
  const last = thread[thread.length - 1];
  if (!last || last.direction !== "inbound") return { acted: "skipped", detail: "nothing to answer" };

  const anchor = await getOrCreateWaAnchor(authorId, vendor.name);
  const settings = await getNegotiationSettings();
  // vendor.name is what we FILE them under and is usually WhatsApp's pushname; this is the only
  // name we are allowed to say to them (095). Null for every vendor nobody has confirmed.
  const theirName = addressableName(vendor);

  // Everything the vendor said since our last message — one reply answers all of it.
  const lastOursIdx = [...thread].map((m) => m.direction).lastIndexOf("outbound");
  const unanswered = thread.slice(lastOursIdx + 1).filter((m) => m.direction === "inbound");
  const latestText = unanswered.map((m) => m.body).join("\n");
  const cls = await classifyWaMessage(latestText);

  // Bookkeeping that happens regardless of autonomy: currency learning and email capture are
  // facts about the deal, not actions.
  let dealCurrency: string | null = anchor.deal_currency ?? null;
  if (!dealCurrency && cls.price != null && cls.currency) {
    dealCurrency = cls.currency;
    await supabaseAdmin.from("outreach_emails").update({ deal_currency: dealCurrency }).eq("id", anchor.id);
  }
  if (cls.email) {
    await upsertContact({ author_id: authorId, type: "mailto", value: cls.email, confidence: 0.9, source: "whatsapp-thread", verified_syntax: true }).catch(() => {});
    // The usual order of events: deal closes, THEN the vendor sends their email when asked. The
    // anchor is already parked as agreed by then, so the recap handoff must fire here, not only
    // on the closing turn.
    if ((anchor.negotiation_status ?? "") === "agreed") {
      await maybeCreateRecapDraft(anchor, theirName, authorId, thread);
    }
  }

  const parked = ["needs_human", "agreed", "declined", "handoff", "not_worth_it"].includes(anchor.negotiation_status ?? "");
  if (parked) return { acted: "skipped", detail: `anchor is ${anchor.negotiation_status}`, anchorId: anchor.id };
  if (!settings.ai_autonomy) return { acted: "skipped", detail: "ai_autonomy off", anchorId: anchor.id };
  if (!anchor.ai_managed) return { acted: "skipped", detail: "thread taken over by a human", anchorId: anchor.id };
  // Transport, most-official-first. 'cloud' needs the API up AND the vendor's 24h window open;
  // 'bridge' is the WAHA relay when it's cleared to send; 'none' means we can still do all the
  // deal thinking and DRAFT a reply, but the human sends it (read-only bridge, or a closed cloud
  // window) — the draft is parked as a suggestion instead of sent.
  const transport: "cloud" | "bridge" | "none" =
    (waCloudEnabled() && serviceWindowOpen(last.sent_at ?? last.created_at)) ? "cloud"
    : waBridgeSendEnabled() ? "bridge"
    : "none";
  // If nothing is configured at all, there is no reason to have been called — bail quietly.
  if (transport === "none" && !waCloudEnabled() && !waBridgeEnabled()) {
    return { acted: "skipped", detail: "no WhatsApp transport configured", anchorId: anchor.id };
  }

  // Runaway cap: at most max_thread_length AI messages since the last HUMAN outbound.
  const lastHumanIdx = [...thread].findLastIndex((m) => m.direction === "outbound" && m.sent_by !== NEGOTIATOR_ACTOR);
  const aiStreak = thread.slice(lastHumanIdx + 1).filter((m) => m.direction === "outbound" && m.sent_by === NEGOTIATOR_ACTOR).length;
  if (aiStreak >= (settings.max_thread_length ?? 4)) {
    await parkAnchor(anchor.id, "Long AI back-and-forth, a person should take over", `Reached the ${settings.max_thread_length ?? 4}-reply cap on this WhatsApp thread.`);
    return { acted: "parked", detail: "reply cap", anchorId: anchor.id };
  }

  if (cls.intent === "needs_human") {
    await parkAnchor(anchor.id, cls.ask ?? "needs a person", `The vendor's message needs a person (${cls.reason}).`);
    return { acted: "parked", detail: `needs_human: ${cls.ask ?? cls.reason}`, anchorId: anchor.id };
  }

  // The currency decision, enforced: a price with no currency and none on file is never guessed.
  if (cls.price != null && !cls.currency && !dealCurrency) {
    await parkAnchor(anchor.id, `Vendor quoted "${cls.price}" with no currency — confirm PKR or USD with them`, "No deal currency on file and the quote is ambiguous; guessing books the wrong price.");
    return { acted: "parked", detail: "ambiguous currency", anchorId: anchor.id };
  }

  const ceiling = anchor.max_offer != null ? Number(anchor.max_offer) : await (async () => {
    const { getPolicyFor } = await import("@/lib/automation/policy");
    return (await getPolicyFor(anchor.workflow_id).catch(() => null))?.max_offer ?? null;
  })();
  const price = cls.price;
  const quoteCurrency = cls.currency ?? dealCurrency; // a bare number rides the deal currency once known
  const ceilingComparable = ceiling != null && quoteCurrency === settings.currency;

  // ── Decide the move, then let the drafter say it in the thread's own register ──
  let steer: string;
  let closeAs: "agreed" | null = null;
  // Some moves need BOTH an answer and a person: "they accepted, say so and let someone sign it
  // off". Parking used to be silent-and-instead-of-replying, which left a vendor who had just said
  // yes staring at nothing. This sends first, then raises the flag.
  let parkAfterReply: { ask: string; reason: string } | null = null;

  // Everything we have already offered, and how many times we have moved the price. Both exist to
  // stop the negotiator arguing with itself: see vendorMetOurNumber.
  const ourOffers = pricesWeNamed(thread);
  const priceRounds = thread.filter((m) => m.direction === "outbound" && extractWaPrices(m.body).length > 0).length;
  const theyMetUs = vendorMetOurNumber(price != null ? { amount: price, currency: cls.currency } : null, ourOffers);
  // Two moves on price, then a person. The old prompts said "push once" and nothing counted, so
  // "once" ran three deep and the vendor's price went UP each round. A cap that only lives in
  // prose is not a cap.
  const MAX_PRICE_ROUNDS = 2;
  // Spelled into every counter as well as enforced here: the drafter reads the whole transcript
  // and will happily invent a lower number if only the code is holding the line.
  const floorRule = ourOffers.length
    ? ` HARD RULE: we have already offered ${[...new Set(ourOffers.map((o) => `${o.amount}${o.currency ? " " + o.currency : ""}`))].join(", ")} in this conversation. Never go below a figure we offered for the same site, and NEVER reopen or shave a price they have already accepted. A different site we have not priced yet is judged on its own.`
    : "";

  // The close discipline, all decided rules in one place:
  //  - an in-range quote closes only after we've pushed at least once (a buyer who accepts the
  //    very first number is leaving money on the table);
  //  - the AI's own close requires a ceiling it can compare against — matching currency, price
  //    at or under it. An "agree" on any other footing (foreign currency, no ceiling, no price)
  //    parks for a human sign-off: the final yes on uncapped money is a person's.
  const agreedCandidate = price ?? extractWaPrice(thread.filter((m) => m.direction === "outbound").map((m) => m.body).join("\n"))?.amount ?? null;
  const closable = ceiling != null && (quoteCurrency ?? dealCurrency) === settings.currency
    && agreedCandidate != null && agreedCandidate <= ceiling;
  // "We've already engaged" = ANY prior outbound in the thread, from the AI, the composer, or the
  // person's own phone (mirrored). This is the right gate for both "don't accept their opening
  // number without a counter" AND "don't re-park an over-ceiling quote before we've pushed" —
  // aiStreak alone is wrong in read-only mode, where the AI sends nothing but the human does.
  const hasPriorOutbound = thread.some((m) => m.direction === "outbound");
  const inRangeQuote = cls.intent === "price_quote" && price != null && ceilingComparable && price <= ceiling;
  if (cls.intent === "decline") {
    await supabaseAdmin.from("outreach_emails").update({
      negotiation_status: "declined",
      negotiation_notes: `vendor declined (${cls.reason})`,
    }).eq("id", anchor.id);
    steer = "They are walking away. Close politely, keep the relationship warm, say we'll be in touch for the next batch. Do not chase or improve the offer.";
    closeAs = null;
  } else if ((cls.intent === "agree" || (inRangeQuote && hasPriorOutbound)) && closable) {
    closeAs = "agreed";
    await supabaseAdmin.from("outreach_emails").update({
      negotiation_status: "agreed",
      agreed_price: agreedCandidate,
      payment_status: "owed",
      deal_currency: quoteCurrency ?? dealCurrency,
      negotiation_notes: `deal agreed on WhatsApp at ${agreedCandidate} ${quoteCurrency ?? dealCurrency ?? ""} (${cls.reason})`,
    }).eq("id", anchor.id);
    steer = `The deal is agreed at ${agreedCandidate} ${quoteCurrency ?? dealCurrency ?? ""}. Confirm it warmly and briefly.${cls.email ? "" : " Ask for their email address so we can send the order details and keep the record straight."}`;
  } else if (cls.intent === "agree") {
    // Not closable on our own (no comparable ceiling), but going SILENT on someone who just said
    // yes is not the careful option, it is the rude one. Acknowledge on the same terms, invent
    // nothing, and put it in front of a person.
    steer = `They have accepted${agreedCandidate != null ? ` at ${agreedCandidate} ${quoteCurrency ?? dealCurrency ?? ""}` : ""}. The negotiation is OVER. Acknowledge warmly, confirm back only the terms already in the conversation, and do not name any new or different figure.${cls.email ? "" : " Ask for their email so we can send the order details."}${floorRule}`;
    parkAfterReply = {
      ask: `Vendor says the deal is done${agreedCandidate != null ? ` (~${agreedCandidate} ${quoteCurrency ?? dealCurrency ?? "?"})` : ""} — sign off on the final terms`,
      reason: "The AI closes deals on its own only inside a matching-currency ceiling; this one needs a person's yes.",
    };
  } else if (cls.intent === "price_quote" && price != null && theyMetUs) {
    // THE fix. They named a number we ourselves put on the table, so the haggling is finished —
    // whatever the ceiling says, whatever round we are on. Note this sits ABOVE every counter
    // branch on purpose: the classifier reads "bratgen.io 80$ ok for this site" as a price quote
    // (there is a number in it), and it was that reading that sent the negotiator back for more
    // after the deal had been struck.
    steer = `They have accepted ${price} ${quoteCurrency ?? ""}, which is a number WE already offered. The haggling is OVER. Confirm that exact figure back, warmly and briefly. Do NOT counter, do NOT mention any other number, and do NOT ask for a discount.${cls.email ? "" : " Ask for their email so we can send the order details."}`;
    parkAfterReply = {
      ask: `Vendor accepted ${price} ${quoteCurrency ?? dealCurrency ?? ""} — confirm the order`,
      reason: "They met a price we had already offered, so the negotiator stopped haggling; the final yes on the terms is yours.",
    };
  } else if (cls.intent === "price_quote" && price != null && priceRounds >= MAX_PRICE_ROUNDS) {
    // We have moved twice and they are still above us. A third counter is where this thread
    // started losing money — the vendor re-anchored UPWARD each time.
    // Silent on purpose, unlike the acceptance branches above. The only thing left to say here is
    // "let me check and get back to you", and the negotiator has no mechanism to come back — an
    // unkept promise reads worse to a vendor than a pause while a colleague picks it up.
    await parkAnchor(anchor.id, `Vendor holding at ${price} ${quoteCurrency ?? dealCurrency ?? ""} after ${priceRounds} price message(s) from us — take the call`, "Two moves on price is the cap; pushing a third time is a person's decision, not the negotiator's.");
    return { acted: "parked", detail: "price round cap", anchorId: anchor.id };
  } else if (cls.intent === "price_quote" && price != null) {
    if (ceilingComparable && price > ceiling) {
      if (hasPriorOutbound) {
        // We already countered once and they held above the ceiling — a person decides.
        await parkAnchor(anchor.id, `Vendor holding at ${price} ${quoteCurrency}, over our ${ceiling} ${settings.currency} ceiling`, "Above the standing max_offer after a counter; raising the ceiling is a human call.");
        return { acted: "parked", detail: "over ceiling after counter", anchorId: anchor.id };
      }
      const counter = Math.max(1, Math.round(ceiling * Math.min(1, Math.max(0.05, (settings.opening_percent ?? 20) / 100 + 0.4))));
      steer = `They quoted ${price} ${quoteCurrency}, above what this is worth to us. Counter at ${counter} ${settings.currency}, firm but friendly; mention we bring repeat volume. Never reveal a maximum and never go above ${ceiling} ${settings.currency}.${floorRule}`;
    } else if (ceilingComparable) {
      // Inside the ceiling but not obviously a yes (e.g. first quote): push once for better.
      // Never ask for less than we have already offered: shaving 20% off a number that is
      // already under our own last offer is the undercut, arithmetic edition.
      const ourFloor = ourOffers.filter((o) => !o.currency || o.currency === quoteCurrency).map((o) => o.amount);
      const target = Math.max(1, Math.round(price * 0.8), ...(ourFloor.length ? [Math.min(...ourFloor)] : []));
      steer = `They quoted ${price} ${quoteCurrency}, which is acceptable, but push once for better: ask for ${target} ${quoteCurrency} citing repeat volume. If they hold, accept it, do not push a second time.${floorRule}`;
    } else {
      // A real quote in a currency our ceiling isn't denominated in (usually PKR): haggle
      // relatively, but the final yes is a human's — never close in this branch.
      steer = `They quoted ${price} ${quoteCurrency ?? "(currency on file: " + (dealCurrency ?? "unknown") + ")"}. Push back ONCE for roughly 20-25% less, citing repeat volume. If they hold or meet you, take it, do not push again. Do NOT accept or confirm any deal; a person signs off on this currency.${floorRule}`;
    }
  } else {
    steer = "Answer their question or acknowledge their update from the conversation only. If they asked something the thread doesn't answer (site metrics, our content plans), say you'll confirm and get back — never invent an answer.";
  }

  const transcript = thread.slice(-40).map((m) => ({ direction: m.direction, body: m.body }));
  let body: string;
  try {
    body = await draftWhatsappReply({ vendorName: theirName, transcript, instruction: steer, lang: null, tone: null });
  } catch (e: any) {
    await parkAnchor(anchor.id, "Draft failed — answer the vendor yourself", `The model didn't produce a reply (${e?.message ?? "unknown"}); the vendor is waiting.`, closeAs ?? undefined);
    return { acted: "parked", detail: "draft failed", anchorId: anchor.id };
  }

  // READ-ONLY: no transport cleared to send. All the state work above already happened (currency
  // learned, agreed/declined recorded, email captured); park the drafted reply as a suggestion
  // the human sends themselves, and still fire the recap handoff if the deal closed.
  if (transport === "none") {
    await setWaSuggestion(anchor.id, body);
    if (parkAfterReply) await parkAnchor(anchor.id, parkAfterReply.ask, parkAfterReply.reason);
    if (closeAs === "agreed") await maybeCreateRecapDraft(anchor, theirName, authorId, thread);
    return { acted: "suggested", detail: closeAs ?? cls.intent, sentBody: body, anchorId: anchor.id };
  }

  const digits = normalizeWaNumber(vendor.whatsapp_url);
  if (!digits) {
    await parkAnchor(anchor.id, "No valid WhatsApp number on file for this vendor", "The negotiator drafted a reply but has no owned number to send it to.", closeAs ?? undefined);
    return { acted: "parked", detail: "no number", anchorId: anchor.id };
  }
  const sent = transport === "cloud" ? await sendWaText(digits, body) : await sendViaBridge(digits, body);
  await insertWhatsappThreadMessages([{
    author_id: authorId, direction: "outbound", body,
    source: "negotiator", status: sent.ok ? "sent" : "failed",
    wa_message_id: sent.waMessageId, error: sent.error,
    sent_at: new Date().toISOString(), sent_by: NEGOTIATOR_ACTOR,
  }]);
  await clearWaSuggestionForAuthor(authorId).catch(() => {}); // a real send supersedes any suggestion
  if (!sent.ok) {
    await parkAnchor(anchor.id, "The send failed — answer the vendor yourself", `${transport === "cloud" ? "Cloud API" : "WAHA bridge"} refused the negotiator's reply: ${sent.error}`, closeAs ?? undefined);
    return { acted: "parked", detail: `send failed: ${sent.error}`, anchorId: anchor.id };
  }

  if (parkAfterReply) {
    await parkAnchor(anchor.id, parkAfterReply.ask, parkAfterReply.reason);
    return { acted: "parked", detail: `answered, then parked: ${parkAfterReply.ask}`, sentBody: body, waMessageId: sent.waMessageId, anchorId: anchor.id };
  }
  if (closeAs === "agreed") {
    await maybeCreateRecapDraft(anchor, theirName, authorId, thread.concat([{ direction: "outbound", body } as any]));
    return { acted: "closed", detail: "deal agreed", sentBody: body, waMessageId: sent.waMessageId, anchorId: anchor.id };
  }
  return { acted: "replied", detail: cls.intent, sentBody: body, waMessageId: sent.waMessageId, anchorId: anchor.id };
}

// ── The email handoff (§7 of the plan) ───────────────────────────────────────

/** Once a deal is agreed AND we hold the vendor's email, draft the recap email as a negotiation
 *  child of the anchor (exempt from the one-initial-per-author index). A DRAFT on purpose: it has
 *  no sender stamp, and the no-fallback-sender rule means a human's send is what stamps it. */
export async function maybeCreateRecapDraft(anchor: any, vendorName: string | null, authorId: string, thread: Array<{ direction: string; body: string }>): Promise<boolean> {
  const { data: mc } = await supabaseAdmin
    .from("contacts").select("value").eq("author_id", authorId).eq("type", "mailto").limit(1).maybeSingle();
  if (!mc?.value) return false; // no email yet — the agreed-reply already asked for one
  const { data: existing } = await supabaseAdmin
    .from("outreach_emails").select("id").eq("parent_id", anchor.id).eq("kind", "negotiation").limit(1).maybeSingle();
  if (existing) return true;

  const { data: fresh } = await supabaseAdmin
    .from("outreach_emails").select("agreed_price, deal_currency").eq("id", anchor.id).maybeSingle();
  const price = (fresh as any)?.agreed_price ?? null;
  const currency = (fresh as any)?.deal_currency ?? "";
  const recent = thread.slice(-30).map((m) => `${m.direction === "inbound" ? "VENDOR" : "US"}: ${m.body.slice(0, 300)}`).join("\n");

  // Same rule as the chat reply: no vouched name, no name. "Hi there" is a normal way to open
  // an email; greeting a stranger by a persona they never gave us is not.
  const greeting = vendorName ? `Hi ${vendorName}` : "Hi there";
  const fallback = `${greeting},\n\nConfirming what we agreed on WhatsApp${price != null ? `: ${price} ${currency} per post` : ""}. Reply here with the site list and we'll send the content and targets on this thread.\n\nThanks!`;
  let body = fallback;
  const res = await llmChat({
    prompt: `We just agreed a guest-post deal with a vendor over WhatsApp (transcript below, mostly Roman Urdu). Write the short ENGLISH recap email that moves the deal onto the email thread: open with "${greeting}" and do not use any other name for them, restate the agreed terms exactly as the transcript supports them${price != null ? ` (price: ${price} ${currency})` : ""} — price, what's included, turnaround if stated — and ask them to confirm and share anything still open (site list, sample URLs). 4-8 sentences, plain text, no em-dashes, no placeholders, nothing invented beyond the transcript.

Transcript:
${recent}`,
  }).catch(() => null);
  if (res?.content?.trim() && !/\[[^\]]{1,40}\]/.test(res.content)) body = res.content.trim();

  await supabaseAdmin.from("outreach_emails").insert({
    workflow_id: anchor.workflow_id, author_id: authorId, parent_id: anchor.id,
    kind: "negotiation", channel: "email", status: "draft",
    subject: `Order confirmation${vendorName ? ` — ${vendorName}` : ""}${price != null ? ` (${price} ${currency})` : ""}`,
    body, ai_managed: false,
  });
  await supabaseAdmin.from("outreach_emails").update({
    intervention_type: "other",
    intervention_ask: "Review and send the recap email — the deal is agreed",
    intervention_reason: "The WhatsApp deal closed; the recap email draft is ready and sending it stamps you as the thread's sender.",
    intervention_at: new Date().toISOString(),
  }).eq("id", anchor.id);
  return true;
}
