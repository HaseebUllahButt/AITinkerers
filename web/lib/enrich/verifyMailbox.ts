// The one place that decides WHICH verifier answers "does this mailbox exist?".
//
// Ordering is free-first, deliberately. Before this file the order was Reoon → (a local SMTP probe
// that cannot run on Vercel), which meant a vendor sitting at 0 credits was consulted on every
// single call and nothing answered afterwards. Reoon is now the LAST resort rather than the first,
// and it is only consulted when a free route genuinely could not reach a verdict.
//
// Free is not merely cheaper here, it is often better: the free SMTP route control-probes every
// domain (see verifyFree.ts), which is how catch-all is detected at all. What Reoon still adds is
// a datacenter IP with mail reputation, so it can get answers from hosts that refuse our probe.
// That is exactly the case where we fall through to it.
import { verifyReoon, reoonEnabled } from "./reoon";
import { verifyFree, type MailboxVerdict } from "./verifyFree";
import { freeOnlyMode } from "@/lib/providers/policy";

export type { MailboxVerdict } from "./verifyFree";

// The free-only switch lives in providers/policy.ts — one definition, so a second copy here
// cannot drift from it. Re-exported because callers of this module already import it from here.
export { freeOnlyMode } from "@/lib/providers/policy";

/** Statuses that settle the question. Anything else means we did not get an answer, and the
 *  paid route is worth a try. `catch_all` counts as settled: a second opinion cannot un-catch-all
 *  a domain, so spending a credit to re-learn it is waste. */
const CONCLUSIVE = new Set(["safe", "invalid", "catch_all"]);

export function isConclusive(v: MailboxVerdict | null): boolean {
  return !!v && CONCLUSIVE.has(v.status);
}

/**
 * Verify one mailbox. Returns null only when NO verifier could be reached at all — callers must
 * render that as "unchecked" (a statement about the verifier), never as a bad address. That
 * contract is inherited from verifyBulk.ts and is the whole reason this returns a nullable.
 */
export async function verifyMailbox(email: string, onError?: (msg: string) => void): Promise<MailboxVerdict | null> {
  const free = await verifyFree(email, () => { /* a free-route miss is not a provider failure */ });
  if (isConclusive(free)) return free;

  if (!reoonEnabled() || freeOnlyMode()) {
    // No paid fallback available. Hand back whatever the free route managed to say — which may be
    // an honest "probe_refused" — so the caller can distinguish that from having no route at all.
    if (!free) onError?.(freeOnlyMode() ? "free-only mode and no free route answered" : "no free route answered and no REOON_API_KEY");
    return free;
  }

  const paid = await verifyReoon(email, onError);
  if (paid) return { ...paid, provider: "reoon" };
  // Reoon could not answer either. The free route's honest non-answer is still the better report.
  return free;
}
