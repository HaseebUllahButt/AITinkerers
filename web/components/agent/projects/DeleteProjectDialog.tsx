"use client";

// Deleting a project. The whole job of this dialog is the second sentence.
//
// The foreign key is ON DELETE SET NULL, so the conversations survive — they go back to being
// unfiled. That makes this one of the mildest destructive actions in the app, and a generic "this
// cannot be undone" would make someone hesitate over something harmless, or worse, guess. So the
// copy names the real number and says plainly what happens to it.
//
// A Dialog rather than an AlertDialog because this repo has no alert-dialog primitive, and adding
// one for a single call site is a dependency in exchange for a role attribute.

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { ProjectRow } from "./types";

export interface DeleteProjectDialogProps {
  project: ProjectRow;
  /** How many conversations are filed here — the true total, not just the ones the rail is
   *  showing. Getting this wrong understates a promise, so it comes from the assignment map, which
   *  covers every session the user has. */
  chatCount: number;
  onOpenChange: (open: boolean) => void;
  /** Resolves to an error message, or null on success. */
  onConfirm: () => Promise<string | null>;
}

export function DeleteProjectDialog({ project, chatCount, onOpenChange, onConfirm }: DeleteProjectDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const message = await onConfirm();
    if (message) {
      setBusy(false);
      setError(message);
      return;
    }
    onOpenChange(false);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{project.name}”?</DialogTitle>
          <DialogDescription>
            {chatCount === 0 ? (
              <>There are no conversations in it. Only the project goes.</>
            ) : (
              <>
                The {chatCount === 1 ? "conversation" : `${chatCount} conversations`} in it{" "}
                {chatCount === 1 ? "is" : "are"} not deleted — {chatCount === 1 ? "it moves" : "they move"} back
                to <span className="text-foreground">Not in a project</span>. Only the project itself goes.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy ? "Deleting…" : "Delete project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
