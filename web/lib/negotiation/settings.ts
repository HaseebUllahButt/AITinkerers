import { supabaseAdmin } from "@/lib/db/supabase";
import { DEFAULT_LINK_EXCHANGE_BRIEF, DEFAULT_LINK_TARGETS, type LinkTarget } from "./inventory";

// A pricing tier: the max we'll offer a site that meets these thresholds. Thresholds left
// blank (or 0) don't constrain. UNVERIFIED metrics (null traffic/US-share, because we're on
// the free Ahrefs plan) do NOT fail a threshold — consistent with qualifyProspect — so DR-based
// tiers apply today and tighten automatically once a paid traffic source is connected.
export interface PricingRule {
  min_dr?: number;
  min_traffic?: number;
  min_us_share?: number;
  max_offer: number;
  label?: string;
}

export type Aggressiveness = "gentle" | "balanced" | "firm";

export interface NegotiationSettings {
  ai_autonomy: boolean;       // false = AI drafts for human approval; true = AI sends on its own
  handbook: string;           // the negotiation brief / criteria the model follows
  tone: string;
  aggressiveness: Aggressiveness; // how hard/fast the AI pushes and concedes
  opening_percent: number;    // where in [floor..ceiling] the AI opens (e.g. 40 = 40%)
  style_rules: string;        // hard writing rules for every generated email (e.g. no em dashes)
  max_thread_length: number;  // max AI messages in a thread before it escalates to a human
  min_price: number;          // floor: never offer/accept below this
  currency: string;
  anti_highball: string;
  pricing_rules: PricingRule[];
  // ── Link-exchange ladder ──
  link_exchange_first: boolean;   // true = lead with a link swap, money only as a later layer
  ai_handles_money: boolean;      // false = when the exchange fails, hand to a human; true = AI offers money itself
  link_exchange_brief: string;    // the tone/what-to-ask brief the model follows for exchange offers
  link_targets: LinkTarget[];     // pages of ours we want partners to link to, with anchors
  // ── Partner worthiness gate (§6 quality bar + §8 hard-nos) ──
  worthiness_gate: boolean;       // score the partner before engaging the ladder
  worthiness_green: number;       // score ≥ this → proceed autonomously
  worthiness_amber: number;       // score ≥ this (but < green) → hand to a human; below → not worth it
  // ── Reply SLA ──
  reply_sla_hours: number;        // an unanswered reply older than this is a failure, whoever owns the thread
  updated_at?: string;
}

export const DEFAULT_NEGOTIATION_SETTINGS: NegotiationSettings = {
  ai_autonomy: false,
  handbook:
    "Goal: get Northwind (an AI image/video generation tool) featured or included in the writer's article, roundup, or list. " +
    "ALWAYS aim to pay the LEAST possible. Prefer a free or editorial inclusion, and only offer money if they clearly require it. " +
    "When you do offer, open LOW, concede slowly in small steps, and never jump to the tier ceiling (that is a hard cap, not a target). " +
    "Be genuinely helpful and specific about why Northwind fits their coverage. Keep it human and short. If they clearly decline, thank them and stop.",
  tone: "Warm, concise, human, professional. Never pushy or robotic.",
  aggressiveness: "firm",
  opening_percent: 20,
  style_rules: "Plain text only. Never use em dashes or en dashes; use commas or periods instead. No bracketed placeholders. Keep it short and human.",
  max_thread_length: 4,
  min_price: 0,
  currency: "USD",
  anti_highball:
    "If they open very high, do not anchor to it. Acknowledge, restate our value, come back near our tier ceiling, and move in small steps.",
  pricing_rules: [{ min_dr: 50, min_traffic: 10000, min_us_share: 50, max_offer: 150, label: "DR 50+ & 10k US traffic" }],
  link_exchange_first: true,
  ai_handles_money: false,
  link_exchange_brief: DEFAULT_LINK_EXCHANGE_BRIEF,
  link_targets: DEFAULT_LINK_TARGETS,
  worthiness_gate: true,
  worthiness_green: 60,
  worthiness_amber: 40,
  reply_sla_hours: 24,
};

