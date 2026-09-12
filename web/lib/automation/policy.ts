// Standing policy for the outreach machine — the contract behind "every send is authorized by a
// human click OR by a policy a human confirmed". One row per workflow plus a global default row
// (workflow_id NULL); the default row replaces the old Redis autopilot:enabled/autopilot:cap pair,
// which a Redis flush silently reset to OFF. Reads fall back campaign row → default row → the
// built-in below, so a missing table degrades to today's behaviour (autopilot off) rather than
// throwing inside a cron.
import { supabaseAdmin } from "@/lib/db/supabase";
import { redis } from "@/lib/redis";
import { EMAIL_TRUST_RANK, type EmailTrust } from "@/lib/backlinks/pipeline";

export interface OutreachPolicy {
  id?: string;
  workflow_id: string | null;
  enabled: boolean;
  daily_cap: number;
  min_trust: "verified" | "sourced";
  followups_enabled: boolean;
  weekly_link_goal: number | null;
  auto_source: boolean;
  retry_stale_days: number | null;
  max_offer: number | null;
  paused_reason: string | null;
  /** What autopilot stamps as outreach_emails.ai_managed on the rows it arms — whether the AI
   *  negotiator may auto-send replies on those threads (the send dialog's "AI replies" default).
   *  Replies are drafted for a person on EVERY thread regardless; this only decides auto-send. */
  ai_replies: boolean;
  updated_by: string | null;
  updated_at?: string;
  /** True when this is the BUILT-IN default served because the table could not be read — so
   *  automation_status can say "built-in fallback (table unreadable)" instead of presenting it
   *  as the stored policy. */
  fallback?: boolean;
}

export const BUILTIN_DEFAULT_POLICY: OutreachPolicy = {
  workflow_id: null,
  enabled: false, // sending on a schedule stays opt-in, exactly as the Redis toggle was
  daily_cap: 25,
  min_trust: "verified",
  followups_enabled: true,
  weekly_link_goal: null,
  auto_source: false,
  retry_stale_days: null,
  max_offer: null,
  paused_reason: null,
  ai_replies: true,
  updated_by: null,
};

const PATCHABLE = new Set([
  "enabled", "daily_cap", "min_trust", "followups_enabled", "weekly_link_goal",
  "auto_source", "retry_stale_days", "max_offer", "paused_reason", "ai_replies",
]);

/** Validate a policy patch at PROPOSAL time, so the model gets a fixable error immediately and a
 *  confirm card can never carry values the table's CHECKs would reject. Pure — the selfcheck
 *  asserts the bounds. Returns the error, or null when valid. */
export function validatePolicyPatch(patch: Record<string, unknown>): string | null {
  const keys = Object.keys(patch);
  if (!keys.length) return "empty policy patch — nothing to change";
  for (const k of keys) if (!PATCHABLE.has(k)) return `unknown policy field "${k}"`;
  const bad = (k: string, why: string) => `${k} ${why}`;
  if ("enabled" in patch && typeof patch.enabled !== "boolean") return bad("enabled", "must be true or false");
  if ("followups_enabled" in patch && typeof patch.followups_enabled !== "boolean") return bad("followups_enabled", "must be true or false");
  if ("auto_source" in patch && typeof patch.auto_source !== "boolean") return bad("auto_source", "must be true or false");
  if ("ai_replies" in patch && typeof patch.ai_replies !== "boolean") return bad("ai_replies", "must be true or false");
  if ("daily_cap" in patch) {
    const n = Number(patch.daily_cap);
    if (!Number.isInteger(n) || n < 1 || n > 500) return bad("daily_cap", "must be an integer between 1 and 500");
  }
  if ("min_trust" in patch && patch.min_trust !== "verified" && patch.min_trust !== "sourced") {
    return bad("min_trust", `must be "verified" (sourced+verified addresses) or "sourced" (directly-sourced only)`);
  }
  if ("weekly_link_goal" in patch && patch.weekly_link_goal !== null) {
    const n = Number(patch.weekly_link_goal);
    if (!Number.isInteger(n) || n < 1 || n > 100) return bad("weekly_link_goal", "must be null or an integer between 1 and 100");
  }
  if ("retry_stale_days" in patch && patch.retry_stale_days !== null) {
    const n = Number(patch.retry_stale_days);
    if (!Number.isInteger(n) || n < 7 || n > 365) return bad("retry_stale_days", "must be null or an integer between 7 and 365");
  }
  if ("max_offer" in patch && patch.max_offer !== null) {
    const n = Number(patch.max_offer);
    if (!Number.isFinite(n) || n < 0) return bad("max_offer", "must be null or a non-negative number");
  }
  if ("paused_reason" in patch && patch.paused_reason !== null && typeof patch.paused_reason !== "string") {
    return bad("paused_reason", "must be null or a string");
  }
  return null;
}

/** May autopilot promote an address of this trust under this policy? min_trust is a floor on
 *  EMAIL_TRUST_RANK (sourced 3 > verified 2 > guess 1 > none 0), so "verified" admits exactly the
 *  set the send gate lets through today and "sourced" tightens it. Pure. */
export function policyAllowsTrust(trust: EmailTrust, minTrust: OutreachPolicy["min_trust"]): boolean {
  return EMAIL_TRUST_RANK[trust] >= EMAIL_TRUST_RANK[minTrust];
}

/** A policy row acts only when enabled AND not auto-paused. Pure. */
export function policyActive(p: Pick<OutreachPolicy, "enabled" | "paused_reason">): boolean {
  return p.enabled && !p.paused_reason;
}

