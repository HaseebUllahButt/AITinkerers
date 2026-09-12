// The negotiation LADDER — the pure decision core. Given the current stage, the classified reply,
// the settings and the price ceiling, it returns the next ACTION. It performs no I/O and calls no
// model, so the selfcheck unit-tests every transition. run.ts turns the chosen action into an
// actual drafted/sent email (or a human handoff); agent.ts realises the wording. This separation —
// deterministic decision vs. model-written prose — is what makes the escalation behaviour testable.
//
// The SOP it encodes (from the SEO team):
//   1. Link exchange first — no money talk.
//   2. If they don't agree, push once, still forcing link exchange.
//   3. Still a no → escalate. Default: hand to a human (money is a human-supervised layer).
//      With ai_handles_money on, the AI proceeds to a money offer itself.
//   4. Complex counters (specific pages / anchors / sections, like a partner listing exact blogs)
//      → hand to a human directly, at any stage.

import type { InterventionType, ReplyClassification } from "./agent";
import type { NegotiationSettings } from "./settings";

export type NegotiationStage = "link_exchange" | "link_exchange_push" | "money" | "done";

export type LadderAction =
  | "offer_exchange"      // draft the opening (or a repeat) link-exchange offer — no money
  | "push_exchange"       // draft a firmer push, still link exchange, offering an alternative page
  | "go_money"            // proceed to a paid offer (only when ai_handles_money and a ceiling exists)
  | "close_agreed"        // they accepted the exchange (or a price at the money stage) — wind down
  | "close_declined"      // hard no / unsubscribe — polite sign-off, stop
  | "handoff";            // route to a human (complex, exchange failed, or an AI-can't-do ask)

export interface LadderInput {
  stage: NegotiationStage;
  cls: ReplyClassification;
  settings: NegotiationSettings;
  ceiling: number | null;    // per-thread price ceiling; null = site below paid tiers
  usCount: number;           // how many messages WE have already sent in this thread
  offeredSlugs: string[];    // pages we have already offered on this thread
}

export interface LadderDecision {
  action: LadderAction;
  nextStage: NegotiationStage;
  interventionType?: InterventionType; // when action === "handoff"
  reason?: string;                     // short, human-facing "why" (for handoff notes / logs)
}

// The whole state machine, as one pure function.
export function nextNegotiationStep(input: LadderInput): LadderDecision {
  const { stage, cls, settings, ceiling, usCount } = input;
  const canMoney = !!settings.ai_handles_money && ceiling != null;
  const H = (interventionType: InterventionType, reason: string, nextStage: NegotiationStage = stage): LadderDecision =>
    ({ action: "handoff", nextStage, interventionType, reason });

  // 1. Terminal declines — always stop, regardless of stage.
  if (cls.intent === "hard_no" || cls.intent === "unsubscribe") {
    return { action: "close_declined", nextStage: "done" };
  }

  // 2. AI-can't-do asks (asset / call / contract / redirect / …). The classifier already set the
  //    intervention type; surface it. These are orthogonal to the exchange/money ladder.
  if (cls.intent === "needs_human") {
    return H(cls.interventionType ?? "other", cls.interventionAsk ?? "asked for something the AI cannot do");
  }

  // 3. Complexity beats everything below it: a counter naming specific pages / anchors / sections
  //    (the "Andrew" case) needs a person, at any stage. This is SOP rule 4.
  if (cls.complex) {
    return H("complex_negotiation", cls.counterAsk || "countered with specific page/anchor demands");
  }

  // 4. They accepted the exchange while we were still negotiating it → close as a placement.
  if (cls.exchangeStance === "accept" && (stage === "link_exchange" || stage === "link_exchange_push")) {
    return { action: "close_agreed", nextStage: "done" };
  }

  // 5. Thread-length backstop: too many of our messages without a close → hand over.
  if (usCount >= settings.max_thread_length) {
    return H("link_exchange_failed", "thread reached its message limit without agreement");
  }

  switch (stage) {
    case "link_exchange": {
      // A plain "can you offer a different blog?" (simple counter) → offer one alternative next.
      if (cls.exchangeStance === "counter") {
        return { action: "push_exchange", nextStage: "link_exchange_push" };
      }
      // They don't want a swap, or they named a price (they want money): push the exchange once.
      if (cls.exchangeStance === "decline" || cls.intent === "counter_offer") {
        return { action: "push_exchange", nextStage: "link_exchange_push" };
      }
      // Interested / a question / nothing decisive → (re)state the exchange offer.
      return { action: "offer_exchange", nextStage: "link_exchange" };
    }

    case "link_exchange_push": {
      // Countered AGAIN after we already offered an alternative → complex enough for a person.
      if (cls.exchangeStance === "counter") {
        return H("complex_negotiation", "kept countering after an alternative page was offered");
      }
      // Still declining, or now asking for money → the exchange has failed. SOP rule 3.
      if (cls.exchangeStance === "decline" || cls.intent === "counter_offer") {
        if (canMoney) return { action: "go_money", nextStage: "money" };
        return H(
          "link_exchange_failed",
          ceiling != null
            ? `declined the link exchange; money is the next layer (ceiling ${settings.currency} ${ceiling})`
            : "declined the link exchange; this site is below our paid tiers",
        );
      }
      // Still engaged/positive → one more push.
      return { action: "push_exchange", nextStage: "link_exchange_push" };
    }

    case "money": {
      if (cls.intent === "accept") return { action: "close_agreed", nextStage: "done" };
      // Existing price machinery drives the wording; the ladder just keeps us in the money stage
      // until they accept or decline (declines were caught at the top).
      return { action: "go_money", nextStage: "money" };
    }

    default:
      return H("other", "negotiation reached an unexpected state");
  }
}

// Which stage a thread is in, tolerant of the legacy null (pre-ladder threads start at link_exchange).
export function normalizeStage(raw: unknown): NegotiationStage {
  return raw === "link_exchange_push" || raw === "money" || raw === "done" ? raw : "link_exchange";
}
