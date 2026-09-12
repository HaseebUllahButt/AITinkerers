import { NextRequest, NextResponse } from "next/server";
import PQueue from "p-queue";
import type { Transporter } from "nodemailer";
import { getDueEmails, updateOutreachEmail, getUserEmailConfig, getUserAppPasswordEnc, getFollowupParent, addressHasOtherSentInitial, logNegotiationActivity } from "@/lib/db/queries";
import { isRoleEmail } from "@/lib/email/roleEmail";
import { normalizeBodyForDedup, IDENTICAL_BODY_LIMIT } from "@/lib/email/massIdentical";
import { supabaseAdmin } from "@/lib/db/supabase";
import { createPooledUserTransport, sendVia } from "@/lib/email/smtp";
import { NO_SENDER_ERROR } from "@/lib/email/deliver";
import { decryptSecret } from "@/lib/crypto";
import { acquireLock, releaseLock, incrDailyCount, getDailyCount } from "@/lib/redis";
import { auth } from "@auth";
import { isPlaceholderEmail } from "@/lib/enrich/personFilter";

export const maxDuration = 300;

// Drain tuning. Concurrency and batch size are what they were under the burst model, because they
// still matter for the kinds this route does NOT pace (negotiation replies) and for a queue spread
// across many senders — each sender contributes at most one paced email per run, so twelve
// senders with due mail still want twelve parallel sends. Pooled transports (maxConnections
// 5/sender) keep Gmail logins sane.
const SEND_CONCURRENCY = 12;
const DRAIN_BATCH = 250;
const TIME_BUDGET_MS = 255_000; // stay under maxDuration (300s) and the 290s lock
const MAX_TOTAL = 8000;         // hard backstop against any pathological loop

const LOCK_KEY = "lock:emails:process";

// Authorized if: no CRON_SECRET configured (local dev), OR the trigger's Bearer token /
// ?key= matches (Vercel cron AND Upstash QStash both send this), OR a valid app session
// (the manual "process now" button).
async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  const session = await auth().catch(() => null);
  return !!session;
}