/** Anomaly auto-pause threshold: a campaign whose last-7-day sends are bouncing hard stops
 *  spending its own prospects. Ten sends minimum — below that the rate is noise. Pure. */
export function shouldAutoPause(input: { sent7d: number; bounced7d: number }): string | null {
  if (input.sent7d >= 10 && input.bounced7d / input.sent7d > 0.3) {
    return `auto-paused: ${input.bounced7d} of ${input.sent7d} sends in the last 7 days bounced`;
  }
  return null;
}

function rowToPolicy(row: Record<string, unknown>): OutreachPolicy {
  return {
    id: row.id as string,
    workflow_id: (row.workflow_id as string | null) ?? null,
    enabled: !!row.enabled,
    daily_cap: Number(row.daily_cap ?? BUILTIN_DEFAULT_POLICY.daily_cap),
    min_trust: row.min_trust === "sourced" ? "sourced" : "verified",
    followups_enabled: row.followups_enabled !== false,
    weekly_link_goal: row.weekly_link_goal == null ? null : Number(row.weekly_link_goal),
    auto_source: !!row.auto_source,
    retry_stale_days: row.retry_stale_days == null ? null : Number(row.retry_stale_days),
    max_offer: row.max_offer == null ? null : Number(row.max_offer),
    paused_reason: (row.paused_reason as string | null) ?? null,
    ai_replies: row.ai_replies !== false,
    updated_by: (row.updated_by as string | null) ?? null,
    updated_at: row.updated_at as string | undefined,
  };
}

/** The global default row, created on first read. Seeds from the legacy Redis autopilot keys when
 *  they exist so flipping this code live cannot silently turn a running autopilot off. */
export async function getDefaultPolicy(): Promise<OutreachPolicy> {
  const { data, error } = await supabaseAdmin
    .from("outreach_policies").select("*").is("workflow_id", null).maybeSingle();
  // The built-in fallback keeps the cron alive through a read failure and fails safe for
  // sending (enabled:false) — but it is MARKED, so a reader never presents it as stored fact.
  if (error) return { ...BUILTIN_DEFAULT_POLICY, fallback: true };
  if (data) return rowToPolicy(data);

  const seed = { ...BUILTIN_DEFAULT_POLICY };
  try {
    const r = redis();
    if (r) {
      const [en, cap] = await Promise.all([r.get("autopilot:enabled"), r.get("autopilot:cap")]);
      if (en != null) seed.enabled = !!Number(en);
      const n = Number(cap);
      if (Number.isFinite(n) && n > 0) seed.daily_cap = Math.min(500, Math.floor(n));
    }
  } catch { /* legacy seed is best-effort */ }
  const { data: inserted } = await supabaseAdmin
    .from("outreach_policies")
    .insert({ ...seed, updated_by: seed.enabled ? "migrated-from-redis" : null })
    .select().maybeSingle();
  return inserted ? rowToPolicy(inserted) : seed;
}

/** Effective policy for one workflow: its own row when it has one, else the global default.
 *  Throws on a read error — a campaign's OWN caps must not be silently replaced by the default
 *  because a SELECT failed. (The cron callers catch and fall back deliberately.) */
export async function getPolicyFor(workflowId: string): Promise<OutreachPolicy> {
  const { data, error } = await supabaseAdmin
    .from("outreach_policies").select("*").eq("workflow_id", workflowId).maybeSingle();
  if (error) throw error;
  return data ? rowToPolicy(data) : getDefaultPolicy();
}

/** Every policy row, default first — for automation_status and the funnel page. Throws on a
 *  read error: `[]` here is the safety claim "no campaign has a standing policy", and a claim
 *  like that must never be manufactured by a failed read. (getDefaultPolicy above deliberately
 *  keeps its built-in fallback — the CRON must keep running, and the built-in default is
 *  enabled:false, which fails safe for sending. It fails safe for truth too now: see `fallback`.) */
export async function listPolicies(): Promise<OutreachPolicy[]> {
  const { data, error } = await supabaseAdmin
    .from("outreach_policies").select("*")
    .order("workflow_id", { ascending: true, nullsFirst: true });
  if (error) throw error;
  return (data ?? []).map(rowToPolicy);
}

/** Apply a validated patch to a workflow's policy (or the default row when workflowId is null),
 *  creating the row from the current effective values on first write. */
export async function upsertPolicy(
  workflowId: string | null,
  patch: Record<string, unknown>,
  updatedBy: string,
): Promise<OutreachPolicy> {
  const invalid = validatePolicyPatch(patch);
  if (invalid) throw new Error(invalid);
  if (workflowId === null) await getDefaultPolicy(); // ensure the default row exists

  const q = supabaseAdmin.from("outreach_policies").select("id");
  const { data: existing } = workflowId === null
    ? await q.is("workflow_id", null).maybeSingle()
    : await q.eq("workflow_id", workflowId).maybeSingle();

  const stamp = { ...patch, updated_by: updatedBy, updated_at: new Date().toISOString() };
  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("outreach_policies").update(stamp).eq("id", existing.id).select().single();
    if (error) throw error;
    return rowToPolicy(data);
  }
  const base = workflowId === null ? await getDefaultPolicy() : { ...BUILTIN_DEFAULT_POLICY };
  const { id: _drop, updated_at: _drop2, ...baseCols } = base;
  const { data, error } = await supabaseAdmin
    .from("outreach_policies")
    .insert({ ...baseCols, ...stamp, workflow_id: workflowId })
    .select().single();
  if (error) throw error;
  return rowToPolicy(data);
}
