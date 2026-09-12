"use client";

// The affordance on a chat row: one click to open, one to file it.
//
// A radio group rather than a list of "Move to X" commands, because a conversation is in exactly
// one project and the menu should show which — including when the answer is none. "Not in a project"
// is a real item you can select, not the absence of a selection: unfiling is a thing people do, and
// deleting a project puts chats back here, so it has to be reachable on purpose.
//
// The trigger is a sibling of the row's button, never a child of it. A button inside a button is
// invalid markup and browsers resolve it by dropping one of them.

import { FolderPlus, Trash2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { projectDotClass } from "./colors";
import type { ProjectRow } from "./types";

/** Radio values are strings, and SQL NULL is not one. This sentinel is the unfiled bucket inside
 *  the menu only — it never reaches the wire, where the value is a real `null`. */
const NONE = "__none__";

export interface SessionProjectMenuProps {
  projects: ProjectRow[];
  /** The chat's current project, or null when it is unfiled. */
  value: string | null;
  onAssign: (projectId: string | null) => void;
  /** Open the create dialog with this chat queued to move into whatever gets made. */
  onCreateProject: () => void;
  className?: string;
  /** For screen readers, and for the tooltip — "Move" alone is ambiguous in a list of chats. */
  label: string;
  /** Throw the chat away. Optional so the menu still renders where deleting is not offered. */
  onDelete?: () => void;
}

export function SessionProjectMenu({
  projects,
  value,
  onAssign,
  onCreateProject,
  className,
  label,
  onDelete,
}: SessionProjectMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Move “${label}” to a project`}
        title="Move to a project"
        className={cn(
          "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none",
          "hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
          className,
        )}
      >
        {/* Three dots would say "more"; this says what the menu is for, which matters when it is
            the only thing on the row and it only ever does one job. */}
        <FolderPlus className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Move to project</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value ?? NONE}
          onValueChange={(next: string) => onAssign(next === NONE ? null : next)}
        >
          {/* closeOnClick because picking IS the whole interaction — Base UI leaves radio menus
              open by default, which is right for a filter and wrong for a one-shot move. */}
          <DropdownMenuRadioItem value={NONE} closeOnClick>
            <span className="size-2 shrink-0 rounded-full ring-1 ring-border" aria-hidden />
            Not in a project
          </DropdownMenuRadioItem>
          {projects.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id} closeOnClick>
              <span className={cn("size-2 shrink-0 rounded-full", projectDotClass(p.color))} aria-hidden />
              <span className="truncate">{p.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {/* The first project gets made from here. Without it, a rail with no projects has no way to
            grow one from the thing you were already looking at. */}
        <DropdownMenuItem onClick={onCreateProject}>
          <FolderPlus />
          New project…
        </DropdownMenuItem>
        {/* Deleting lives in the row's existing menu rather than getting its own always-visible
            button. A destructive control that sits permanently next to "open this chat" is a control
            people hit by accident; behind the same menu as everything else it takes an intent. */}
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 />
              Delete chat
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
