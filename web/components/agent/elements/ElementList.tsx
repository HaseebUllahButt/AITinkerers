"use client";

// SearchOps Agent — the element bucket renderer.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §8.1, §8.5, §8.6.
//
// Elements are a flat array joined to nodes by `forId`, so an image arriving never touches text
// state. This component takes one node's bucket (from `useElementsFor`) and renders it in a FIXED
// type order — image → table → text → file (ELEMENT_TYPE_ORDER) — regardless of arrival order.
// Without bucketing, two images separated by a text element render as three separate grids and the
// whole block reflows every time something lands.
//
// Known one-way door, recorded deliberately: bucketing makes authored interleave (image → paragraph
// → table → image) impossible. Accepted for v1.

import { Suspense, lazy, memo, useMemo } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { ELEMENT_TYPE_ORDER, TABLE_MAX_HEIGHT_PX } from "../constants";
import type { AgentElement } from "../types";
import { FileElement } from "./FileElement";
import { ImageGrid } from "./ImageGrid";

// Lazy so the table code never enters the main bundle for the ~90% of turns with no table (§8.6).
// Must stay a bare dynamic import of a module with a default export — do not "simplify" to a static
// import, that silently undoes the split.
const TableElement = lazy(() => import("./TableElement"));

export interface ElementListProps {
  /** One node's bucket. Pass the reference-stable array from `useElementsFor` — never an inline []. */
  elements: readonly AgentElement[];
  /** True while the owning node belongs to the run streaming right now (drives eager image decode). */
  isLiveTurn?: boolean;
  className?: string;
}

type Buckets = Partial<Record<AgentElement["type"], AgentElement[]>>;

function ElementListImpl({ elements, isLiveTurn = false, className }: ElementListProps) {
  const buckets = useMemo<Buckets>(() => {
    const out: Buckets = {};
    for (const el of elements) {
      // `display: 'side'` belongs to the side panel, not the transcript.
      // TODO(P2): render side elements in the element side panel; today they are simply not shown
      // inline, which is correct-but-incomplete rather than wrong.
      if (el.display !== "inline") continue;
      (out[el.type] ??= []).push(el);
    }
    return out;
  }, [elements]);

  const hasAny = ELEMENT_TYPE_ORDER.some((t) => (buckets[t]?.length ?? 0) > 0);
  if (!hasAny) return null;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {ELEMENT_TYPE_ORDER.map((type) => {
        const bucket = buckets[type];
        if (!bucket?.length) return null;

        if (type === "image") {
          return <ImageGrid key={type} elements={bucket} isLiveTurn={isLiveTurn} />;
        }

        return (
          <div key={type} className="flex flex-col gap-4">
            {bucket.map((el) => {
              if (el.type === "table") {
                return (
                  // The fallback reserves the table's capped height, so the lazy chunk resolving
                  // does not shift the transcript.
                  <Suspense key={el.id} fallback={<Skeleton className="w-full rounded-md" style={{ height: TABLE_MAX_HEIGHT_PX }} />}>
                    <TableElement element={el} title={el.name} />
                  </Suspense>
                );
              }
              if (el.type === "text") return <TextElement key={el.id} element={el} />;
              return <FileElement key={el.id} element={el} />;
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A text element — a named blob of prose the agent attached to the message.
 *
 * TODO(P2): fetch `element.url` and render the body inline (behind the same lazy/Suspense treatment
 * as the table). Until then this is a titled card with a link, which is honest about what it has;
 * an empty body would read as a bug.
 */
function TextElement({ element }: { element: AgentElement }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2.5">
      <p className="text-sm font-medium">{element.name}</p>
      {element.url ? (
        <a
          href={element.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Open text
        </a>
      ) : (
        <p className="text-xs text-muted-foreground">{element.status === "error" ? "Unavailable" : "Preparing…"}</p>
      )}
    </div>
  );
}

/**
 * Memoized on the element bucket reference. `useElementsFor` returns the same array until an element
 * for THIS node actually changes, so tokens streaming into the node's text cost zero renders here.
 */
export const ElementList = memo(ElementListImpl);
ElementList.displayName = "ElementList";
