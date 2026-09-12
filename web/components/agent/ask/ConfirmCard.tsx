"use client";

// SearchOps Agent — the irreversible-action confirmation card.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §9.8. MOVED verbatim in semantics from src/app/hermes/page.tsx.
//
// This card is the point of the whole confirm-in-chat design: the model PROPOSES, the card states
// exactly what it is, and this click is what EXECUTES. It gates real spend and real sends. Nothing
// here may be loosened — not the "proposed only" gate, not the disabled-while-running rule, not the
// failure text. The server re-checks all of it (owner-only, TTL, and a guarded `proposed →
// confirmed` UPDATE that only one click can win), but a card that lets you click a dead action is
// still a card that lied to you.
//
// Three things changed in the move, all from §9.8:
//
//  1. It is a transcript NODE keyed on `actionId`, not an entry in a separate `actions` array
//     rendered after every item — which is why a turn-2 proposal used to float below turn 7's
//     answer.
//  2. Resolution comes from the `confirm_resolved` event so the card rewrites in place; the REST
//     response is the FALLBACK. (The server does not emit that event yet, so today the fallback is
//     what you see — hence the "still proposed?" re-check before applying it.)
//  3. The `deciding` spinner follows the same three-phase pattern as §9.4.

import { useCallback, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAgentStoreInstance } from "../store/hooks";
import type { ActionRow, AgentNode, AgentTransport, ConfirmData } from "../types";

export interface ConfirmCardProps {
  /** A `kind: "confirm"` node. Renders nothing for anything else. */
  node: AgentNode;
  transport: AgentTransport;
  /**
   * A turn is in flight. Preserved from the original card's `disabled={running}`: you cannot
   * resolve a proposal while the agent is mid-turn, because executing under it would race the
   * model's own next tool call.
   */
  runActive: boolean;
  className?: string;
}

/**
 * Wire status → the four states the node model carries.
 *
 * The DB has six (`proposed`, `confirmed`, `executed`, `failed`, `declined`, `expired`) and
 * `ConfirmData.status` has four, so `executed` folds into `confirmed` and `expired` into
 * `declined`. The raw string is kept in `outcome` and is what the card actually PRINTS, so the
 * user still sees "executed" / "expired" and not a lossy rename.
 */
function toConfirmStatus(wire: string): ConfirmData["status"] {
  if (wire === "executed" || wire === "confirmed") return "confirmed";
  if (wire === "failed") return "failed";
  if (wire === "declined" || wire === "expired") return "declined";
  return "proposed";
}

/**
 * The failure text, lifted verbatim from the original card.
 *
 * Several target routes report an actionable refusal as a 2xx with `ok:false` (needsAppPassword,
 * publish blockers), so this string is frequently the only place the user learns WHY nothing was
 * sent. The asymmetric slicing — `.error` untruncated, the JSON dump and the raw string capped at
 * 300 — is intentional and unchanged: a real error message should not be cut mid-sentence.
 */
function failureTextFromRow(result: ActionRow["result"]): string | null {
  const response = result?.response;
  if (response == null) return null;
  if (typeof response === "object") {
    return String(
      (response as { error?: string }).error ?? JSON.stringify(response).slice(0, 300),
    );
  }
  return String(response).slice(0, 300);
}

