import { NextRequest, NextResponse } from "next/server";
import { identifyCaller, actorFor } from "@/lib/auth/service";
import {
  getUserEmailConfig, getUserAppPasswordEnc,
  updateOutreachEmail, isSuppressed,
  createCampaign, createWorkflow, linkAuthorsToCampaign, addWorkflowProspects,
} from "@/lib/db/queries";
import { resolveInboxSender } from "@/lib/email/manualSender";
import { supabaseAdmin } from "@/lib/db/supabase";
import { decryptSecret } from "@/lib/crypto";
import { sendEmailAs } from "@/lib/email/smtp";
import { isRoleEmail } from "@/lib/enrich/personFilter";
import { emailTrust } from "@/lib/backlinks/pipeline";

export const maxDuration = 30;

/**
 * Start a brand-new thread with someone who has been discovered but never contacted.
 *
 * The Inbox could only ever continue conversations that already existed — every outbound thread had to
 * originate from a workflow send or a backlink campaign. So the obvious thing (you find a good writer,
 * you want to email them now) was the one thing it couldn't do, and people went around the tool.
 *
 * This is a genuine send, so it gets the same guards the batch path has rather than a shortcut around
 * them: suppression list, role-address rejection, the guessed-address gate, and a duplicate check. It
 * also writes a real `outreach_emails` row with `kind: "initial"`, which is what makes the thread appear
 * in the Inbox, count toward the Status page's reply/win rates, and be adoptable by the AI negotiator
 * later. A raw SMTP send with no row would be invisible to every one of those.
 */
/**
 * The workflow every one-off send belongs to.
 *
 * `outreach_emails.workflow_id` is NOT NULL and every list, stat and filter in the app joins through
 * it — the Status page's reply/win rates, the Negotiation thread list, the send queue. Making the
 * column nullable to support one-off sends would mean auditing all of them, and a thread with no
 * workflow would silently disappear from most views.
 *
 * So a one-off gets a real, shared workflow instead: "Direct outreach". It is honest (these ARE a
 * hand-curated campaign), it keeps every existing query working unchanged, and it means direct sends
 * are visible and measurable alongside everything else rather than being a separate invisible class.
 */
async function ensureDirectWorkflow(): Promise<{ workflowId: string; campaignId: string }> {
  const NAME = "Direct outreach";
  const { data: existing, error } = await supabaseAdmin
    .from("workflows").select("id, campaign_id").eq("name", NAME).limit(1).maybeSingle();
  // Throw, don't fall through: an error here read as "no such workflow" and created a DUPLICATE
  // "Direct outreach" campaign, permanently splitting one-off sends across two rows.
  if (error) throw new Error(`Could not look up the Direct outreach workflow (${error.message}).`);
  if (existing) return { workflowId: (existing as any).id, campaignId: (existing as any).campaign_id };

  const campaign = await createCampaign({ name: NAME, keywords: [] });
  const workflow = await createWorkflow({ campaign_id: campaign.id, name: NAME });
  return { workflowId: workflow.id, campaignId: campaign.id };
}

