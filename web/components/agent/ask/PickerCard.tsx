"use client";

// The multi-select picker — the finalize step of the competitor-backlink flow.
//
// Ported from the pre-ChatSurface hermes page (PR #26) when that page became a redirect. The
// behaviour is deliberately unchanged, because the point of it is a safety property rather than a
// convenience: the model lays out candidates, a HUMAN ticks the ones worth harvesting, and the
// submit composes the reply itself from the chosen key-column values VERBATIM. No model
// transcription sits between the click and the harvest, so nothing can be silently mistyped into
// the next turn.
//
// Two rules carried over intact:
//   • Only the NEWEST picker is live. A picker with any user message after it is stale — that one
//     rule covers both "reloaded after submitting" (the submission is itself a persisted user
//     message, so the rehydrated card renders read-only) and "superseded by a later picker".
//   • Submitting once locks it. The turn it starts is expensive and not idempotent.

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export interface PickerData {
  title: string;
  columns: string[];
  rows: string[][];
  /** Index of the column whose values are sent back. */
  keyCol: number;
}

export interface PickerCardProps {
  data: PickerData;
  /** Newest picker in the transcript with no user reply after it. */
  active: boolean;
  /** A turn is in flight. */
  disabled?: boolean;
  onSubmit: (message: string) => void;
  className?: string;
}

export function PickerCard({ data, active, disabled = false, onSubmit, className }: PickerCardProps) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [submitted, setSubmitted] = useState(false);

  const dead = !active || submitted || disabled;
  const allOn = data.rows.length > 0 && sel.size === data.rows.length;

  const toggle = (i: number) =>
    setSel((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const submit = () => {
    // Sorted by row order, not click order: the message should read like the table looks.
    const keys = [...sel]
      .sort((a, b) => a - b)
      .map((i) => data.rows[i]?.[data.keyCol] ?? "")
      .filter(Boolean);
    if (!keys.length) return;
    setSubmitted(true);
    onSubmit(`Proceed with these:\n${keys.join("\n")}`);
  };

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border/60", className)}>
      {data.title ? <p className="px-3 pt-2.5 pb-1 text-sm font-medium">{data.title}</p> : null}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/60 bg-muted/50">
              <th className="w-8 px-3 py-1.5">
                <Checkbox
                  checked={allOn}
                  disabled={dead}
                  aria-label={allOn ? "Clear selection" : "Select all rows"}
                  onCheckedChange={(on) =>
                    setSel(on ? new Set(data.rows.map((_, i) => i)) : new Set())
                  }
                />
              </th>
              {data.columns.map((c, i) => (
                <th key={i} className="px-3 py-1.5 text-left font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr
                key={i}
                className={cn(
                  "border-b border-border/40 last:border-0",
                  !dead && "cursor-pointer transition-colors hover:bg-accent/40",
                  sel.has(i) && "bg-highlight/10",
                )}
                // The whole row is the target, not just the 16px box. A table of candidates is
                // read left-to-right and clicked wherever the eye stopped.
                onClick={dead ? undefined : () => toggle(i)}
              >
                <td className="px-3 py-1.5">
                  <Checkbox
                    checked={sel.has(i)}
                    disabled={dead}
                    aria-label={`Select ${r[data.keyCol] ?? `row ${i + 1}`}`}
                    // The row handler already toggles; without this the click counts twice and
                    // the box appears not to respond.
                    onClick={(e) => e.stopPropagation()}
                    onCheckedChange={() => toggle(i)}
                  />
                </td>
                {r.map((cell, j) => (
                  <td key={j} className="px-3 py-1.5">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 border-t border-border/60 bg-muted/30 px-3 py-2">
        {submitted ? (
          <span className="text-xs text-muted-foreground">Selection sent.</span>
        ) : !active ? (
          <span className="text-xs text-muted-foreground">Selection closed.</span>
        ) : (
          <>
            <Button size="sm" disabled={disabled || sel.size === 0} onClick={submit}>
              Use {sel.size} selected
            </Button>
            <span className="text-xs text-muted-foreground">
              {sel.size} of {data.rows.length} selected
            </span>
          </>
        )}
      </div>
    </div>
  );
}
