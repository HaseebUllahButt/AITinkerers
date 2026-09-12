// The unanswered-reply SLA.
//
// One source of truth for "a prospect replied and nobody has answered them yet", read from the
// outreach_unanswered_replies view (scripts/103_reply_sla.mjs). The send-processor's sweep, the
// Negotiation page, the digest, Slack and Hermes all read this — before it, each computed its own
// idea of "answered" and they disagreed: the sweep only ever saw ai_managed threads, so a reply on
// any other thread was answered by nobody and reported by nothing (13 of 17 replies in the 30 days
// to 2026-09-07, 11 of them quoting a price).
//
// The pure helpers below are what the selfcheck pins; getUnansweredReplies THROWS on a failed read,
// because "0 unanswered" is the safety claim this whole module exists to make truthfully.
import { supabaseAdmin } from "@/lib/db/supabase";

export interface UnansweredReply {
  anchorId: string;
  authorId: string | null;
  workflowId: string | null;
  senderEmail: string | null;
  aiManaged: boolean;
  negotiationStatus: string | null;
  replyIntent: string | null;
  replyExcerpt: string | null;
  replyFrom: string | null;
  repliedAt: string;
  lastAnswerAt: string | null;
  ageHours: number;
  /** An unsent AI draft (draft/failed) created after their reply already exists — a person has
   *  something to send, so the sweep must not draft again. */
  hasFreshDraft: boolean;
}

/** Who is expected to answer this reply. */
export type UnansweredOwner = "ai" | "human" | "nobody";

export interface UnansweredVerdict {
  overSla: boolean;
  owner: UnansweredOwner;
  /** 0 = priced reply past the SLA (money on the table, nobody talking); 1 = past the SLA;
   *  2 = inside the SLA. Sort ascending. */
  priority: 0 | 1 | 2;
  priced: boolean;
  label: string;
}

const PRICED_INTENTS = new Set(["asks_price", "counter_offer", "accept"]);
const PRICE_RE = /(?:\$|usd|eur|gbp|€|£)\s?\d|\d+\s?(?:\$|usd|dollars|eur|gbp|€|£)\b/i;

/** Does this reply put money on the table (a quoted price or a price question)? Pure. */
export function isPricedReply(intent: string | null, excerpt: string | null): boolean {
  if (intent && PRICED_INTENTS.has(intent)) return true;
  return PRICE_RE.test(excerpt ?? "");
}

/** Pure. `slaHours` comes from negotiation_settings.reply_sla_hours. */
export function classifyUnanswered(r: Pick<UnansweredReply, "aiManaged" | "negotiationStatus" | "replyIntent" | "replyExcerpt" | "ageHours">, slaHours: number): UnansweredVerdict {
  const parked = r.negotiationStatus === "needs_human" || r.negotiationStatus === "handoff";
  const owner: UnansweredOwner = parked ? "human" : r.aiManaged ? "ai" : "nobody";
  const overSla = r.ageHours > Math.max(0, slaHours);
  const priced = isPricedReply(r.replyIntent, r.replyExcerpt);
  const priority: 0 | 1 | 2 = overSla ? (priced ? 0 : 1) : 2;
  const age = r.ageHours < 48 ? `${Math.floor(r.ageHours)}h` : `${Math.floor(r.ageHours / 24)}d`;
  const label = `${age} unanswered${priced ? ", priced" : ""}${owner === "human" ? ", parked for a person" : owner === "nobody" ? ", no AI send on this thread" : ""}`;
  return { overSla, owner, priority, priced, label };
}

/** Lines for the digest and Slack. Pure — renders exactly what it is given, so "0 unanswered" and
 *  "unreadable" can never look alike (the caller prints the unreadable line itself). */
export function formatSlaSummary(rows: UnansweredReply[], slaHours: number): string[] {
  const verdicts = rows.map((r) => ({ r, v: classifyUnanswered(r, slaHours) }))
    .sort((a, b) => a.v.priority - b.v.priority || b.r.ageHours - a.r.ageHours);
  const over = verdicts.filter((x) => x.v.overSla);
  const priced = over.filter((x) => x.v.priced);
  const lines: string[] = [];
  lines.push(`Replies waiting on us: ${rows.length} unanswered, ${over.length} older than ${slaHours}h${priced.length ? ` (${priced.length} with a price on the table)` : ""}.`);
  for (const { r, v } of over.slice(0, 10)) {
    const who = r.replyFrom ?? r.senderEmail ?? "a prospect";
    const gist = (r.replyExcerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
    lines.push(`  ${who}: ${v.label}${gist ? ` — "${gist}${(r.replyExcerpt ?? "").length > 90 ? "…" : ""}"` : ""}`);
  }
  if (over.length > 10) lines.push(`  …and ${over.length - 10} more past the SLA.`);
  return lines;
}

function rowToUnanswered(row: Record<string, unknown>): UnansweredReply {
  return {
    anchorId: String(row.anchor_id),
    authorId: (row.author_id as string | null) ?? null,
    workflowId: (row.workflow_id as string | null) ?? null,
    senderEmail: (row.sender_email as string | null) ?? null,
    aiManaged: !!row.ai_managed,
    negotiationStatus: (row.negotiation_status as string | null) ?? null,
    replyIntent: (row.reply_intent as string | null) ?? null,
    replyExcerpt: (row.reply_excerpt as string | null) ?? null,
    replyFrom: (row.reply_from as string | null) ?? null,
    repliedAt: String(row.replied_at),
    lastAnswerAt: (row.last_answer_at as string | null) ?? null,
    ageHours: Number(row.age_hours ?? 0),
    hasFreshDraft: !!row.has_fresh_draft,
  };
}

/** Every reply nobody has answered, oldest first. THROWS on a read error: an empty list is the
 *  claim "everyone has been answered", and a failed SELECT must never make that claim. */
export async function getUnansweredReplies(opts: { limit?: number } = {}): Promise<UnansweredReply[]> {
  const { data, error } = await supabaseAdmin
    .from("outreach_unanswered_replies")
    .select("*")
    .order("replied_at", { ascending: true })
    .limit(opts.limit ?? 500);
  if (error) throw new Error(`unanswered replies unreadable: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(rowToUnanswered);
}

/** Backlog numbers for overviews. `null` means unreadable, never zero. */
export async function unansweredBacklog(slaHours: number): Promise<{ unanswered: number | null; overSla: number | null; oldestHours: number | null }> {
  try {
    const rows = await getUnansweredReplies();
    const over = rows.filter((r) => classifyUnanswered(r, slaHours).overSla).length;
    const oldest = rows.reduce((m, r) => Math.max(m, r.ageHours), 0);
    return { unanswered: rows.length, overSla: over, oldestHours: rows.length ? Math.floor(oldest) : 0 };
  } catch {
    return { unanswered: null, overSla: null, oldestHours: null };
  }
}
