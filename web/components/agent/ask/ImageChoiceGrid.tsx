"use client";

// SearchOps Agent — image choices for a blocking ask.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §9.5.
//
// When EVERY choice carries an `imageUrl`, the button row is dropped for a grid of image cards.
// This is where `generate_assets` output is supposed to land: "which of these?" instead of dumping
// four images into the void and hoping the user types "the second one".
//
// Same contract as ChoiceButtons: no state, no network, no `runActive` — the three-phase click
// lives in AskCard.

import { Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { IMAGE_FADE_MS } from "../constants";
import type { AskChoice, AskState } from "../types";

export interface ImageChoiceGridProps {
  askId: string;
  choices: readonly AskChoice[];
  status: AskState["status"];
  chosenId?: string;
  onChoose: (choiceId: string) => void;
  className?: string;
}

/** True when the grid applies — every choice must have an image, or the row is the right shape. */
export function isImageChoiceSet(choices: readonly AskChoice[] | undefined): boolean {
  return !!choices && choices.length > 0 && choices.every((c) => !!c.imageUrl);
}

export function ImageChoiceGrid({
  askId,
  choices,
  status,
  chosenId,
  onChoose,
  className,
}: ImageChoiceGridProps) {
  // See ChoiceButtons: gated on the ask status only. `runActive` here would be the §9.2 deadlock.
  const locked = status !== "pending";

  return (
    <div className={cn("grid grid-cols-2 gap-2 sm:grid-cols-3", className)}>
      {choices.map((c) => {
        const picked = chosenId === c.id;
        const spinning = status === "submitting" && picked;
        return (
          <button
            key={c.id}
            type="button"
            id={`ask-${askId}-${c.id}`}
            disabled={locked}
            aria-pressed={picked}
            aria-label={c.label}
            onClick={() => onChoose(c.id)}
            className={cn(
              "group/choice block w-full rounded-lg text-left outline-none transition-opacity",
              // A locked grid keeps the picked card at full strength and fades the rest, so the
              // transcript still shows what was chosen rather than a uniformly greyed row.
              locked && !picked && "opacity-50",
              locked && "pointer-events-none",
            )}
          >
            <span
              className={cn(
                "relative block overflow-hidden rounded-lg ring-1 ring-border transition-all",
                // 2px ring on hover/focus is the whole affordance — these are the blocking species
                // of control and must not read as decorative thumbnails.
                !locked &&
                  "group-hover/choice:ring-2 group-hover/choice:ring-primary group-focus-visible/choice:ring-2 group-focus-visible/choice:ring-primary",
                picked && "ring-2 ring-primary",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- agent-generated remote asset, not a local file */}
              <img
                src={c.imageUrl}
                alt={c.label}
                loading="lazy"
                decoding="async"
                className="aspect-square w-full object-cover"
                // Matches the element renderer's decode fade so a grid of asks and a grid of
                // inline images do not settle at visibly different speeds.
                style={{ transitionDuration: `${IMAGE_FADE_MS}ms` }}
              />
              {picked && (
                <span className="absolute right-1.5 top-1.5 grid size-5 place-content-center rounded-full bg-primary text-primary-foreground shadow-sm">
                  {spinning ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Check className="size-3" />
                  )}
                </span>
              )}
            </span>
            <span className="mt-1 block truncate px-0.5 text-xs text-muted-foreground">
              {c.label}
            </span>
            {c.description && (
              <span
                id={`ask-desc-${askId}-${c.id}`}
                className="block px-0.5 text-xs leading-snug text-muted-foreground/80"
              >
                {c.description}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
