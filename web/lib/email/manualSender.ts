import { getUserEmailConfig, getInboxAccounts } from "@/lib/db/queries";
import { isAdminEmail } from "@/lib/auth/admin";

// Who an INBOX send (a reply, or a one-off compose) goes out as.
//
// `resolveInboxAccount` answers a different question — which mailbox am I LOOKING at — and it is
// deliberately open: any signed-in teammate may read any team inbox. The send paths inherited that
// answer by using the same resolved account as the FROM identity, so anyone signed in could put
// outreach on the wire from a colleague's Gmail, and the reply route recorded nothing at all about
// who actually clicked. Reading a colleague's inbox and sending as them are different powers.
// Viewing stays open; acting as another mailbox is admin-only here, the same rule
// `resolveManualSender` already applies to every other act-as in the app.
//
// One deliberate divergence from that function: sentBy stays the CLICKER rather than becoming the
// mailbox owner. Full act-as is right for a scheduled campaign send, where the row records the
// identity for good; an inbox reply writes no outreach_emails row at all, so the CC that a
// different sentBy produces is the only durable trace of who sent it.
export type InboxSenderResult =
  | { ok: true; account: string; sentBy: string }
  | { ok: false; error: string; status: 400 | 403 };

export async function resolveInboxSender(input: {
  /** The caller's email, or the synthetic actor of a machine caller (`hermes@agent` / `cron`). */
  actor: string;
  /** Agent and cron callers may never act as a person, admin list or not. */
  machine?: boolean;
  requestedAs?: string | null;
}): Promise<InboxSenderResult> {
  const requested = (input.requestedAs ?? "").trim();
  if (!requested || requested.toLowerCase() === input.actor.toLowerCase()) {
    return { ok: true, account: input.actor, sentBy: input.actor };
  }
  if (input.machine) {
    return { ok: false, status: 403, error: "A machine caller cannot send as a person. Drop ?as= to send from its own identity." };
  }
  if (!isAdminEmail(input.actor)) {
    return {
      ok: false, status: 403,
      error: `You can read ${requested}'s inbox, but only an admin can send from it. Reply from your own mailbox, or ask an admin to send this one.`,
    };
  }
  const acct = (await getInboxAccounts()).find((a) => a.email.toLowerCase() === requested.toLowerCase());
  if (!acct) return { ok: false, status: 400, error: "That account can't be sent from — it has no connected Gmail app password." };
  return { ok: true, account: acct.email, sentBy: input.actor };
}

// Who a MANUAL per-row send/schedule goes out as.
//
// The bug this closes: backlink pitches are drafted by the nightly cron, which has no human
// identity, so their sender_email is null. The per-row "Send now" and "Schedule" actions then
// handed that null straight to deliverOutreach, which at the time fell back to the server's
// env-SMTP identity (a real teammate's mailbox — that fallback is gone; unstamped sends are
// refused now), or, with no env SMTP configured, failed. The batch workflow-send route already
// solved this by stamping the clicking user's own Gmail; this is that same contract, factored out
// so the single-row actions get it too.
//
// Precedence: an already-stamped sender is respected (a scheduled row that a teammate set up
// stays theirs); otherwise the caller becomes the sender. An admin may act-as a configured shared
// inbox via `requestedSender`. Either way the chosen identity must have a Gmail app password, or
// the mail cannot go out as them — returned as a needsAppPassword result rather than a silent
// fallback.
export type ManualSenderResult =
  | { ok: true; sender: string; sentBy: string }
  | { ok: false; needsAppPassword: true; sender: string; reason: string }
  | { ok: false; needsAppPassword: false; error: string; status: 400 | 403 };

export async function resolveManualSender(input: {
  callerEmail: string;
  existingSender: string | null | undefined;
  requestedSender?: string | null;
}): Promise<ManualSenderResult> {
  const caller = input.callerEmail;
  let sender = (input.existingSender && input.existingSender.trim()) || caller;
  let sentBy = caller;

  // Explicit act-as (admin only, must be a real configured mailbox) — same rule as the batch route.
  const requested = typeof input.requestedSender === "string" ? input.requestedSender.trim() : "";
  if (requested && requested.toLowerCase() !== caller.toLowerCase()) {
    if (!isAdminEmail(caller)) return { ok: false, needsAppPassword: false, error: "Only an admin can send as another user.", status: 403 };
    const acct = (await getInboxAccounts()).find((a) => a.email.toLowerCase() === requested.toLowerCase());
    if (!acct) return { ok: false, needsAppPassword: false, error: "That account can't be sent from — it has no connected Gmail app password.", status: 400 };
    sender = acct.email;
    sentBy = acct.email; // full act-as: their Gmail, attributed to them
  }

  const cfg = await getUserEmailConfig(sender);
  if (!cfg.hasPassword) {
    return {
      ok: false, needsAppPassword: true, sender,
      reason: sender.toLowerCase() === caller.toLowerCase()
        ? "Add your Gmail app password in Settings → Your sending email, so this sends from your own address and lands in your Sent box."
        : `${sender}'s Gmail app password isn't set up yet.`,
    };
  }
  return { ok: true, sender, sentBy };
}
