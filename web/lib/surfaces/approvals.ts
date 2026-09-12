// Approving a proposal from the surfaces that render plain text or their own buttons.
//
// Two affordances, one path:
//   - a typed command — `approve a1b2c3d4` / `decline a1b2c3d4` — works on every surface
//   - a native control (Telegram inline keyboard) — callback carries the full action id
//
// Text commands resolve through THIS chat's session, so `approve 8f` can only reach proposals
// this conversation produced. A random eight characters from some other channel's card resolves
// nothing — the scope check is the authorization check.
import { getAgentAction, resolveAction, type AgentAction } from "@/lib/agent";
import { queryOne } from "@/lib/db/pg";
import { findSession, type Surface } from "./store";

export interface ActionCommand {
  decision: "approved" | "declined";
  /** Full action id or its leading characters — the same short ref the reply text prints. */
  ref: string;
}

export function matchActionCommand(text: string): ActionCommand | null {
  const m = text.trim().match(/^(?:\/)?(approve|decline)\s+([0-9a-f-]{4,36})$/i);
  if (!m) return null;
  return {
    decision: m[1].toLowerCase() === "approve" ? "approved" : "declined",
    ref: m[2].toLowerCase(),
  };
}

/** The pending action a ref names — scoped to the session this surface thread maps to. */
export async function pendingActionByRef(
  surface: Surface, workspaceId: string, channelId: string, threadId: string, ref: string,
): Promise<AgentAction | null> {
  const sessionId = await findSession(surface, workspaceId, channelId, threadId);
  if (!sessionId) return null;
  return queryOne<AgentAction>(
    `select id, session_id, kind, params, summary, status, result
       from agent_actions
      where session_id = $1 and status = 'proposed' and id::text like $2
      order by proposed_at desc limit 1`,
    [sessionId, `${ref}%`],
  );
}

/** One-line "what happened" for the surface — mirrors the Slack card's outcome text. */
export function actionOutcomeText(action: AgentAction, decision: "approved" | "declined"): string {
  if (decision === "declined") return "Declined.";
  if (action.status === "executed") {
    const r = (action.result ?? {}) as Record<string, unknown>;
    const detail = r.pr ?? r.messageId ?? r.submitted ?? r.posted;
    return `Executed.${detail ? ` ${String(detail).slice(0, 200)}` : ""}`;
  }
  const err = (action.result as { error?: unknown } | null)?.error;
  return `Approved, but execution failed: ${String(err ?? "unknown").slice(0, 240)}`;
}

/**
 * Resolve an action and return the line to post back. `null` only when the id itself is gone —
 * an already-resolved action returns the "nothing changed" line like the Slack card does.
 */
export async function resolveActionForSurface(input: {
  actionId: string;
  decision: "approved" | "declined";
  resolvedBy: string;
  via: "whatsapp" | "telegram";
}): Promise<string> {
  const existing = await getAgentAction(input.actionId);
  if (!existing) return "That proposal no longer exists.";
  const resolved = await resolveAction({
    actionId: input.actionId,
    decision: input.decision,
    resolvedBy: input.resolvedBy,
    resolvedVia: input.via,
  });
  if (!resolved) return `Already ${existing.status} — nothing changed.`;
  return `${input.decision === "declined" ? "Declined" : "Approved"} by ${input.resolvedBy.replace(/[*_`]/g, "")}. ${actionOutcomeText(resolved, input.decision)}`.trim();
}