export async function POST(req: NextRequest) {
  const caller = await identifyCaller(req);
  const me = actorFor(caller);
  if (!me) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const authorId = typeof body.author_id === "string" ? body.author_id : null;
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  const toOverride = typeof body.to === "string" ? body.to.trim() : "";

  if (!authorId) return NextResponse.json({ ok: false, error: "Pick a person to email." }, { status: 400 });
  if (!subject) return NextResponse.json({ ok: false, error: "A subject is required." }, { status: 400 });
  if (!text) return NextResponse.json({ ok: false, error: "The message is empty." }, { status: 400 });

  // Reading any team inbox is open; starting a NEW thread from someone else's mailbox is
  // admin-only, and never available to a machine caller.
  const resolved = await resolveInboxSender({
    actor: me, machine: caller?.kind !== "user", requestedAs: req.nextUrl.searchParams.get("as"),
  });
  if (!resolved.ok) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  const account = resolved.account;

  // Resolve the recipient and, importantly, HOW we got the address. Both reads fail CLOSED with
  // the real reason: a DB error here used to declare the person nonexistent, or tell the sender
  // to "re-find" an address that is on file.
  const { data: author, error: authorError } = await supabaseAdmin
    .from("authors").select("id, full_name, primary_domain_id").eq("id", authorId).maybeSingle();
  if (authorError) return NextResponse.json({ ok: false, error: `Could not read that person (${authorError.message}). Nothing was sent.` }, { status: 503 });
  if (!author) return NextResponse.json({ ok: false, error: "That person is not in the database." }, { status: 404 });

  const { data: contact, error: contactError } = await supabaseAdmin
    .from("contacts").select("value, source").eq("author_id", authorId).eq("type", "mailto").limit(1).maybeSingle();
  if (contactError) return NextResponse.json({ ok: false, error: `Could not read their address (${contactError.message}). Nothing was sent.` }, { status: 503 });

  const recipient = toOverride || (contact?.value ? String(contact.value).replace(/^mailto:/, "") : "");
  if (!recipient) {
    return NextResponse.json({ ok: false, error: "No email address on file for this person. Run “Re-find email” first." }, { status: 400 });
  }

  // ---- The same guards the batch send path applies. A one-off must not be a way around them. ----
  // Including the same valve: ALLOW_ROLE_EMAILS=1 deliberately opens shared inboxes here exactly
  // as it does in the send processor — one policy, not two.
  if (isRoleEmail(recipient) && process.env.ALLOW_ROLE_EMAILS !== "1") {
    return NextResponse.json({ ok: false, error: `${recipient} is a generic/role mailbox, not a person. (ALLOW_ROLE_EMAILS=1 permits these deliberately.)` }, { status: 400 });
  }
  // Only gate on trust when we are using the address we found; an explicitly typed override is the
  // sender taking responsibility for it.
  if (!toOverride && emailTrust(contact?.source ?? null) === "guess" && process.env.ALLOW_GUESSED_EMAILS !== "1") {
    return NextResponse.json({
      ok: false,
      error: "That address was constructed from a domain pattern and never verified — sending to it risks a bounce. Type it explicitly to override.",
    }, { status: 400 });
  }
  const domainHost = recipient.split("@")[1] ?? "";
  // Fail CLOSED: a suppression check that cannot run is not a pass. (Sourcing paths keep their
  // fail-open .catch — creating a prospect is reversible; sending is not.)
  try {
    if (domainHost && await isSuppressed(domainHost)) {
      return NextResponse.json({ ok: false, error: `${domainHost} is on the suppression list.` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Could not check the suppression list (${e instanceof Error ? e.message : "read failed"}). Nothing was sent.` }, { status: 503 });
  }

  // Don't quietly start a second conversation with someone already in one. Fail closed — an
  // unreadable history is not an empty one.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("outreach_emails").select("id, status, sent_at")
    .eq("author_id", authorId).eq("kind", "initial")
    .not("sent_at", "is", null).limit(1).maybeSingle();
  if (existingError) return NextResponse.json({ ok: false, error: `Could not check for an existing thread (${existingError.message}). Nothing was sent.` }, { status: 503 });
  if (existing && !body.force) {
    return NextResponse.json({
      ok: false, alreadyContacted: true,
      error: "This person has already been emailed. Open the existing thread, or pass force to email again.",
    }, { status: 409 });
  }

  const pass = decryptSecret(await getUserAppPasswordEnc(account)) ?? null;
  if (!pass) {
    return NextResponse.json({ ok: false, error: `No Gmail app password on file for ${account}. Add it in Settings.` }, { status: 400 });
  }
  const cfg = await getUserEmailConfig(account);

  // The row is created BEFORE the send, so a send that fails still leaves a record of the attempt
  // rather than vanishing. Status is corrected either way once we know the outcome.
  const { workflowId, campaignId } = await ensureDirectWorkflow();
  // Attach the person to the campaign/workflow so the thread is reachable from the normal surfaces,
  // not just from the Inbox that created it.
  await linkAuthorsToCampaign(campaignId, [authorId]).catch(() => {});
  await addWorkflowProspects(workflowId, [authorId]).catch(() => {});

  // Inserted directly rather than through upsertOutreachEmail / updateOutreachEmail. Both are
  // deliberately narrow allow-lists — neither models `kind`, `sender_email`, `sent_by_email`,
  // `ai_managed` or `recipient_override` — and widening a validated allow-list so one caller can pass
  // more fields weakens the guard for the four call sites that depend on it. A compose row genuinely
  // has a shape those helpers do not describe.
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("outreach_emails")
    .insert({
      workflow_id: workflowId,
      author_id: authorId,
      subject, body: text,
      status: "ready",
      kind: "initial",
      sender_email: account,
      sent_by_email: me,
      ai_managed: false,
      recipient_override: toOverride || null,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    return NextResponse.json({ ok: false, error: insErr?.message ?? "Couldn't record the send." }, { status: 500 });
  }
  const row = inserted as { id: string };

  // An admin sending as someone else is CC'd, the same rule deliverOutreach applies to a
  // shared-inbox send: the mailbox owner's Sent box holds the message, and the person who
  // actually clicked stays in the thread to see the reply. (`sent_by_email` above records it too.)
  const cc = resolved.sentBy.toLowerCase() !== account.toLowerCase() ? resolved.sentBy : undefined;
  const res = await sendEmailAs({ user: account, pass, fromName: cfg.from_name, to: recipient, subject, body: text, cc });

  if (!res.ok) {
    await updateOutreachEmail(row.id, { status: "failed", error: res.error ?? "send failed" }).catch(() => {});
    return NextResponse.json({ ok: false, error: res.error ?? "Send failed" }, { status: 500 });
  }

  await updateOutreachEmail(row.id, {
    status: "sent",
    sent_at: new Date().toISOString(),
    message_id: res.messageId ?? null,
  }).catch(() => {});

  return NextResponse.json({ ok: true, id: row.id, to: recipient, from: account, subject });
}
