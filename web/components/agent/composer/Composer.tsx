"use client";

// SearchOps Agent — the composer.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §11. Fixes D7 (both pages disable the whole composer while the
// agent runs) and D8 (the writer has no stop button; Hermes' stop changes the footer's width).
//
// ══ The contract with ChatSurface ═══════════════════════════════════════════════════════════════
//
//   • `runActive` is a PROP, read HIGH via `useRunState()` and passed down (§5.1). It must never
//     travel through context — anything that changes at turn frequency in context defeats every
//     `memo` in the transcript.
//   • The ask is read here via `useAsk()`. It changes ~twice per turn, this component already
//     re-renders on every keystroke of the draft, and gating on the ask is a composer concern.
//   • The draft lives in local `useState`, deliberately. Per §5.2 it is the one piece of state that
//     changes per keystroke and it must not be able to re-render anything above this component.
//   • The composer sits OUTSIDE the scroll container (§11.5). Its height changes — autosize,
//     banner, ask affordances — alter the container's `clientHeight`, which is why the spacer's
//     ResizeObserver watches the container itself and not just the content.
//
// ══ The one rule (§11.1) ════════════════════════════════════════════════════════════════════════
//
// The textarea is NEVER given `disabled`. Submission is blocked by an early return in `submit()`;
// only the toolbar buttons are disabled. You can type a follow-up while the agent streams, with the
// caret and the draft intact.

import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
  type Ref,
} from "react";

import { Paperclip } from "lucide-react";

import { cn } from "@/lib/utils";

import { useAsk } from "../store/hooks";
import { AutoResizeTextarea } from "./AutoResizeTextarea";
import { SubmitButton } from "./SubmitButton";

/** Imperative surface for programmatic draft writes: `?prompt=`, a retry, a quoted reply. */
export interface ComposerHandle {
  /** Replace the draft. The autosize effect is keyed on the value, so the box resizes. */
  setDraft(text: string): void;
  clear(): void;
  focus(): void;
}

export interface ComposerProps {
  /** Null → no thread to post to. Blocks submission; does NOT disable the textarea. */
  sessionId: string | null;
  /** The page can mint a session on demand, so an absent `sessionId` is not a blocker. */
  canOpenSession?: boolean;
  /** Is a turn in flight? Drives Send ⇄ Stop and the toolbar, never the textarea. */
  runActive: boolean;
  /**
   * Network/transport reachability, if the page tracks it. Blocks submission when false.
   * Defaults to true — a page with no connection signal is assumed connected.
   */
  connected?: boolean;

  /** Called with the trimmed draft. The parent re-arms follow intent, then calls `stream.send`. */
  onSubmit: (message: string) => void;
  /** Local-first stop (§5.6): the parent's `stream.stop()` mutates state before touching the wire. */
  onStop: () => void;

  placeholder?: string;
  /** Rendered between the transcript and the card (e.g. the writer's "N proposals waiting"). */
  banner?: ReactNode;
  /** Page-supplied controls in the toolbar, left of the submit slot. Disabled with the toolbar. */
  composerSlot?: ReactNode;

  /**
   * Files the person attached, by paste, drop, or the paperclip. The page uploads them and decides
   * what to do with the result; the composer only collects them.
   *
   * Its presence is also the feature switch: with no `onAttach` there is no paperclip, no drop
   * target, and paste behaves exactly as the browser intends.
   */
  onAttach?: (files: File[]) => void;

  /** Attached-file chips, rendered by the page above the toolbar (it owns upload state). */
  attachmentSlot?: ReactNode;

  /** Seeds the draft on first mount only (a `?prompt=` deep link). */
  defaultValue?: string;
  ref?: Ref<ComposerHandle>;
  className?: string;
}

// ── mobile detection (§11.6) ────────────────────────────────────────────────────────────────────
//
// Matches Tailwind's `md` breakpoint. Module-scope subscribe/snapshot functions so the identities
// are stable and `useSyncExternalStore` does not re-subscribe on every commit.

const MOBILE_QUERY = "(max-width: 767px)";

function subscribeMobile(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getMobileSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(MOBILE_QUERY).matches;
}

/**
 * SSR answer: "assume mobile".
 *
 * Deliberately pessimistic. Guessing "desktop" on the server means a phone autofocuses during
 * hydration — the software keyboard pops on load, the viewport collapses to a third of its height
 * and the transcript scrolls out of view. Guessing "mobile" costs a desktop user one extra frame
 * before the caret lands, which nobody can see.
 */
function getServerMobileSnapshot(): boolean {
  return true;
}

