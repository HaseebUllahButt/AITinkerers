"use client";

// "Does Strapi have this?" — the second chip, deliberately separate from SaveStatus.
//
// These answer two different questions, and the old UI conflated them into one Save button plus a
// toast warning, which is why "did it save?" and "is it live?" were impossible to tell apart.
import { CloudUpload, Loader2, ExternalLink, CheckCircle2, AlertTriangle, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SYNC_STATE_META, type DerivedSyncState } from "@/lib/blog/state";

const TONE: Record<string, string> = {
  muted: "text-muted-foreground",
  brand: "text-highlight-ink",
  emerald: "text-success",
  amber: "text-warning",
  red: "text-destructive",
};

interface Props {
  state: DerivedSyncState;
  adminUrl?: string | null;
  syncError?: string | null;
  busy: boolean;
  /** Blockers from publishReadiness() — non-empty disables Publish. */
  publishProblems: string[];
  onSync: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
}

export function SyncStatus({
  state, adminUrl, syncError, busy, publishProblems, onSync, onPublish, onUnpublish,
}: Props) {
  const meta = SYNC_STATE_META[state];
  const Icon = state === "published" ? CheckCircle2
    : state === "sync_failed" ? AlertTriangle
    : state === "local_only" ? Cloud
    : CloudUpload;

  const canPublish = publishProblems.length === 0;
  const isLive = state === "published" || state === "published_stale";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span
        className={cn("flex items-center gap-1.5 text-xs px-2 py-1 rounded-md", TONE[meta.tone])}
        title={meta.help}
      >
        <Icon className="h-3.5 w-3.5" /> {meta.label}
      </span>

      {adminUrl && (
        <a href={adminUrl} target="_blank" rel="noreferrer"
          className="text-xs text-highlight-ink hover:underline flex items-center gap-1">
          Open in Strapi <ExternalLink className="h-3 w-3" />
        </a>
      )}

      {state === "sync_failed" && syncError && (
        <Popover>
          <PopoverTrigger
            render={<Button size="xs" variant="ghost" className="h-10 text-xs text-destructive">See why</Button>}
          />
          <PopoverContent className="w-80 text-xs space-y-2">
            <p className="font-medium text-destructive">Strapi rejected the last push</p>
            <p className="text-muted-foreground break-words font-mono text-xs">{syncError}</p>
            <p className="text-muted-foreground">
              Your local copy is untouched — nothing was lost. Fix the field it names and retry.
            </p>
          </PopoverContent>
        </Popover>
      )}

      {/* Sync: create/update the UNPUBLISHED Strapi draft. Safe at any readiness level — Strapi
          relaxes required fields for drafts, so this works on a half-finished post. */}
      {(state === "local_only" || state === "synced_stale" || state === "sync_failed") && (
        <Button size="xs" variant="outline" disabled={busy} onClick={onSync} className="gap-1">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CloudUpload className="h-3 w-3" />}
          {state === "sync_failed" ? "Retry sync" : "Sync to Strapi"}
        </Button>
      )}

      {state === "published_stale" && (
        <Button size="xs" variant="outline" disabled={busy} onClick={onPublish} className="gap-1 text-warning border-warning/40">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CloudUpload className="h-3 w-3" />} Push update
        </Button>
      )}

      {!isLive && (
        <Button
          size="xs" disabled={busy || !canPublish} onClick={onPublish} className="gap-1"
          title={canPublish ? "Make this post live in Strapi" : publishProblems.join(" · ")}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />} Publish
        </Button>
      )}

      {isLive && (
        <Button size="xs" variant="ghost" disabled={busy} onClick={onUnpublish} className="text-muted-foreground">
          Unpublish
        </Button>
      )}
    </div>
  );
}
