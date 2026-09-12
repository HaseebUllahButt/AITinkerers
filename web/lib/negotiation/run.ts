import { supabaseAdmin } from "@/lib/db/supabase";
import { getNegotiationSettings } from "./settings";
import { maxOfferFor } from "./pricing";
import { classifyReplyIntent, draftNegotiationReply, type ThreadMessage, type InterventionType, type DraftResult } from "./agent";
import { nextNegotiationStep, normalizeStage, type NegotiationStage, type LadderAction } from "./ladder";
import { pickExchangeOffer, pickLinkTarget, pageUrl } from "./inventory";
import { getOrScoreWorthiness, markWorthinessOverride } from "./signals";
import { updateOutreachEmail, getUserEmailConfig } from "@/lib/db/queries";
import { deliverOutreach } from "@/lib/email/deliver";

// The reply goes out from the initial's sender inbox, so it must be SIGNED by that person, not a
// hardcoded name. Prefer their configured From name; else derive a first name from the address.
function firstNameFromEmail(e?: string | null): string | undefined {
  if (!e) return undefined;
  const local = (e.split("@")[0] || "").split(/[._+-]/)[0] || "";
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : undefined;
}

// Human-readable "why a person is needed" per intervention type (shown on the Negotiation page).
const INTERVENTION_REASON: Record<string, string> = {
  asset_request: "They want a document/assets the AI cannot attach on its own.",
  identity_verification: "They want proof of who we are (LinkedIn / website / references).",
  sync_contact: "They want a live call or meeting, which only a person can take.",
  scheduling: "They want availability or a calendar link.",
  redirect: "They pointed us to a different contact to email.",
  process_portal: "They want us to submit via a form/portal or create an account.",
  legal_contract: "They want a contract/NDA handled or signed.",
  payment_details: "They want invoice/PO/bank/tax details.",
  factual_question: "They asked a factual question the AI must not fabricate.",
  over_policy: "They want terms beyond our price ceiling or policy.",
  inbound_attachment: "They sent a file for us to review.",
  other_channel: "They want to move to another channel (WhatsApp/phone/etc.).",
  complex_negotiation: "They countered with specific pages/anchors/sections — this needs the guidelines and a person's judgement.",
  link_exchange_failed: "They declined the link exchange. A person should decide whether to offer money.",
  worthiness_review: "The partner site scored borderline on the quality bar. The SEO Lead decides whether it's worth pursuing.",
  other: "This reply needs a person to handle it.",
};

// Flag a thread for a human and clear any unsent AI draft. Used by both the AI-can't-do path and
// the ladder's handoff decisions (complex counters, exchange failed, thread over length).
async function flagNeedsHuman(initialId: string, itype: InterventionType, ask: string, note?: string): Promise<void> {
  await supabaseAdmin.from("outreach_emails").delete().eq("parent_id", initialId).eq("kind", "negotiation").eq("status", "draft");
  await updateOutreachEmail(initialId, {
    negotiation_status: "needs_human",
    intervention_type: itype,
    intervention_ask: ask,
    intervention_reason: INTERVENTION_REASON[itype] ?? INTERVENTION_REASON.other,
    intervention_at: new Date().toISOString(),
    negotiation_notes: note ?? `needs human: ${itype} — ${ask}`,
  } as any);
}

// Slugs we have already offered on this thread, read from the anchor's exchange_offer jsonb, so a
// push offers a DIFFERENT page rather than repeating the same one.
function offeredSlugsFrom(exchangeOffer: any): string[] {
  const raw = exchangeOffer?.offered;
  return Array.isArray(raw) ? raw.filter((s: any) => typeof s === "string") : [];
}

export interface NegotiationResult {
  ok: boolean; draftId?: string; body?: string; ceiling: number | null;
  suggestedOffer: number | null; statusHint: string | null; intent: string | null;
  autonomy: boolean; persistedAs: string; sent: boolean; sendError?: string | null; recipientMissing?: boolean;
  error?: string;
}

