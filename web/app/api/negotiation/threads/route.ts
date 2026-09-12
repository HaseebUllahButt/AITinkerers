import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";
import { getNegotiationSettings } from "@/lib/negotiation/settings";
import { maxOfferFor } from "@/lib/negotiation/pricing";
import { getUnansweredReplies, classifyUnanswered, type UnansweredReply } from "@/lib/negotiation/sla";

// GET — every outreach thread that has engagement (a reply / bounce / auto-reply) or is
// AI-managed, classified into triage buckets and priced by the site's DR tier. Powers the
// Negotiation page: needs-reply / negotiating / agreed / hard-no / automated / bounced.
export async function GET() {
  try {
    const settings = await getNegotiationSettings();
    // The try/catch below is NOT protection here: supabase-js reports failures in `error`, it
    // never throws — so an unchecked read returned 200 {threads: []} and the single
    // highest-value list in the app (every needs-reply and agreed deal) silently emptied.
    const { data, error } = await supabaseAdmin
      .from("outreach_emails")
      .select("id, author_id, subject, status, replied_at, bounced_at, reply_kind, reply_sentiment, reply_excerpt, reply_subject, reply_from, negotiation_status, negotiation_stage, exchange_offer, ai_managed, max_offer, sent_at, created_at, sender_email, intervention_type, intervention_reason, intervention_ask, intervention_assist_input, intervention_asset_name, author:authors(full_name, domain:domains(host, name, dr, organic_traffic, us_traffic_share, worthiness_score, worthiness_band, worthiness_hard_no))")
      .eq("kind", "initial")
      .order("sent_at", { ascending: false, nullsFirst: false })
      .limit(1000);
    if (error) return NextResponse.json({ error: `Could not read the threads (${error.message}). They are not gone.` }, { status: 503 });

    const rows = (data ?? []).filter((r: any) => r.replied_at || r.bounced_at || r.ai_managed || r.negotiation_status);

    // "Answered" comes from the same view the sweep, the digest and Hermes read, so the buckets
    // here can never disagree with them. It also fixes two old mislabels: a thread a person
    // answered from the Inbox showed needs_reply (no negotiation child), and a thread answered by
    // an OLDER sent draft showed negotiating after a NEWER reply arrived. Throws → 503, because
    // an empty needs-reply bucket is a claim about people waiting on us.
    let unansweredById: Map<string, UnansweredReply>;
    try {
      unansweredById = new Map((await getUnansweredReplies()).map((u) => [u.anchorId, u]));
    } catch (e) {
      return NextResponse.json({ error: `Could not read which replies are unanswered (${e instanceof Error ? e.message : "read failed"}). The threads are not gone.` }, { status: 503 });
    }

    // The latest negotiation reply per thread (to read/send/regenerate on the page).
    const ids = rows.map((r: any) => r.id);
    const draftByParent = new Map<string, { status: string; body: string; id: string }>();
    for (let i = 0; i < ids.length; i += 300) {
      const { data: kids, error: kidsError } = await supabaseAdmin
        .from("outreach_emails").select("id, parent_id, status, body, created_at")
        .eq("kind", "negotiation").in("parent_id", ids.slice(i, i + 300))
        .order("created_at", { ascending: false });
      // A failed chunk would misclassify every thread in it as needs_reply and hide its draft.
      if (kidsError) return NextResponse.json({ error: `Could not read the drafts (${kidsError.message}).` }, { status: 503 });
      for (const k of kids ?? []) if (!draftByParent.has((k as any).parent_id)) draftByParent.set((k as any).parent_id, { status: (k as any).status, body: (k as any).body, id: (k as any).id });
    }

    const threads = rows.map((r: any) => {
      const dom = r.author?.domain ?? null;
      const tier = maxOfferFor(dom?.dr ?? null, dom?.organic_traffic ?? null, dom?.us_traffic_share ?? null, settings.pricing_rules);
      const ceiling = r.max_offer != null ? Number(r.max_offer) : (tier?.offer ?? null);
      const draft = draftByParent.get(r.id);
      // Buckets: bounced / automated / hard_no / agreed take precedence. Then a reply that we
      // have NOT answered yet = needs_reply; one we've replied to = negotiating. No reply yet
      // (AI-managed, scheduled or sent) = queued (waiting on them).
      // needs_human is checked BEFORE automated so an OOO-with-alternate-contact lands in Human
      // intervention (redirect) rather than the dead-end automated bucket.
      let category: string;
      if (r.bounced_at) category = "bounced";
      else if (r.negotiation_status === "needs_human") category = "needs_human";
      else if (r.negotiation_status === "not_worth_it") category = "not_worth_it";
      else if (r.reply_kind === "auto") category = "automated";
      else if (r.negotiation_status === "declined") category = "hard_no";
      else if (r.negotiation_status === "agreed") category = "agreed";
      else if (r.replied_at) category = unansweredById.has(r.id) ? "needs_reply" : "negotiating";
      else category = "queued";
      const unanswered = unansweredById.get(r.id) ?? null;
      const verdict = unanswered ? classifyUnanswered(unanswered, settings.reply_sla_hours) : null;
      return {
        // Unanswered-reply SLA (null when this thread is not waiting on us).
        ageHours: unanswered ? Math.floor(unanswered.ageHours) : null,
        overSla: verdict?.overSla ?? false,
        owner: verdict?.owner ?? null,
        priced: verdict?.priced ?? false,
        status: r.status,
        id: r.id, authorId: r.author_id, name: r.author?.full_name ?? "Unknown",
        publication: dom?.name ?? dom?.host ?? "", host: dom?.host ?? "", dr: dom?.dr ?? null,
        ceiling, category, replyKind: r.reply_kind, sentiment: r.reply_sentiment,
        repliedAt: r.replied_at, bouncedAt: r.bounced_at, sentAt: r.sent_at, negotiationStatus: r.negotiation_status,
        aiManaged: r.ai_managed, subject: r.subject, replyExcerpt: r.reply_excerpt,
        sender: r.sender_email, replyFrom: r.reply_from,
        stage: r.negotiation_stage ?? null,
        exchangeOffer: r.exchange_offer ?? null,
        worthiness: dom?.worthiness_band ? { score: Number(dom.worthiness_score ?? 0), band: dom.worthiness_band, hardNo: dom.worthiness_hard_no ?? null } : null,
        interventionType: r.intervention_type ?? null,
        interventionReason: r.intervention_reason ?? null,
        interventionAsk: r.intervention_ask ?? null,
        interventionAssistInput: r.intervention_assist_input ?? null,
        interventionAssetName: r.intervention_asset_name ?? null,
        draftStatus: draftByParent.get(r.id)?.status ?? null,
        // Only an UNSENT draft (draft/failed) is editable/sendable. Once sent, it is read-only
        // history (badge "AI replied"), so don't hand the page a body to re-show or re-send.
        draftBody: draftByParent.get(r.id)?.status === "sent" ? null : (draftByParent.get(r.id)?.body ?? null),
      };
    });

    return NextResponse.json({ threads, autonomy: settings.ai_autonomy, currency: settings.currency, slaHours: settings.reply_sla_hours });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
