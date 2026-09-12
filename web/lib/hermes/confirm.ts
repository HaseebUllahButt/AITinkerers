// The confirm-in-chat framework: the model proposes, a human click executes.
//
// Execution is a self-call to the SAME session-only route the page button hits, with the clicking
// user's session cookie forwarded — so every existing guard (publish gate, readiness checks, link
// check, sender resolution, admin checks) applies unchanged, and attribution lands on the human who
// clicked exactly as if they had pressed the button on the page. Replicating those route bodies
// here would fork logic the routes' own comments beg not to fork (the publish ordering guarantee,
// the trust gates); forwarding the cookie keeps one implementation.
//
// The state machine is enforced by resolveHermesAction's guarded UPDATE (WHERE status IN …), so a
// double-click or a stale card resolves zero rows instead of executing twice.
import {
  createHermesAction, getHermesAction, resolveHermesAction,
  type HermesAction, type HermesActionKind,
} from "@/lib/db/queries";
import { validatePolicyPatch } from "@/lib/automation/policy";

export const ACTION_KINDS = [
  "send_emails", "send_reply", "publish_draft", "unpublish_draft", "sync_draft",
  "open_pr", "create_ticket", "post_slack",
  "mark_payment", "request_payment", "set_policy", "fix_404s",
] as const;

/** Proposals a person never clicked go stale: routes change, queues drain, prices move. After this
 *  long a card's Confirm resolves to `expired` instead of executing. */
export const ACTION_TTL_MS = 24 * 60 * 60 * 1000;

const REQUIRED_PARAMS: Record<HermesActionKind, string[]> = {
  send_emails: ["workflow_id"],
  send_reply: ["anchor_id"],
  publish_draft: ["draft_id"],
  unpublish_draft: ["draft_id"],
  sync_draft: ["draft_id"],
  open_pr: ["preview"],
  create_ticket: ["preview"],
  post_slack: ["text"],
  mark_payment: ["email_id", "action"],
  request_payment: ["email_id"],
  // workflow_id is deliberately NOT required: omitted/null targets the global default policy.
  set_policy: ["patch"],
  // The plan already lives in Redis from the sweep; there is nothing to pass, and nothing to pass
  // means nothing that can drift between the card being shown and the person pressing Confirm.
  fix_404s: [],
};

/** Param validation at PROPOSAL time, so the model gets a fixable error immediately rather than the
 *  person clicking Confirm on a card that can only fail. Returns the error, or null when valid. */
export function validateActionParams(kind: HermesActionKind, params: Record<string, unknown>): string | null {
  if (!(ACTION_KINDS as readonly string[]).includes(kind)) {
    return `Unknown action kind "${kind}". Valid kinds: ${ACTION_KINDS.join(", ")}.`;
  }
  const missing = REQUIRED_PARAMS[kind].filter((k) => {
    const v = params[k];
    return v === undefined || v === null || v === "";
  });
  if (missing.length) return `${kind} requires params: ${missing.join(", ")}.`;
  if (kind === "mark_payment" && !["paid", "reset"].includes(String(params.action))) {
    return `mark_payment's action must be "paid" or "reset" (use request_payment to request).`;
  }
  if (kind === "set_policy") {
    // Validated at PROPOSAL time with the same rules the apply route enforces, so a person can
    // never be shown a confirm card whose click could only fail the table's CHECKs.
    if (!params.patch || typeof params.patch !== "object" || Array.isArray(params.patch)) {
      return "set_policy's patch must be an object of policy fields.";
    }
    const invalid = validatePolicyPatch(params.patch as Record<string, unknown>);
    if (invalid) return `set_policy: ${invalid}`;
  }
  return null;
}

export async function proposeAction(
  sessionId: string, kind: HermesActionKind, summary: string, params: Record<string, unknown>,
): Promise<HermesAction> {
  return createHermesAction({ session_id: sessionId, kind, summary, params });
}

export async function declineAction(id: string, resolvedBy: string): Promise<HermesAction | null> {
  return resolveHermesAction(id, "declined", resolvedBy);
}

/** Pure mapping from an action to the route its page button already calls. Exported so the
 *  selfcheck can assert every kind has a route without executing anything. */
