"use client";

// Create a project, or rename one. The same three fields either way, so the same dialog.
//
// It holds no `useEffect` to seed itself from props: the parent mounts it only while it is open and
// gives it a `key` that changes per subject, so the initial `useState` IS the seed. The obvious
// alternative — sync props into state on open — is a setState in an effect, the cascading-render
// pattern React 19 lints against, and it would also quietly discard what someone had typed.

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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { MAX_PROJECT_NAME } from "./constants";
import { PROJECT_COLORS, isProjectColor, projectDotClass, type ProjectColor } from "./colors";
import type { ProjectRow } from "./types";

export interface ProjectFormDialogProps {
  /** The project being renamed. Absent when creating. */
  project?: ProjectRow | null;
  /** Colour a NEW project starts on — cycled by the caller so consecutive projects differ. */
  suggestedColor: ProjectColor;
  /** When creating from a chat's menu, the chat that will be filed into it. Shown so the side
   *  effect is stated before it happens rather than discovered afterwards. */
  fileChatTitle?: string | null;
  onOpenChange: (open: boolean) => void;
  /** Resolves to an error message to show inline, or null on success. The 409 for a duplicate name
   *  belongs in the dialog beside the field, not in a toast over a form that already closed. */
  onSubmit: (values: { name: string; color: ProjectColor }) => Promise<string | null>;
}

export function ProjectFormDialog({
  project,
  suggestedColor,
  fileChatTitle,
  onOpenChange,
  onSubmit,
}: ProjectFormDialogProps) {
  const [name, setName] = useState(project?.name ?? "");
  const [color, setColor] = useState<ProjectColor>(
    isProjectColor(project?.color) ? project.color : suggestedColor,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editing = Boolean(project);
  const trimmed = name.trim();

  async function submit() {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const message = await onSubmit({ name: trimmed, color });
    if (message) {
      // Stay open on failure: the name is the thing that was wrong, and it is still in the field.
      setBusy(false);
      setError(message);
      return;
    }
    onOpenChange(false);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{editing ? "Rename project" : "New project"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "The conversations in it stay exactly where they are."
              : fileChatTitle
                ? `“${fileChatTitle}” moves into it.`
                : "A shelf for related conversations. Nothing else changes."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {/* autoFocus is right here: the dialog exists to collect this one string. */}
          <Input
            autoFocus
            value={name}
            maxLength={MAX_PROJECT_NAME}
            placeholder="Launches"
            aria-label="Project name"
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
          />

          <div className="flex items-center gap-2" role="radiogroup" aria-label="Project colour">
            {PROJECT_COLORS.map((token) => (
              <button
                key={token}
                type="button"
                role="radio"
                aria-checked={color === token}
                aria-label={`Colour ${token.replace("chart-", "")}`}
                onClick={() => setColor(token)}
                className={cn(
                  "size-6 rounded-full transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  projectDotClass(token),
                  // Selection is a ring rather than a border so the swatch itself never changes size
                  // and the row does not shuffle as you click along it.
                  color === token ? "ring-2 ring-foreground/60 ring-offset-2 ring-offset-popover" : "opacity-70 hover:opacity-100",
                )}
              />
            ))}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed || busy}>
              {busy ? "Saving…" : editing ? "Rename" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
