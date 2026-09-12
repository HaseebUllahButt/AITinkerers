"use client";

// SearchOps Agent — one step (tool call or summarized thinking).
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §7.5 (the row, disclosure, open-state machine, nesting,
// partitioning), §7.6 (duration), §7.8 (accordion animation).
//
// The row is ONE LINE OF TEXT. No icon, no spinner, no card. Running is a shimmer on the label
// itself; done is the same box in muted ink. The box is byte-identical in both states, so
// completion causes ZERO reflow — with eight steps, a spinner that mounts and unmounts is eight
// visible jumps, and that single difference is most of why a step list reads as polished.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, CircleAlert } from "lucide-react";
import { MessageRow } from "./MessageRow";
import { StepDuration } from "./StepDuration";
import { StepList } from "./StepList";
import { ElementList } from "./elements/ElementList";
import { ACCORDION_MS, USER_FACING_KINDS, prefersReducedMotion } from "./constants";
import {
  useAgentStoreInstance,
  useChildIds,
  useElementsFor,
  useNode,
} from "./store/hooks";
import { isNodeRunning } from "./store/selectors";
import { cn } from "@/lib/utils";

export interface StepNodeProps {
  id: string;
  runActive: boolean;
  depth: number;
}

export const StepNode = memo(function StepNode({ id, runActive, depth }: StepNodeProps) {
  const store = useAgentStoreInstance();
  const node = useNode(id);
  const childIds = useChildIds(id);
  const elements = useElementsFor(id);

  // The shared three-way AND. `runActive` is in it so a dropped stream, an abort, or a missing
  // `node_end` can never leave an orphaned shimmer — `endRun()` settles every in-flight step at
  // once, which is what makes Stop safe without per-step done events.
  const running = isNodeRunning(node, runActive);

  const rowRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // ── open-state machine (§7.5) ────────────────────────────────────────────────────────────────
  //
  // `defaultOpen` is a mount-time SEED, never a controlled prop: as a prop, every patch during a
  // turn slams the panel back to the server's opinion while the user is reading it.
  const [open, setOpen] = useState(!!node.defaultOpen);
  const userTouched = useRef(false);
  const everRan = useRef(false);
  // Render-phase ref write, deliberately: the auto-collapse effect below needs to know whether THIS
  // client ever saw the step running, and it must be true before that effect's first run on the
  // running → done edge.
  if (running) everRan.current = true;

  // Panel stays mounted through the collapse animation; `open` is intent, `mounted` is presence.
  const [mounted, setMounted] = useState(!!node.defaultOpen);

  // ── children partition (§7.5) ────────────────────────────────────────────────────────────────
  //
  // The two predicates are EXACTLY complementary: overlap renders a step twice, a gap loses a node.
  // Kind is fixed at insert (an `upsertNode` for a known id patches fields, never the kind), so
  // recomputing only when the id list changes is sound — and it keeps `nested` reference-stable,
  // which is what lets `StepList`'s default memo comparator work.
  const { nested, hoisted } = useMemo(() => {
    const nestedIds: string[] = [];
    const hoistedIds: string[] = [];
    for (const cid of childIds) {
      const kind = store.getNode(cid)?.kind;
      if (kind && USER_FACING_KINDS.has(kind)) hoistedIds.push(cid);
      else nestedIds.push(cid);
    }
    return { nested: nestedIds, hoisted: hoistedIds };
  }, [childIds, store]);

  // Re-evaluated every render, so a step that starts empty and later receives output UPGRADES from
  // a plain row to an accordion mid-stream.
  //
  // Deviation from the spec snippet, which reads `childIds.length`: the count must be `nested`, not
  // all children. A step whose only child is a hoisted assistant message renders that child OUTSIDE
  // the body, so `childIds.length` would put a chevron on a panel that expands to nothing — the
  // exact "broken promise" the same paragraph forbids.
  const hasContent = !!(node.input || node.output || nested.length);

  // Auto-collapse on the running → done EDGE only. Keyed on primitives, never on the node object,
  // or every token re-runs it.
  useEffect(() => {
    if (running || !everRan.current || !node.autoCollapse) return;
    // A user toggle wins forever, and an error must never hide itself.
    if (userTouched.current || node.isError) return;
    setOpen(false);
  }, [running, node.autoCollapse, node.isError]);

  // Errors force open, once. `everRan` above and this guard together are the two fixes for
  // Chainlit's resume bug: without `everRan`, every historical step with `autoCollapse` is
  // force-closed on rehydration; without this, a failure auto-hides its own diagnosis.
  useEffect(() => {
    if (node.isError && !userTouched.current) setOpen(true);
  }, [node.isError]);

  // Mount the panel as soon as intent flips open; unmounting is deferred to the animation below.
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // ── accordion animation (§7.8) ───────────────────────────────────────────────────────────────
  const didMount = useRef(false);
  useLayoutEffect(() => {
    const first = !didMount.current;
    didMount.current = true;

    const el = panelRef.current;

    // Replayed history and thread resume open with no mount animation, and reduced motion never
    // animates. Both cases still have to complete the unmount half of a close.
    if (!el || first || prefersReducedMotion()) {
      if (!open) setMounted(false);
      return;
    }

    // Height-animate the OPEN/CLOSE EDGE ONLY, then release to `height: auto`. Deliberately not a
    // `max-height` transition: content that streams into an already-open panel under a max-height
    // cap silently clips. The keyframes (`acc-down` / `acc-up`, reading `--acc-h`) live in
    // agent.css; if they are ever removed the panel simply appears instantly rather than breaking.
    const from = el.getBoundingClientRect().height;
    const target = open ? el.scrollHeight : from;
    el.style.setProperty("--acc-h", `${target}px`);
    el.style.overflow = "hidden";
    el.style.animation = `${open ? "acc-down" : "acc-up"} ${ACCORDION_MS}ms ease-out`;

    // Reading-position compensation: collapsing a tall step whose row sits above the fold otherwise
    // yanks whatever the user was reading up the viewport.
    //
    // TODO(P1): the other half of §7.8 — suppressing the stick-to-bottom write for this 200ms
    // window — needs an entry point on the scroll layer (scroll/useStickToBottom.ts). Until it
    // exists, an expand during an active stream can briefly fight the follow write.
    const scroller = findScrollParent(el);
    const rowEl = rowRef.current;
    const beforeTop = rowEl?.getBoundingClientRect().top ?? 0;
    const aboveFold = !!scroller && !!rowEl && beforeTop < scroller.getBoundingClientRect().top;

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      el.style.animation = "";
      el.style.overflow = "";
      el.style.removeProperty("--acc-h");
      if (aboveFold && scroller && rowEl) {
        const delta = rowEl.getBoundingClientRect().top - beforeTop;
        if (delta) scroller.scrollTop += delta;
      }
      if (!open) setMounted(false);
    };

    el.addEventListener("animationend", done, { once: true });
    // `animationend` never fires in a background tab, and a mid-flight unmount would strand the
    // inline styles. The bail keeps the panel from being stuck with `overflow: hidden`.
    const bail = window.setTimeout(done, ACCORDION_MS + 50);

    return () => {
      window.clearTimeout(bail);
      el.removeEventListener("animationend", done);
      // Rapid re-toggle: clear the inline styles so the next animation starts from a clean box.
      el.style.animation = "";
      el.style.overflow = "";
      el.style.removeProperty("--acc-h");
    };
  }, [open, mounted]);

  // ── presentation ─────────────────────────────────────────────────────────────────────────────

  const label = node.label ?? node.name ?? (node.kind === "thinking" ? "Thinking" : "tool");
  const state = node.isError ? "error" : running ? "running" : "done";
  // The verb carries the state, so it is never conveyed by colour alone.
  const text = node.isError ? `${label} failed` : running ? `Using ${label}` : `Used ${label}`;

  const triggerId = `step-trigger-${node.id}`;
  const panelId = `step-panel-${node.id}`;

  // Identical class list for the interactive and non-interactive rows, so the upgrade to an
  // accordion — and the running → done transition — move nothing.
  const rowClass = cn(
    "flex w-full items-center justify-start gap-1.5 p-0 text-left text-sm",
    // shadcn's trigger base is `transition-all`, which visibly smears the shimmer → muted colour
    // handoff at the moment of completion. Only the chevron is allowed to animate.
    "transition-none hover:no-underline",
    node.isError
      ? "text-destructive"
      : running
        ? "text-foreground"
        : "text-muted-foreground hover:text-foreground",
  );

  const rowInner = (
    <>
      <span className={cn("truncate", running && !node.isError && "loading-shimmer")}>{text}</span>
      {node.isError ? <CircleAlert aria-hidden className="size-3.5 shrink-0" /> : null}
      {hasContent ? (
        <ChevronDown
          aria-hidden
          // The chevron sits IMMEDIATELY after the label, not at the far right edge: far right
          // reads as a settings accordion, adjacent reads as an inline log entry. Its rotation is
          // the entire motion budget of the collapsed row.
          className={cn("size-3.5 shrink-0 transition-transform duration-200", open && "rotate-180")}
        />
      ) : null}
      {node.detail ? (
        <span className="truncate text-muted-foreground/70">{node.detail}</span>
      ) : null}
      <StepDuration node={node} running={running} />
    </>
  );

  const shouldRenderOutput = !!node.output && node.output.trim() !== "";

  return (
    <>
      <div
        ref={rowRef}
        id={`step-${node.id}`}
        data-step-row=""
        // Keyed on the step ID, never the tool name — two calls to the same tool are two rows.
        // The name travels as data so tests and CSS can still target it.
        data-step-name={node.name ?? undefined}
        data-step-kind={node.kind}
        data-step-state={state}
        data-step-depth={depth}
        className={cn(
          // `min-w-0` is the load-bearing part: without it a wide table or <pre> inside an expanded
          // body sets this flex item's min-content width and blows the whole transcript out
          // horizontally (SearchOps's table output hits this immediately). The spec writes `w-0`,
          // which assumes Chainlit's flex-ROW parent; every parent here is a flex COLUMN, where
          // `w-0` wins over stretch and collapses the row to zero width.
          "flex w-full min-w-0 flex-grow flex-col",
        )}
        // depth is NEVER a margin. It does exactly two things, and this is the first: release
        // max-width below the root so nested rails do not compound into a narrow gutter.
        style={depth > 0 ? { maxWidth: "100%" } : undefined}
      >
        {hasContent ? (
          <button
            type="button"
            id={triggerId}
            data-step-trigger=""
            aria-expanded={open}
            aria-controls={panelId}
            className={rowClass}
            onClick={() => {
              userTouched.current = true; // a user toggle wins forever for this step
              setOpen((v) => !v);
            }}
          >
            {rowInner}
          </button>
        ) : (
          // A chevron that expands to nothing is a broken promise, so a step with no body is not a
          // control at all. Same box, so the mid-stream upgrade to an accordion moves nothing.
          <p className={rowClass}>{rowInner}</p>
        )}

        {hasContent && mounted ? (
          <div
            ref={panelRef}
            id={panelId}
            role="region"
            aria-labelledby={triggerId}
            // One 2px rail per nesting level, stacking naturally — the rail IS the depth cue.
            // `overflow-x-auto` so a wide table scrolls inside itself instead of widening the page.
            className="mt-4 ml-1 flex flex-col gap-3 overflow-x-auto border-l-2 border-primary pl-4"
          >
            {node.input ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Input</p>
                {/*
                  Plain <pre>, not the markdown renderer: tool input is JSON or a query, and running
                  it through an inline parser mangles asterisks and underscores. tabIndex makes the
                  scroll region keyboard-reachable, which is required once it can scroll.
                */}
                <pre
                  tabIndex={0}
                  aria-label={`Step input (${node.inputLang ?? "text"})`}
                  className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap"
                >
                  {node.input}
                </pre>
              </div>
            ) : null}

            {/* The "Output" heading stays suppressed until output actually exists. */}
            {shouldRenderOutput ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Output</p>
                <pre
                  tabIndex={0}
                  aria-label="Step output"
                  className="overflow-x-auto text-xs break-words whitespace-pre-wrap"
                >
                  {node.output}
                </pre>
              </div>
            ) : null}

            {nested.length > 0 ? (
              <StepList ids={nested} runActive={runActive} depth={depth + 1} />
            ) : null}
          </div>
        ) : null}
      </div>

      {/*
        Hoisted, OUTSIDE the body and at depth 0 (§7.5). This is how an asset produced inside a tool
        call escapes a collapsed 2px rail and renders at root width — and how assistant prose
        emitted under a step is never swallowed by a step the user happens to have closed.
      */}
      {elements.length > 0 ? <ElementList elements={elements} isLiveTurn={runActive} /> : null}
      {hoisted.map((cid) => (
        <MessageRow key={cid} id={cid} runActive={runActive} depth={0} />
      ))}
    </>
  );
});

/**
 * Nearest scrollable ancestor, for the collapse compensation above.
 *
 * Walks computed `overflow-y` rather than taking a ref, because the scroll container is owned by
 * `scroll/ScrollContainer.tsx` and deliberately does not thread a ref through every row.
 */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const overflowY = window.getComputedStyle(cur).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && cur.scrollHeight > cur.clientHeight) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}
