// Automatic follow-ups: for an initial send that got no reply after N days, generate a
// short, personalized nudge and SCHEDULE it (one per recipient) to send ~a day later AS A
// REPLY IN THE SAME THREAD. Scheduling (rather than firing instantly) gives every follow-up
// a visible date and a window to toggle it off individually. The normal send processor then
// delivers it threaded when due. A global kill-switch and a per-email skip flag are the
// safety valves.
import { redis } from "@/lib/redis";
import { llmChat } from "@/lib/providers/llm";
import { getEmailsNeedingFollowup, createFollowupRow, updateOutreachEmail, getUserEmailConfig, getSendConfig, FOLLOWUP_LEAD_MS } from "@/lib/db/queries";
import { computeSmartSchedule } from "@/lib/email/schedule";
import { getDefaultPolicy, listPolicies } from "@/lib/automation/policy";

const ENABLED_KEY = "followups:enabled";
const FOLLOWUP_DAYS = 2;

export async function followupsEnabled(): Promise<boolean> {
  const r = redis();
  if (!r) return true;
  const v = await r.get(ENABLED_KEY).catch(() => null);
  return v === null || v === undefined ? true : !!v; // default ON (user chose fully-automatic)
}
export async function setFollowupsEnabled(on: boolean): Promise<void> {
  const r = redis();
  if (r) await r.set(ENABLED_KEY, on ? 1 : 0);
}

function sanitize(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ", ").replace(/[ \t]{2,}/g, " ").replace(/ ,/g, ",").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function hasPlaceholder(s: string): boolean { return /\[[^\]]{1,40}\]/.test(s) || /\{\{[^}]+\}\}/.test(s); }

