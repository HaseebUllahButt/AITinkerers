"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search, Check } from "lucide-react";

export interface SearchableOption { id: string; label: string; hint?: string | number }

// A dropdown with a built-in search box — a drop-in replacement for a native <select> when
// the option list gets long (workflows, templates, campaigns). Value is the option id;
// pass noneLabel to include a "none" choice that reports "" via onChange.
export function SearchableSelect({
  value, onChange, options, placeholder = "Select…", searchPlaceholder = "Search…",
  noneLabel, disabled, className = "", menuWidth = "w-72",
}: {
  value: string | null | undefined;
  onChange: (id: string) => void;
  options: SearchableOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  noneLabel?: string;
  disabled?: boolean;
  className?: string;
  menuWidth?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selected = options.find((o) => o.id === value);
  const label = selected?.label ?? (value ? "" : (noneLabel ?? placeholder));
  const filtered = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        type="button"
        disabled={disabled}
        className="w-full h-9 rounded-md border border-input bg-background px-2.5 text-sm flex items-center justify-between gap-2 disabled:opacity-50"
        onClick={() => { setOpen((o) => !o); setQ(""); }}
      >
        <span className={`truncate ${selected ? "" : "text-muted-foreground"}`}>{label || placeholder}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>
      {open && (
        <div className={`absolute z-40 mt-1 ${menuWidth} max-w-[80vw] rounded-md border border-border bg-popover shadow-lg overflow-hidden`}>
          <div className="relative border-b border-border">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              autoFocus
              placeholder={searchPlaceholder}
              className="w-full h-9 bg-transparent pl-8 pr-2 text-sm outline-none"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {noneLabel && !q && (
              <button
                type="button"
                className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/50 flex items-center justify-between gap-2 ${!value ? "bg-muted/40" : ""}`}
                onClick={() => { onChange(""); setOpen(false); }}
              >
                <span className="truncate text-muted-foreground">{noneLabel}</span>
                {!value && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            )}
            {filtered.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/50 flex items-center justify-between gap-2 ${value === o.id ? "bg-muted/40" : ""}`}
                onClick={() => { onChange(o.id); setOpen(false); }}
              >
                <span className="truncate">{o.label}</span>
                <span className="flex items-center gap-1.5 shrink-0">
                  {o.hint != null && <span className="text-xs text-muted-foreground">{o.hint}</span>}
                  {value === o.id && <Check className="h-3.5 w-3.5" />}
                </span>
              </button>
            ))}
            {filtered.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground text-center">No matches</p>}
          </div>
        </div>
      )}
    </div>
  );
}
