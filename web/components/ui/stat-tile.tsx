import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One big number with its label. The only stat tile.
 *
 * Thirteen pages used to hand-roll their own: some put the label above the number, some below, some
 * coloured every number teal, some added an icon, one added a two-line subline to a single tile in a
 * row of seven. Side by side they read as seven different widgets. This is one.
 *
 * Tone is for STATE, not decoration: `warning` when the number is a problem to look at, `success`
 * when it is a win, `accent` for the one figure a page is about. Everything else stays ink-coloured,
 * so a coloured number means something.
 */
export type StatTone = "default" | "accent" | "success" | "warning" | "destructive";

const TONE: Record<StatTone, string> = {
  default: "text-foreground",
  accent: "text-highlight-ink",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

export function StatTile({
  label,
  value,
  hint,
  tone = "default",
  icon: Icon,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  /** One short line under the label. Truncates rather than wraps, so every tile in a row stays the same height. */
  hint?: ReactNode;
  tone?: StatTone;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-xl border border-border bg-card px-4 py-3.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm text-muted-foreground">{label}</p>
        {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />}
      </div>
      <p className={cn("mt-1 truncate text-2xl font-light tracking-tight font-tabular leading-none", TONE[tone])}>{value}</p>
      {hint && <p className="mt-1.5 truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A row of tiles that never clips. Columns come from the available width (150px minimum each), so a
 * seven-tile row is seven across on a wide monitor and wraps to four-and-three on a laptop instead of
 * pushing the last tile off the edge.
 */
export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]", className)}>
      {children}
    </div>
  );
}