export function Composer({
  sessionId,
  canOpenSession = false,
  runActive,
  connected = true,
  onSubmit,
  onStop,
  placeholder,
  banner,
  composerSlot,
  onAttach,
  attachmentSlot,
  defaultValue = "",
  ref,
  className,
}: ComposerProps) {
  const [value, setValue] = useState(defaultValue);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const ask = useAsk();

  const isMobile = useSyncExternalStore(subscribeMobile, getMobileSnapshot, getServerMobileSnapshot);

  // A pending ask blocks free text UNLESS it is a text ask or explicitly allows one alongside its
  // choices. When it does allow text, the parent routes the submit to `answerAsk` — the composer
  // knows nothing about the ask beyond whether it blocks.
  //
  // `runActive` is NOT in here, on purpose (§11.1): queueing a follow-up while the agent streams is
  // allowed, and `useAgentStream` holds it in a single-slot queue that drains at the turn boundary.
  const askBlocks = !!ask && ask.status === "pending" && ask.askKind !== "text" && !ask.allowText;
  // `!sessionId` only blocks when nobody can create one. Where the page supplies onRequireSession,
  // the first send IS the thing that opens the thread.
  const submitBlocked = !connected || (!sessionId && !canOpenSession) || askBlocks;

  // Toolbar buttons — unlike the textarea — DO go dead. There is nothing to attach to and nothing
  // to configure when there is no session, and the page's own slot controls almost always mutate
  // the turn that is currently streaming.
  const toolbarDisabled = submitBlocked || runActive;

  const canSend = !submitBlocked && value.trim() !== "";

  const submit = useCallback(() => {
    // The early return IS the block (§11.1). Do not turn this into a `disabled` on the input.
    if (submitBlocked) return;
    const message = value.trim();
    if (!message) return;
    // Clear before handing off, so a parent that re-renders synchronously never paints the sent
    // text back into the box.
    setValue("");
    onSubmit(message);
    // Restore focus (§11.6). A click on Send moved focus to the button; without this the next
    // keystroke goes nowhere and the user has to click back into the composer every single turn.
    textareaRef.current?.focus();
  }, [onSubmit, submitBlocked, value]);

  useImperativeHandle(
    ref,
    (): ComposerHandle => ({
      setDraft: (text: string) => setValue(text),
      clear: () => setValue(""),
      focus: () => textareaRef.current?.focus(),
    }),
    [],
  );

  const handlePaste = useCallback(
    (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
      // Until a page passes `onAttach`, paste behaves exactly as the browser intends — a text paste
      // is never intercepted.
      if (!onAttach) return;
      const items = e.clipboardData?.files;
      if (!items || items.length === 0) return;
      const images = Array.from(items).filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      // Only prevented once we know we are handling it: Safari otherwise inserts the blob's
      // filename into the draft as text alongside the attachment.
      e.preventDefault();
      onAttach(images);
    },
    [onAttach],
  );

  // ── drag and drop ─────────────────────────────────────────────────────────────────────────────
  //
  // Counted, not boolean. `dragenter`/`dragleave` fire for every child element the pointer crosses,
  // so a plain flag flickers off the moment the cursor moves from the card onto the textarea inside
  // it. Tracking depth means the highlight only clears when the pointer has genuinely left.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const onDragEnter = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    if (!onAttach || !e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }, [onAttach]);

  const onDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    // Without preventDefault on dragover the browser refuses the drop and opens the file instead,
    // navigating away from the conversation.
    if (!onAttach || !e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
  }, [onAttach]);

  const onDragLeave = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    if (!onAttach) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, [onAttach]);

  const onDrop = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    if (!onAttach) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    // Everything, not just images: the server decides what it can read and reports per file. A
    // client-side filter here would silently swallow a .md the model could have used.
    if (files.length) onAttach(files);
  }, [onAttach]);

  const effectivePlaceholder = useMemo(() => {
    if (!sessionId && !canOpenSession) return "Start a session to send a message";
    if (askBlocks) return "Answer the question above to continue";
    // NOTE: the placeholder does NOT change while the agent runs. It used to say "ask anything"
    // over a disabled textarea — the contradiction at the heart of D7.
    return placeholder ?? "Ask anything…";
  }, [askBlocks, placeholder, sessionId, canOpenSession]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {banner}

      {/* The CARD owns the focus affordance — the textarea's own ring is stripped, or the two
          nest and you get a double outline (§11.2). */}
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          // The caret sits at the very start of the first line, hard against the top-left corner —
          // the one spot where the border curves toward the text. Matching the inset to the radius
          // (px-3 at rounded-xl) left it visibly cramped, and px-4 was still tight. The inset has to
          // CLEAR the radius with room to spare, so: 20px horizontal / 16px vertical against a 12px
          // radius. Measured caret-to-border afterwards, not eyeballed.
          "relative rounded-xl border border-input bg-background/80 px-5 py-4 backdrop-blur-[20px]",
          "transition-[color,box-shadow,border-color]",
          "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          // Dragging wins over the focus ring: while a file is over the card, "you can drop here" is
          // the only thing worth saying.
          dragging && "border-highlight ring-3 ring-highlight/40",
        )}
      >
        {dragging && (
          // pointer-events-none matters: an overlay that swallows the drop makes the whole thing
          // look broken at the last moment.
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/85">
            <span className="text-sm font-medium">Drop to attach</span>
          </div>
        )}
        <AutoResizeTextarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onSubmit={submit}
          onPaste={handlePaste}
          autoFocus={!isMobile}
          placeholder={effectivePlaceholder}
          aria-label="Message"
        />

        {attachmentSlot}

        <div className="mt-2 flex items-center justify-between gap-2">
          {/* A real `<fieldset disabled>` rather than a className toggle: it disables every nested
              native control at once, so a page can drop arbitrary buttons into `composerSlot`
              without knowing anything about the run state. `:disabled` matches the fieldset itself,
              which is what greys the group. */}
          <fieldset
            disabled={toolbarDisabled}
            className="m-0 flex min-w-0 items-center gap-1 border-0 p-0 disabled:pointer-events-none disabled:opacity-50"
          >
            {onAttach && (
              <>
                {/* The input is the control; the button just clicks it. A styled <label> would work
                    too, but a real button keeps keyboard focus and the disabled fieldset behaving
                    like every other control in this row. */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length) onAttach(files);
                    // Cleared so choosing the SAME file twice in a row still fires onChange.
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach files"
                  title="Attach images or text files"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
              </>
            )}
            {composerSlot}
          </fieldset>

          <SubmitButton
            runActive={runActive}
            canSend={canSend}
            onSend={submit}
            onStop={onStop}
          />
        </div>
      </div>
    </div>
  );
}
