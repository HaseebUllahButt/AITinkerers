// SearchOps Agent — the type contract for the shared chat surface.
//
// This module is the single source of truth for every other file under src/components/agent/.
// It is pure types plus one error class, so it is safe to import from a server component; nothing
// here touches the DOM.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §2.2 (props), §4.2 (event union), §5 (state model).
//
// The discriminant on the event union is `t`, deliberately, because that is what the two existing
// SSE producers already emit (src/lib/hermes/agent.ts, src/lib/writer/agent.ts). Renaming it would
// force a server change before any of this could land.

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

// ─────────────────────────────────────────────────────────────── mode & feature flags

export type AgentMode = "hermes" | "writer";

export interface Starter {
  id: string;
  /** Shown on the chip. */
  label: string;
  /** What is actually sent when the chip is clicked. */
  prompt: string;
  icon?: LucideIcon;
}

export interface AgentFeatureFlags {
  /** Jump the newest user message to the top of the viewport on submit. Default true. */
  jumpToTop: boolean;
  /** Stick to the bottom while the assistant streams. Default true. */
  followStream: boolean;
  /** Show thumbs + comment on completed runs. Default true. */
  feedback: boolean;
  /** Show the copy button on completed assistant messages. Default true. */
  copy: boolean;
  /** Render inline image/file elements. Default true. */
  elements: boolean;
  /** Render the token-usage footer. Default: true for hermes, false for writer. */
  usageFooter: boolean;
}

// ─────────────────────────────────────────────────────────────── node model

export type NodeKind =
  | "user" // a human turn
  | "assistant" // model prose
  | "thinking" // summarized reasoning
  | "tool" // a tool call
  | "table" // a rendered table (legacy `table` event)
  | "options" // legacy `options` event, until it becomes an `ask`
  | "confirm" // an irreversible-action card
  | "picker"; // multi-select finalize table (competitor-backlink flow)

export type RunEndReason = "complete" | "stopped" | "error" | "continue";

/** Payload for the legacy `table` node. Retired in P1 when tables become elements. */
export interface TableData {
  kind: "table";
  title: string;
  columns: string[];
  rows: string[][];
}

/**
 * Payload for the legacy `options` node. Retired in P1 when the bare `options` event is replaced
 * by the rich `ask`.
 *
 * IMPORTANT for whoever renders `kind: 'options'`: the legacy adapter emits BOTH this node (as the
 * anchor) and a matching `ask` whose `stepId` is this node's id. Render the question text here and
 * let `AskCard` own the buttons — rendering the choices in both places double-draws them.
 */
export interface OptionsData {
  kind: "options";
  question: string;
  options: string[];
}

/** Payload for the SearchOps-specific irreversible-action confirmation card. */
export interface ConfirmData {
  kind: "confirm";
  actionId: string;
  /** The action's own kind string (e.g. "send_email"), NOT a NodeKind. */
  actionKind: string;
  summary: string;
  params?: Record<string, unknown>;
  status: "proposed" | "confirmed" | "declined" | "failed";
  outcome?: string;
  detail?: string;
}

/**
 * Kind-specific payload carried on `node_start` and stored on the node.
 *
 * This is the one field added beyond the spec's literal `node_start` shape. Legacy `table`,
 * `options` and `confirm` events carry structured data that has nowhere else to live, and stuffing
 * it into `output` as JSON would make the markdown renderer parse it. One optional discriminated
 * field is the smallest honest way to carry it. It disappears with the legacy adapter in P1.
 */
/** The competitor-backlink finalize step: a table the human ticks rows in. See ask/PickerCard. */
export interface PickerCardData {
  kind: "picker";
  title: string;
  columns: string[];
  rows: string[][];
  /** Index of the column whose values are sent back verbatim. */
  keyCol: number;
}

export type NodeData = TableData | OptionsData | ConfirmData | PickerCardData;

export interface AgentNode {
  id: string;
  runId: string;
  parentId?: string;
  kind: NodeKind;
  /** Machine name (tool name). Never shown raw — see `label`. */
  name?: string;
  /** Human-readable label. Falls back to `name` at render time. */
  label?: string;
  detail?: string;
  /** Tool input, rendered in the accordion body above `output`. */
  input?: string;
  inputLang?: string;
  /** Streamed prose / tool output. The markdown source for assistant nodes. */
  output?: string;
  /** ISO-8601 UTC, server-authoritative. */
  start?: string;
  /** ISO-8601 UTC. Absent while the node is open. */
  end?: string;
  isError?: boolean;
  /**
   * True between `node_start` and `node_end`. Drives the cursor sentinel. NOT the same as
   * "running" — see `isNodeRunning()` in store/selectors.ts, which ANDs this with the run flag so
   * an aborted stream can never leave an orphaned shimmer.
   */
  streaming: boolean;
  /** Mount-time seed for the accordion. Never a controlled prop (§7.5). */
  defaultOpen?: boolean;
  /** Collapse on the running → done edge, unless the user touched it or it errored. */
  autoCollapse?: boolean;
  data?: NodeData;
}

