"use client";

// §10.2 — copy the finished answer in two flavours at once.
//
// The whole point of this button is that pasting into a code editor gets markdown source and
// pasting into Slack/Docs/Notion gets the rendered thing, from the *same* click. That only works
// if both MIME types are keys of ONE ClipboardItem; two ClipboardItems in the array is a spec
// violation and only the first one survives the paste.

import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { COPY_RESET_MS, TOOLTIP_DELAY_MS } from "../constants";

export interface CopyButtonProps {
  /** The raw markdown source. Written as `text/plain`. */
  text: string;
  /**
   * The rendered OUTPUT element — never a wrapper. `innerHTML` off this node is written as
   * `text/html`, so scoping it to the output div is what stops a copy from silently swallowing
   * the tool-input block rendered above it.
   */
  contentRef?: RefObject<HTMLElement | null>;
  /** Tooltip/aria label in the idle state. */
  label?: string;
  /** Tooltip/aria label in the confirmed state. */
  copiedLabel?: string;
  className?: string;
}

export function CopyButton({
  text,
  contentRef,
  label = "Copy",
  copiedLabel = "Copied",
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  // Chainlit leaks this timer: once transcripts virtualize, a message that unmounts inside the
  // 2000ms window fires setState on a dead component. Clear on unmount, and clear again on every
  // click so a rapid re-click restarts the full window instead of inheriting the old deadline.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async () => {
    try {
      // Guard `typeof ClipboardItem` BEFORE constructing it. Chainlit constructs first and checks
      // second, so on a browser without ClipboardItem it throws past its own writeText fallback.
      if (
        navigator.clipboard?.write &&
        contentRef?.current &&
        typeof ClipboardItem !== "undefined"
      ) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([contentRef.current.innerHTML], { type: "text/html" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      if (timer.current) clearTimeout(timer.current);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), COPY_RESET_MS);
    } catch {
      // Clipboard writes genuinely fail: insecure context, denied permission, Safari's
      // user-gesture rules. A silent no-op is the worst outcome — the user pastes stale content.
      toast.error("Copy failed");
    }
  }, [contentRef, text]);

  return (
    <>
      <Tooltip>
        {/*
          Base UI's tooltip association is not a substitute for a label: it breaks on
          pointer-events-none triggers and never fires on touch. Every icon-only button in this
          row carries an explicit aria-label IN ADDITION to its tooltip.
        */}
        <TooltipTrigger
          delay={TOOLTIP_DELAY_MS}
          render={<Button variant="ghost" size="icon-xs" />}
          aria-label={copied ? copiedLabel : label}
          onClick={copy}
          className={cn("text-muted-foreground hover:text-foreground", className)}
        >
          {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        </TooltipTrigger>
        {/*
          Relabelling the tooltip is free feedback: it is already open under the cursor, so the
          icon swap alone would be missed by anyone whose eyes were on the text.
        */}
        <TooltipContent>{copied ? copiedLabel : label}</TooltipContent>
      </Tooltip>

      {/*
        Icon + tooltip are both visual. Screen readers get the confirmation here.

        `top-0 left-0` is load-bearing, not cosmetic. `sr-only` is `position:absolute` with no
        offsets, so the span resolves to its STATIC position inside whatever the nearest positioned
        ancestor happens to be — here the scroll container, hundreds of pixels up the tree. Deep in a
        long transcript that puts a 1px box past the container's bottom edge, which inflates
        scrollHeight and gives the page a phantom scrollbar (measured: 137px of dead scroll on
        /hermes, with the composer clipped as a result). Pinning it to the containing block's origin
        keeps it inside the box. Verified in the browser, not just reasoned about.
      */}
      <span role="status" aria-live="polite" className="sr-only top-0 left-0">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </>
  );
}
