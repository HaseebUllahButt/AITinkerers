// SearchOps Agent — today's wire format → AgentEvent.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §4.1, §4.3, §4.4. Ships in P0, DELETED in P1.1 once the server owns
// ids.
//
// ══ The two wire formats this has to swallow ════════════════════════════════════════════════════
//
// hermes  (src/lib/hermes/agent.ts, HermesEvent):
//   thinking · text · tool_start · tool_result · table · options · confirm · usage · done · error
//
// writer  (src/lib/writer/agent.ts, WriterEvent + src/app/api/blog/writer/[id]/turn/route.ts):
//   phase · thinking · text · tool_start · tool_result · progress · outline · draft · usage ·
//   done{phase, needs_continuation} · error   … plus route-level: continuing · stalled
//
// They overlap on the interesting part (text/thinking/tool_start/tool_result) and diverge on the
// side channels. Both use the same envelope: `data: ${JSON.stringify(x)}\n\n`. Neither puts an id
// on ANY node — which is the whole reason this file exists, and precisely why §4.3 makes
// server-side ids the one blocking backend change.
//
// The differences that actually cost code here:
//   · hermes has `confirm`/`table`/`options`; writer has none of them.
//   · writer has `progress`/`outline`/`draft`/`phase`/`continuing`/`stalled`; hermes has none.
//   · writer emits `{t:"text", text:""}` as a keepalive — an empty token that must NOT open an
//     assistant node, or every retry paints an empty bubble with a blinking cursor.
//   · writer's `done` carries `phase` and `needs_continuation`; hermes' `done` is bare.
//   · writer's route can emit `continuing`, which starts a SECOND agent segment inside one HTTP
//     request. That is D6's origin: the segment replays tool_start events and the old
//     append-by-position client grew a twin row for each.
//
// ══ RULE ════════════════════════════════════════════════════════════════════════════════════════
// This adapter is the ONLY place that may invent an id. Nothing downstream may.

import { ASK_DEADLINE_MS } from "../constants";
import type { ActionRow, AgentEvent, AgentSnapshot, AgentNode, AskChoice, RunEndReason } from "../types";

// ─────────────────────────────────────────────────────────────── input typing

/**
 * The union of both servers' events. `adapt()` takes `unknown` and narrows through here, because
 * the bytes come off a socket and a malformed frame must be dropped, not thrown on.
 */