export function actionRequest(action: HermesAction): { method: "POST"; path: string; body: Record<string, unknown>; timeoutMs: number } {
  const p = action.params;
  const s = (k: string) => encodeURIComponent(String(p[k] ?? ""));
  switch (action.kind) {
    case "send_emails":
      return { method: "POST", path: `/api/workflows/${s("workflow_id")}/send`,
        body: typeof p.sender_email === "string" && p.sender_email ? { sender_email: p.sender_email } : {}, timeoutMs: 240_000 };
    case "send_reply":
      return { method: "POST", path: `/api/negotiation/${s("anchor_id")}`,
        body: { action: "send", ...(typeof p.body === "string" && p.body ? { body: p.body } : {}) }, timeoutMs: 60_000 };
    case "publish_draft":
      return { method: "POST", path: `/api/blog/drafts/${s("draft_id")}/publish`,
        body: p.force === true ? { force: true } : {}, timeoutMs: 90_000 };
    case "unpublish_draft":
      return { method: "POST", path: `/api/blog/drafts/${s("draft_id")}/unpublish`, body: {}, timeoutMs: 60_000 };
    case "sync_draft":
      return { method: "POST", path: `/api/blog/drafts/${s("draft_id")}/sync`, body: {}, timeoutMs: 60_000 };
    case "open_pr":
      return { method: "POST", path: `/api/indexing/pr`, body: { preview: p.preview }, timeoutMs: 90_000 };
    case "create_ticket":
      return { method: "POST", path: `/api/indexing/ticket`, body: { preview: p.preview }, timeoutMs: 60_000 };
    case "post_slack":
      return { method: "POST", path: `/api/indexing/slack`, body: { text: String(p.text ?? "") }, timeoutMs: 30_000 };
    case "mark_payment":
      return { method: "POST", path: `/api/payments/${s("email_id")}`, body: { action: String(p.action) }, timeoutMs: 30_000 };
    case "request_payment":
      return { method: "POST", path: `/api/payments/${s("email_id")}`, body: { action: "request" }, timeoutMs: 60_000 };
    case "fix_404s":
      return { method: "POST", path: `/api/link-fix/apply`, body: {}, timeoutMs: 120_000 };
    case "set_policy":
      return {
        method: "POST", path: `/api/automation/policy`,
        body: { workflow_id: typeof p.workflow_id === "string" && p.workflow_id ? p.workflow_id : null, patch: p.patch },
        timeoutMs: 30_000,
      };
  }
}

export interface ExecuteResult {
  action: HermesAction;
  /** What to tell the model/user, already safe to display. */
  outcome: "executed" | "failed" | "declined" | "expired" | "conflict";
}

/**
 * Execute a proposed action on behalf of the human who clicked.
 *
 * `cookie` is the raw Cookie header from the click request — forwarding it is what makes the target
 * route see the clicker's real session. `origin` is the click request's own origin, preferred over
 * env so dev and preview deployments hit themselves.
 */
export async function executeAction(
  actionId: string,
  opts: { resolvedBy: string; cookie: string | null; origin?: string },
): Promise<ExecuteResult | null> {
  const action = await getHermesAction(actionId);
  if (!action) return null;

  if (action.status !== "proposed") {
    return { action, outcome: "conflict" };
  }
  if (Date.now() - new Date(action.proposed_at).getTime() > ACTION_TTL_MS) {
    const expired = await resolveHermesAction(actionId, "expired", opts.resolvedBy);
    return { action: expired ?? action, outcome: "expired" };
  }

  // proposed → confirmed is the concurrency gate: only one click wins this UPDATE.
  const confirmed = await resolveHermesAction(actionId, "confirmed", opts.resolvedBy);
  if (!confirmed) {
    const current = await getHermesAction(actionId);
    return { action: current ?? action, outcome: "conflict" };
  }

  const req = actionRequest(confirmed);
  const base = (opts.origin || process.env.APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/$/, "");
  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch(`${base}${req.path}`, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (e: unknown) {
    body = { error: e instanceof Error ? e.message : String(e) };
  }

  // A 2xx whose body says ok:false is a failure — several routes report actionable refusals
  // (needsAppPassword, publish blockers) that way, and marking those "executed" would be the
  // status board lying about a send that never happened.
  const ok = status >= 200 && status < 300 && (body as { ok?: unknown } | null)?.ok !== false;
  const result = { http_status: status, response: body } as Record<string, unknown>;
  const final = await resolveHermesAction(actionId, ok ? "executed" : "failed", opts.resolvedBy, result);
  return { action: final ?? confirmed, outcome: ok ? "executed" : "failed" };
}