// Sends any scheduled emails whose time has arrived, PACED (see the drain below).
//
// Any trigger can call this, but the trigger interval is load-bearing now: pacing can only be as
// fine as the poll. Upstash QStash pings it every 10 minutes (scripts/setup-qstash.mjs); the
// Vercel cron entry is a once-a-day backstop and cannot pace anything on its own — on that alone,
// one email goes out per day per sender. A Redis lock ensures overlapping triggers never
// double-send.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const got = await acquireLock(LOCK_KEY, 290, lockToken);
  if (!got) {
    return NextResponse.json({ skipped: "another send run is in progress" });
  }

  const day = new Date().toISOString().slice(0, 10); // UTC date bucket for the daily counter

  // Optional global ceiling on INITIAL sends per UTC day, across every sender — defense-in-depth
  // on top of each sender's own gap and daily_cap. Unset = no global ceiling. Thread replies
  // (followup/negotiation) are exempt from THIS ceiling; follow-ups are still paced per sender by
  // the gate below. Capped initials are DEFERRED 24h, not failed: the row stays scheduled, so the
  // next day's drain picks it up in order. Without Redis the ceiling still holds within each run;
  // with Redis it holds durably across runs.
  const capEnv = Number(process.env.SEND_DAILY_CAP);
  const initialCap = Number.isFinite(capEnv) && capEnv > 0 ? Math.floor(capEnv) : null;
  let initialsToday = initialCap === null ? 0 : await getDailyCount("global-initials", day).catch(() => 0);
  // Per-sender credential + config cache (each email sends from its own user's Gmail).
  // The whole config is cached, not just the name: the pacing gate below needs each sender's
  // gap_minutes, and re-reading it per email would be one query per send.
  type SenderEntry = { pass: string | null; fromName?: string; cfg: Awaited<ReturnType<typeof getUserEmailConfig>> };
  const senderCache = new Map<string, SenderEntry>();
  const senderInfo = async (email: string): Promise<SenderEntry> => {
    if (!senderCache.has(email)) {
      const [enc, cfg] = await Promise.all([getUserAppPasswordEnc(email), getUserEmailConfig(email)]);
      senderCache.set(email, { pass: decryptSecret(enc), fromName: cfg.from_name, cfg });
    }
    return senderCache.get(email)!;
  };
  const senderConfig = async (email: string) => (await senderInfo(email)).cfg;
  // One pooled SMTP transport per sender, reused across the whole burst (closed in finally).
  const txPool = new Map<string, Transporter>();

  let sent = 0, failed = 0, cappedSkipped = 0, dupSkipped = 0;
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];

  try {
    // Reply detection runs BEFORE the send loop — so a follow-up that's due right now sees the
    // freshest reply status and the send-time guard below can park it if the recipient replied
    // since it was scheduled. (Read-only; failures never block sending.)
    let replies = { accountsChecked: 0, repliesFound: 0, errors: [] as string[] };
    try {
      const { runReplyDetection } = await import("@/lib/email/imap");
      replies = await runReplyDetection();
    } catch (e: any) { replies.errors.push(e?.message ?? "reply detection error"); }

    // ── Paced drain ──────────────────────────────────────────────────────────
    //
    // Send due emails in parallel (bounded concurrency, pooled transports), looping until
    // nothing more can go out this run or we near the function time budget.
    //
    // "What can go out this run" is the part that changed. This route used to re-stamp every
    // queued initial onto one instant and then send the lot: 23 initials left one Gmail inside
    // 46 seconds on 2 Sep 2026, which is exactly the pattern spam filters score against, and it
    // is what the outreach team reported. The schedule is spaced again (lib/email/schedule.ts),
    // and the gate below is the second half of that fix, because scheduling alone cannot hold a
    // gap: this route is polled every N minutes, so every email that came due since the last
    // poll is due SIMULTANEOUSLY from the drain's point of view. Two emails 20 minutes apart on
    // paper still leave together if the poller only looks every 30.
    //
    // So pacing is enforced here too, at the point of sending: ONE paced email per sender per
    // run, and only if that sender's last paced send is at least its gap_minutes old. Whatever
    // is deferred stays scheduled and goes out on a later run, in order.
    //
    // Negotiation replies are exempt — they answer a live conversation, and parking a ready
    // answer for 20 minutes is worse than the pattern risk of one extra message. Initials and
    // follow-ups are both paced: a follow-up is a cold chaser and carries the same risk.
    let drained = 0;
    let pacedDeferred = 0;
    /** Everything except a live negotiation reply is paced. `kind` is null on the oldest rows,
     *  which are initials, so an unknown kind is paced rather than exempt. */
    const isPaced = (kind: unknown): boolean => kind !== "negotiation";
    // Senders that have already had their one paced send this run, and each sender's last paced
    // send time (read once per sender, then maintained in memory).
    const pacedThisRun = new Set<string>();
    const lastPacedAt = new Map<string, number | null>();
    const senderGapMs = async (sender: string): Promise<number> => {
      const cfg = await senderConfig(sender);
      const raw = Number(cfg.gap_minutes);
      return (Number.isFinite(raw) && raw > 0 ? Math.min(240, Math.floor(raw)) : 15) * 60_000;
    };
    /** May this sender send a paced email right now? Claims the slot when it may. */
    const claimPacedSlot = async (sender: string): Promise<boolean> => {
      if (pacedThisRun.has(sender)) return false;
      if (!lastPacedAt.has(sender)) {
        // A failed read must not open the gate: pacing exists to protect the sending domain, so
        // an unknown last-send is treated as "just sent" and the email waits for the next run.
        const { data, error } = await supabaseAdmin
          .from("outreach_emails").select("sent_at")
          .eq("sender_email", sender).eq("status", "sent")
          .or("kind.is.null,kind.eq.initial,kind.eq.followup")
          .not("sent_at", "is", null)
          .order("sent_at", { ascending: false }).limit(1);
        if (error) { lastPacedAt.set(sender, Date.now()); }
        else lastPacedAt.set(sender, data?.[0]?.sent_at ? new Date(data[0].sent_at as string).getTime() : null);
      }
      const last = lastPacedAt.get(sender) ?? null;
      if (last !== null && Date.now() - last < await senderGapMs(sender)) return false;
      pacedThisRun.add(sender);
      return true;
    };

    // In-run duplicate-inbox guard: never send two INITIALS to the same address within this
    // run. The DB guard (addressHasOtherSentInitial) only catches ALREADY-SENT initials, and
    // parallel sends can race past it before either is marked sent, so we also claim here.
    const claimedInitialTo = new Set<string>();
    // Sources that mean "we built this address and never confirmed it". Kept in sync with
    // emailTrust() in src/lib/backlinks/pipeline.ts.
    const GUESS_SOURCES = new Set(["pattern", "pattern-catchall", "page-scrape-unmatched"]);
    let guessSkipped = 0;
    let placeholderSkipped = 0;

    // Mass-identical-body guard state: per workflow, how many initials with each exact normalized
    // body have gone out — historically (fetched once per workflow per run) plus in this run.
    // See @/lib/email/massIdentical for what this catches and why the limit is where it is.
    const sentBodyHistory = new Map<string, Map<string, number>>();
    const inRunBodyCounts = new Map<string, number>();
    let identicalSkipped = 0;
    const historicalBodyCounts = async (workflowId: string): Promise<Map<string, number>> => {
      const cached = sentBodyHistory.get(workflowId);
      if (cached) return cached;
      const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
      // A failed read counts as no history — the guard still catches the blast within this run.
      const { data } = await supabaseAdmin
        .from("outreach_emails").select("body")
        .eq("workflow_id", workflowId).eq("kind", "initial").gte("sent_at", since);
      const counts = new Map<string, number>();
      for (const r of (data ?? []) as Array<{ body: string | null }>) {
        const nb = normalizeBodyForDedup(r.body);
        if (nb) counts.set(nb, (counts.get(nb) ?? 0) + 1);
      }
      sentBodyHistory.set(workflowId, counts);
      return counts;
    };

    const sendOne = async (email: any): Promise<void> => {
      if (!email.recipient) {
        await updateOutreachEmail(email.id, { status: "failed", error: "No recipient email address" });
        failed++; results.push({ id: email.id, ok: false, error: "no recipient" });
        return;
      }
      // Role/generic org mailboxes (press@, info@, contacto@, …) are parked by default — not a
      // person, shared across many authors. But the team deliberately uses them as openers that
      // get routed to an editor, so ALLOW_ROLE_EMAILS=1 is the operator's valve to send them
      // (the SEO team's measured practice: the contacto@ reply is what connects them to the
      // author who manages the blog). Default stays off — bounces burn the sending domain.
      if (isRoleEmail(email.recipient) && process.env.ALLOW_ROLE_EMAILS !== "1") {
        await updateOutreachEmail(email.id, { status: "failed", error: "Skipped: generic/role address (not a person). Set ALLOW_ROLE_EMAILS=1 to deliberately send to shared inboxes.", followup_skipped: true });
        results.push({ id: email.id, ok: false, error: "role address" });
        return;
      }
      const isThreadReply = email.kind === "followup" || email.kind === "negotiation";

      // NO fallback identity. The env-SMTP identity is a real teammate's mailbox, and the old
      // fallback delivered other people's unstamped queued rows from it — mail "from" someone who
      // never scheduled anything, with sender_email left null so nobody could tell whose Gmail it
      // actually left. Park the row instead; Send now / Schedule stamp the acting person and
      // retry it as them. Refused FIRST — before the daily-cap slot is reserved and before the
      // duplicate-inbox claim below — because a refused row must not burn a cap slot, and must not
      // claim its recipient: that would fail a properly-stamped initial to the same inbox later in
      // this run as "duplicate" when nothing was ever sent.
      const sender = email.sender_email as string | undefined;
      if (!sender) {
        await updateOutreachEmail(email.id, { status: "failed", error: NO_SENDER_ERROR });
        failed++; results.push({ id: email.id, ok: false, error: "no sender assigned" });
        return;
      }

      // GLOBAL DAILY CEILING (initials only, only when SEND_DAILY_CAP is set). The slot is
      // reserved before any await so twelve parallel sends cannot overshoot it; a slot consumed
      // by a send that then fails is accepted — the ceiling errs conservative.
      if (!isThreadReply && initialCap !== null) {
        if (initialsToday >= initialCap) {
          await updateOutreachEmail(email.id, { scheduled_at: new Date(Date.now() + 24 * 3600_000).toISOString() });
          cappedSkipped++; results.push({ id: email.id, ok: false, error: "daily send ceiling reached — deferred to tomorrow" });
          return;
        }
        initialsToday++;
      }

      // EMAIL-TRUST GATE. A "pattern"/"pattern-catchall" address was CONSTRUCTED from a domain
      // guess, never confirmed to accept mail — and `pattern-verified` has never once appeared in
      // this database, meaning Reoon has confirmed exactly zero of them. Measured before this gate:
      // 163 emails had already been sent to guessed addresses against an overall bounce rate of
      // ~24%, and bounces are what burn a sending domain.
      //
      // Parked rather than deleted, and follow-ups suppressed, so the prospect survives for a real
      // address to be found later. Set ALLOW_GUESSED_EMAILS=1 to deliberately send to guesses.
      if (!isThreadReply && GUESS_SOURCES.has(email.recipientSource ?? "") && process.env.ALLOW_GUESSED_EMAILS !== "1") {
        await updateOutreachEmail(email.id, {
          status: "failed",
          error: "Skipped: address was guessed from a domain pattern, never verified",
          followup_skipped: true,
        });
        guessSkipped++;
        results.push({ id: email.id, ok: false, error: "unverified guessed address" });
        return;
      }

      // A documentation placeholder scraped off a page — `user@domain.com`, `example@domain.com`.
      //
      // This has no ALLOW_ override, unlike the guess gate above, because there is no circumstance in
      // which sending to one is the right call: it is not a low-confidence address, it is not an address
      // at all. It also cannot be caught by the guess gate, which keys on source, because these arrive
      // tagged `page-scrape` — the HIGHEST trust rank in emailTrust(), above pattern-verified.
      //
      // Extraction is now guarded in three places, so nothing new should reach here. This stays as the
      // gate of last resort for the rows written before that fix, which are already in the database.
      if (!isThreadReply && isPlaceholderEmail(email.recipient)) {
        await updateOutreachEmail(email.id, {
          status: "failed",
          error: "Skipped: recipient is a documentation placeholder, not a real mailbox",
          followup_skipped: true,
        });
        placeholderSkipped++;
        results.push({ id: email.id, ok: false, error: "placeholder address" });
        return;
      }

      // MASS-IDENTICAL-BODY GUARD (INITIALS only). Fourteen initials once left one workflow with
      // the same body, greeting aside — six to a single publication; zero replies. The Nth copy
      // of one exact body is refused with instructions, before the duplicate-inbox claim below so
      // a refused row never blocks a later, properly personalized initial to the same inbox.
      // Test sends (recipient_override) are exempt: repeating one body at yourself is the point.
      if (!isThreadReply && !email.recipient_override && email.workflow_id) {
        const nb = normalizeBodyForDedup(email.body);
        if (nb) {
          const runKey = `${email.workflow_id}|${nb}`;
          const already = ((await historicalBodyCounts(email.workflow_id)).get(nb) ?? 0) + (inRunBodyCounts.get(runKey) ?? 0);
          if (already >= IDENTICAL_BODY_LIMIT) {
            await updateOutreachEmail(email.id, {
              status: "failed",
              error: `Skipped: ${already} emails with this exact body already left this workflow — a mass-identical blast reads as spam to recipients and filters alike. Personalize each pitch (the drafter writes a grounded opener per article) before sending.`,
            });
            identicalSkipped++;
            results.push({ id: email.id, ok: false, error: "mass-identical body" });
            return;
          }
          inRunBodyCounts.set(runKey, (inRunBodyCounts.get(runKey) ?? 0) + 1);
        }
      }

      // Duplicate-inbox guard (INITIALS only): skip an initial whose recipient inbox already
      // got an initial (already sent, per the DB, OR claimed earlier in this same run). Follow-
      // ups / negotiation replies continue an existing thread, and admin test-sends
      // (recipient_override) always deliver to the test address, so both are exempt.
      if (!isThreadReply && !email.recipient_override) {
        const key = email.recipient.toLowerCase();
        if (claimedInitialTo.has(key) || await addressHasOtherSentInitial(email.recipient, email.id)) {
          await updateOutreachEmail(email.id, { status: "failed", error: "Skipped: recipient inbox already contacted in another campaign", followup_skipped: true });
          dupSkipped++; results.push({ id: email.id, ok: false, error: "duplicate inbox — contacted elsewhere" });
          return;
        }
        claimedInitialTo.add(key);
      }

      const sentBy = email.sent_by_email as string | undefined;
      // CC whoever actually clicked Send when it went out through a shared inbox, so they
      // see replies and can reply themselves.
      const cc = sentBy && sentBy !== sender ? sentBy : undefined;

      // Follow-ups thread into the original: pull the parent's Message-ID for In-Reply-To.
      // Also a last-second guard — if the recipient replied or converted since this follow-up
      // was scheduled, park it instead of nagging someone who already engaged.
      let inReplyTo: string | undefined;
      if (isThreadReply && email.parent_id) {
        const parent = await getFollowupParent(email.parent_id).catch(() => null);
        // A NUDGE follow-up must not go out if they've since replied/converted. A NEGOTIATION
        // reply is the opposite — it's our answer TO their reply — so it always proceeds.
        if (email.kind === "followup" && (parent?.replied_at || parent?.success_at)) {
          await updateOutreachEmail(email.id, { status: "draft", scheduled_at: null });
          results.push({ id: email.id, ok: false, error: "parent replied — follow-up skipped" });
          return;
        }
        inReplyTo = parent?.message_id ?? undefined;
      }

      const info = await senderInfo(sender);
      if (!info.pass) {
        await updateOutreachEmail(email.id, { status: "failed", error: `Sender ${sender} has no app password set` });
        failed++; results.push({ id: email.id, ok: false, error: "no app password" });
        return;
      }
      let tx = txPool.get(sender);
      if (!tx) { tx = createPooledUserTransport(sender, info.pass); txPool.set(sender, tx); }
      const res = await sendVia(tx, { user: sender, fromName: info.fromName, to: email.recipient, subject: email.subject ?? "(no subject)", body: email.body ?? "", cc, inReplyTo, references: inReplyTo });

      if (res.ok) {
        // Store the Message-ID so IMAP reply detection can thread replies to this send.
        await updateOutreachEmail(email.id, { status: "sent", sent_at: new Date().toISOString(), error: undefined, message_id: res.messageId ?? undefined });
        await incrDailyCount(sender, day).catch(() => {}); // counted for the status page
        // Keep the in-memory pacing clock in step with what just left. `pacedThisRun` is what
        // actually blocks a second paced send this run; this is the value the NEXT run would read
        // from the database anyway, written now so the two can never disagree mid-run.
        if (!isThreadReply || email.kind === "followup") lastPacedAt.set(sender, Date.now());
        if (!isThreadReply) await incrDailyCount("global-initials", day).catch(() => {}); // durable bucket behind SEND_DAILY_CAP
        sent++; results.push({ id: email.id, ok: true });
      } else {
        await updateOutreachEmail(email.id, { status: "failed", error: res.error });
        failed++; results.push({ id: email.id, ok: false, error: res.error });
      }
    };

    const startTs = Date.now();
    // Guard reads (duplicate-inbox, app-password) now THROW on a DB error instead of failing
    // open. A thrown guard leaves the email scheduled (a transient blip must not burn a real
    // send), is counted, and is skipped for the REST of this run so the drain loop cannot
    // hot-loop on the same due row.
    const erroredThisRun = new Set<string>();
    // Rows this run decided not to send yet. They stay `scheduled` and stay due, so without this
    // set the loop below would fetch them again every iteration and spin until the time budget.
    const deferredThisRun = new Set<string>();
    while (Date.now() - startTs < TIME_BUDGET_MS && drained < MAX_TOTAL) {
      const batch = (await getDueEmails(DRAIN_BATCH))
        .filter((e: any) => !erroredThisRun.has(e.id) && !deferredThisRun.has(e.id));
      if (!batch.length) break;

      // Pacing gate. Ordered oldest-scheduled-first by getDueEmails, so the email that has
      // waited longest takes the sender's slot — a follow-up scheduled this morning goes before
      // an initial scheduled this afternoon, rather than whichever the query happened to return.
      const sendable: any[] = [];
      for (const email of batch) {
        const sender = email.sender_email as string | undefined;
        // Unpaced kinds, and rows with no sender at all (sendOne fails those fast and explains
        // why — holding them back would just hide the real error behind a pacing delay).
        if (!isPaced(email.kind) || !sender) { sendable.push(email); continue; }
        if (await claimPacedSlot(sender)) sendable.push(email);
        else { deferredThisRun.add(email.id); pacedDeferred++; }
      }
      if (!sendable.length) break;

      const queue = new PQueue({ concurrency: SEND_CONCURRENCY });
      for (const email of sendable) queue.add(() => sendOne(email).catch((e: unknown) => {
        erroredThisRun.add(email.id);
        failed++;
        results.push({ id: email.id, ok: false, error: `guard read failed — left scheduled for the next run: ${e instanceof Error ? e.message : "unknown"}` });
      }));
      await queue.onIdle();
      drained += sendable.length;
    }
    const due = { length: drained }; // response shape: how many due emails we processed this run

    // Reply sweep — every reply nobody has answered yet gets looked at, whoever owns the thread.
    //
    // This used to select `ai_managed = true` threads only, so a reply on any other thread was
    // answered by nobody and reported by nothing: 13 of the 17 replies in the 30 days to
    // 2026-09-07, 11 of them quoting a price, sat unanswered. ai_managed now means exactly one
    // thing — "the AI may SEND on this thread" — and the set of threads to look at comes from the
    // outreach_unanswered_replies view (lib/negotiation/sla.ts), oldest first:
    //   • AI-managed + autonomy on  → the negotiator answers (bounded per sender per run).
    //   • anything else             → the negotiator DRAFTS once (forceDraft) so a person has a
    //                                 one-click send; has_fresh_draft stops it drafting again every
    //                                 ten minutes.
    // Threads parked for a person (needs_human / handoff) are counted but not touched.
    const negotiations = {
      attempted: 0, sent: 0, drafted: 0, skippedParked: 0, unansweredTotal: null as number | null,
      overSla: null as number | null, errors: [] as string[],
    };
    try {
      const { getNegotiationSettings } = await import("@/lib/negotiation/settings");
      const settings = await getNegotiationSettings();
      const { negotiateThread } = await import("@/lib/negotiation/run");
      const { getUnansweredReplies, classifyUnanswered } = await import("@/lib/negotiation/sla");
      // Throws on a failed read — an empty sweep must never masquerade as "everyone answered".
      const unanswered = await getUnansweredReplies();
      negotiations.unansweredTotal = unanswered.length;
      negotiations.overSla = unanswered.filter((u) => classifyUnanswered(u, settings.reply_sla_hours).overSla).length;
      // A live negotiation reply is unpaced, but ten of them leaving one Gmail in one tick is the
      // burst pattern the paced drain exists to avoid. Three auto-sends per sender per run; the
      // rest stay in the view and go on the next tick, oldest first.
      const AUTO_SENDS_PER_SENDER = 3;
      const autoSentBySender = new Map<string, number>();
      // One LLM pass per thread, and drafting is the expensive step — cap the work per run so
      // the sweep can never starve the follow-up pass or the function budget.
      const MAX_LLM_PASSES = 20;
      for (const u of unanswered.slice(0, 40)) {
        if (Date.now() - startTs > TIME_BUDGET_MS - 45_000) { negotiations.errors.push("sweep stopped at the time budget; the rest go next run"); break; }
        if (negotiations.attempted >= MAX_LLM_PASSES) break;
        if (u.negotiationStatus === "needs_human" || u.negotiationStatus === "handoff") { negotiations.skippedParked++; continue; }
        const { data: thr, error: thrError } = await supabaseAdmin
          .from("outreach_emails").select("kind, status, replied_at, reply_kind, sent_at")
          .or(`id.eq.${u.anchorId},parent_id.eq.${u.anchorId}`);
        // Fail closed: an unreadable thread zeroed sentNegs, so the reply cap and the
        // auto-responder check both failed OPEN — extra AI replies on a live thread.
        if (thrError) { negotiations.errors.push(`thread ${u.anchorId}: read failed (${thrError.message}) — skipped`); continue; }
        const rowsT = (thr ?? []) as any[];
        if (rowsT.some((r) => r.reply_kind === "auto")) continue; // autoresponders aren't negotiated
        // Hard reply cap: never let the AI send more than max_thread_length replies in one
        // thread (default 4). At the cap, escalate to a human instead of endless back-and-forth
        // (prevents the runaway where a re-marked reply made the AI answer the same message N times).
        const sentNegs = rowsT.filter((r) => r.kind === "negotiation" && r.status === "sent").length;
        if (sentNegs >= (settings.max_thread_length ?? 4)) {
          await supabaseAdmin.from("outreach_emails").update({
            negotiation_status: "needs_human", intervention_type: "other",
            intervention_ask: "Long AI back-and-forth, a person should take over",
            intervention_reason: `Reached the ${settings.max_thread_length ?? 4}-reply cap for this thread.`,
            intervention_at: new Date().toISOString(),
          }).eq("id", u.anchorId);
          continue;
        }
        const autonomous = settings.ai_autonomy && u.aiManaged;
        if (autonomous) {
          const sender = u.senderEmail ?? "";
          if ((autoSentBySender.get(sender) ?? 0) >= AUTO_SENDS_PER_SENDER) continue; // next tick
          negotiations.attempted++;
          const r = await negotiateThread(u.anchorId).catch((e: any) => { negotiations.errors.push(e?.message ?? "negotiate error"); return null; });
          if (r?.sent) {
            negotiations.sent++;
            autoSentBySender.set(sender, (autoSentBySender.get(sender) ?? 0) + 1);
            await logNegotiationActivity(u.anchorId, "ai-autonomy", "send", "AI auto-sent a negotiation reply");
          } else if (r?.ok) negotiations.drafted++;
        } else {
          if (u.hasFreshDraft) continue; // a person already has something to send
          negotiations.attempted++;
          const r = await negotiateThread(u.anchorId, { forceDraft: true }).catch((e: any) => { negotiations.errors.push(e?.message ?? "negotiate error"); return null; });
          if (r?.ok) {
            negotiations.drafted++;
            await logNegotiationActivity(u.anchorId, "ai-sla", "draft", "AI drafted a reply because theirs sat unanswered; a person sends it");
          }
        }
      }
    } catch (e: any) { negotiations.errors.push(e?.message ?? "reply sweep error"); }

    // Auto follow-ups — day-2, no-reply initials get a threaded nudge SCHEDULED (kill-switch
    // respected). They send on a later run when due, threaded into the original.
    let followups = { generated: 0, scheduled: 0, skippedDisabled: false, errors: [] as string[] };
    try {
      const { runFollowups } = await import("@/lib/email/followup");
      followups = await runFollowups();
    } catch (e: any) { followups.errors.push(e?.message ?? "followup error"); }

    // The processor's logbook row — skipped when the run touched nothing, because this route fires
    // every ~10 minutes and 144 identical zero rows a day would bury the signal the log exists for.
    // The nightly crons are the heartbeat writers; this row records actual activity.
    const overSla = negotiations.overSla ?? 0;
    if (drained > 0 || sent > 0 || failed > 0 || negotiations.attempted > 0 || followups.scheduled > 0 || replies.repliesFound > 0 || overSla > 0) {
      const { recordAutomationRun } = await import("@/lib/automation/runs");
      await recordAutomationRun("send-processor", null, {
        due: drained, sent, failed, cappedSkipped, pacedDeferred, dupSkipped, guessSkipped, placeholderSkipped, identicalSkipped,
        repliesFound: replies.repliesFound, negotiationsSent: negotiations.sent, negotiationsDrafted: negotiations.drafted,
        unansweredTotal: negotiations.unansweredTotal, overSla: negotiations.overSla, followupsScheduled: followups.scheduled,
      });
    }

    return NextResponse.json({ due: due.length, sent, failed, cappedSkipped, pacedDeferred, dupSkipped, guessSkipped, placeholderSkipped, identicalSkipped, replies, negotiations, followups, results });
  } finally {
    // Close every pooled SMTP connection opened for this burst.
    for (const tx of txPool.values()) { try { tx.close(); } catch { /* best-effort */ } }
    await releaseLock(LOCK_KEY, lockToken);
  }
}

// Vercel cron / QStash may issue GET — support both.
export async function GET(req: NextRequest) {
  return POST(req);
}