export function ConfirmCard({ node, transport, runActive, className }: ConfirmCardProps) {
  const store = useAgentStoreInstance();
  const [deciding, setDeciding] = useState<"confirm" | "decline" | null>(null);
  // The REST row is strictly richer than the node data (it carries `resolved_by` and the raw
  // `result` body). Kept locally as a display overlay only — the node stays the source of truth for
  // `status`, so a `confirm_resolved` arriving later still wins.
  const [row, setRow] = useState<ActionRow | null>(null);

  const data = node.data?.kind === "confirm" ? node.data : null;
  const actionId = data?.actionId;

  const decide = useCallback(
    async (decision: "confirm" | "decline") => {
      if (!actionId || deciding || runActive) return;

      // Re-verify against the STORE, not the props this rendered with. The same stale-form
      // reasoning as §9.4: this card can sit in the transcript for many turns, and a resolution may
      // have landed between paint and click.
      const live = store.getNode(node.id);
      if (!live || live.data?.kind !== "confirm" || live.data.status !== "proposed") {
        toast.error("That action was already resolved.");
        return;
      }

      setDeciding(decision);
      try {
        const action = await transport.decideAction({ actionId, decision });
        setRow(action);

        // §9.8 — apply the REST result ONLY if the card is still proposed, so a `confirm_resolved`
        // that raced in over the open SSE always wins. Same shape either way, so this is
        // idempotent once the server starts emitting the event.
        const current = store.getNode(node.id);
        if (current?.data?.kind === "confirm" && current.data.status === "proposed") {
          store.patchNode(node.id, {
            data: {
              ...current.data,
              status: toConfirmStatus(action.status),
              outcome: action.status,
              detail: failureTextFromRow(action.result) ?? current.data.detail,
            },
            isError: action.status === "failed",
          });
        }

        // Unchanged from the original: a decline is silent, a confirm always says what happened.
        // "executed" is the ONLY success — a 2xx whose body says `ok:false` is resolved `failed`
        // server-side precisely so this toast cannot claim a send that never happened.
        if (decision === "confirm") {
          if (action.status === "executed") toast.success("Done.");
          else toast.error(`That did not execute (${action.status}) — the card has the detail.`);
        }
      } catch (e: unknown) {
        // Three-phase (§9.4): a failed click restores the buttons. It must never eat the decision
        // and leave a dead card — the action is still proposed server-side and still needs a human.
        toast.error(e instanceof Error ? e.message : "That decision did not go through.");
      } finally {
        setDeciding(null);
      }
    },
    [actionId, deciding, runActive, store, node.id, transport],
  );

  if (!data) return null;

  const resolved = data.status !== "proposed";
  // Print the raw wire status when we have it, so "executed" and "expired" survive the fold above.
  const statusLabel = data.outcome ?? data.status;
  const tone =
    statusLabel === "executed" || statusLabel === "confirmed"
      ? "text-success"
      : statusLabel === "failed"
        ? "text-destructive dark:text-destructive"
        : "text-muted-foreground";
  const failure =
    data.status === "failed" ? (failureTextFromRow(row?.result ?? null) ?? data.detail) : null;
  const params = data.params;

  return (
    <div
      data-slot="confirm-card"
      data-action-id={data.actionId}
      className={cn(
        "rounded-lg border p-3.5 space-y-2",
        resolved ? "opacity-90" : "border-amber-400/60 bg-warning/5",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono text-xs">
          {data.actionKind}
        </Badge>
        {resolved && (
          <span className={cn("text-xs font-medium", tone)}>
            {statusLabel}
            {row?.resolved_by ? ` · ${row.resolved_by}` : ""}
          </span>
        )}
      </div>

      <p className="text-sm">{data.summary}</p>

      {/* What will actually run. Collapsed by default so a large payload cannot push the composer
          off-screen, but present: "states exactly what it is" is the card's entire job. */}
      {!resolved && params && Object.keys(params).length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
            What will run
          </summary>
          <pre className="mt-1.5 max-h-40 overflow-auto rounded-md bg-muted/50 p-2 text-xs leading-relaxed break-words whitespace-pre-wrap">
            {JSON.stringify(params, null, 2)}
          </pre>
        </details>
      )}

      {failure && (
        <p className="text-xs break-words text-destructive dark:text-destructive">{failure}</p>
      )}

      {!resolved && (
        <div className="flex gap-2 pt-0.5">
          <Button
            size="sm"
            className="gap-1.5"
            disabled={deciding !== null || runActive}
            onClick={() => void decide("confirm")}
          >
            {deciding === "confirm" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}{" "}
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={deciding !== null || runActive}
            onClick={() => void decide("decline")}
          >
            {deciding === "decline" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}{" "}
            Decline
          </Button>
        </div>
      )}
    </div>
  );
}
