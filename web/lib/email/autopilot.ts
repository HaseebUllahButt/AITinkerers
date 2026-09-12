// Send autopilot: keeps the scheduled queue topped up from READY initials, per workflow, under
// each workflow's standing policy (outreach_policies — campaign row, else the global default
// row). It never sends and never drafts; it only ever moves ready → scheduled, and the per-30-min
// processor delivers what's due. Three things changed from the Redis-era version this replaces:
//   - policy lives in Postgres (a Redis flush used to read as OFF, silently);
//   - the cap and the on/off switch are PER WORKFLOW, so "run Arham's campaign at 10/day and
//     nobody else's" is expressible;
//   - promotion respects the policy's min_trust floor, so an address the send gate would park
//     anyway (or one the policy distrusts) never occupies a day's slot.
// Every run writes automation_runs rows — the heartbeat that makes a lapsed scheduler visible.
import { supabaseAdmin } from "@/lib/db/supabase";
import { updateOutreachEmail, getUserEmailConfig } from "@/lib/db/queries";
import { inferTimezone } from "@/lib/email/timezones";
import { computeSmartSchedule, type ScheduleRecipient } from "@/lib/email/schedule";
import { getDefaultPolicy, listPolicies, policyActive, policyAllowsTrust, upsertPolicy, type OutreachPolicy } from "@/lib/automation/policy";
import { recordAutomationRun } from "@/lib/automation/runs";
import { emailTrust } from "@/lib/backlinks/pipeline";
import { resolveManualSender } from "@/lib/email/manualSender";

/** Kept for the AutopilotCard UI and /api/emails/autopilot route: the global switch is now the
 *  default policy row. Same names, same meaning, durable storage. */
export async function autopilotEnabled(): Promise<boolean> {
  const p = await getDefaultPolicy();
  return policyActive(p);
}
export async function autopilotCap(): Promise<number> {
  return (await getDefaultPolicy()).daily_cap;
}
export async function setAutopilot(input: { enabled?: boolean; cap?: number }): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
  if (typeof input.cap === "number" && input.cap > 0) patch.daily_cap = Math.min(500, Math.floor(input.cap));
  if (Object.keys(patch).length) await upsertPolicy(null, patch, "autopilot-toggle");
}

interface ReadyRow {
  id: string;
  workflow_id: string | null;
  sender_email: string | null;
  author: {
    timezone?: string | null;
    domain?: { host?: string; country?: string } | null;
    contacts?: { type: string; value: string; source?: string | null }[];
  } | null;
}

export interface AutopilotWorkflowReport {
  workflow_id: string;
  cap: number;
  alreadyQueued: number;
  scheduled: number;
  skippedTrust: number;
  /** Unstamped rows left alone because no identity could own the send. See `actorEmail`. */
  skippedNoSender: number;
  policy: "own" | "default";
}

/**
 * Top each workflow's queue up to its policy's daily cap. `force` is the manual "top up now"
 * button: it overrides enabled/paused (a human is asking), but caps and the trust floor still
 * apply — force means "now", not "more" or "worse".
 *
 * `actorEmail` is the person who clicked. It matters because a cron-drafted pitch has NO sender,
 * and the send processor refuses unstamped rows (the retired env-SMTP fallback used to deliver
 * them from a real teammate's mailbox) — so arming one without an owner just parks it as failed
 * at send time. With an actor we stamp the send as theirs (the same contract as a manual per-row
 * send); without one we leave unstamped rows alone and report them, because guessing an owner is
 * worse than telling someone the queue needs a person.
 */
