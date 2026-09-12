"use client";

// Shown when a PATCH comes back 409 — someone else (another tab, a teammate, or the writer agent)
// advanced `rev` while this editor was holding an older one.
//
// Design goal is not slick merging, it's that NO branch is ever silently lost. Whichever side the
// user discards is snapshotted to blog_draft_revisions server-side first, so it stays recoverable
// from the Revisions popover either way. That's why "Keep mine" is safe to offer as a plain button.
import { useMemo, useState } from "react";
import { Users } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BlogDraft } from "@/lib/db/queries";
import { diffLines, collapseUnchanged, countChanges } from "@/lib/blog/diff";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** What we have locally (the form). */
  mine: Partial<BlogDraft>;
  /** What the server now holds. */
  theirs: BlogDraft | null;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
}

export function ConflictDialog({ open, onOpenChange, mine, theirs, onKeepMine, onTakeTheirs }: Props) {
  const [showDiff, setShowDiff] = useState(false);

  const lines = useMemo(
    () => (theirs ? diffLines(theirs.body ?? "", mine.body ?? "") : []),
    [theirs, mine.body],
  );
  const { added, removed } = useMemo(() => countChanges(lines), [lines]);
  const collapsed = useMemo(() => collapseUnchanged(lines), [lines]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-warning" /> This draft was edited somewhere else
          </DialogTitle>
          <DialogDescription>
            {theirs?.last_edited_by
              ? <>Last saved by <span className="font-medium">{theirs.last_edited_by}</span>. </>
              : null}
            Your text is safe either way — whichever version you don&apos;t keep is saved to this
            draft&apos;s history first, so you can restore it later.
          </DialogDescription>
        </DialogHeader>

        <div className="text-xs text-muted-foreground">
          Compared to the saved version, your copy {added ? <>adds <span className="text-success">{added}</span> line{added === 1 ? "" : "s"}</> : null}
          {added && removed ? " and " : null}
          {removed ? <>removes <span className="text-destructive">{removed}</span> line{removed === 1 ? "" : "s"}</> : null}
          {!added && !removed ? "has no body changes (only other fields differ)." : "."}
          {" "}
          <button className="text-highlight-ink hover:underline" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? "Hide comparison" : "Compare"}
          </button>
        </div>

        {showDiff && (
          <div className="max-h-72 overflow-auto rounded-lg border border-border font-mono text-xs leading-relaxed">
            {collapsed.map((l, i) =>
              l.op === "skip" ? (
                <div key={i} className="px-2 py-0.5 text-muted-foreground bg-muted/40 text-center">
                  ⋯ {l.count} unchanged line{l.count === 1 ? "" : "s"}
                </div>
              ) : (
                <div key={i} className={cn(
                  "px-2 whitespace-pre-wrap break-words",
                  l.op === "add" && "bg-success/15 text-success",
                  l.op === "remove" && "bg-destructive/10 text-destructive",
                )}>
                  <span className="select-none opacity-50 mr-2">{l.op === "add" ? "+" : l.op === "remove" ? "−" : " "}</span>
                  {l.text || " "}
                </div>
              ),
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Decide later</Button>
          <Button variant="outline" onClick={onTakeTheirs}>Load theirs</Button>
          <Button onClick={onKeepMine}>Keep mine</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
