"use client";

// Summit Agent — the button row for a blocking ask.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §9.1 (two species of button), §9.3 (the card), §9.4 (three phases).
//
// This is the BLOCKING species: `variant="outline"`, full size, prominent, in its own card. It must
// never be confused with the end-of-turn action strip (`size="sm" variant="ghost"
// text-muted-foreground`), which is an optional thing you may click later. Summit renders one kind
// today, which is why a real question currently reads as decoration.
//
// The row owns NO state and does NO network. It is handed `status`/`chosenId` and calls `onChoose`.
// The three-phase click (§9.4) lives in AskCard, so there is exactly one place that can get the
// stale-ask guard wrong.

import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  Check,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Link as LinkIcon,
  Loader2,
  Mail,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  SkipForward,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AskChoice, AskState } from "../types";

/**
 * The icon names an agent may put on a choice.
 *
 * A closed allow-list on purpose: `AskChoice.icon` is a string off the wire, and the alternative —
 * indexing the whole of lucide dynamically — pulls the entire icon set into this chunk and lets a
 * typo render a crash instead of a button. An unknown name falls back to no icon, never to text.
 */
const CHOICE_ICONS: Readonly<Record<string, LucideIcon>> = {
  "alert-triangle": AlertTriangle,
  "arrow-right": ArrowRight,
  calendar: CalendarDays,
  check: Check,
  clock: Clock,
  download: Download,
  "external-link": ExternalLink,
  file: FileText,
  "file-text": FileText,
  image: ImageIcon,
  link: LinkIcon,
  mail: Mail,
  pencil: Pencil,
  play: Play,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  send: Send,
  settings: Settings,
  skip: SkipForward,
  "skip-forward": SkipForward,
  sparkles: Sparkles,
  "thumbs-down": ThumbsDown,
  "thumbs-up": ThumbsUp,
  trash: Trash2,
  upload: Upload,
  x: X,
};

/** Resolve an agent-supplied icon name. Tolerates `ArrowRight`, `arrow_right`, `arrow-right`. */
export function choiceIcon(name?: string): LucideIcon | undefined {
  if (!name) return undefined;
  const key = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
  return CHOICE_ICONS[key];
}

export interface ChoiceButtonsProps {
  askId: string;
  choices: readonly AskChoice[];
  status: AskState["status"];
  /** Which choice the user picked — drives the optimistic spinner and `aria-pressed`. */
  chosenId?: string;
  onChoose: (choiceId: string) => void;
  className?: string;
}

export function ChoiceButtons({
  askId,
  choices,
  status,
  chosenId,
  onChoose,
  className,
}: ChoiceButtonsProps) {
  // Disabled is gated on the ASK status and nothing else. Deliberately NOT on `runActive`: §9.2 —
  // the run is paused precisely because a human is the bottleneck, and disabling on "running" is
  // the total deadlock where the user cannot answer their own question.
  const locked = status !== "pending";

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {choices.map((c) => {
        const Icon = choiceIcon(c.icon);
        const spinning = status === "submitting" && chosenId === c.id;
        return (
          <Button
            key={c.id}
            id={`ask-${askId}-${c.id}`}
            variant={c.variant ?? "outline"}
            // `break-words h-auto min-h-10 whitespace-normal` is required, not cosmetic:
            // agent-authored labels are prose-length and the default `h-10 whitespace-nowrap`
            // either clips them or blows the row out sideways. `h-auto min-h-10` keeps short
            // labels on the 40px rhythm while letting long ones grow.
            className="h-auto min-h-10 py-2 whitespace-normal break-words"
            disabled={locked}
            aria-pressed={chosenId === c.id}
            aria-describedby={c.description ? `ask-desc-${askId}-${c.id}` : undefined}
            onClick={() => onChoose(c.id)}
          >
            {spinning ? <Loader2 className="size-4 animate-spin" /> : Icon ? <Icon /> : null}
            {c.label}
          </Button>
        );
      })}

      {/* Descriptions are referenced by aria-describedby but rendered visibly under the row, so
          sighted users get the same detail a screen reader does. */}
      {choices.some((c) => c.description) && (
        <ul className="w-full space-y-0.5 pt-0.5">
          {choices
            .filter((c) => c.description)
            .map((c) => (
              <li
                key={c.id}
                id={`ask-desc-${askId}-${c.id}`}
                className="text-xs leading-snug text-muted-foreground"
              >
                <span className="font-medium text-foreground/80">{c.label}</span> — {c.description}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