export type LegacyEvent =
  | { t: "text"; text: string }
  | { t: "thinking"; text: string }
  | { t: "tool_start"; name: string; label: string; detail?: string }
  | { t: "tool_result"; name: string; label: string; is_error: boolean; detail?: string; preview: string }
  | { t: "table"; title: string; columns: string[]; rows: string[][] }
  | { t: "options"; question: string; options: string[] }
  | { t: "confirm"; action_id: string; kind: string; summary: string }
  | { t: "picker"; title: string; columns: string[]; rows: string[][]; key_col: number }
  | {
      t: "element";
      id: string;
      element_type: "image";
      url: string;
      alt: string;
      mime?: string;
      width?: number;
      height?: number;
    }
  | { t: "usage"; usage: Record<string, number> }
  | { t: "error"; message: string }
  // Two spellings, deliberately. The writer route sends `needs_continuation`; Hermes sends
  // `needsContinuation`. Both are on the wire today, so both are read below — see the `done` case.
  | { t: "done"; phase?: string; needs_continuation?: boolean; needsContinuation?: boolean }
  // writer-only
  | { t: "phase"; phase: string }
  | {
      t: "progress";
      sections_written: number;
      sections_total: number;
      words: number;
      target_words?: number | null;
    }
  | { t: "outline"; outline: unknown }
  | { t: "draft"; draft_id: string }
  | { t: "continuing"; phase?: string; segment?: number }
  | { t: "stalled"; phase?: string; message: string }
  | { t: "email"; payload?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Narrow a decoded SSE frame, or null if it is not something we recognise. */
export function asLegacyEvent(raw: unknown): LegacyEvent | null {
  if (!isRecord(raw) || typeof raw.t !== "string") return null;
  return raw as unknown as LegacyEvent;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function nowIso(): string {
  return new Date().toISOString();
}

/** Stable, readable choice ids from bare option strings. Deterministic so a replay matches. */
function slug(label: string, index: number): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base ? `${index}-${base}` : `${index}`;
}

// ─────────────────────────────────────────────────────────────── the adapter

export interface LegacyAdapter {
  /** Translate one decoded frame into zero or more AgentEvents. */
  adapt(raw: unknown): AgentEvent[];
  /**
   * Close whatever is still open at end of turn. The stream loop calls this in its `finally` so a
   * dropped connection still settles the transcript. Emits `node_end` for the live assistant and
   * thinking nodes; open tools are settled by `store.endRun()` (the run-level flag, §5.6) rather
   * than by fabricating timestamps we do not have.
   */
  finish(reason: RunEndReason): AgentEvent[];
}

/**
 * @param runId The run id minted by `store.beginRun()`. Every synthesised node id is prefixed with
 *   it, so ids are unique across turns within a tab. They are NOT stable across a reload — which is
 *   exactly the limitation that makes server-owned ids the P0.1 blocker.
 */
export function createLegacyAdapter(runId: string): LegacyAdapter {
  let assistantId = "";
  let thinkingId = "";

  /**
   * FIFO of tool node ids that have not seen a `tool_result` yet. Matching by FIFO is the best
   * available given the wire has no ids: the servers emit results in call order.
   */
  const openTools: string[] = [];

  /**
   * MONOTONIC sequence numbers — deliberately NOT `openTools.length`.
   *
   * `openTools.length` returns to 0 after every result is shifted off, so the 4th tool of a turn
   * would be handed the same id as the 1st. `upsertNode` would then PATCH the finished first step
   * instead of inserting a new one, and the transcript would silently lose steps. Same trap for
   * thinking blocks. The sequence must only ever go up.
   */
  let toolSeq = 0;
  // The tool node most recently closed. `element` frames arrive immediately AFTER their
  // `tool_result` (agent.ts emits them in that order), by which point the id has already been
  // shifted off `openTools` — so elements need this to know what to hang off.
  let lastToolId = "";
  let thinkingSeq = 0;

  /** Close the live thinking block, if any. Both `text` and `tool_start` end a thinking run. */
  function closeThinking(): AgentEvent[] {
    if (!thinkingId) return [];
    const id = thinkingId;
    thinkingId = "";
    return [{ t: "node_end", id, end: nowIso() }];
  }

  function closeAssistant(): AgentEvent[] {
    if (!assistantId) return [];
    const id = assistantId;
    assistantId = "";
    return [{ t: "node_end", id, end: nowIso() }];
  }

  function adapt(raw: unknown): AgentEvent[] {
    const e = asLegacyEvent(raw);
    if (!e) return [];

    switch (e.t) {
      // ── prose ─────────────────────────────────────────────────────────────────────────────
      case "text": {
        const text = str(e.text);
        // The writer's keepalive is `{t:"text", text:""}`. Opening a node for it paints an empty
        // bubble with a cursor; appending it is a store write that fires every scroll consumer for
        // nothing.
        if (!text) return [];
        const out: AgentEvent[] = closeThinking();
        if (!assistantId) {
          assistantId = `${runId}:assistant:${toolSeq}`;
          out.push({ t: "node_start", id: assistantId, runId, kind: "assistant", start: nowIso() });
        }
        out.push({ t: "token", id: assistantId, text });
        return out;
      }

      case "thinking": {
        const text = str(e.text);
        if (!text) return [];
        const out: AgentEvent[] = [];
        if (!thinkingId) {
          thinkingId = `${runId}:thinking:${thinkingSeq++}`;
          out.push({
            t: "node_start",
            id: thinkingId,
            runId,
            kind: "thinking",
            name: "Thinking",
            label: "Thinking",
            start: nowIso(),
            // Summarized reasoning is worth reading while it happens and worth tidying away once
            // it is not. This is D3: today it is truncated to 400 chars and then destroyed.
            defaultOpen: true,
            autoCollapse: true,
          });
        }
        out.push({ t: "token", id: thinkingId, text });
        return out;
      }

      // ── tools ─────────────────────────────────────────────────────────────────────────────
      case "tool_start": {
        const id = `${runId}:tool:${toolSeq++}`;
        openTools.push(id);
        // A tool call ends the current prose run and the current thinking block: the next `text`
        // after a tool belongs to a new assistant node, not appended to the one before it.
        const out: AgentEvent[] = [...closeThinking(), ...closeAssistant()];
        out.push({
          t: "node_start",
          id,
          runId,
          kind: "tool",
          name: str(e.name),
          label: str(e.label) || str(e.name),
          detail: typeof e.detail === "string" ? e.detail : undefined,
          start: nowIso(),
        });
        return out;
      }

      case "tool_result": {
        const id = openTools.shift();
        if (!id) return []; // orphan result — drop, never guess which step it belonged to
        lastToolId = id;
        return [
          {
            t: "node_end",
            id,
            end: nowIso(),
            // `preview` is the tool's actual output (first 200 chars); `detail` is the same
            // human-readable string already shown on the row. Using `detail` as the body would
            // make every accordion echo its own label, so prefer the real output and fall back.
            output: str(e.preview) || (typeof e.detail === "string" ? e.detail : undefined),
            isError: !!e.is_error,
          },
        ];
      }

      // ── hermes-only UI events ─────────────────────────────────────────────────────────────

      // Media produced by a tool (today: generate_assets). Hangs off the tool node that made it, so
      // the images sit under "Used generate assets" rather than floating at the end of the turn.
      // Falls back to the open assistant node if a server ever emits one outside a tool.
      case "element": {
        const forId = lastToolId || assistantId;
        if (!forId) return []; // nothing to attach to — drop rather than orphan it
        return [
          {
            t: "element",
            element: {
              id: str(e.id) || `${runId}:el:${toolSeq++}`,
              forId,
              type: "image",
              name: str(e.alt) || "Generated image",
              display: "inline",
              url: str(e.url),
              mime: typeof e.mime === "string" ? e.mime : undefined,
              width: typeof e.width === "number" ? e.width : undefined,
              height: typeof e.height === "number" ? e.height : undefined,
              // The bytes already exist — the tool only emits this after the render completed —
              // so it goes straight to ready. A reserved aspect box still prevents layout shift
              // while the browser fetches it.
              status: "ready",
            },
          },
        ];
      }

      // The multi-select finalize card (PR #26). A transcript node rather than an ask: it carries no
      // ask id on this wire, and its "answer" is an ordinary user message composed from the ticked
      // rows — which is the safety property, see ask/PickerCard.
      case "picker": {
        const id = `${runId}:picker:${toolSeq++}`;
        const ts = nowIso();
        return [
          ...closeAssistant(),
          {
            t: "node_start",
            id,
            runId,
            kind: "picker",
            name: str(e.title),
            label: str(e.title),
            start: ts,
            data: {
              kind: "picker",
              title: str(e.title),
              columns: Array.isArray(e.columns) ? e.columns.map(String) : [],
              rows: Array.isArray(e.rows)
                ? e.rows.map((r) => (Array.isArray(r) ? r.map(String) : []))
                : [],
              keyCol: Number(e.key_col ?? 0),
            },
          },
          { t: "node_end", id, end: ts },
        ];
      }

      case "table": {
        const id = `${runId}:table:${toolSeq++}`;
        const ts = nowIso();
        return [
          ...closeAssistant(),
          {
            t: "node_start",
            id,
            runId,
            kind: "table",
            name: str(e.title),
            label: str(e.title),
            start: ts,
            data: {
              kind: "table",
              title: str(e.title),
              columns: Array.isArray(e.columns) ? e.columns.map(String) : [],
              rows: Array.isArray(e.rows)
                ? e.rows.map((r) => (Array.isArray(r) ? r.map(String) : []))
                : [],
            },
          },
          { t: "node_end", id, end: ts },
        ];
      }

      case "options": {
        // Emits TWO things, on purpose:
        //   1. an `options` node — the anchor the card attaches to, and the thing that survives in
        //      the transcript forever once answered;
        //   2. an `ask` whose `stepId` is that node, so the rich AskCard machinery (P1.3) works
        //      against legacy data without a server change.
        // The `options` renderer must draw the QUESTION ONLY. Drawing the choices there too
        // double-renders them.
        const id = `${runId}:options:${toolSeq++}`;
        const ts = nowIso();
        const list = Array.isArray(e.options) ? e.options.map(String) : [];
        const choices: AskChoice[] = list.map((label, i) => ({
          id: slug(label, i),
          label,
          variant: "outline",
        }));
        return [
          ...closeAssistant(),
          {
            t: "node_start",
            id,
            runId,
            kind: "options",
            name: str(e.question),
            start: ts,
            data: { kind: "options", question: str(e.question), options: list },
          },
          { t: "node_end", id, end: ts },
          {
            t: "ask",
            askId: id,
            stepId: id,
            runId,
            askKind: "action",
            prompt: str(e.question),
            choices,
            allowText: true,
            cancel: null,
            // The legacy server has no deadline concept, so the client synthesises one. Absolute
            // timestamp, never a duration — a duration-based countdown lies after a tab suspend.
            deadline: new Date(Date.now() + ASK_DEADLINE_MS).toISOString(),
          },
        ];
      }

      case "confirm":
        return [
          ...closeAssistant(),
          {
            t: "confirm",
            actionId: str(e.action_id),
            runId,
            kind: str(e.kind),
            summary: str(e.summary),
          },
        ];

      // ── side channels (never rendered by the surface) ─────────────────────────────────────
      case "usage":
        return [{ t: "usage", usage: isRecord(e.usage) ? (e.usage as Record<string, number>) : {} }];

      case "phase":
        return [{ t: "phase", phase: str(e.phase) }];

      case "progress":
        return [
          {
            t: "progress",
            done: num(e.sections_written),
            total: num(e.sections_total),
            label: `${num(e.words)} words`,
            // Verbatim passthrough — the writer's draft pane needs `words`/`target_words`, which
            // done/total/label cannot carry.
            raw: e,
          },
        ];

      case "outline":
        // The union has no `outline` member; `draft` is the writer's generic pane channel. The
        // payload is the original frame, so the page discriminates on `payload.t`.
        return [{ t: "draft", payload: e }];

      case "draft":
        return [{ t: "draft", payload: e }];

      case "email":
        return [{ t: "email", payload: e }];

      case "continuing": {
        // A second agent segment inside one HTTP request. Reset the prose cursors so the next
        // `text` opens a NEW assistant node instead of appending to the previous segment's, and
        // leave `toolSeq` climbing so replayed tool_starts get fresh ids (never a twin — D6).
        const out: AgentEvent[] = [...closeThinking(), ...closeAssistant()];
        out.push({ t: "continuing", runId, raw: e });
        return out;
      }

      case "stalled":
        return [{ t: "stalled", message: str(e.message), raw: e }];

      // ── terminal ──────────────────────────────────────────────────────────────────────────
      case "error":
        return [{ t: "error", message: str(e.message) || "Turn failed." }];

      case "done":
        // Read BOTH spellings. This only read `needs_continuation`, which is what the blog writer's
        // route sends — but Hermes' route sends `needsContinuation`, so every Summer turn arrived here
        // as `false` and the client's continuation loop exited after one segment. That is the whole
        // reason a landing-page fill still needed somebody to type "go on": the server was asking to
        // continue and the ask was being dropped in translation. Normalising here rather than renaming
        // one of the two routes, because both wires are live and a rename breaks whichever ships second.
        return [{ t: "done", needsContinuation: !!(e.needs_continuation ?? e.needsContinuation) }];

      default:
        // Unknown event from a newer server. Dropping is correct: this adapter's job is to make
        // TODAY's wire work, and P1 deletes it entirely.
        return [];
    }
  }

  function finish(_reason: RunEndReason): AgentEvent[] {
    void _reason;
    return [...closeThinking(), ...closeAssistant()];
  }

  return { adapt, finish };
}

// ─────────────────────────────────────────────────────────────── transcript rehydration

/**
 * The display-item union returned by GET /api/hermes/sessions/[id]. Identical to the `DisplayItem`
 * type in that route and in the old hermes page.
 */
export type LegacyTranscriptItem =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "step"; label: string; detail?: string; is_error?: boolean }
  | { kind: "table"; title: string; columns: string[]; rows: string[][] }
  | { kind: "options"; question: string; options: string[] };

