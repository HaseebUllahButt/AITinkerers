"use client";

// §10.3 — the comment step.
//
// A bare thumb is a scalar that tells you nothing about *why*. Routing every new score through
// this dialog costs the user one Enter and converts each signal into a labelled training example,
// which is the only reason the feedback loop is worth building at all.

import { useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Loader2Icon } from "lucide-react";

export interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The score about to be committed. 1 = thumbs up, 0 = thumbs down. */
  value: 0 | 1;
  /** Seeds the textarea when reopening an existing comment for edit. */
  initialComment?: string;
  submitting?: boolean;
  /** Score and comment are written TOGETHER — this dialog never commits the score on its own. */
  onSubmit: (comment: string) => void;
  /**
   * The thumb that opened the dialog. Focus returns here on close; without it Base UI falls back
   * to "previously focused element", which is right in the common case and wrong after the row
   * re-renders underneath the open dialog.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function FeedbackDialog({
  open,
  onOpenChange,
  value,
  initialComment,
  submitting = false,
  onSubmit,
  returnFocusRef,
}: FeedbackDialogProps) {
  const [comment, setComment] = useState(initialComment ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reseed on the closed→open EDGE, not on every `initialComment` change: a parent re-render
  // mid-typing must not stomp what the user is writing. Adjusting state during render (rather
  // than in an effect) is the sanctioned pattern — it re-renders before paint instead of
  // cascading a second commit, so the textarea never flashes the stale value.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setComment(initialComment ?? "");
  }

  const positive = value === 1;

  const submit = () => {
    if (submitting) return;
    onSubmit(comment);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter submits. Plain Enter has to stay a newline — the whole value of this dialog
    // is the multi-line "why".
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent
        // Focus lands in the textarea, not on the close button: the textarea is the only reason
        // this dialog exists. Base UI traps focus inside the popup while it is open.
        initialFocus={textareaRef}
        finalFocus={returnFocusRef ?? true}
      >
        <DialogHeader>
          {/* Base UI wires aria-labelledby from Title → popup, so the dialog is labelled. */}
          <DialogTitle>{positive ? "What worked?" : "What went wrong?"}</DialogTitle>
          <DialogDescription>
            {positive
              ? "Optional, but a sentence about what was useful makes this rating worth learning from."
              : "Optional, but a sentence about what was wrong makes this rating worth learning from."}
          </DialogDescription>
        </DialogHeader>

        <Textarea
          ref={textareaRef}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={onKeyDown}
          rows={4}
          placeholder={positive ? "It picked the right sources…" : "It invented a number…"}
          aria-label="Feedback comment"
        />

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={submitting} />}>
            Cancel
          </DialogClose>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2Icon className="animate-spin" aria-hidden /> : null}
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
