"use client";

import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The honest face of a failed data load. One rule, learned twice in one day (the Summer rail,
 * the backlinks "not found"): a fetch failure must never render as an empty account or a zero.
 * Pages keep whatever data they already showed, put the failure in state, and render this above
 * the (possibly stale) content — with the server's own reason and a retry.
 *
 * Use `nothing` for what the failure hides ("your conversations", "this campaign's prospects"),
 * so the copy reads "Couldn't load your conversations — they are not gone."
 */
export function LoadFailed({ nothing, detail, onRetry, className }: {
  nothing: string;
  detail?: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning", className)}>
      <p className="flex items-start gap-1.5">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Couldn&apos;t load {nothing} — {nothing.startsWith("your") ? "they are" : "it is"} <b>not</b> gone
          {detail ? <> ({detail})</> : null}. The numbers below may be stale or missing.
        </span>
      </p>
      {onRetry && (
        <Button size="sm" variant="outline" className="mt-2 h-7" onClick={onRetry}>
          Try again now
        </Button>
      )}
    </div>
  );
}

/** Normalize any fetch outcome into data-or-reason, so pages stop hand-rolling the triple.
 *  Throws never; the reason is display-ready. */
export async function fetchHonest<T = Record<string, unknown>>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ data: T; reason: null } | { data: null; reason: string }> {
  try {
    const res = await fetch(input, init);
    const body = (await res.json().catch(() => null)) as (T & { ok?: unknown; error?: unknown }) | null;
    if (!res.ok || body === null || body.ok === false) {
      const reason = typeof body?.error === "string" && body.error ? body.error : `the server did not answer (HTTP ${res.status})`;
      return { data: null, reason };
    }
    return { data: body as T, reason: null };
  } catch (e) {
    return { data: null, reason: e instanceof Error ? e.message : "network error" };
  }
}
