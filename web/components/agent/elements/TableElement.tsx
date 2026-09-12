"use client";

// Summit Agent — a tabular result.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §8.6.
//
// This module is the LAZY chunk: ElementList imports it with `React.lazy` behind a Skeleton, so the
// table never enters the main bundle for the ~90% of turns that produce no table. That is also why
// it carries a default export — keep it.
//
// Three anti-jank rules encoded below, all of them about the surface not moving under the user:
//   • `max-h-[450px] overflow-auto`, so a 900-row result cannot push the composer off-screen or make
//     the scroll container's scrollHeight jump by thousands of pixels mid-stream.
//   • Pagination controls stay MOUNTED when unusable, disabled with `pointer-events-none opacity-50`.
//     Unmounting them changes the footer width and shifts the whole table sideways.
//   • The empty state is one row with `colSpan` and a fixed height, so a zero-result table has the
//     same shape as a populated one.

import { memo, useCallback, useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsUpDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { TABLE_MAX_HEIGHT_PX } from "../constants";
import type { AgentElement } from "../types";

export interface TableElementProps {
  title?: string;
  columns?: readonly string[];
  rows?: readonly (readonly string[])[];
  /**
   * Element-borne table (`AgentElement.type === 'table'`). The wire element carries a URL, not rows.
   * TODO(P2): fetch and parse `element.url` here (P1.7 retires the legacy `table` NODE, at which
   * point every table arrives this way). Until then this renders a link card rather than lying with
   * an empty grid.
   */
  element?: AgentElement;
  /** Rows per page. Not a spec constant — tune freely; only the "stays mounted" rule is load-bearing. */
  pageSize?: number;
  className?: string;
}

type SortState = { col: number; dir: "asc" | "desc" } | null;

// Frozen singletons for the "no data yet" case, mirroring EMPTY_IDS/EMPTY_ELEMENTS in constants.ts:
// a fresh `[]` per render would invalidate the memos below on every parent render.
const EMPTY_COLUMNS: readonly string[] = Object.freeze([]);
const EMPTY_ROWS: readonly (readonly string[])[] = Object.freeze([]);

/**
 * Numeric when BOTH cells parse as numbers, lexicographic otherwise. Mixed columns ("12", "n/a")
 * therefore fall back to text rather than sorting NaNs to one end at random.
 */
function compareCells(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== "" && b.trim() !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function TableElementImpl({ title, columns, rows, element, pageSize = 25, className }: TableElementProps) {
  const [sort, setSort] = useState<SortState>(null);
  const [page, setPage] = useState(0);

  const cols = columns ?? EMPTY_COLUMNS;
  // Memoized (not `rows ?? []`) so the fallback is one stable reference — an inline literal would be
  // a fresh array every render and re-run the sort memo below on every keystroke elsewhere.
  const allRows = useMemo(() => rows ?? EMPTY_ROWS, [rows]);

  const sortedRows = useMemo(() => {
    if (!sort) return allRows;
    // Copy before sorting: `rows` belongs to the store and mutating it in place would desync every
    // other consumer of the same array (and defeat the reference-compare memo above).
    return [...allRows].sort((ra, rb) => {
      const cmp = compareCells(ra[sort.col] ?? "", rb[sort.col] ?? "");
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [allRows, sort]);

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  // Clamped on read rather than corrected in an effect: rows can shrink under a streamed re-emit,
  // and a setState-in-effect fix renders one frame of a blank page first.
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => sortedRows.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [sortedRows, safePage, pageSize],
  );

  const toggleSort = useCallback((col: number) => {
    // asc → desc → unsorted. The third state matters: it is the only way back to the agent's own
    // ordering, which is frequently meaningful (ranked results).
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return null;
    });
    setPage(0);
  }, []);

  if (!columns) {
    return <UnfetchedTableCard element={element} title={title} className={className} />;
  }

  const canPrev = safePage > 0;
  const canNext = safePage < pageCount - 1;

  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-background", className)}>
      {title && <p className="px-3 pt-2.5 pb-1 text-sm font-medium">{title}</p>}

      <div className="overflow-auto" style={{ maxHeight: TABLE_MAX_HEIGHT_PX }}>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/50">
              {cols.map((c, i) => {
                // Bound as an object rather than a boolean so `dir` stays narrowed below.
                const activeSort = sort && sort.col === i ? sort : null;
                const ariaSort = activeSort ? (activeSort.dir === "asc" ? "ascending" : "descending") : "none";
                const SortIcon = activeSort
                  ? activeSort.dir === "asc"
                    ? ArrowUpIcon
                    : ArrowDownIcon
                  : ChevronsUpDownIcon;
                return (
                  // Sticky so the header survives scrolling the capped body.
                  <th
                    key={c || `col-${i}`}
                    scope="col"
                    aria-sort={ariaSort}
                    className="sticky top-0 z-10 bg-muted/50 p-0 text-left font-medium backdrop-blur-sm"
                  >
                    {/* A real <button>, not a div with onClick: keyboard-operable and announced as a
                        control, which is what makes the aria-sort above mean anything. */}
                    <button
                      type="button"
                      onClick={() => toggleSort(i)}
                      className="flex w-full items-center gap-1 px-3 py-1.5 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <span className="truncate">{c}</span>
                      <SortIcon
                        className={cn("size-3 shrink-0", activeSort ? "text-foreground" : "text-muted-foreground/50")}
                        aria-hidden
                      />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={Math.max(1, cols.length)} className="h-24 text-center text-muted-foreground">
                  No rows
                </td>
              </tr>
            ) : (
              pageRows.map((r, i) => (
                // Row identity is positional — these are anonymous string tuples with no id. The
                // offset keeps keys unique across pages.
                <tr key={`${safePage}-${i}`} className="border-b last:border-0">
                  {cols.map((_, j) => (
                    <td key={j} className="px-3 py-1.5 align-top">
                      {r[j] ?? ""}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Always mounted, even for a single-page table. Unmounting it changes the card's height and
          shifts everything below — see the header comment. */}
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground",
          pageCount === 1 && "pointer-events-none opacity-50",
        )}
      >
        <span>
          {sortedRows.length} {sortedRows.length === 1 ? "row" : "rows"}
        </span>
        <span className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Previous page"
            disabled={!canPrev}
            onClick={() => setPage(safePage - 1)}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <span className="tabular-nums">
            {safePage + 1} / {pageCount}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Next page"
            disabled={!canNext}
            onClick={() => setPage(safePage + 1)}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
        </span>
      </div>
    </div>
  );
}

/** Placeholder for a table element whose rows live behind `element.url`. See the TODO(P2) above. */
function UnfetchedTableCard({ element, title, className }: { element?: AgentElement; title?: string; className?: string }) {
  const label = title ?? element?.name ?? "Table";
  return (
    <div className={cn("rounded-lg border border-border bg-background px-3 py-2.5 text-sm", className)}>
      <p className="font-medium">{label}</p>
      {element?.url ? (
        <a href={element.url} target="_blank" rel="noreferrer noopener" className="text-xs text-muted-foreground underline underline-offset-2">
          Open data
        </a>
      ) : (
        <p className="text-xs text-muted-foreground">Preparing…</p>
      )}
    </div>
  );
}

export const TableElement = memo(TableElementImpl);
TableElement.displayName = "TableElement";

// Default export is what `React.lazy(() => import("./TableElement"))` resolves. Do not remove it.
export default TableElement;
