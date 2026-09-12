// Bulk mailbox verification with a durable verdict cache — the ground truth behind the
// verify_emails brain tool.
//
// This exists because "are these emails correct?" had no tool that could answer it. The agent
// could only re-filter Hunter confidence scores it had already shown, and every "are you sure?"
// pass shaved the list without adding information — the measured 200 → 100 → a-handful funnel.
// One SMTP pass answers the question once, with verdicts that stay the same when asked twice.
//
// The verifier itself is chosen in verifyMailbox.ts, free routes first. This file owns the
// batching, the durable cache and the honesty rules; it does not care who answered.
//
// Verdict honesty is the whole contract (the OpenRouter-402 lesson, re-learned on Reoon itself,
// which sat at 0 credits for weeks while every check silently answered "unknown"):
// safe / invalid / catch_all / inconclusive are statements about the ADDRESS; "unchecked" is a
// statement about the VERIFIER, and must never be presented as the address being bad. Only
// address verdicts are cached — a provider outage is not knowledge worth storing.
import PQueue from "p-queue";
import { supabaseAdmin } from "@/lib/db/supabase";
import { reoonBalance, reoonEnabled } from "./reoon";
import { verifyMailbox, freeOnlyMode, type MailboxVerdict } from "./verifyMailbox";
import { isRoleEmail, isPlaceholderEmail } from "./personFilter";
import { registrableDomain } from "@/lib/util/domain";

/** A mailbox's existence changes on the timescale of jobs, not days — but it does change, so a
 *  verdict is trusted for a month and then re-earned. Longer than Hunter's 14 (an index snapshot
 *  goes stale faster than an SMTP fact). */
export const VERDICT_CACHE_TTL_DAYS = 30;

/** How long a domain-level catch-all finding is trusted (migration 090). Same 30 days as an
 *  address verdict: a domain's catch-all configuration is more stable than a single mailbox, so if
 *  anything this is conservative. */
export const DOMAIN_ROUTE_TTL_DAYS = 30;

/** Stop launching live checks this long before the turn deadline: a killed tool call discards the
 *  verdicts it already paid for, which is the worst outcome available (see HermesToolCtx.deadlineAt). */
const DEADLINE_MARGIN_MS = 20_000;

export type BulkVerdict = "safe" | "invalid" | "catch_all" | "inconclusive" | "unchecked";

export interface VerifiedRow {
  email: string;
  verdict: BulkVerdict;
  detail: string;
  /** Shared-inbox shape (info@, tips@) — can be a real mailbox, but the send machine refuses it
   *  unless ALLOW_ROLE_EMAILS=1, so it is flagged rather than failed. */
  role: boolean;
  placeholder: boolean;
  cached: boolean;
  credits_spent: 0 | 1;
}

/** Clean, dedupe and cap a raw email list. Junk is COUNTED (`dropped`), and overflow beyond the
 *  cap is COUNTED (`truncated`) — a silent cap reads as "checked everything" when it didn't.
 *  Pure, so the selfcheck can pin it. */
export function normalizeEmailList(raw: unknown, cap = 50): { emails: string[]; dropped: number; truncated: number } {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of list) {
    const e = String(item ?? "").trim().toLowerCase().replace(/^mailto:/, "");
    if (!e) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { dropped++; continue; }
    seen.add(e);
  }
  const all = [...seen];
  return { emails: all.slice(0, cap), dropped, truncated: Math.max(0, all.length - cap) };
}

// Statuses that mean the mailbox is definitively not worth mail. Everything else that is neither
// safe nor catch-all ("unknown", "role_account", "probe_refused", …) is INCONCLUSIVE: the server
// would not say, which is not the same as saying no.
const DEAD_STATUSES = new Set(["invalid", "disposable", "spamtrap"]);

/**
 * Map one verifier outcome (or its absence) to an honest verdict. Pure, for the selfcheck.
 *
 * Provider-agnostic since the free routes landed: the detail line names whichever route actually
 * answered, because "mailbox rejected (via smtp)" and "mailbox rejected (via reoon)" carry
 * different weight when someone is deciding whether to trust it.
 */
