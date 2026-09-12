"use client";

// SearchOps Agent — Send ⇄ Stop in ONE fixed slot.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §11.4. Fixes D8 (no stop button at all on the writer, and a
// width-changing one on Hermes).
//
// ══ Why both branches are pinned to SUBMIT_SLOT_PX ══════════════════════════════════════════════
//
// Identical geometry means ZERO layout shift at the exact moment the user's eye is on that corner.
// Hermes today swaps a compact Send for a wider `<Square/> Stop` and the whole composer jumps a few
// px sideways on every turn. The width/height are written as inline styles rather than utility
// classes so nobody can quietly override them from a parent's className.
//
// There is deliberately NO entry animation on the swap. Anything that changes the footer's box size
// shifts the transcript under the reader mid-sentence (§11.5).

import { memo } from "react";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { SUBMIT_SLOT_PX } from "../constants";

export interface SubmitButtonProps {
  /** Is a turn in flight? Read HIGH (`useRunState`) and passed down as a prop. */
  runActive: boolean;
  /** `!submitBlocked && draft.trim() !== ""`. Only ever gates SEND. */
  canSend: boolean;
  onSend: () => void;
  /** Local-first: mutates client state, aborts the reader, then POSTs (§5.6). */
  onStop: () => void;
  className?: string;
}

/**
 * The stop glyph: a rounded rect filled with `currentColor`, not lucide's `<Square/>` outline.
 *
 * Filled-from-currentColor means it inherits the button's theme and hover colours for free, and it
 * reads as a "stop" at 10px where a 1.5px stroked outline reads as a smudge.
 */
function StopGlyph() {
  return <span aria-hidden="true" className="block size-2.5 rounded-[2px] bg-current" />;
}

function SubmitButtonImpl({ runActive, canSend, onSend, onStop, className }: SubmitButtonProps) {
  // One slot, two occupants. Same size, same shape, same position.
  const slot = cn("shrink-0 rounded-full p-0", className);
  const style = { width: SUBMIT_SLOT_PX, height: SUBMIT_SLOT_PX } as const;

  if (runActive) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="icon-xs"
        className={slot}
        style={style}
        aria-label="Stop generating"
        // NEVER disabled. A dead stop button during the one state where the user most wants out is
        // the worst failure mode a composer has (§11.4). Not while the POST is in flight, not
        // while an ask is pending, not ever.
        onClick={onStop}
      >
        <StopGlyph />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="icon-xs"
      className={slot}
      style={style}
      aria-label="Send message"
      disabled={!canSend}
      onClick={onSend}
    >
      <Send aria-hidden="true" />
    </Button>
  );
}

/**
 * Memo'd because the Composer re-renders on every keystroke of the draft. `canSend` only flips on
 * the empty ⇄ non-empty edge, so this subtree paints twice per message instead of once per key.
 */
export const SubmitButton = memo(SubmitButtonImpl);
SubmitButton.displayName = "SubmitButton";