function parseTargets(raw: any): LinkTarget[] {
  if (!raw) return DEFAULT_NEGOTIATION_SETTINGS.link_targets;
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    const clean = Array.isArray(arr) ? arr.filter((t) => t && typeof t.url === "string" && typeof t.anchor === "string") : [];
    return clean.length ? clean : DEFAULT_NEGOTIATION_SETTINGS.link_targets;
  } catch {
    return DEFAULT_NEGOTIATION_SETTINGS.link_targets;
  }
}

function parseRules(raw: any): PricingRule[] {
  if (!raw) return DEFAULT_NEGOTIATION_SETTINGS.pricing_rules;
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.filter((r) => typeof r?.max_offer === "number") : DEFAULT_NEGOTIATION_SETTINGS.pricing_rules;
  } catch {
    return DEFAULT_NEGOTIATION_SETTINGS.pricing_rules;
  }
}

export async function getNegotiationSettings(): Promise<NegotiationSettings> {
  const { data, error } = await supabaseAdmin.from("negotiation_settings").select("*").eq("id", true).maybeSingle();
  // The default is for a row that was never CREATED, not for a failed read: on an error this
  // used to report autonomy off while the AI was armed, and price every ceiling off the default
  // handbook instead of the stored rules.
  if (error) throw error;
  if (!data) return DEFAULT_NEGOTIATION_SETTINGS;
  return {
    ...DEFAULT_NEGOTIATION_SETTINGS,
    ...data,
    // Coalesce the columns that may be absent (pre-migration) or null so a null cell never
    // shadows a sensible default (the spread above would otherwise let `null` win).
    pricing_rules: parseRules(data.pricing_rules),
    link_exchange_first: data.link_exchange_first ?? DEFAULT_NEGOTIATION_SETTINGS.link_exchange_first,
    ai_handles_money: data.ai_handles_money ?? DEFAULT_NEGOTIATION_SETTINGS.ai_handles_money,
    link_exchange_brief: data.link_exchange_brief || DEFAULT_NEGOTIATION_SETTINGS.link_exchange_brief,
    link_targets: parseTargets(data.link_targets),
    worthiness_gate: data.worthiness_gate ?? DEFAULT_NEGOTIATION_SETTINGS.worthiness_gate,
    worthiness_green: Number(data.worthiness_green ?? DEFAULT_NEGOTIATION_SETTINGS.worthiness_green),
    worthiness_amber: Number(data.worthiness_amber ?? DEFAULT_NEGOTIATION_SETTINGS.worthiness_amber),
    reply_sla_hours: Number(data.reply_sla_hours ?? DEFAULT_NEGOTIATION_SETTINGS.reply_sla_hours),
  };
}

export async function saveNegotiationSettings(patch: Partial<NegotiationSettings>): Promise<NegotiationSettings> {
  const row: any = { id: true, updated_at: new Date().toISOString() };
  for (const k of ["ai_autonomy", "handbook", "tone", "aggressiveness", "opening_percent", "style_rules", "max_thread_length", "min_price", "currency", "anti_highball", "link_exchange_first", "ai_handles_money", "link_exchange_brief", "worthiness_gate", "worthiness_green", "worthiness_amber", "reply_sla_hours"] as const) {
    if (patch[k] !== undefined) row[k] = patch[k];
  }
  if (patch.pricing_rules !== undefined) row.pricing_rules = JSON.stringify(patch.pricing_rules);
  if (patch.link_targets !== undefined) row.link_targets = JSON.stringify(patch.link_targets);
  await supabaseAdmin.from("negotiation_settings").upsert(row, { onConflict: "id" });
  return getNegotiationSettings();
}