export function mapVerifyOutcome(r: MailboxVerdict | null, error: string | null): { verdict: BulkVerdict; detail: string } {
  if (!r) {
    return { verdict: "unchecked", detail: `verifier unavailable${error ? ` (${error})` : ""} — says nothing about the address` };
  }
  const via = r.provider ? ` (via ${r.provider})` : "";
  if (r.catchAll) return { verdict: "catch_all", detail: `domain accepts every address — existence unprovable${via}` };
  if (r.safe) return { verdict: "safe", detail: `mailbox exists and accepts mail${via}` };
  // "No MX" is a fact about the DOMAIN, so saying "mailbox rejected" would misdescribe it — there
  // was no server to do any rejecting.
  if (r.provider === "dns:no-mx") return { verdict: "invalid", detail: "the domain has no mail server at all" };
  if (DEAD_STATUSES.has(r.status)) return { verdict: "invalid", detail: `mailbox rejected${via}` };
  // The measured trap: a 550 that was about OUR IP reputation, not the recipient (forbes.com and
  // microsoft.com both did this). It must read as "we could not check", never as a bad address.
  if (r.status === "probe_refused") {
    return { verdict: "inconclusive", detail: `the mail host refused our probe — this says nothing about the address${via}` };
  }
  return { verdict: "inconclusive", detail: `server would not confirm or deny${via}` };
}

export interface BulkVerifyReport {
  /** One row per input address, in the caller's order. */
  rows: VerifiedRow[];
  /** PAID verifier answers this run. Free-route answers are always 0, which is the point of the
   *  exercise; a non-zero number means a free route could not reach a verdict and Reoon was asked.
   *  Reoon does not bill verdicts it could not reach, so this is the worst case, not an invoice. */
  credits_spent: number;
  /** Stored pattern-guess contacts whose mailbox proved real, upgraded to pattern-verified. */
  trust_upgraded: string[];
  notes: string[];
}

/**
 * Verify a batch of addresses: durable cache first, placeholders short-circuited, then Reoon —
 * grouped by mail domain so one catch-all answer settles the whole domain without further credits.
 *
 * `deadlineAt` is the turn deadline from HermesToolCtx: work stops with margin to spare and the
 * unreached tail comes back "unchecked", because partial results delivered beat complete results
 * discarded.
 */
