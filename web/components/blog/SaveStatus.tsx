"use client";

// "Is my typing safe?" — one chip, always visible in the editor header.
//
// Colour policy is deliberate: network trouble renders AMBER and reassuring, because the text is
// still in React state and in the localStorage journal, so nothing is actually at risk. Red is
// reserved for `no_local_backup`, the one state where the two-places invariant is genuinely broken.
// Making every hiccup red would train people to ignore the chip.
import { useEffect, useState } from "react";
import {
  CheckCircle2, Loader2, RefreshCw, WifiOff, Users, ShieldAlert, Download, Circle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SaveState } from "@/lib/blog/useDraftAutosave";

function relative(ts: number): string {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

interface Props {
  state: SaveState;
  lastSavedAt: number | null;
  retryInSec: number | null;
  onRetry: () => void;
  onResolveConflict: () => void;
  /** Client-side .md download — the last resort if both Postgres and localStorage are unavailable. */
  onDownload: () => void;
}

export function SaveStatus({ state, lastSavedAt, retryInSec, onRetry, onResolveConflict, onDownload }: Props) {
  // Re-render every 30s so "Saved 2m ago" doesn't go stale while the user reads.
  const [, tick] = useState(0);
  useEffect(() => {
    if (state !== "saved") return;
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [state]);

  const base = "flex items-center gap-1.5 text-xs px-2 py-1 rounded-md";

  switch (state) {
    case "saving":
      return (
        <span className={cn(base, "text-muted-foreground")}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
        </span>
      );

    case "just_saved":
      return (
        <span className={cn(base, "text-success")}>
          <CheckCircle2 className="h-3.5 w-3.5" /> Saved
        </span>
      );

    case "saved":
      return (
        <span className={cn(base, "text-muted-foreground")} title="Autosaved to SearchOps. Strapi is separate.">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {lastSavedAt ? `Saved ${relative(lastSavedAt)}` : "Saved"}
        </span>
      );

    case "dirty":
      // No spinner: nothing is happening yet, and a spinner here reads as "working" when it's
      // really "waiting for you to stop typing".
      return (
        <span className={cn(base, "text-muted-foreground")}>
          <Circle className="h-2 w-2 fill-amber-500 text-warning" /> Unsaved changes
        </span>
      );

    case "offline":
      return (
        <span className={cn(base, "text-warning")} title="Your changes are kept on this device and will save automatically when you reconnect.">
          <WifiOff className="h-3.5 w-3.5" /> Offline — kept on this device
        </span>
      );

    case "retrying":
      return (
        <span className={cn(base, "text-warning")}>
          <RefreshCw className="h-3.5 w-3.5" />
          Can&apos;t reach the server{retryInSec ? ` — retrying in ${retryInSec}s` : ""}
          <Button size="xs" variant="ghost" className="h-7 px-2 text-xs" onClick={onRetry}>Retry now</Button>
          <Button size="xs" variant="ghost" className="h-7 px-2 text-xs" onClick={onDownload}>
            <Download className="h-3 w-3 mr-0.5" /> Download .md
          </Button>
        </span>
      );

    case "conflict":
      return (
        <button onClick={onResolveConflict} className={cn(base, "text-warning hover:bg-warning/10")}>
          <Users className="h-3.5 w-3.5" /> Edited elsewhere — review
        </button>
      );

    case "no_local_backup":
      // The only genuinely alarming state: we cannot keep an off-network copy, so an unsaved edit
      // really can be lost if the tab dies.
      return (
        <span className={cn(base, "text-destructive bg-destructive/10 border border-destructive/30")}
          title="This browser is blocking local storage (private mode, or storage disabled), so unsaved edits can't be kept on this device.">
          <ShieldAlert className="h-3.5 w-3.5" /> Local backup blocked — keep this tab open until it says Saved
        </span>
      );
  }
}