// ─────────────────────────────────────────────────────────────── elements

export interface AgentElement {
  /** Stable across re-emits — the upsert key. */
  id: string;
  /** Node id this hangs off. */
  forId: string;
  type: "image" | "file" | "text" | "table";
  /** Also the alt text — make it descriptive. */
  name: string;
  display: "inline" | "side";
  /** Absent while status === 'pending'. */
  url?: string;
  mime?: string;
  size?: "small" | "medium" | "large";
  /** REQUIRED for images the moment they are known — this is what reserves the box (§6.8). */
  width?: number;
  height?: number;
  status: "pending" | "ready" | "error";
}

// ─────────────────────────────────────────────────────────────── asks

export type AskAnswer =
  | { type: "choice"; choiceId: string }
  | { type: "text"; text: string }
  | { type: "form"; values: Record<string, unknown>; submitted: boolean };

export interface AskChoice {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  variant?: "default" | "outline" | "destructive";
  /** Turns the row into an image-choice grid (§9.5). */
  imageUrl?: string;
}

export interface FormField {
  id: string;
  label: string;
  required?: boolean;
  help?: string;
  type: "text" | "textarea" | "select" | "multiselect" | "number" | "date" | "toggle" | "url";
  options?: string[];
  value?: unknown;
  placeholder?: string;
}

export interface FormSpec {
  fields: FormField[];
  submitLabel?: string;
  cancelLabel?: string;
}

export type AskKind = "action" | "text" | "form";

/**
 * Client-side ask state. `status` is local (the three-phase click of §9.4); everything else comes
 * off the wire.
 */
export interface AskState {
  askId: string;
  /** The node the card attaches to. Gate on this, NEVER on "is the last message" (§9.3). */
  stepId: string;
  runId: string;
  askKind: AskKind;
  prompt: string;
  choices?: AskChoice[];
  form?: FormSpec;
  allowText?: boolean;
  cancel?: { label: string } | null;
  /** ABSOLUTE ISO timestamp, never a duration (§9.2). */
  deadline: string;
  status: "pending" | "submitting" | "resolved" | "timeout" | "cancelled";
  /** Which choice the user picked, for the optimistic spinner. */
  chosenId?: string;
  /** Terminal text once resolved — "Selected: X", "Skipped", "No answer — timed out". */
  summary?: string;
}

// ─────────────────────────────────────────────────────────────── run

export interface RunState {
  runId: string | null;
  active: boolean;
  /** Terminal reason of the most recent run. null while a run is in flight. */
  lastReason: RunEndReason | null;
}

// ─────────────────────────────────────────────────────────────── the event union

export type AgentEvent =
  // run framing
  | { t: "run_start"; runId: string; ts: string }
  | { t: "run_end"; runId: string; ts: string; reason: RunEndReason }

  // nodes
  | {
      t: "node_start";
      id: string;
      runId: string;
      parentId?: string;
      kind: NodeKind;
      name?: string;
      label?: string;
      detail?: string;
      input?: string;
      inputLang?: string;
      /** ISO-8601 UTC, server-authoritative. */
      start: string;
      defaultOpen?: boolean;
      autoCollapse?: boolean;
      data?: NodeData;
    }
  | { t: "token"; id: string; text: string; target?: "output" | "input" }
  | { t: "node_end"; id: string; end: string; output?: string; isError?: boolean }

  // elements
  | { t: "element"; element: AgentElement }
  | { t: "element_removed"; id: string }

  // asks
  | {
      t: "ask";
      askId: string;
      stepId: string;
      runId: string;
      askKind: AskKind;
      prompt: string;
      choices?: AskChoice[];
      form?: FormSpec;
      allowText?: boolean;
      cancel?: { label: string } | null;
      /** ABSOLUTE ISO timestamp, never a duration. */
      deadline: string;
    }
  | { t: "ask_resolved"; askId: string; summary: string }
  | { t: "ask_timeout"; askId: string }
  | { t: "ask_cancelled"; askId: string }

  // irreversible-action confirmation (SearchOps-specific, keep)
  | {
      t: "confirm";
      actionId: string;
      runId: string;
      kind: string;
      summary: string;
      params?: Record<string, unknown>;
    }
  | {
      t: "confirm_resolved";
      actionId: string;
      status: "confirmed" | "declined" | "failed";
      outcome?: string;
      detail?: string;
    }

  // feedback echo (server confirms a write)
  | { t: "feedback"; runId: string; value: 0 | 1; comment?: string }

  // out-of-band, forwarded to `onEvent`, never rendered by the surface
  | { t: "usage"; usage: Record<string, number> }
  | { t: "phase"; phase: string }
  /**
   * `raw` carries the untranslated legacy event. The writer's progress event has four fields
   * (sections_written/sections_total/words/target_words) and the draft pane needs all of them;
   * squeezing it into done/total/label would silently drop the word counts. Deleted with the
   * legacy adapter in P1.
   */
  | { t: "progress"; done: number; total: number; label?: string; raw?: unknown }
  | { t: "continuing"; runId: string; raw?: unknown }
  | { t: "stalled"; message: string; raw?: unknown }
  | { t: "email"; payload: unknown }
  | { t: "draft"; payload: unknown }

  // terminal
  | { t: "error"; message: string; nodeId?: string; fatal?: boolean }
  | { t: "done"; needsContinuation?: boolean };

