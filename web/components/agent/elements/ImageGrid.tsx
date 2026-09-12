"use client";

// SearchOps Agent — the image bucket: single-image fast path, quilted grid for the rest, one lightbox.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §8.3, §8.4.

import { memo, useCallback, useState } from "react";

import { cn } from "@/lib/utils";

import {
  ELEMENT_DEFAULT_UNITS,
  ELEMENT_GRID_COLS,
  ELEMENT_GRID_MAX_PX,
  ELEMENT_SIZE_PX,
  ELEMENT_SIZE_UNITS,
} from "../constants";
import type { AgentElement } from "../types";
import { ImageElement } from "./ImageElement";
import { Lightbox } from "./Lightbox";

export interface ImageGridProps {
  /** Image elements only — ElementList has already bucketed by type. */
  elements: readonly AgentElement[];
  isLiveTurn?: boolean;
  className?: string;
}

/** Column AND row span in the quilted grid, so every tile stays square and a mixed batch mosaics. */
function sizeToUnit(el: AgentElement): number {
  return el.size ? ELEMENT_SIZE_UNITS[el.size] : ELEMENT_DEFAULT_UNITS;
}

function ImageGridImpl({ elements, isLiveTurn = false, className }: ImageGridProps) {
  // One lightbox per bucket, addressed by element id rather than index — the array can grow and
  // reorder underneath an open viewer.
  const [openId, setOpenId] = useState<string | null>(null);
  const handleOpen = useCallback((id: string) => setOpenId(id), []);
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) setOpenId(null);
  }, []);
  const openElement = openId ? (elements.find((e) => e.id === openId) ?? null) : null;

  if (elements.length === 0) return null;

  // ── single-image fast path: no grid at all ────────────────────────────────────────────────────
  // In a 4-column grid a `medium` image would occupy 2 of 4 columns = half of 600px. For one image
  // `size` has to mean an absolute max-width, not a fraction of a grid that isn't there.
  if (elements.length === 1) {
    const only = elements[0];
    return (
      <>
        <div className={cn("w-full", className)} style={{ maxWidth: ELEMENT_SIZE_PX[only.size ?? "medium"] }}>
          <ImageElement element={only} isLiveTurn={isLiveTurn} onOpen={handleOpen} />
        </div>
        <Lightbox element={openElement} open={openElement !== null} onOpenChange={handleOpenChange} />
      </>
    );
  }

  return (
    <>
      <div
        // `transform-gpu` promotes the grid to its own compositor layer, so an image finishing its
        // decode repaints the grid instead of the whole transcript behind it.
        className={cn("grid w-full transform-gpu gap-2", className)}
        style={{
          gridTemplateColumns: `repeat(${ELEMENT_GRID_COLS}, minmax(0, 1fr))`,
          maxWidth: ELEMENT_GRID_MAX_PX,
          // Row height == column width, so a `span n / span n` tile is square. The 1.5rem subtracted
          // is the three `gap-2` (0.5rem) gutters between four columns; `min(100%, …)` keeps the
          // rows correct when the transcript is narrower than the 600px cap.
          gridAutoRows: `minmax(0, calc((min(100%, ${ELEMENT_GRID_MAX_PX}px) - 1.5rem) / ${ELEMENT_GRID_COLS}))`,
        }}
      >
        {elements.map((el) => {
          const units = sizeToUnit(el);
          return (
            // Keyed by element.id, NEVER by index. Arrival is streamed and out of order; an index key
            // remounts <img> nodes on every insert, re-triggering loads — visible flicker.
            <div
              key={el.id}
              className="min-h-0 min-w-0"
              style={{ gridColumn: `span ${units} / span ${units}`, gridRow: `span ${units} / span ${units}` }}
            >
              <ImageElement element={el} isLiveTurn={isLiveTurn} onOpen={handleOpen} fill />
            </div>
          );
        })}
      </div>
      <Lightbox element={openElement} open={openElement !== null} onOpenChange={handleOpenChange} />
    </>
  );
}

export const ImageGrid = memo(ImageGridImpl);
ImageGrid.displayName = "ImageGrid";
