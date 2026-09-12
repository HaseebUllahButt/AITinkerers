"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";

// A free-text page-path input with a filterable dropdown of known pages underneath it — type
// anything (for a page not in the list yet) or pick from what's actually on the site. Used
// everywhere the app asks "which page do you mean" (backlinks, internal links).
export function PathCombobox({
  value, onChange, options, placeholder = "/ai-image-generator", className = "", id,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const q = value.toLowerCase().trim();
  const filtered = (q ? options.filter((o) => o.toLowerCase().includes(q)) : options).slice(0, 200);
  const exactMatch = options.includes(value.trim());

  return (
    <div className={`relative ${className}`} ref={ref}>
      <div className="relative">
        <Input
          id={id}
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="pr-8"
          autoComplete="off"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setOpen((o) => !o)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="absolute z-40 mt-1 w-full min-w-[280px] rounded-md border border-border bg-popover shadow-lg overflow-hidden">
          <div className="max-h-64 overflow-y-auto py-1">
            {!exactMatch && value.trim() && (
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 text-highlight-ink"
                onClick={() => setOpen(false)}
              >
                Use "{value.trim()}"
              </button>
            )}
            {filtered.map((p) => (
              <button
                key={p}
                type="button"
                className="w-full text-left px-3 py-2 text-sm font-mono hover:bg-muted/50 truncate"
                onClick={() => { onChange(p); setOpen(false); }}
              >
                {p}
              </button>
            ))}
            {filtered.length === 0 && !value.trim() && (
              <p className="px-3 py-3 text-xs text-muted-foreground text-center">No pages loaded</p>
            )}
            {filtered.length === 0 && value.trim() && exactMatch && (
              <p className="px-3 py-3 text-xs text-muted-foreground text-center">No other matches</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