export type AgentEventType = AgentEvent["t"];

// ─────────────────────────────────────────────────────────────── transport

/** The row shape returned by POST /api/hermes/actions/[id]. Kept verbatim from hermes/page.tsx. */
export interface ActionRow {
  id: string;
  kind: string;
  summary: string;
  status: string;
  resolved_by: string | null;
  result: { http_status?: number; response?: unknown } | null;
}

export interface FeedbackPayload {
  runId: string;
  /** `null` deletes the signal — clicking the already-set thumb toggles it off (§10.3). */
  value: 0 | 1 | null;
  comment?: string;
}

/** Rehydration payload. Fed through `upsertNode` one node at a time — never `setNodes(final)`. */
export interface AgentSnapshot {
  nodes: AgentNode[];
  elements?: AgentElement[];
  /** An unanswered ask replayed on reconnect (§9.2). */
  ask?: AskState | null;
}

/** Thrown by `answerAsk` on a 409 — the ask was already answered elsewhere. Surface as a toast. */
export class AskConflictError extends Error {
  readonly askId: string;
  constructor(askId: string, message = "That question was already answered.") {
    super(message);
    this.name = "AskConflictError";
    this.askId = askId;
  }
}

export interface AgentTransport {
  /**
   * POST that returns an SSE `Response`. MUST honour `signal`.
   *
   * `continuation` is true for machine-driven follow-on segments (the writer's
   * `done.needs_continuation` loop). A continuation carries no human message — the writer's route
   * expects the `message` key to be absent, so send `{}` rather than `{ message: "" }`.
   */
  startTurn(args: { message: string; signal: AbortSignal; continuation?: boolean }): Promise<Response>;
  /** Server-side stop flag. Called AFTER the client has already stopped locally. */
  stopTurn(): Promise<void>;
  /** Answer a pending ask. Rejects with `AskConflictError` on 409. */
  answerAsk(args: { askId: string; answer: AskAnswer }): Promise<void>;
  /** Resolve a confirmation card. */
  decideAction(args: { actionId: string; decision: "confirm" | "decline" }): Promise<ActionRow>;
  /** Persist a feedback signal. Optional — omit to hide the thumbs. */
  submitFeedback?(args: FeedbackPayload): Promise<void>;
  /** Rehydrate a thread. Returns the canonical node list; called ONLY on session open. */
  loadTranscript(): Promise<AgentSnapshot>;
}

// ─────────────────────────────────────────────────────────────── surface props

export interface ChatSurfaceProps {
  mode: AgentMode;
  /** null → render `emptyState` and disable the composer. */
  sessionId: string | null;
  /** Must be referentially stable per session (wrap in useMemo keyed on sessionId). */
  transport: AgentTransport;

  /** Shown above the transcript when the thread has no user turns yet. */
  heading?: ReactNode;
  /** Chips under `heading`. Clicking one submits `prompt`. */
  starters?: Starter[];
  /**
   * Called when the human tries to start something but no thread is open — today, a starter chip on
   * the zero state. The page opens a session and replays the prompt into it. Optional: a surface
   * whose page cannot mint sessions simply leaves the chips disabled, which is the old behaviour.
   */
  onRequireSession?: (prompt: string) => void;
  /** Shown when `sessionId === null`. */
  emptyState?: ReactNode;
  placeholder?: string;

  /** Extra controls rendered in the composer toolbar, left of the submit button. */
  composerSlot?: ReactNode;
  /**
   * Files attached by paste, drop, or the paperclip. The page uploads them and owns the result.
   * Its presence is the feature switch — without it there is no paperclip and no drop target.
   */
  onAttach?: (files: File[]) => void;
  /** Chips for the attached files, rendered above the composer toolbar by the page. */
  attachmentSlot?: ReactNode;
  /** Rendered between the transcript and the composer (e.g. writer's "N proposals waiting"). */
  banner?: ReactNode;

  /**
   * Side channel for events the surface does not render: `usage`, `phase`, `progress`,
   * `continuing`, `stalled`, `email`, `draft`. Called from the reader loop, NOT from render.
   * MUST be wrapped in useCallback by the page.
   */
  onEvent?: (event: AgentEvent) => void;
  /** Fired once per turn after the stream closes, with the terminal reason. */
  onTurnEnd?: (reason: RunEndReason) => void;

  features?: Partial<AgentFeatureFlags>;
  className?: string;
}
