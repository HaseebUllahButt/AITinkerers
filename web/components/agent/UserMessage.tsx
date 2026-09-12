"use client";

// Summit Agent — the human turn.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §7.1.

import { memo } from "react";
import { ElementList } from "./elements/ElementList";
import { useElementsFor } from "./store/hooks";
import type { AgentNode } from "./types";
import { cn } from "@/lib/utils";

export const UserMessage = memo(function UserMessage({ node }: { node: AgentNode }) {
  // Attachments hang off the user node like any other element, so this is the same subscription
  // every other row uses; it is reference-stable and returns the frozen empty array when there are
  // none, so this component does not re-render when someone else's elements arrive.
  const elements = useElementsFor(node.id);
  const hasAttachments = elements.length > 0;

  return (
    // `data-role="user"` is the scroll anchor contract (§6.5): the scroll layer finds the newest
    // user row by DOM query — never by ref — and measures `nextElementSibling` from it to size the
    // spacer. It must sit on the ROW ROOT, and this row must stay a direct child of the content
    // wrapper. Renaming or nesting this attribute breaks jump-to-top with no error.
    <div
      data-role="user"
      data-node-id={node.id}
      className="flex flex-col items-end gap-1.5"
    >
      {hasAttachments ? (
        <div className="flex w-full justify-end">
          <ElementList elements={elements} />
        </div>
      ) : null}

      {/*
        A <pre> with an inherited font, not a <div>: pasted indentation has to survive verbatim
        without the text turning into a code block. Never markdown — a pasted subject line with
        asterisks must look exactly as typed.

        Colour: `bg-accent` + `text-accent-foreground`. In this palette `--accent` is a translucent
        white rim over the canvas wash and `--accent-foreground` is the same ink as `--foreground`
        (#14262a light / #e6efee dark), so the highest-traffic text surface here clears 4.5:1 in
        both themes. Do not swap to a bare `text-foreground` on a tinted background without
        re-measuring.
      */}
      <pre
        style={{ fontFamily: "inherit" }}
        className={cn(
          "ml-auto max-w-[70%] rounded-3xl bg-accent px-5 py-2.5 text-sm text-accent-foreground",
          "break-words whitespace-pre-wrap",
          // The corner nearest the attachments tightens so the stack and the bubble read as one
          // object rather than two floating shapes.
          hasAttachments && "rounded-tr-lg",
        )}
      >
        {node.output ?? ""}
      </pre>
    </div>
  );
});
