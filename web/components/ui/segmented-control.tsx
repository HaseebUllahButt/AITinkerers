"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A row of mutually exclusive choices: view tabs, list filters, a two-way toggle.
 *
 * The app had four ways to draw this — a segmented track, underlined tabs, filled chips, and plain
 * text chips — sometimes three of them stacked on one page. This is the one idiom for all of them.
 * It is a control, not navigation: use it for state that stays on the page. Route changes go through
 * links.
 *
 * Long rows scroll sideways inside the track instead of wrapping onto a second line or clipping the
 * last option, which is what nine tabs did on Admin at laptop widths.
 */
export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** A count shown after the label, muted. */
  count?: number | string | null;
  icon?: LucideIcon;
  /** Draws the count in the warning tone: a number the reader should look at. */
  attention?: boolean;
  disabled?: boolean;
  title?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  wrap = false,
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  size?: "sm" | "md";
  /** Wrap onto more lines instead of scrolling. For narrow side panels where a scrolling track would hide options. */
  wrap?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 rounded-lg bg-muted p-0.5",
        wrap ? "flex-wrap" : "no-scrollbar overflow-x-auto",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:opacity-50",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden="true" />}
            {o.label}
            {o.count != null && (
              <span
                className={cn(
                  "font-tabular text-xs font-normal",
                  o.attention ? "text-warning" : active ? "text-muted-foreground" : "text-muted-foreground/70",
                )}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