export async function runAutopilot(opts: { force?: boolean; actorEmail?: string | null } = {}): Promise<{
  enabled: boolean; cap: number; alreadyQueued: number; scheduled: number;
  perWorkflow: AutopilotWorkflowReport[];
  /** Set when unstamped rows were skipped because the actor cannot send yet. */
  needsAppPassword?: { sender: string; reason: string };
}> {
  const defaultPolicy = await getDefaultPolicy();
  const rows = await listPolicies();
  const byWorkflow = new Map(rows.filter((p) => p.workflow_id).map((p) => [p.workflow_id as string, p]));
  const policyFor = (wf: string): { policy: OutreachPolicy; own: boolean } => {
    const own = byWorkflow.get(wf);
    return own ? { policy: own, own: true } : { policy: defaultPolicy, own: false };
  };

  // Nothing can act → heartbeat and out, without the candidate queries.
  const anyActive = policyActive(defaultPolicy) || rows.some((p) => p.workflow_id && policyActive(p));
  if (!anyActive && !opts.force) {
    await recordAutomationRun("autopilot", null, { enabled: false, cap: defaultPolicy.daily_cap, workflows: 0, scheduled: 0 });
    return { enabled: false, cap: defaultPolicy.daily_cap, alreadyQueued: 0, scheduled: 0, perWorkflow: [] as AutopilotWorkflowReport[] };
  }

  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 3600_000).toISOString();

  // What is already queued for the next 24h, per workflow.
  const { data: queuedRows } = await supabaseAdmin
    .from("outreach_emails").select("workflow_id")
    .eq("status", "scheduled").eq("kind", "initial")
    .gte("scheduled_at", now.toISOString()).lt("scheduled_at", in24h)
    .limit(5000);
  const queuedByWf = new Map<string, number>();
  for (const r of (queuedRows ?? []) as { workflow_id: string | null }[]) {
    if (!r.workflow_id) continue;
    queuedByWf.set(r.workflow_id, (queuedByWf.get(r.workflow_id) ?? 0) + 1);
  }

  // Oldest READY initials, generously over-fetched: many lack an email or fail the trust floor.
  const { data } = await supabaseAdmin
    .from("outreach_emails")
    .select("id, workflow_id, sender_email, author:authors(timezone, domain:domains(host, country), contacts(type, value, source))")
    .eq("status", "ready").eq("kind", "initial")
    .order("created_at", { ascending: true })
    .limit(1500);
  const ready = (data ?? []) as unknown as ReadyRow[];

  const perWorkflow: AutopilotWorkflowReport[] = [];
  const reports = new Map<string, AutopilotWorkflowReport & { recipients: ScheduleRecipient[] }>();

  // Can the clicking person own an unstamped send? Resolved ONCE (it is one config read, and the
  // answer is the same for every row). No actor, or an actor without a Gmail app password, means we
  // must not arm unstamped rows at all: they would leave from the server identity.
  // id → the identity to stamp on an otherwise-unstamped row as we arm it.
  const stampById = new Map<string, string>();
  // row id → the sending account that will deliver it.
  const senderByRow = new Map<string, string>();
  let actorSender: string | null = null;
  let needsAppPassword: { sender: string; reason: string } | undefined;
  if (opts.actorEmail) {
    const resolved = await resolveManualSender({ callerEmail: opts.actorEmail, existingSender: null });
    if (resolved.ok) actorSender = resolved.sender;
    else if (resolved.needsAppPassword) needsAppPassword = { sender: resolved.sender, reason: resolved.reason };
  }

  for (const row of ready) {
    const wf = row.workflow_id;
    if (!wf) continue;
    const { policy, own } = policyFor(wf);
    if (!policyActive(policy) && !opts.force) continue;

    let rep = reports.get(wf);
    if (!rep) {
      rep = {
        workflow_id: wf, cap: policy.daily_cap, alreadyQueued: queuedByWf.get(wf) ?? 0,
        scheduled: 0, skippedTrust: 0, skippedNoSender: 0, policy: own ? "own" : "default", recipients: [],
      };
      reports.set(wf, rep);
    }
    if (rep.recipients.length >= Math.max(0, rep.cap - rep.alreadyQueued)) continue;

    // An unstamped row can only be armed if somebody can own it. Otherwise it would send from the
    // server's env-SMTP identity, never reaching the sender's own Sent box.
    const stampAs = row.sender_email ? null : actorSender;
    if (!row.sender_email && !stampAs) { rep.skippedNoSender++; continue; }

    const mailtos = (row.author?.contacts ?? []).filter((c) => c.type === "mailto");
    if (!mailtos.length) continue;
    // The best trust among the author's addresses decides; the send gate re-checks the one that
    // actually goes out.
    const passes = mailtos.some((c) => policyAllowsTrust(emailTrust(c.source ?? null), policy.min_trust));
    if (!passes) { rep.skippedTrust++; continue; }

    const tz = row.author?.timezone || inferTimezone(row.author?.domain?.host, row.author?.domain?.country, "America/New_York");
    if (stampAs) stampById.set(row.id, stampAs);
    // Which mailbox this will leave from. Pacing is per sending account, so the row has to carry
    // it: two workflows can share a sender, and one workflow can span several.
    senderByRow.set(row.id, (row.sender_email ?? stampAs) as string);
    rep.recipients.push({ id: row.id, tz });
  }

  let totalScheduled = 0, totalQueued = 0;
  for (const rep of reports.values()) {
    totalQueued += rep.alreadyQueued;
    if (rep.recipients.length) {
      // Paced with each SENDER's real settings, not a hardcoded UTC 9-17 window.
      //
      // This used to pass `{ gap_minutes: 15, send_hour_start: 9, send_hour_end: 17, timezone:
      // "UTC" }` — invented values that no account has. Under the burst model it barely showed,
      // because every slot collapsed to one instant anyway; with pacing restored those numbers
      // would decide when a real mailbox sends, and a US-hours team would have been paced against
      // a UTC window: 09:00 UTC is 05:00 in New York.
      //
      // Grouped by sender because the gap protects an ACCOUNT: two senders in one workflow can
      // each send on their own clock, and interleaving them against a single cursor would space
      // out mail that never needed spacing.
      const slots: Array<{ id: string; at: string }> = [];
      const bySender = new Map<string, typeof rep.recipients>();
      for (const r of rep.recipients) {
        const sender = senderByRow.get(r.id) ?? "";
        if (!bySender.has(sender)) bySender.set(sender, []);
        bySender.get(sender)!.push(r);
      }
      for (const [sender, mine] of bySender) {
        const cfg = sender ? await getUserEmailConfig(sender).catch(() => null) : null;
        slots.push(...computeSmartSchedule(mine, {
          id: "", workflow_id: "", provider: "smtp" as const, created_at: "",
          timezone: cfg?.timezone ?? "America/New_York",
          send_hour_start: cfg?.send_hour_start ?? 9,
          send_hour_end: cfg?.send_hour_end ?? 17,
          gap_minutes: cfg?.gap_minutes ?? 15,
          daily_cap: cfg?.daily_cap ?? 50,
        }, now));
      }
      // The policy's AI-replies switch rides along onto every row the machine arms. Before this,
      // autopilot never wrote ai_managed at all, so a reply to a machine-sent pitch was a thread
      // the negotiator would not auto-answer and — until the unanswered-reply sweep — nobody
      // drafted for either.
      const aiReplies = policyFor(rep.workflow_id).policy.ai_replies;
      for (const s of slots) {
        const stamp = stampById.get(s.id);
        await updateOutreachEmail(s.id, {
          scheduled_at: s.at, status: "scheduled", ai_managed: aiReplies,
          // Stamped only when the row had no sender: a teammate's own scheduled row stays theirs.
          ...(stamp ? { sender_email: stamp, sent_by_email: stamp } : {}),
        });
        rep.scheduled++; totalScheduled++;
      }
    }
    const { recipients: _drop, ...publicRep } = rep;
    perWorkflow.push(publicRep);
    await recordAutomationRun("autopilot", rep.workflow_id, {
      cap: rep.cap, alreadyQueued: rep.alreadyQueued, scheduled: rep.scheduled,
      skippedTrust: rep.skippedTrust, skippedNoSender: rep.skippedNoSender,
      policy: rep.policy, forced: !!opts.force, actor: opts.actorEmail ?? null,
    });
  }
  // The heartbeat row: written even when nothing was eligible, so a silent scheduler and a quiet
  // night stop being the same absence.
  await recordAutomationRun("autopilot", null, {
    enabled: policyActive(defaultPolicy), cap: defaultPolicy.daily_cap,
    workflows: perWorkflow.length, scheduled: totalScheduled, forced: !!opts.force,
  });

  return {
    enabled: policyActive(defaultPolicy), cap: defaultPolicy.daily_cap,
    alreadyQueued: totalQueued, scheduled: totalScheduled, perWorkflow,
    // Only worth reporting if it actually cost us rows.
    ...(needsAppPassword && perWorkflow.some((w) => w.skippedNoSender > 0) ? { needsAppPassword } : {}),
  };
}
