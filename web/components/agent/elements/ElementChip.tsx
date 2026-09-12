"use client";

// SearchOps Agent — the inline element reference chip.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §8.5.
//
// The agent emits an explicit `[[element:abc123]]` marker in its prose (ELEMENT_REF_RE) and the
// markdown renderer swaps that marker for one of these. Deliberately NOT Chainlit's element-*name*
// substitution: names are not unique, and any sentence that happens to contain a name gets silently
// rewritten into a chip.

import { memo, useCallback, useState } from "react";

import { cn } from "@/lib/utils";

import type { AgentElement } from "../types";
import { Lightbox } from "./Lightbox";

export interface ElementChipProps {
  /** The resolved element. Undefined when the marker names an element that has not arrived. */
  element?: AgentElement;
  /** Overrides the element's name as the chip's label. */
  label?: string;
  /** Host-supplied activation (e.g. scroll to the element, open a side panel). Wins over the default. */
  onSelect?: (element: AgentElement) => void;
  className?: string;
}

function ElementChipImpl({ element, label, onSelect, className }: ElementChipProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const isImage = element?.type === "image" && !!element.url;

  const handleClick = useCallback(() => {
    if (!element) return;
    if (onSelect) {
      onSelect(element);
      return;
    }
    if (isImage) {
      setLightboxOpen(true);
      return;
    }
    // Anything else with bytes behind it opens in a new tab. Never navigate the current tab: a live
    // SSE run is attached to this document and leaving kills it mid-turn.
    if (element.url) window.open(element.url, "_blank", "noopener,noreferrer");
  }, [element, isImage, onSelect]);

  // An unresolved marker renders nothing. Tokens and element events race, so a chip can be parsed
  // before its element exists; emitting a dead chip (or the raw id) would leave debris in the prose
  // when the element never arrives. The markdown node re-renders when the element bucket changes,
  // so the chip appears the moment it does.
  if (!element) return null;

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        title={element.name}
        // -translate-y-px is an optical correction, not a nudge: a chip sitting on the text baseline
        // reads heavier than the prose around it. The 1px lift centres it in the line box.
        className={cn(
          "inline-flex max-w-[14rem] -translate-y-px items-center rounded-xl bg-muted px-1.5 align-middle text-xs uppercase transition-colors outline-none hover:bg-primary hover:text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
          className,
        )}
      >
        <span className="truncate">{label ?? element.name}</span>
      </button>

      {isImage && <Lightbox element={element} open={lightboxOpen} onOpenChange={setLightboxOpen} />}
    </>
  );
}

export const ElementChip = memo(ElementChipImpl);
ElementChip.displayName = "ElementChip";