// Generate (and, when autonomy is ON, immediately SEND) the AI's next negotiation reply for a
// thread. Used by the Negotiation page button AND the send-processor's auto-negotiation loop.
// forceDraft = never auto-send even if autonomy is on (the "just draft it" path).
export async function negotiateThread(emailId: string, opts?: { forceDraft?: boolean; assistInput?: string | null }): Promise<NegotiationResult> {
  const base: NegotiationResult = { ok: false, ceiling: null, suggestedOffer: null, statusHint: null, intent: null, autonomy: false, persistedAs: "draft", sent: false };
  const assisting = !!(opts?.assistInput && opts.assistInput.trim());

  const { data: email } = await supabaseAdmin
    .from("outreach_emails")
    .select("id, kind, parent_id, subject, author_id, sender_email, sent_by_email, max_offer, author:authors(full_name, domain:domains(id, host, name, dr, organic_traffic, us_traffic_share))")
    .eq("id", emailId).maybeSingle();
  if (!email) return { ...base, error: "email not found" };

  const initialId = (email as any).kind === "followup" || (email as any).kind === "negotiation"
    ? ((email as any).parent_id ?? email.id) : email.id;

  const { data: threadRows } = await supabaseAdmin
    .from("outreach_emails")
    .select("id, kind, body, subject, created_at, reply_excerpt, reply_subject, replied_at, parent_id, sender_email, sent_by_email, workflow_id, author_id, message_id, recipient_override, negotiation_stage, exchange_offer, intervention_type")
    .or(`id.eq.${initialId},parent_id.eq.${initialId}`)
    .order("created_at", { ascending: true });
  const rows = (threadRows ?? []) as any[];
  const initial = rows.find((r) => r.id === initialId) ?? (email as any);

  const thread: ThreadMessage[] = [];
  let latestReply: any = null;
  for (const r of rows) {
    if (r.body) thread.push({ from: "us", body: r.body });
    if (r.reply_excerpt) { thread.push({ from: "them", body: r.reply_excerpt }); latestReply = r; }
  }

  const settings = await getNegotiationSettings();
  const dom: any = (email as any).author?.domain ?? null;
  const cls = await classifyReplyIntent(latestReply?.reply_excerpt ?? "", latestReply?.reply_subject ?? "");
  const tier = maxOfferFor(dom?.dr ?? null, dom?.organic_traffic ?? null, dom?.us_traffic_share ?? null, settings.pricing_rules);
  // Ceiling precedence, most specific wins: the per-thread override a person typed, then the
  // campaign's standing policy (outreach_policies.max_offer — "this page's links are worth at
  // most $X to us"), then the DR-tier handbook default.
  let policyCeiling: number | null = null;
  const workflowId = (initial as any)?.workflow_id ?? null;
  if (workflowId) {
    const { getPolicyFor } = await import("@/lib/automation/policy");
    policyCeiling = (await getPolicyFor(workflowId).catch(() => null))?.max_offer ?? null;
  }
  const ceiling = (email as any).max_offer != null ? Number((email as any).max_offer) : (policyCeiling ?? tier?.offer ?? null);

  // HUMAN-INTERVENTION SHORT-CIRCUIT. If the writer asked for something the AI cannot do (a
  // document/call/redirect/etc.) and no human assist input was supplied, never draft or send a
  // hollow reply — flag the thread for a person and stop. (When assisting, the human HAS provided
  // what's needed, so we fall through and draft a truthful reply.)
  if (cls.intent === "needs_human" && !assisting) {
    await supabaseAdmin.from("outreach_emails").delete().eq("parent_id", initialId).eq("kind", "negotiation").eq("status", "draft");
    const itype = cls.interventionType ?? "other";
    await updateOutreachEmail(initialId, {
      negotiation_status: "needs_human",
      intervention_type: itype,
      intervention_ask: cls.interventionAsk ?? "asked for something the AI cannot do",
      intervention_reason: INTERVENTION_REASON[itype] ?? INTERVENTION_REASON.other,
      intervention_at: new Date().toISOString(),
      negotiation_notes: `needs human: ${itype} — ${cls.interventionAsk ?? ""}`,
    } as any);
    return { ...base, ok: true, ceiling, intent: cls.intent, statusHint: "needs_human", persistedAs: "needs_human" };
  }

  // When assisting, load any uploaded document so the draft can truthfully say it's attached.
  let asset: { name: string; mime: string; b64: string } | null = null;
  if (assisting) {
    const { data: a } = await supabaseAdmin.from("outreach_emails")
      .select("intervention_asset_name, intervention_asset_mime, intervention_asset_b64").eq("id", initialId).maybeSingle();
    if ((a as any)?.intervention_asset_b64) asset = { name: (a as any).intervention_asset_name || "attachment", mime: (a as any).intervention_asset_mime || "application/octet-stream", b64: (a as any).intervention_asset_b64 };
  }

  // Sign as the person whose inbox this reply is sent from (initial.sender_email).
  const senderCfg = (initial as any).sender_email ? await getUserEmailConfig((initial as any).sender_email).catch(() => null) : null;
  const senderName = (senderCfg?.from_name?.trim().split(/\s+/)[0]) || firstNameFromEmail((initial as any).sender_email);

  const publication = dom?.name ?? dom?.host ?? "";
  const authorFull = (email as any).author?.full_name ?? "there";
  const first = (authorFull || "there").trim().split(/\s+/)[0] || "there";
  const signer = senderName || "Abdullah";

  // ── Decide the next move on the link-exchange ladder ──────────────────────────
  const usCount = thread.filter((m) => m.from === "us").length;
  const stage: NegotiationStage = normalizeStage((initial as any).negotiation_stage);
  const offeredSlugs = offeredSlugsFrom((initial as any).exchange_offer);
  const topicHint = `${publication} ${initial.subject ?? ""} ${latestReply?.reply_excerpt ?? ""}`.trim();
  const partnerBrand = dom?.name ?? (dom?.host ? String(dom.host).replace(/^www\./, "").split(".")[0] : null);

  let mode: "exchange" | "money" = "money";
  let action: LadderAction | undefined;
  let nextStage: NegotiationStage | null = null;
  let offer: { slug: string; url: string } | null = null;
  let target: { url: string; anchor: string } | null = null;
  let draft: DraftResult | null = null;

  if (settings.link_exchange_first && assisting) {
    // A human is directing this thread (they typed what to do). Draft with their input rather than
    // re-running the autonomous ladder: the money stage stays money; exchange stages draft a push
    // that incorporates the human's steer. The reply is always forceDraft, so it's reviewed first.
    // Assisting a worthiness_review handoff IS the "worth pursuing" verdict — record the override
    // on the domain so the gate does not re-flag this partner on their next reply.
    if ((initial as any).intervention_type === "worthiness_review" && dom?.id) {
      await markWorthinessOverride(dom.id, null).catch(() => {});
    }
    if (stage === "money") { mode = "money"; action = "go_money"; nextStage = "money"; }
    else { mode = "exchange"; action = "push_exchange"; nextStage = stage === "link_exchange" ? "link_exchange_push" : stage; }
  } else if (settings.link_exchange_first) {
    const decision = nextNegotiationStep({ stage, cls, settings, ceiling, usCount, offeredSlugs });
    nextStage = decision.nextStage;

    if (decision.action === "handoff") {
      await flagNeedsHuman(
        initialId,
        decision.interventionType ?? "other",
        decision.reason ?? "needs a person",
        `needs human (${stage}): ${decision.interventionType ?? "other"} — ${decision.reason ?? ""}`,
      );
      return { ...base, ok: true, ceiling, intent: cls.intent, statusHint: "needs_human", persistedAs: "needs_human" };
    } else if (decision.action === "close_declined") {
      draft = { body: `Hi ${first},\n\nTotally understand, thanks for letting me know and no worries at all. If anything changes down the line, my door is open. Wishing you well.\n\nBest,\n${signer}`, suggestedOffer: null, shouldStop: true, statusHint: "declined" };
    } else if (decision.action === "close_agreed") {
      const onOur = (initial as any).exchange_offer?.current?.url ? ` on ${(initial as any).exchange_offer.current.url}` : "";
      draft = { body: `Hi ${first},\n\nPerfect, glad it works. I'll get your link added${onOur} and send over the short blurb for the ImagineArt mention so you can add it on your side. Thanks ${first}, great to be working together.\n\nBest,\n${signer}`, suggestedOffer: null, shouldStop: true, statusHint: "agreed" };
    } else if (decision.action === "go_money") {
      mode = "money"; action = "go_money";
    } else {
      mode = "exchange"; action = decision.action; // offer_exchange | push_exchange
    }
  }

  // ── The worthiness gate (§6 quality bar + §8 hard-nos) ────────────────────────
  // Fires exactly when the ladder is about to ENGAGE (offer or push an exchange): is this partner
  // even worth negotiating with? Cached 30 days on the domain, so the page fetch runs once per
  // partner. Red / hard-no → stop, never negotiate. Amber → the SEO Lead decides (§6: "borderline
  // cases go to the SEO Lead"). Green → proceed. Assisted turns skip it (override recorded above).
  if (!draft && mode === "exchange" && settings.worthiness_gate && !assisting && dom?.host) {
    const w = await getOrScoreWorthiness(dom.id ?? null, dom.host, {
      dr: dom.dr ?? null, organicTraffic: dom.organic_traffic ?? null, topic: topicHint,
      thresholds: { green: settings.worthiness_green, amber: settings.worthiness_amber },
    });
    if (w.band === "red") {
      await supabaseAdmin.from("outreach_emails").delete().eq("parent_id", initialId).eq("kind", "negotiation").eq("status", "draft");
      await updateOutreachEmail(initialId, {
        negotiation_status: "not_worth_it",
        negotiation_notes: `not worth it (${w.score}/100${w.hardNo ? `, hard no: ${w.hardNo}` : ""}): ${w.reasons.slice(0, 4).join("; ")}`,
      } as any);
      return { ...base, ok: true, ceiling, intent: cls.intent, statusHint: "not_worth_it", persistedAs: "not_worth_it" };
    }
    if (w.band === "amber") {
      await flagNeedsHuman(initialId, "worthiness_review",
        `scored ${w.score}/100 on the quality bar — ${w.reasons.slice(0, 3).join("; ")}`,
        `needs human: worthiness ${w.score}/100 (amber)`);
      return { ...base, ok: true, ceiling, intent: cls.intent, statusHint: "needs_human", persistedAs: "needs_human" };
    }
  }

  // For exchange mode, pick a concrete OPEN-inventory page (guardrails guaranteed inside the picker).
  if (!draft && mode === "exchange") {
    const pick = pickExchangeOffer(topicHint, { excludeSlugs: offeredSlugs, partnerBrand });
    if (!pick.page) {
      if (!assisting) {
        const itype: InterventionType = /guardrail|§3\.2|comparison|alternatives/i.test(pick.handoffReason ?? "") ? "complex_negotiation" : "link_exchange_failed";
        await flagNeedsHuman(initialId, itype, pick.handoffReason ?? "no page to offer", `needs human: ${pick.handoffReason ?? "no relevant page to offer"}`);
        return { ...base, ok: true, ceiling, intent: cls.intent, statusHint: "needs_human", persistedAs: "needs_human" };
      }
      mode = "money"; action = "go_money"; // assisting: fall back to the money draft
    } else {
      offer = { slug: pick.page.slug, url: pageUrl(pick.page.slug) };
      target = pickLinkTarget(topicHint, settings.link_targets);
    }
  }

  if (!draft) {
    draft = await draftNegotiationReply({
      settings, thread,
      authorName: authorFull,
      publication,
      ceiling, floor: settings.min_price, lastIntent: cls.intent, theirPrice: cls.priceMentioned,
      senderName,
      assistInput: assisting ? opts!.assistInput : null,
      assistHasAttachment: !!asset,
      mode, action, stage: nextStage ?? stage,
      offer, ourTarget: target,
      exchangeBrief: settings.link_exchange_brief,
    });
  }
  if (!draft) return { ...base, ceiling, intent: cls.intent, error: "No OPENROUTER_API_KEY configured" };

  // Post-generation guard tripped inside the agent (model tried to promise a capability with no
  // backing input): route to a human instead of sending the fabricated reply.
  if (draft.needsHuman) {
    await supabaseAdmin.from("outreach_emails").delete().eq("parent_id", initialId).eq("kind", "negotiation").eq("status", "draft");
    const itype = draft.interventionType ?? "other";
    await updateOutreachEmail(initialId, {
      negotiation_status: "needs_human",
      intervention_type: itype,
      intervention_ask: draft.interventionAsk ?? "reply would need something the AI cannot provide",
      intervention_reason: INTERVENTION_REASON[itype] ?? INTERVENTION_REASON.other,
      intervention_at: new Date().toISOString(),
      negotiation_notes: `needs human (guard): ${itype}`,
    } as any);
    return { ...base, ok: true, ceiling, intent: "needs_human", statusHint: "needs_human", persistedAs: "needs_human" };
  }

  const subject = /^re:/i.test(initial.subject ?? "") ? initial.subject : `Re: ${initial.subject ?? "(no subject)"}`;
  const wouldAutoSend = settings.ai_autonomy && !opts?.forceDraft && cls.intent !== "hard_no" && cls.intent !== "unsubscribe" && cls.intent !== "needs_human";
  // Autonomy needs a mailbox to send from. An unstamped legacy thread (its initial left via the
  // retired server-mailbox fallback) has none — deliverOutreach refuses it — and retrying would
  // loop forever: the 30-min processor only skips a thread once a reply is SENT or the thread is
  // parked, so every run would burn an LLM draft and pile up another failed row. Draft once and
  // park the thread for a person instead; their manual Send stamps them as the thread's sender.
  const noSendingMailbox = wouldAutoSend && !initial.sender_email;
  const autonomy = wouldAutoSend && !noSendingMailbox;

  const { data: mc } = await supabaseAdmin.from("contacts").select("value").eq("author_id", initial.author_id).eq("type", "mailto").limit(1).maybeSingle();
  // Test-send override on the initial keeps the whole AI thread on the test address.
  const recipient = ((initial as any).recipient_override && (initial as any).recipient_override.trim())
    || ((mc as any)?.value ?? "").replace(/^mailto:/i, "").trim();
  const parentMsgId = (initial as any).message_id ?? undefined;

  // Clear any previous UNSENT draft so we never pile up stale drafts.
  await supabaseAdmin.from("outreach_emails").delete().eq("parent_id", initialId).eq("kind", "negotiation").eq("status", "draft");

  let status = "draft";
  let sent: any = null;
  if (autonomy && recipient) {
    sent = await deliverOutreach({ to: recipient, subject, body: draft.body, sender: initial.sender_email, sentBy: initial.sent_by_email, inReplyTo: parentMsgId, references: parentMsgId }).catch((e: any) => ({ ok: false, error: e?.message }));
    status = sent?.ok ? "sent" : "failed";
  }

  const { data: row } = await supabaseAdmin.from("outreach_emails").insert({
    workflow_id: initial.workflow_id, author_id: initial.author_id, parent_id: initialId,
    kind: "negotiation", subject, body: draft.body, status,
    sent_at: status === "sent" ? new Date().toISOString() : null,
    message_id: sent?.messageId ?? null,
    error: status === "failed" ? (sent?.error ?? "send failed") : null,
    sender_email: initial.sender_email, sent_by_email: initial.sent_by_email,
    recipient_override: (initial as any).recipient_override ?? null,
    ai_managed: true, max_offer: ceiling, negotiation_status: draft.statusHint,
  }).select("id").single();

  // If they explicitly WAIVED the fee / offered free editorial, an "agreed" is a placement at no
  // cost — never record a payment owed (fixes threads marked agreed with a bogus amount owed).
  const waived = /\b(waive[ds]?|free of charge|no cost|no charge|complimentary|on the house|gratis|won'?t charge)\b/i.test(latestReply?.reply_excerpt ?? "");
  // A link exchange is a placement at no cost, so an exchange-mode "agreed" never records money owed.
  const agreedPrice = draft.statusHint === "agreed"
    ? (mode === "exchange" ? 0 : (waived ? 0 : (draft.suggestedOffer ?? cls.priceMentioned ?? null)))
    : null;
  const newExchangeOffer = (mode === "exchange" && offer)
    ? { offered: Array.from(new Set([...offeredSlugs, offer.slug])), current: { slug: offer.slug, url: offer.url, target_url: target?.url ?? null, target_anchor: target?.anchor ?? null } }
    : ((initial as any).exchange_offer ?? null);
  await updateOutreachEmail(initialId, {
    negotiation_status: draft.statusHint,
    negotiation_notes: settings.link_exchange_first
      ? `stage: ${nextStage ?? stage}; stance: ${cls.exchangeStance ?? "none"}; intent: ${cls.intent} (${cls.reason})${mode === "exchange" && offer ? `; offered /blogs/${offer.slug}` : mode === "money" ? `; money offer: ${draft.suggestedOffer ?? "-"} (ceiling ${ceiling ?? "placement-only"})` : ""}`
      : `their intent: ${cls.intent} (${cls.reason}); our offer: ${draft.suggestedOffer ?? "-"}; ceiling: ${ceiling ?? "placement-only"}`,
    ...(nextStage ? { negotiation_stage: nextStage } : {}),
    ...(newExchangeOffer ? { exchange_offer: newExchangeOffer } : {}),
    ...(draft.statusHint === "agreed" ? { agreed_price: agreedPrice, payment_status: agreedPrice ? "owed" : null } : {}),
    // Assisting resolves the intervention: clear the ask/reason so it leaves the Human-intervention
    // bucket. The uploaded asset (if any) is kept until the reply is actually sent, then cleared.
    ...(assisting ? { intervention_ask: null, intervention_reason: null, intervention_at: null, intervention_type: null } : {}),
    // Last so it wins over statusHint: a thread the AI cannot send on goes to a person.
    ...(noSendingMailbox ? {
      negotiation_status: "needs_human", intervention_type: "other",
      intervention_ask: "Send the drafted reply yourself — this thread has no sending mailbox",
      intervention_reason: "The initial left via the retired server-mailbox fallback, so no user's Gmail owns this thread. Sending the draft yourself stamps the thread as yours from here on.",
      intervention_at: new Date().toISOString(),
    } : {}),
  } as any);

  return {
    ok: true, draftId: (row as any)?.id, body: draft.body, ceiling,
    suggestedOffer: draft.suggestedOffer, statusHint: draft.statusHint, intent: cls.intent,
    autonomy, persistedAs: status, sent: status === "sent",
    sendError: status === "failed" ? (sent?.error ?? "send failed") : null,
    recipientMissing: autonomy && !recipient,
  };
}
