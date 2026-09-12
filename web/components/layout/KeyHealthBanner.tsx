"use client";

// API-key health, as a top-bar indicator.
//
// This used to be a full-width red bar between the top bar and every page. One unreachable
// enrichment API (which most pages never call) painted 60px of alert above Prospects, Settings and
// the blog editor alike, pushed all content down, and competed with the pages' own warnings. It is
// now a pill in the top bar: visible on every screen, one glance to know something is off, one click
// for the detail and a recheck. Nothing renders at all when every key is fine.

import { useEffect, useState, useCallback } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface KeyHealth {
  service: string;
  label: string;
  configured: boolean;
  ok: boolean;
  message: string;
}

interface Warning { label: string; message: string }

export function KeyHealthIndicator() {
  const [broken, setBroken] = useState<KeyHealth[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [rechecking, setRechecking] = useState(false);

  const load = useCallback(async (force = false) => {
    try {
      const data = await fetch(`/api/health/keys${force ? "?force=1" : ""}`).then((r) => r.json());
      setBroken(data.broken ?? []);
      setWarnings(data.warnings ?? []);
    } catch {}
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 60_000); // poll every minute
    return () => clearInterval(t);
  }, [load]);

  async function recheck() {
    setRechecking(true);
    await load(true);
    setRechecking(false);
  }

  if (broken.length === 0 && warnings.length === 0) return null;

  const isError = broken.length > 0;
  const count = isError ? broken.length : warnings.length;
  const label = isError
    ? `${count} key${count === 1 ? "" : "s"} down`
    : `${count} warning${count === 1 ? "" : "s"}`;

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
          isError
            ? "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15"
            : "border-warning/30 bg-warning/10 text-warning hover:bg-warning/15",
        )}
        title={isError ? "An API key isn't working" : "Heads up"}
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        {label}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-96 gap-0 p-0">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <p className="text-sm font-medium">{isError ? "API keys not working" : "Heads up"}</p>
          <button
            type="button"
            onClick={recheck}
            disabled={rechecking}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", rechecking && "animate-spin")} />
            Recheck
          </button>
        </div>
        <ul className="border-t border-border px-4 py-2 text-sm">
          {broken.map((b) => (
            <li key={b.service} className="flex items-start gap-2 py-1.5">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
              <span className="min-w-0">
                <span className="font-medium">{b.label}</span>
                <span className="text-muted-foreground"> — {b.message}</span>
              </span>
            </li>
          ))}
          {warnings.map((w) => (
            <li key={w.label} className="flex items-start gap-2 py-1.5">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
              <span className="min-w-0">
                <span className="font-medium">{w.label}</span>
                <span className="text-muted-foreground"> — {w.message}</span>
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** @deprecated The banner is now the indicator in the top bar. Kept so old imports still compile. */
export const KeyHealthBanner = () => null;
