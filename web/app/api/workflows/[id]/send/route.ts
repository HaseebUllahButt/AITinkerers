import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getWorkflowEmails, getWorkflowProspects, getUserEmailConfig, scheduleWorkflowEmails, getContactedAuthorIds, getInboxAccounts } from "@/lib/db/queries";
import { computeSmartSchedule, dailyCapacity, type ScheduleRecipient } from "@/lib/email/schedule";
import { isAdminEmail } from "@/lib/auth/admin";
import type { EmailSendConfig } from "@/lib/types";

export const maxDuration = 300;

// POST — schedule all ready emails for included prospects.
// Body: { sender_email?: string } — omit (or your own address) to send from your own Gmail
// as before; pass a currently-enabled shared inbox's address (managed in Admin) to send
// from that identity instead. Either way, sent_by_email always records who actually
// clicked Send, so attribution isn't lost when sending through a shared inbox.
// Requires the CHOSEN identity to have a Gmail app password set (else needsAppPassword).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await auth().catch(() => null);
    const authEmail = (session?.user?.email as string | undefined) ?? "";
    if (!authEmail) return NextResponse.json({ error: "not signed in" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    // Send from your own Gmail by default. If a different team account is chosen, ACT AS them:
    // send from their Gmail AND attribute it to them (sent_by = them), exactly as if they had
    // signed in and pressed Send. Only accounts with a connected app password are selectable.
    let senderEmail = authEmail;
    let sentByEmail = authEmail;
    let actingAs = false;
    if (typeof body.sender_email === "string" && body.sender_email && body.sender_email.toLowerCase() !== authEmail.toLowerCase()) {
      if (!isAdminEmail(authEmail)) {
        return NextResponse.json({ error: "Only an admin can send as another user." }, { status: 403 });
      }
      const acct = (await getInboxAccounts()).find((a) => a.email.toLowerCase() === body.sender_email.toLowerCase());
      if (!acct) {
        return NextResponse.json({ error: "That account can't be sent from — it has no connected Gmail app password." }, { status: 400 });
      }
      senderEmail = acct.email;
      sentByEmail = acct.email; // full act-as: their Gmail, attributed to them
      actingAs = true;
    }

    const userCfg = await getUserEmailConfig(senderEmail);
    if (!userCfg.hasPassword) {
      return NextResponse.json({
        needsAppPassword: true,
        sender: senderEmail,
        reason: actingAs
          ? `${senderEmail}'s Gmail app password isn't set up yet.`
          : "Add your Gmail app password in Settings so emails send from your own address.",
      });
    }
    // Shape the chosen identity's config for computeSmartSchedule (timezone/window/cap
    // protect whichever Gmail account is actually sending, so they come from its owner).
    const config: EmailSendConfig = {
      id: "", workflow_id: id, provider: "smtp", created_at: "",
      timezone: userCfg.timezone, send_hour_start: userCfg.send_hour_start, send_hour_end: userCfg.send_hour_end,
      gap_minutes: userCfg.gap_minutes, daily_cap: userCfg.daily_cap, from_name: userCfg.from_name, from_email: senderEmail,
    };

    const [emails, { prospects }] = await Promise.all([
      getWorkflowEmails(id),
      getWorkflowProspects(id, { limit: 1000 }),
    ]);

    const includedIds = new Set(prospects.filter((p) => p.included).map((p) => p.author_id));
    const prospectByAuthor = new Map(prospects.map((p) => [p.author_id, p]));

    // Admin test-send: route every email to this address instead of the prospect's. In test
    // mode we bypass the contacted-elsewhere and has-real-email guards so a test always sends.
    const toOverride = typeof body.to_override === "string" ? body.to_override.trim() : "";
    const testMode = !!toOverride;

    // Never contact someone already emailed/queued in another campaign (skipped in test mode).
    const contactedElsewhere = await getContactedAuthorIds(id);

    let skippedContacted = 0;
    const sendable = emails.filter((e) => {
      if (!includedIds.has(e.author_id)) return false;
      if (e.status !== "ready" && e.status !== "scheduled") return false;
      if (!testMode && contactedElsewhere.has(e.author_id)) { skippedContacted++; return false; }
      if (testMode) return true; // override provides the address; no real mailto needed
      const contacts = (prospectByAuthor.get(e.author_id) as any)?.contacts ?? [];
      return contacts.some((c: any) => c.type === "mailto");
    });

    if (sendable.length === 0) {
      return NextResponse.json({
        scheduled: 0,
        skippedContacted,
        reason: skippedContacted > 0
          ? `All candidates were already contacted in another campaign (${skippedContacted} skipped).`
          : "No ready emails with a recipient address — generate first.",
      });
    }

    // Everyone in this sender's queue is scheduled in the sender's own timezone/window.
    const recipients: ScheduleRecipient[] = sendable.map((e) => ({ id: e.id, tz: config.timezone }));

    const slots = computeSmartSchedule(recipients, config, new Date());
    await scheduleWorkflowEmails(id, slots.map((s) => s.id), slots.map((s) => s.at), senderEmail, sentByEmail, body.ai_managed === true, toOverride || undefined);

    return NextResponse.json({
      scheduled: slots.length,
      skippedContacted,
      sender: senderEmail,
      sentBy: sentByEmail,
      // Paced: the queue spans firstAt..lastAt, one send every gap_minutes to 2×gap_minutes
      // inside the window, spilling into later days when a day's window fills. The caller shows
      // both ends, because with a queue of any size "when does this finish" is the real question.
      firstAt: slots[0]?.at,
      lastAt: slots[slots.length - 1]?.at,
      timezone: config.timezone,
      config: {
        timezone: config.timezone, mode: "paced",
        window: `${config.send_hour_start}:00–${config.send_hour_end}:00`,
        gapMinutes: config.gap_minutes, dailyCap: config.daily_cap,
        perDay: dailyCapacity(config),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
