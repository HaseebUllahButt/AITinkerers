"use client";

// The row of attached files above the composer toolbar.
//
// Each chip reports its own state, because "uploading" and "attached" and "refused" are three
// genuinely different things and a spinner that resolves into silence tells you nothing about
// which happened. A refused file keeps its chip and shows the reason: a file that disappears looks
// like a bug, where one that says "PDFs cannot be read yet" is an answer.

import { FileText, ImageIcon, Loader2, X, AlertCircle } from "lucide-react";

import { cn } from "@/lib/utils";

/** Mirrors StoredAttachment in lib/hermes/attachments, plus the client-only pending state. */
export interface ChipAttachment {
  /** Stable across the upload so a chip does not remount when the server answers. */
  key: string;
  name: string;
  status: "uploading" | "ready" | "rejected";
  kind?: "image" | "text" | "rejected";
  url?: string;
  reason?: string;
}

export interface AttachmentChipsProps {
  items: ChipAttachment[];
  onRemove: (key: string) => void;
}

export function AttachmentChips({ items, onRemove }: AttachmentChipsProps) {
  if (!items.length) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.map((a) => {
        const failed = a.status === "rejected";
        return (
          <div
            key={a.key}
            className={cn(
              "flex max-w-[15rem] items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
              failed ? "border-destructive/40 bg-destructive/10" : "border-border bg-muted/40",
            )}
            // The reason is on the chip AND in the title: the chip truncates, and a person whose
            // file was refused deserves the whole sentence without opening anything.
            title={failed ? `${a.name} — ${a.reason ?? "could not be attached"}` : a.name}
          >
            {a.status === "uploading" ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : failed ? (
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
            ) : a.kind === "image" ? (
              <ImageIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}

            <span className="min-w-0 flex-1 truncate">{a.name}</span>

            {failed && a.reason && (
              <span className="shrink-0 text-xs text-destructive">{a.reason.split(".")[0]}</span>
            )}

            <button
              type="button"
              onClick={() => onRemove(a.key)}
              aria-label={`Remove ${a.name}`}
              className="shrink-0 rounded text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