export async function verifyEmailsBulk(
  emails: string[],
  opts: { deadlineAt?: number } = {},
): Promise<BulkVerifyReport> {
  const notes: string[] = [];
  const byEmail = new Map<string, VerifiedRow>();
  const flags = (email: string) => ({ role: isRoleEmail(email), placeholder: isPlaceholderEmail(email) });

  // 1) The durable cache answers first, with zero credits. A failed cache read only costs money
  //    (everything goes live), never correctness — but it is said out loud, not swallowed.
  const cutoff = new Date(Date.now() - VERDICT_CACHE_TTL_DAYS * 86_400_000).toISOString();
  const { data: cachedRows, error: cacheError } = await supabaseAdmin
    .from("email_verifications").select("email, verdict, detail, checked_at")
    .in("email", emails).gte("checked_at", cutoff);
  if (cacheError) notes.push("The verdict cache could not be read — every address goes to the verifier live.");
  for (const c of cachedRows ?? []) {
    const email = String(c.email);
    byEmail.set(email, {
      email,
      verdict: c.verdict as BulkVerdict,
      detail: `${c.detail ?? c.verdict} — cached ${String(c.checked_at).slice(0, 10)}`,
      ...flags(email),
      cached: true,
      credits_spent: 0,
    });
  }

  // 2) Placeholders never reach the verifier: user@domain.com is a permanent no by construction,
  //    and spending a credit on it would only dignify the junk.
  for (const email of emails) {
    if (byEmail.has(email) || !isPlaceholderEmail(email)) continue;
    byEmail.set(email, {
      email, verdict: "invalid", detail: "documentation placeholder — never a real mailbox",
      role: isRoleEmail(email), placeholder: true, cached: false, credits_spent: 0,
    });
  }

  const pending = emails.filter((e) => !byEmail.has(e));
  let creditsSpent = 0;

  if (pending.length) {
    // 3) Reoon's balance is a NOTE now, not a gate.
    //
    //    It used to decide whether any live check ran at all: at zero credits every pending address
    //    was stamped "unchecked" and the function returned. That was correct about Reoon and wrong
    //    about the world — free routes needing no credits (MX / SMTP / Microsoft HTTPS, see
    //    verifyFree.ts) sat unused while the whole funnel reported "unchecked" for weeks.
    if (freeOnlyMode()) {
      notes.push("PROVIDER_FREE_ONLY=1 — metered verifiers are disabled; free routes only.");
    } else if (!reoonEnabled()) {
      notes.push("REOON_API_KEY is not set — verification ran on free routes only (MX / SMTP / Microsoft).");
    } else {
      const balance = await reoonBalance();
      if (balance && balance.daily + balance.instant <= 0) {
        notes.push("Reoon is OUT OF CREDITS — free routes did the checking. Nothing below is 'bad' merely because Reoon could not answer.");
      } else if (balance) {
        notes.push(`Reoon balance before this run: ${balance.daily} daily + ${balance.instant} instant credits (spent only where a free route could not reach a verdict).`);
      }
    }

    // 4) Live checks, grouped by registrable mail domain: catch-all is a DOMAIN truth, so the
    //    first catch-all answer settles every remaining address there for free. Domains run in
    //    parallel; addresses within a domain run in order so the short-circuit can fire.
    const groups = new Map<string, string[]>();
    for (const email of pending) {
      const d = registrableDomain(email.split("@")[1] ?? "");
      groups.set(d, [...(groups.get(d) ?? []), email]);
    }
    // 4a) Domains already KNOWN to be catch-all are settled before a single packet goes out.
    //     Catch-all is a stable property of the domain, so rediscovering it per address — two RCPTs
    //     each — is pure waste. A failed read only costs time (everything is probed live), so it is
    //     noted rather than swallowed.
    const knownCatchAll = new Set<string>();
    {
      const domainCutoff = new Date(Date.now() - DOMAIN_ROUTE_TTL_DAYS * 86_400_000).toISOString();
      const { data: routeRows, error: routeError } = await supabaseAdmin
        .from("domain_mail_routes").select("domain, catch_all, checked_at")
        .in("domain", [...groups.keys()]).eq("catch_all", true).gte("checked_at", domainCutoff);
      if (routeError) notes.push("The domain route cache could not be read — every domain is probed live.");
      for (const r of routeRows ?? []) knownCatchAll.add(String(r.domain));
    }
    for (const [domain, group] of groups) {
      if (!knownCatchAll.has(domain)) continue;
      for (const email of group) {
        byEmail.set(email, {
          email, verdict: "catch_all",
          detail: `${domain} is on record as accepting every address — existence unprovable, nothing spent`,
          ...flags(email), cached: true, credits_spent: 0,
        });
      }
      groups.delete(domain);
    }

    let deadlineSkipped = 0;
    const refusedDomains: string[] = [];
    const learnedCatchAll: string[] = [];
    const deadline = opts.deadlineAt ? opts.deadlineAt - DEADLINE_MARGIN_MS : null;
    const queue = new PQueue({ concurrency: 3 });
    await Promise.all([...groups.entries()].map(([domain, group]) => queue.add(async () => {
      let domainCatchAll = false;
      // A host that refuses our probe refuses it for reputation or policy reasons, which apply to
      // the whole domain — so learn it once instead of paying a 20s timeout per address.
      let domainRefused: string | null = null;
      for (const email of group) {
        if (domainCatchAll) {
          byEmail.set(email, {
            email, verdict: "catch_all", detail: "same domain already answered catch-all — nothing spent",
            ...flags(email), cached: false, credits_spent: 0,
          });
          continue;
        }
        if (domainRefused) {
          byEmail.set(email, {
            email, verdict: "inconclusive",
            detail: `the mail host for this domain refused our probe (${domainRefused}) — says nothing about the address`,
            ...flags(email), cached: false, credits_spent: 0,
          });
          continue;
        }
        if (deadline && Date.now() > deadline) {
          deadlineSkipped++;
          byEmail.set(email, {
            email, verdict: "unchecked", detail: "not reached before the turn deadline — run verify_emails again for this one",
            ...flags(email), cached: false, credits_spent: 0,
          });
          continue;
        }
        let lastError: string | null = null;
        const r = await verifyMailbox(email, (m) => { lastError = m; }).catch(() => null);
        // Only a PAID answer costs anything. A free route answering is the point of all this.
        const paid = r?.provider === "reoon";
        if (paid) creditsSpent++;
        const outcome = mapVerifyOutcome(r, lastError);
        if (outcome.verdict === "catch_all" && !domainCatchAll) {
          domainCatchAll = true;
          learnedCatchAll.push(domain);
        }
        if (r?.status === "probe_refused") {
          domainRefused = r.provider ?? "probe refused";
          refusedDomains.push(domain);
        }
        byEmail.set(email, { email, ...outcome, ...flags(email), cached: false, credits_spent: paid ? 1 : 0 });
      }
    })));
    if (refusedDomains.length) {
      notes.push(`${refusedDomains.length} domain${refusedDomains.length === 1 ? "" : "s"} refused our probe outright (${[...new Set(refusedDomains)].slice(0, 5).join(", ")}${refusedDomains.length > 5 ? ", …" : ""}). Those addresses are unchecked, not bad — a probe from a datacenter IP with mail reputation gets further.`);
    }
    if (deadlineSkipped) notes.push(`${deadlineSkipped} address${deadlineSkipped === 1 ? "" : "es"} not reached before the turn deadline — run verify_emails again for the rest.`);

    // 4b) Record the catch-all domains we just learned, so the next run settles them for free.
    //     Best-effort: failing to cache a fact must never fail the run that discovered it.
    if (learnedCatchAll.length) {
      await supabaseAdmin.from("domain_mail_routes").upsert(
        [...new Set(learnedCatchAll)].map((domain) => ({ domain, catch_all: true, checked_at: new Date().toISOString() })),
        { onConflict: "domain" },
      ).then(() => {}, () => {});
    }
  }

  // 5) A real verdict is an asset — store it so the next "are these correct?" is free. Placeholder
  //    rows are recomputable for free and "unchecked" is not knowledge; neither is stored.
  //    Best-effort: a cache-write failure must never fail the verification it would have saved.
  const toStore = [...byEmail.values()].filter((r) => !r.cached && !r.placeholder && r.verdict !== "unchecked");
  if (toStore.length) {
    await supabaseAdmin.from("email_verifications").upsert(
      toStore.map((r) => ({ email: r.email, verdict: r.verdict, detail: r.detail, checked_at: new Date().toISOString() })),
      { onConflict: "email" },
    ).then(() => {}, () => {});
  }

  // 6) A pattern guess whose mailbox proved real is exactly what "verified" trust MEANS
  //    (emailTrust: pattern-verified → verified) — the same write the cascade makes when it
  //    verifies at find time, applied to the contacts that were filed before anyone could check.
  //    Constructed sources only: a sourced address is already above verified and stays untouched.
  const safeEmails = [...byEmail.values()].filter((r) => r.verdict === "safe").map((r) => r.email);
  let trustUpgraded: string[] = [];
  if (safeEmails.length) {
    const { data: upgraded } = await supabaseAdmin
      .from("contacts")
      .update({ source: "pattern-verified" })
      .eq("type", "mailto")
      .in("source", ["pattern", "pattern-catchall"])
      .in("value", safeEmails)
      .select("value");
    trustUpgraded = [...new Set((upgraded ?? []).map((u) => String(u.value).toLowerCase()))];
    if (trustUpgraded.length) {
      notes.push(`${trustUpgraded.length} stored pattern-guess contact${trustUpgraded.length === 1 ? "" : "s"} upgraded to verified trust (source: pattern-verified).`);
    }
  }

  return {
    rows: emails.map((e) => byEmail.get(e)).filter((r): r is VerifiedRow => !!r),
    credits_spent: creditsSpent,
    trust_upgraded: trustUpgraded,
    notes,
  };
}