/**
 * Project a persisted transcript into an `AgentSnapshot` for `store.hydrate()`.
 *
 * Ids are positional (`hist:<n>`) and therefore stable for a given persisted transcript, which is
 * what matters: hydrating twice patches in place rather than duplicating. They intentionally do NOT
 * collide with live-stream ids (which are prefixed with a runId uuid).
 *
 * Every node comes back settled — `streaming: false`, `start === end` — so §7.5's "replayed history
 * renders all-closed with no mount animation" holds and StepDuration shows nothing rather than a
 * fabricated number.
 *
 * The writer's transcript has a different persisted shape; its transport should map into
 * `LegacyTranscriptItem[]` before calling this rather than growing a second projection here.
 */
export function snapshotFromLegacyItems(
  items: readonly LegacyTranscriptItem[],
  actions: readonly ActionRow[] = [],
): AgentSnapshot {
  const nodes: AgentNode[] = [];
  // Epoch, and `end` ONLY. History has no meaningful client-side timing: the persisted transcript
  // records no start, so giving a node `start === end` made StepDuration render a literal "0ms"
  // under every rehydrated step. `StepDuration` needs BOTH to print a settled value, so omitting
  // `start` is what actually delivers "shows nothing rather than a fabricated number". Dropping it
  // cannot resurrect a step either — `isNodeRunning` requires `start` to be present.
  const ts = new Date(0).toISOString();

  items.forEach((item, i) => {
    const id = `hist:${i}`;
    switch (item.kind) {
      case "text":
        nodes.push({
          id,
          runId: "",
          kind: item.role === "user" ? "user" : "assistant",
          output: item.text,
          end: ts,
          streaming: false,
        });
        return;
      case "step":
        nodes.push({
          id,
          runId: "",
          kind: "tool",
          name: item.label,
          label: item.label,
          detail: item.detail,
          isError: !!item.is_error,
          end: ts,
          streaming: false,
        });
        return;
      case "table":
        nodes.push({
          id,
          runId: "",
          kind: "table",
          name: item.title,
          label: item.title,
          end: ts,
          streaming: false,
          data: { kind: "table", title: item.title, columns: item.columns, rows: item.rows },
        });
        return;
      case "options":
        nodes.push({
          id,
          runId: "",
          kind: "options",
          name: item.question,
          end: ts,
          streaming: false,
          data: { kind: "options", question: item.question, options: item.options },
        });
        return;
    }
  });

  // Confirmation cards keep the SAME id scheme as the live `confirm` event (`confirm:<actionId>`),
  // so a card proposed during this session and then rehydrated patches in place instead of
  // appearing twice.
  //
  // KNOWN LIMITATION: the persisted `actions` rows carry no transcript position, so on rehydration
  // they land at the end rather than in turn order. Live cards are positioned correctly. Fixing it
  // properly needs the server to emit the action inline with the items — folded into P0.1.
  for (const a of actions) {
    nodes.push({
      id: `confirm:${a.id}`,
      runId: "",
      kind: "confirm",
      name: a.kind,
      start: ts,
      end: ts,
      streaming: false,
      data: {
        kind: "confirm",
        actionId: a.id,
        actionKind: a.kind,
        summary: a.summary,
        // The DB has six statuses and `ConfirmData` has four. `executed` is the SUCCESS status —
        // mapping only the three literal matches left every completed send rehydrating as
        // `proposed`, i.e. a live Confirm button under an email that already went out. The click
        // was safe (the route 409s), but the card lied. `expired` folds into `declined` for the
        // same reason. The raw string rides in `outcome`, which is what the card actually prints,
        // so the user still reads "executed" / "expired" rather than a lossy rename.
        status:
          a.status === "confirmed" || a.status === "executed"
            ? "confirmed"
            : a.status === "declined" || a.status === "expired"
              ? "declined"
              : a.status === "failed"
                ? "failed"
                : "proposed",
        outcome: a.status === "proposed" ? undefined : a.status,
      },
    });
  }

  return { nodes };
}
