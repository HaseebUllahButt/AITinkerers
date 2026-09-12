"use client";

// Summit Agent — the model turn.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §7.2 (layout), §7.4 (cursor), §9.3 (ask placement), §10.1 (actions).
//
// Layout is a two-column flex, not a bubble: a 20px avatar and a content column. The bubble is
// reserved for the human, which is what makes the two turns readable at a glance without colour.

import { memo, useRef } from "react";
import { CircleAlert } from "lucide-react";
import { MarkdownContent } from "./content/Markdown";
import { ElementList } from "./elements/ElementList";
import { MessageActions } from "./actions/MessageActions";
import { AskCard } from "./ask/AskCard";
import { useAsk, useElementsFor } from "./store/hooks";
import { useAgentSurface } from "./surfaceContext";
import type { AgentNode } from "./types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export interface AssistantMessageProps {
  node: AgentNode;
  runActive: boolean;
  /** Avatar renders at depth 0 only; below that the step rail is the depth cue (§7.5). */
  depth: number;
}

export const AssistantMessage = memo(function AssistantMessage({
  node,
  runActive,
  depth,
}: AssistantMessageProps) {
  // Reference-stable per node, and the reason the markdown memo can compare `elements` by
  // reference: the element reducer mints a new array only when an element actually changed.
  const elements = useElementsFor(node.id);
  const ask = useAsk();
  // The one permitted context bag (§5.1 rule 3): transport, feature flags and the follow ref, all
  // stable for the session, so reading them here cannot invalidate this component's memo mid-turn.
  const { transport, followRef, features, onFeedback } = useAgentSurface();

  // Scoped to the OUTPUT div only, so a copy can never pick up a tool-input block or the ask card
  // sitting below it (§10.2).
  const contentRef = useRef<HTMLDivElement>(null);

  // Gate on the ask's `stepId`, NEVER on "is this the last message" — once a tool emits anything
  // after the question, a last-message check attaches the buttons to the wrong bubble (§9.3).
  const askHere = !!ask && ask.stepId === node.id;

  return (
    <div data-role="assistant" data-node-id={node.id} className="flex gap-4">
      {depth === 0 ? (
        node.isError ? (
          <CircleAlert
            role="img"
            aria-label="Error"
            // 5px rather than the avatar's 3px: the glyph's optical centre sits higher than a
            // filled circle's, so it needs the extra 2px to land on the same cap-height.
            className="mt-[5px] size-5 shrink-0 text-destructive"
          />
        ) : (
          <Avatar
            aria-hidden
            className={cn(
              // 20px, nudged 3px down so the circle lands on the cap-height of 28px-line-height text.
              "mt-[3px] size-5 shrink-0",
              // Consecutive assistant rows share one text column, so only the first of a run keeps
              // its avatar. `invisible`, never `display:none` / unmounted: the gap-4 column has to
              // stay aligned or the second paragraph steps left by 36px. Done in CSS because the
              // row cannot know its predecessor's kind without reading another node, and reading
              // another node here would widen this component's subscription.
              "[[data-role=assistant]+[data-role=assistant]_&]:invisible",
            )}
          >
            {/*
              A skeleton circle, never initials: an initial that flashes and is then replaced by an
              image is the cheapest-looking moment in a chat UI, and there is no avatar image here
              to swap in.
            */}
            <AvatarFallback className="animate-pulse bg-muted" />
          </Avatar>
        )
      ) : null}

      <div
        className={cn(
          // min-w so a two-word answer does not collapse the column and wrap the action row.
          "flex min-w-[150px] flex-1 flex-col",
          // depth is NEVER a margin (§7.5). It does exactly two things, and this is the second:
          // release max-width below the root so nested rails do not compound into a narrow gutter.
          depth > 0 && "max-w-full",
        )}
      >
        <div ref={contentRef}>
          {/*
            The streaming cursor is NOT rendered here. `MarkdownContent` appends the ZWSP sentinel
            to the markdown SOURCE while `node.streaming && node.output`, and the parser turns it
            into a <StreamCursor/> at the end of the current inline run. A cursor rendered as a
            sibling block after the markdown lands on its own line and reflows the paragraph every
            time the last word wraps (§7.4).
          */}
          <MarkdownContent node={node} elements={elements} />
        </div>

        {elements.length > 0 ? <ElementList elements={elements} isLiveTurn={runActive} /> : null}

        {/* After the content, before the action strip (§9.3). */}
        {askHere && ask ? <AskCard ask={ask} transport={transport} followRef={followRef} /> : null}

        {/*
          The action row unmounts (rather than greys out) while the turn is in flight — that is what
          makes its end-of-turn appearance read as a deliberate reveal instead of a control
          flickering between states. The `!node.output || node.streaming || runActive` gate lives
          inside MessageActions so every call site gets it.
        */}
        <MessageActions
          node={node}
          runActive={runActive}
          contentRef={contentRef}
          features={features}
          askPending={askHere && ask?.status === "pending"}
          onFeedback={onFeedback}
        />
      </div>
    </div>
  );
});