async function generateFollowupBody(authorName: string, pubName: string, originalSubject: string, guidance: string | null, senderName: string): Promise<string> {
  const first = (authorName ?? "there").trim().split(/\s+/)[0] || "there";
  const fallback = `Hi ${first},\n\nJust floating this back to the top of your inbox in case it slipped by. Would love to hear your thoughts whenever you get a moment.\n\nBest,\n${senderName}`;
  // No temperature, no max_tokens, no timeout: all three were tuned for Haiku and all three fail
  // SILENTLY on the Opus-class default. A sampling param is a 400 on the frontier models; 200
  // tokens is a budget that thinking eats before the email exists; 20s aborts a turn that thinks
  // first. Each one lands here as "no usable body" and quietly ships the canned fallback to a real
  // recipient, so llmChat picks the frontier-safe values instead. Don't put them back.
  const res = await llmChat({
    prompt: `Write a SHORT, warm follow-up email to ${authorName} at ${pubName}. It is a reply in the same thread as a first outreach email (subject was "${originalSubject}") that they haven't replied to after a couple of days.

HARD RULES:
- 2-3 sentences max. Polite, low-pressure, human. Not pushy, not guilt-trippy.
- It's a REPLY in the thread, so don't re-introduce everything; just gently resurface it.
- Start with "Hi ${first},". End with "Best,\\n${senderName}".
- NEVER use bracketed placeholders. NEVER use em-dashes or en-dashes. Plain text only.${guidance ? `\n\nSENDER'S WRITING DIRECTION (obey): ${guidance}` : ""}

Output ONLY the email body.`,
  });
  if (!res) return fallback; // null covers the old missing-key, non-2xx, timeout and throw paths
  const out = sanitize(res.content.trim());
  return !out || hasPlaceholder(out) ? fallback : out;
}

// The name a follow-up signs off with. This replaced a literal "Abdullah" (the original
// single-mailbox deployment) that kept signing every other sender's nudges with the wrong name.
// The WORKFLOW's send config is asked first because that is the name the thread's initial pitch
// was signed with (its templates fill from there — e.g. "Arham", where the user-level config says
// "Syed Muhammad Arham"); a nudge that suddenly signs differently reads as a different person.
async function senderFirstName(senderEmail: string, workflowId: string | null): Promise<string> {
  const workflowName = workflowId ? await getSendConfig(workflowId).then((c) => c?.from_name).catch(() => undefined) : undefined;
  const userName = workflowName ? undefined : await getUserEmailConfig(senderEmail).then((c) => c.from_name).catch(() => undefined);
  const name = (workflowName ?? userName)?.trim().split(/\s+/)[0];
  if (name) return name;
  const local = senderEmail.split("@")[0].split(/[._-]/)[0];
  return local ? local[0].toUpperCase() + local.slice(1) : senderEmail;
}

export interface FollowupResult { generated: number; scheduled: number; skippedDisabled: boolean; skippedPolicy: number; errors: string[] }

// Generate + SCHEDULE follow-ups (does not send). One per recipient (createFollowupRow's
// parent already guarantees no duplicate). Handles the backlog too: any initial >2 days old
// with no reply/win and no follow-up yet gets one scheduled ~a day out.
export async function runFollowups(force = false): Promise<FollowupResult> {
  const result: FollowupResult = { generated: 0, scheduled: 0, skippedDisabled: false, skippedPolicy: 0, errors: [] };
  // `force` = manual backfill (e.g. the one-time script for the existing backlog); it ignores
  // the global kill-switch but still respects per-email skips and the one-per-recipient rule.
  if (!force && !(await followupsEnabled())) { result.skippedDisabled = true; return result; }

  // Per-workflow veto: a campaign whose standing policy turned follow-ups off keeps its threads
  // quiet without touching anyone else's. The Redis kill-switch above stays the global master.
  const [defaultPolicy, policyRows] = await Promise.all([getDefaultPolicy(), listPolicies()]);
  const policyByWf = new Map(policyRows.filter((p) => p.workflow_id).map((p) => [p.workflow_id as string, p]));
  const followupsAllowed = (wf: string | null) => ((wf && policyByWf.get(wf)) || defaultPolicy).followups_enabled;

  const candidates = await getEmailsNeedingFollowup(FOLLOWUP_DAYS, 50);

  // Follow-up send times, SPACED PER SENDER inside that sender's window.
  //
  // Every follow-up in a run used to get one shared `when` (now + lead), which is why seven left
  // one Gmail together at 20:30 local on 1 Sep 2026 — in a burst, and outside the 09:00-17:00
  // window the account is configured for. A follow-up is a cold chaser to someone who never
  // replied, so it carries the same pattern risk as an initial and gets the same treatment.
  //
  // Times are computed up front, per sender, so the whole run's queue is laid out on one pass:
  // the row that is written first also has the earliest slot, which is the order the drain sends
  // them in. computeSmartSchedule handles the window, the 15-30 minute gap, the daily cap, and
  // the spill into tomorrow.
  const earliest = new Date(Date.now() + FOLLOWUP_LEAD_MS);
  const eligible = candidates.filter((c) => c.recipient && c.sender_email && followupsAllowed(c.workflow_id ?? null));
  const slotsBySender = new Map<string, string[]>();
  for (const sender of new Set(eligible.map((c) => c.sender_email as string))) {
    const mine = eligible.filter((c) => c.sender_email === sender);
    const cfg = await getUserEmailConfig(sender).catch(() => null);
    const config = {
      id: "", workflow_id: "", provider: "smtp" as const, created_at: "",
      timezone: cfg?.timezone ?? "America/New_York",
      send_hour_start: cfg?.send_hour_start ?? 9,
      send_hour_end: cfg?.send_hour_end ?? 17,
      gap_minutes: cfg?.gap_minutes ?? 15,
      daily_cap: cfg?.daily_cap ?? 50,
    };
    slotsBySender.set(
      sender,
      computeSmartSchedule(mine.map((c) => ({ id: c.id, tz: config.timezone })), config, earliest).map((s) => s.at),
    );
  }
  /** Next free slot for this sender. A sender with no slots left (or one that could not be read)
   *  falls back to the lead time rather than losing its follow-up. */
  const nextSlot = (sender: string): string => {
    const queue = slotsBySender.get(sender);
    return queue?.shift() ?? earliest.toISOString();
  };
  const senderNames = new Map<string, string>(); // one config read per sender per run
  for (const c of candidates) {
    if (!followupsAllowed(c.workflow_id ?? null)) { result.skippedPolicy++; continue; }
    // The author has no mailto contact anymore (typically discarded after a bounce elsewhere).
    // There is nobody to send a nudge to, and an unstamped no-recipient row re-matches the
    // candidate query forever — stamping is what drains it from the scan.
    if (!c.recipient) {
      await updateOutreachEmail(c.id, { followup_skipped: true }).catch(() => {});
      result.errors.push(`${c.author_name}: author has no email address on record — follow-up skipped`);
      continue;
    }
    // The initial has no sender on record (it left via the retired env-SMTP fallback). A nudge
    // must come from the same mailbox as the initial to thread honestly, and that mailbox isn't
    // any user's — so don't schedule one the processor would refuse anyway. Marked skipped so it
    // stops re-candidating; a person can still follow up manually from their own account.
    if (!c.sender_email) {
      await updateOutreachEmail(c.id, { followup_skipped: true }).catch(() => {});
      result.errors.push(`${c.recipient}: initial has no sender on record — follow-up skipped`);
      continue;
    }
    try {
      const nameKey = `${c.workflow_id}|${c.sender_email}`;
      if (!senderNames.has(nameKey)) senderNames.set(nameKey, await senderFirstName(c.sender_email, c.workflow_id ?? null));
      const body = await generateFollowupBody(c.author_name, c.publication, c.subject, c.guidance, senderNames.get(nameKey)!);
      const subject = /^re:/i.test(c.subject) ? c.subject : `Re: ${c.subject}`;
      await createFollowupRow({
        workflow_id: c.workflow_id, author_id: c.author_id, parent_id: c.id, subject, body,
        sender_email: c.sender_email, sent_by_email: c.sent_by_email,
        status: "scheduled", scheduled_at: nextSlot(c.sender_email),
      });
      result.generated++; result.scheduled++;
    } catch (e: any) {
      result.errors.push(`${c.recipient}: ${e?.message ?? "followup error"}`);
    }
  }
  return result;
}
