import { verifyMailbox } from "./verifyMailbox";

export type VerifyStatus = "safe" | "invalid" | "catch_all" | "unknown";
export interface Verdict { status: VerifyStatus }

// Unified verify, free routes first — see verifyMailbox.ts for the ordering argument and
// verifyFree.ts for the routes themselves.
//
// This used to try Reoon and then fall back to `deep-email-validator`, which needs local port 25
// and is therefore dead on Vercel; with Reoon at 0 credits that left no working verifier at all.
// The local-SMTP fallback is gone rather than kept alongside: verifyFree's SMTP route does the
// same job and additionally control-probes for catch-all, which deep-email-validator cannot do —
// and catch-all is the distinction the send gate actually turns on.
export async function verifyEmail(email: string, onError?: (msg: string) => void): Promise<Verdict> {
  const v = await verifyMailbox(email, onError);
  if (!v) return { status: "unknown" };
  if (v.catchAll) return { status: "catch_all" };
  if (v.safe) return { status: "safe" };
  // Only a real mailbox rejection is "invalid". A refused or unanswered probe is "unknown" — the
  // measured forbes.com/microsoft.com case, where a 550 was about our IP reputation and not the
  // address. Calling that "invalid" would discard good prospects.
  return { status: v.status === "invalid" ? "invalid" : "unknown" };
}
