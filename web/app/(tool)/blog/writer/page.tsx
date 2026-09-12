"use client";

// The AI writer: a chat that produces a blog draft.
//
// The shape of this screen follows the workflow it drives, and the approval step is the reason it is
// a chat at all rather than a form. You brief it, it researches, it proposes an outline, and nothing
// gets written until you press Approve. That button is the only path past step 3 — the model has no
// tool that can advance it, which is enforced server-side, not by prompt.
//
// The transcript, the streaming, the steps and the composer belong to the shared Summit Agent
// surface (src/components/agent). What is left here is everything BESIDE the transcript: the
// session rail, the status strip, the outline approval gate, the QA panel, and the HTTP shape of
// the writer API. This page holds no transcript state — no `messages`, no `live`, no `activity`.
//
// Two things worth knowing before editing:
//
//  1. The approval gate and the provenance the outline carries (`from`, source_plan, link_plan) are
//     load-bearing and unchanged. `from` is the index a section held in the SAVED outline (-1 when
//     newly added), which is how the server remaps source and link assignments after a reorder.
//  2. Auto-continuation now lives in the surface's reader loop (MAX_CONTINUATIONS), not here. The
//     status strip stays live across it because `progress` and `phase` arrive as events; the draft
//     and outline are refetched once, when the whole chain ends.
//
// This page is no longer in the sidebar. It was taken out of the nav — not deleted — because Summer
// is the path we want people starting on, but Summer cannot yet do what this page does: it has no
// tool that opens a writer session, so the outline gate, the research ledger the validator checks
// citations against, and the 31 QA gates are reachable ONLY from here (and from the autopilot, for
// batches). Deleting the route would have removed those from the product outright. It stays live at
// its URL, with the banner below saying where the supported path is. Delete it once Summer can
// start and drive a single article end to end.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Bot, Plus, Loader2, Check, FileText, Wrench, ListTree, AlertTriangle,
  CheckCircle2, Sparkles, ExternalLink, PencilLine, Trash2, ChevronUp, ChevronDown,
  BrainCircuit, ArrowRight
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ChatSurface, type ChatSurfaceHandle } from "@/components/agent/ChatSurface";
import type { LegacyTranscriptItem } from "@/components/agent/store/legacyAdapter";
import { snapshotFromLegacyItems } from "@/components/agent/store/legacyAdapter";
import type {
  AgentEvent,
  AgentSnapshot,
  AgentTransport,
  RunEndReason,
  Starter,
} from "@/components/agent/types";
import type { WriterSession, WriterSessionSummary, WriterVoice, BlogDraft, WriterOutline } from "@/lib/db/queries";

/** The display projection GET /api/blog/writer/[id] returns. Mapped into transcript nodes below. */
interface DisplayMsg {
  role: "user" | "assistant"; kind: string; text?: string;
  name?: string; label?: string; detail?: string; state?: string;
}
interface Violation { gate: string; severity: string; detail: string }

/** Where this piece actually stands. Computed server-side so the UI never has to infer it. */
interface Status {
  phase: string;
  sections_written: number; sections_total: number;
  words: number; target_words: number | null;
  sources_found: number; real_questions_found: number;
  writer_status: string | null;
  usage: Record<string, number>;
}

/** The writer's `progress` frame, carried verbatim on `AgentEvent.raw` (the adapter's §4.4 note). */
interface LegacyProgress {
  sections_written?: number; sections_total?: number; words?: number; target_words?: number | null;
}

/**
 * The three states a person actually cares about, derived from the phase.
 *
 * "Researching" and "Writing" are the tool's vocabulary; "waiting on you" versus "working" versus
 * "done" is the user's. Showing only the phase left it ambiguous whether the agent wanted something
 * or had quietly stopped.
 */
type Standing = "working" | "waiting" | "done" | "stopped";
function standingFor(phase: string, running: boolean): Standing {
  if (running) return "working";
  if (phase === "done") return "done";
  if (phase === "failed") return "stopped";
  return "waiting";      // gathering, outline_pending, and anything parked mid-flight
}

const STANDING_META: Record<Standing, { label: string; hint: string; cls: string; dot: string }> = {
  working:  { label: "Working",      hint: "No input needed, this can take a few minutes.", cls: "text-highlight-ink border-highlight/40 bg-highlight-soft", dot: "bg-primary" },
  waiting:  { label: "Your turn",    hint: "It is waiting on you.",                          cls: "text-warning border-warning/50 bg-warning/10",   dot: "bg-warning" },
  done:     { label: "Done",         hint: "The draft is written and checked.",              cls: "text-success border-success/40 bg-success/15", dot: "bg-success" },
  stopped:  { label: "Stopped",      hint: "This one needs a human.",                        cls: "text-destructive border-destructive/50 bg-destructive/10",         dot: "bg-destructive" },
};

const PHASE_LABEL: Record<string, string> = {
  gathering: "Gathering the brief",
  researching: "Researching",
  outline_pending: "Outline awaiting your approval",
  approved: "Approved, ready to write",
  writing: "Writing",
  validating: "Checking quality",
  done: "Done",
  failed: "Stopped",
};

/** Module scope so the identity is stable — the chips are memo'd on the array. */
const STARTERS: Starter[] = [
  { id: "continue", label: "Continue the draft", prompt: "Continue the draft." },
  { id: "intro", label: "Tighten the intro", prompt: "Tighten the intro." },
  { id: "qa", label: "Run the QA pass", prompt: "Run the QA pass." },
];

/** The writer has no feedback route and no per-turn token footer. */
const WRITER_FEATURES = { usageFooter: false, feedback: false } as const;

export default function WriterPage() {
  const [sessions, setSessions] = useState<WriterSessionSummary[]>([]);
  const [voices, setVoices] = useState<WriterVoice[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [session, setSession] = useState<WriterSession | null>(null);
  const [draft, setDraft] = useState<BlogDraft | null>(null);
  /**
   * Is a turn in flight? Set from the transport's own `startTurn` — every turn goes through it,
   * whether it started at the composer, at a starter chip, or at the Approve button — and cleared
   * on `onTurnEnd`. The page cannot subscribe to the surface's run state (it is outside the store's
   * provider), and this is exact rather than inferred.
   */
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [qa, setQa] = useState<{ verdict: string; violations: Violation[]; repair_prompt: string | null } | null>(null);
  /** Set when the server reports a segment that changed nothing, so the UI can say so plainly
   *  instead of just going quiet. */
  const [stalled, setStalled] = useState<string | null>(null);
  /** A local copy of the outline while editing. Each section carries `from`: the index it held in the
   *  saved outline (-1 when newly added), which is how the server remaps source/link assignments after
   *  a reorder. `key` is a stable React key so re-rendering does not lose focus mid-typing. */
  const [draftOutline, setDraftOutline] = useState<
    { h1: string; search_intent: string; sections: Array<{ key: string; from: number; level: string; heading: string; target_words?: number }> } | null
  >(null);
  const editingOutline = draftOutline !== null;
  const [busy, setBusy] = useState<string | null>(null);

  const surfaceRef = useRef<ChatSurfaceHandle>(null);
  /** The session whose first turn has not been kicked off yet. See the effect below. */
  const kickoffRef = useRef<string | null>(null);
  /** Set by "Ask it to fix these": re-run the checks once that repair turn closes. */
  const finalizeAfterTurnRef = useRef(false);

  useEffect(() => {
    fetch("/api/blog/writer").then((r) => r.json()).then((d) => { if (d?.ok) setSessions(d.sessions); }).catch(() => {});
    fetch("/api/blog/voices").then((r) => r.json()).then((d) => { if (d?.ok) setVoices(d.voices); }).catch(() => {});
  }, []);

  const refreshSessions = useCallback(() => {
    fetch("/api/blog/writer").then((r) => r.json()).then((d) => { if (d?.ok) setSessions(d.sessions); }).catch(() => {});
  }, []);

  /**
   * Everything about this session EXCEPT the transcript.
   *
   * The transcript is the surface's, and refetching it at end of turn is D5 — the live nodes would
   * be torn down and replaced a round trip later, with a blank frame in between. This fetches the
   * same endpoint for the pane state only, which is why it returns the payload rather than owning
   * the mapping.
   */
  const loadMeta = useCallback(async (sid: string) => {
    const d = await fetch(`/api/blog/writer/${sid}`).then((r) => r.json()).catch(() => null);
    if (!d?.ok) { toast.error(d?.error ?? "Couldn't load that session."); return null; }
    setSession(d.session); setDraft(d.draft); setStatus(d.status ?? null);
    setQa(d.draft?.writer_qa ? { verdict: d.draft.writer_status, violations: d.draft.writer_qa.violations ?? [], repair_prompt: null } : null);
    return d as { messages?: DisplayMsg[] };
  }, []);

  /**
   * The writer wire. Memoised on the session id — §2.2 requires a stable transport per session.
   *
   * Two shapes worth noting. A CONTINUATION (and the machine kickoff behind `surface.start()`) must
   * post a body with NO `message` key at all: the route branches on `message === undefined`, and
   * `{ message: "" }` would read as an empty human turn. And there is no stop endpoint on this
   * wire — the surface has already aborted the reader locally by the time `stopTurn` is called, so
   * the honest implementation is a no-op rather than a lie.
   */
  const transport = useMemo<AgentTransport>(() => {
    const sid = id;
    const requireSession = (): string => {
      if (!sid) throw new Error("No session is open.");
      return sid;
    };
    return {
      async startTurn({ message, signal, continuation }) {
        setRunning(true);
        setStalled(null);
        return fetch(`/api/blog/writer/${requireSession()}/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(continuation ? {} : { message }),
          signal,
        });
      },
      async stopTurn() {
        // No server-side stop for the writer. The client abort already ended the UI's turn; the
        // server finishes its segment and persists it, which is why a stopped turn still shows up
        // after a reload.
      },
      async answerAsk() {
        throw new Error("The writer does not ask multiple-choice questions.");
      },
      async decideAction() {
        throw new Error("The writer proposes no irreversible actions.");
      },
      async loadTranscript(): Promise<AgentSnapshot> {
        const d = await loadMeta(requireSession());
        if (!d) throw new Error("Couldn't load that session.");
        return snapshotFromLegacyItems(toTranscriptItems(d.messages ?? []));
      },
    };
  }, [id, loadMeta]);

  /**
   * Kick off a brand-new session's first turn.
   *
   * It cannot be fired from `newSession()`: the surface is keyed on the session id, so at that
   * moment `surfaceRef` still points at the PREVIOUS session's instance — with the previous
   * session's transport closed over it. Waiting for the commit means the ref is the new one.
   * Child effects run before the parent's, so the surface has already mounted by the time this
   * runs.
   */
  useEffect(() => {
    if (!id || kickoffRef.current !== id) return;
    kickoffRef.current = null;
    surfaceRef.current?.start();
  }, [id]);

  const handleEvent = useCallback((event: AgentEvent) => {
    switch (event.t) {
      case "progress": {
        // `raw` is the verbatim legacy frame: `done`/`total`/`label` cannot carry the word counts.
        const p = (event.raw ?? {}) as LegacyProgress;
        setStatus((s) => ({
          ...(s ?? EMPTY_STATUS),
          sections_written: p.sections_written ?? event.done,
          sections_total: p.sections_total ?? event.total,
          words: p.words ?? 0,
          target_words: p.target_words ?? s?.target_words ?? null,
        }));
        return;
      }
      case "phase":
        setStatus((s) => (s ? { ...s, phase: event.phase } : s));
        return;
      case "stalled":
        setStalled(event.message);
        toast.warning(event.message);
        return;
      case "error":
        // Also rendered into the transcript by the reducer, so it survives the toast.
        toast.error(event.message);
        return;
      default:
        // `draft` and `outline` frames arrive here too. Nothing to do with them mid-turn: the pane
        // reads the persisted session at the turn boundary, which is the same state one refetch
        // later and cannot disagree with the server.
        return;
    }
  }, []);

  const handleTurnEnd = useCallback(
    (reason: RunEndReason) => {
      setRunning(false);
      if (id) void loadMeta(id);
      refreshSessions();
      // "Ask it to fix these" ends in a fresh check, exactly as it did when the send was awaited.
      // Only after a turn that actually finished — re-checking a stopped repair would report the
      // violations the user just interrupted.
      if (finalizeAfterTurnRef.current) {
        finalizeAfterTurnRef.current = false;
        if (reason === "complete") void finalize();
      }
    },
    // `finalize` is a hoisted declaration re-created every render, so listing it would make this
    // callback change identity on every keystroke elsewhere on the page. It closes over the same
    // `id` this callback does, so calling the render-current one is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, loadMeta, refreshSessions],
  );

  async function newSession(voiceId?: string) {
    // Keyed by which button was pressed, not a bare flag: a stalled request used to disable and
    // spin every voice button at once with no way to tell which one was actually running, and no
    // way out short of a refresh. Reported directly against the feature-page voice, though nothing
    // about this path is voice-specific — any slow request would have looked identical.
    const key = voiceId ?? "__default__";
    setBusy(key);
    // A network stall must surface as an error, not sit there forever. 20s is generous for two DB
    // writes; the earlier version had no ceiling at all, so a stalled connection looked identical to
    // a live one, indefinitely.
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch("/api/blog/writer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_id: voiceId }),
        signal: ctrl.signal,
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.ok) { toast.error(d?.error ?? `Couldn't start a session (${res.status}).`); return; }
      setSessions((s) => [d.session, ...s]);
      // Kick it off immediately so the user lands on a question, not an empty box. The effect above
      // fires it once the surface has remounted onto this session.
      kickoffRef.current = d.session.id;
      setId(d.session.id);
    } catch (e) {
      toast.error(e instanceof Error && e.name === "AbortError"
        ? "Starting a session timed out. The server may be slow right now — try again."
        : "Couldn't reach the server to start a session.");
    } finally {
      clearTimeout(timeout);
      setBusy(null);
    }
  }

  async function approve() {
    if (!id) return;
    setBusy("approve");
    try {
      const d = await fetch(`/api/blog/writer/${id}/approve`, { method: "POST" }).then((r) => r.json());
      if (!d?.ok) { toast.error(d?.error ?? "Couldn't approve."); return; }
      toast.success("Outline approved. Writing now.");
      await loadMeta(id);
      surfaceRef.current?.start();   // approved phase: the next turn starts section 0
    } finally { setBusy(null); }
  }

  async function finalize() {
    if (!id) return;
    setBusy("finalize");
    try {
      const d = await fetch(`/api/blog/writer/${id}/finalize`, { method: "POST" }).then((r) => r.json());
      if (!d?.ok) { toast.error(d?.error ?? "Check failed."); return; }
      setQa({ verdict: d.verdict, violations: d.violations, repair_prompt: d.repair_prompt });
      await loadMeta(id);
      const n = (d.violations ?? []).filter((v: Violation) => v.severity !== "auto_fix").length;
      if (d.verdict === "ok") toast.success("Clean. Nothing to fix.");
      else if (d.verdict === "failed") toast.error("A source could not be verified. This one needs a human.");
      else toast.warning(`${n} thing${n === 1 ? "" : "s"} to look at.`);
    } finally { setBusy(null); }
  }

  function sendRepair() {
    if (!id || !qa?.repair_prompt) return;
    const p = qa.repair_prompt;
    setQa({ ...qa, repair_prompt: null });
    finalizeAfterTurnRef.current = true;
    // The model needs the `<repair_request>` framing; the human does not need to read it back.
    // `stripDirectives` does the same job server-side for the persisted copy.
    surfaceRef.current?.send(p, { display: "sent the fix list back" });
  }

  const outline = session?.outline as WriterOutline | null;
  // Prefer the live status object: during a turn it is ahead of `session`, which only refreshes when
  // the turn ends. Fall back to the session so a freshly-opened page still shows the right numbers.
  const phase = status?.phase ?? session?.phase ?? "gathering";
  const sectionsDone = status?.sections_written ?? Object.keys(session?.sections ?? {}).length;
  const sectionsTotal = status?.sections_total ?? outline?.sections.length ?? 0;
  const words = status?.words ?? 0;
  const standing = standingFor(phase, running);
  const plannedWords = (editingOutline ? draftOutline!.sections : (outline?.sections ?? []))
    .reduce((n: number, s: { target_words?: number }) => n + (Number(s.target_words) || 0), 0);

  function startOutlineEdit() {
    if (!outline) return;
    setDraftOutline({
      h1: outline.h1,
      search_intent: outline.search_intent,
      sections: outline.sections.map((s, i) => ({
        key: `s${i}`, from: i, level: s.level, heading: s.heading, target_words: s.target_words,
      })),
    });
  }

  function patchSection(i: number, patch: Record<string, unknown>) {
    setDraftOutline((d) => {
      if (!d) return d;
      const sections = [...d.sections];
      sections[i] = { ...sections[i], ...patch };
      return { ...d, sections };
    });
  }

  function moveSection(i: number, delta: number) {
    setDraftOutline((d) => {
      if (!d) return d;
      const j = i + delta;
      if (j < 0 || j >= d.sections.length) return d;
      const sections = [...d.sections];
      [sections[i], sections[j]] = [sections[j], sections[i]];
      return { ...d, sections };
    });
  }

  function dropSection(i: number) {
    setDraftOutline((d) => (d ? { ...d, sections: d.sections.filter((_, j) => j !== i) } : d));
  }

  function addSection() {
    setDraftOutline((d) => (d ? {
      ...d,
      // from: -1 marks it as new, so the server knows no existing source or link belongs to it.
      sections: [...d.sections, { key: `new${d.sections.length}${Date.now()}`, from: -1, level: "h2", heading: "" }],
    } : d));
  }

  /** How many sources/links are attached to the section that originally sat at `from`. Shown so it is
   *  obvious what a Remove will take with it. */
  function sourcesFor(from: number): number {
    return from < 0 ? 0 : (outline?.source_plan ?? []).filter((x) => x.section_index === from).length;
  }
  function linksFor(from: number): number {
    return from < 0 ? 0 : (outline?.link_plan ?? []).filter((x) => x.section_index === from).length;
  }

  async function saveOutline() {
    if (!id || !draftOutline) return;
    setBusy("outline");
    try {
      const d = await fetch(`/api/blog/writer/${id}/outline`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outline: {
            h1: draftOutline.h1,
            search_intent: draftOutline.search_intent,
            sections: draftOutline.sections.map((s) => ({
              from: s.from, level: s.level, heading: s.heading, target_words: s.target_words,
            })),
          },
        }),
      }).then((r) => r.json());
      if (!d?.ok) { toast.error(d?.error ?? "Couldn't save the outline."); return; }
      for (const n of (d.notes ?? []) as string[]) toast.warning(n);
      setDraftOutline(null);
      toast.success("Outline saved. Approve when you are happy with it.");
      await loadMeta(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save the outline.");
    } finally { setBusy(null); }
  }

  const targetWords = status?.target_words ?? (session?.brief as { word_count?: number } | null)?.word_count ?? null;

  const composerPlaceholder =
    phase === "gathering" ? "Primary keyword, topic and angle, blog or landing page, word count…"
    : phase === "outline_pending" ? "Approve above, or type the changes you want…"
    : "Reply, or ask for changes…";

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* Where the supported path is. Not a warning colour: nothing here is broken or going away
          today, and dressing a working tool in destructive red would read as "this is about to
          stop". `shrink-0` so it never steals height from the two panes below it. */}
      <div className="shrink-0 flex items-center gap-2.5 flex-wrap rounded-lg border border-highlight/40 bg-highlight-soft px-3 py-2">
        <BrainCircuit className="h-4 w-4 text-highlight-ink shrink-0" />
        <p className="text-sm">
          Summer is the supported way to make content now.
          <span className="text-muted-foreground">
            {" "}This writer is still here for a single article that needs the outline approval gate and
            the quality checks — Summer cannot run those on its own yet.
          </span>
        </p>
        {/* Plain styled Link, not <Button asChild> — this Button does not forward to a child. */}
        <Link href="/summer" className="ml-auto flex shrink-0 items-center gap-1.5 text-sm text-highlight-ink hover:underline">
          Open Summer <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="flex gap-6 flex-1 min-h-0">
      {/* Sessions */}
      <div className="w-80 shrink-0 h-full min-h-0 flex flex-col overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-[64px] backdrop-saturate-[1.65] shadow-[var(--glass-shadow)]">
        <div className="p-3 border-b border-border space-y-2">
          <h1 className="text-sm font-medium">AI writer</h1>
          <p className="text-xs text-muted-foreground">
            Brief it, approve the outline, and it writes the draft.
          </p>
          {voices.length > 1 ? (
            /* These start a NEW piece; they are not a picker for the open one, and a session's voice
               is fixed once created (it is baked into the cached system prompt). The fill used to
               follow v.is_default, which meant the house voice looked selected no matter which voice
               the open session was actually using — the reported "I can't see which voice is
               selected". It now follows the open session, and the heading says what the buttons do. */
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground pt-0.5">
                Start a new piece in
              </p>
              {voices.map((v) => {
                const active = session?.voice_id === v.id;
                const loading = busy === v.id;
                return (
                  <Button key={v.id} size="sm" variant={active ? "default" : "outline"}
                    title={active ? `${v.name} — the voice this session is using` : `Start a new piece in ${v.name}`}
                    className="w-full gap-1.5 justify-start text-xs"
                    disabled={busy !== null} onClick={() => newSession(v.id)}>
                    {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                    <span className="truncate">{v.name}</span>
                  </Button>
                );
              })}
            </div>
          ) : (
            <Button size="sm" className="w-full gap-1.5" disabled={busy !== null} onClick={() => newSession()}>
              {busy === "__default__" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} New post
            </Button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground text-center">No sessions yet.</p>
          ) : sessions.map((s) => (
            <button key={s.id} onClick={() => setId(s.id)}
              className={cn("w-full text-left px-3 py-2.5 border-b border-border/60 hover:bg-muted/40",
                id === s.id && "bg-highlight-soft")}>
              <p className="text-sm font-medium truncate">
                {(s.brief as { primary_keyword?: string } | null)?.primary_keyword || "Untitled brief"}
              </p>
              {/* Voice alongside the phase: until a keyword is saved every row reads "Untitled
                  brief", so the voice is the only thing telling two of them apart. */}
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {PHASE_LABEL[s.phase] ?? s.phase}
                {voices.find((v) => v.id === s.voice_id)?.name
                  ? ` · ${voices.find((v) => v.id === s.voice_id)!.name}`
                  : ""}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Chat */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {id && (
          /* Status strip. The standing pill comes first and is the biggest thing here on purpose:
             "is this waiting on me, working, or finished" was previously only inferable from the
             phase name, which meant a parked session looked identical to a busy one. */
          <div className="flex items-center gap-2.5 pb-2.5 border-b border-border flex-wrap shrink-0">
            <span className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3 h-8 text-sm font-medium",
              STANDING_META[standing].cls,
            )}>
              <span className={cn("h-2 w-2 rounded-full", STANDING_META[standing].dot,
                standing === "working" && "animate-pulse")} />
              {STANDING_META[standing].label}
            </span>
            <span className="text-xs text-muted-foreground">{STANDING_META[standing].hint}</span>
            <Badge variant="outline" className="text-xs text-highlight-ink border-highlight/40">
              {PHASE_LABEL[phase] ?? phase}
            </Badge>
            {/* Which voice is writing this. The chat gives no clue on its own, and the voice is
                fixed at creation, so without this the only way to find out was to read the copy
                and guess. */}
            {voices.find((v) => v.id === session?.voice_id) && (
              <Badge variant="outline" className="text-xs gap-1 text-muted-foreground">
                <PencilLine className="h-2.5 w-2.5" />
                {voices.find((v) => v.id === session?.voice_id)!.name}
              </Badge>
            )}
            {sectionsTotal > 0 && (phase === "writing" || phase === "done" || sectionsDone > 0) && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-1.5 w-20 rounded-full bg-muted overflow-hidden">
                  <span className="block h-full bg-primary transition-all duration-500"
                    style={{ width: `${Math.min(100, Math.round((sectionsDone / sectionsTotal) * 100))}%` }} />
                </span>
                {sectionsDone}/{sectionsTotal} sections
              </span>
            )}
            {words > 0 && (
              <span className="text-xs text-muted-foreground">
                {words.toLocaleString()}{targetWords ? ` / ${targetWords.toLocaleString()}` : ""} words
              </span>
            )}
            {(status?.sources_found ?? 0) > 0 && (
              <span className="text-xs text-muted-foreground">
                {status!.sources_found} source{status!.sources_found === 1 ? "" : "s"}
              </span>
            )}
            {(status?.real_questions_found ?? 0) > 0 && (
              <span className="text-xs text-muted-foreground">
                {status!.real_questions_found} real question{status!.real_questions_found === 1 ? "" : "s"}
              </span>
            )}
            {draft?.writer_status && (
              <Badge variant="outline" className={cn("text-xs",
                draft.writer_status === "ok" && "text-success border-success/40",
                draft.writer_status === "flagged" && "text-warning border-warning/30",
                draft.writer_status === "failed" && "text-destructive border-destructive/30")}>
                {draft.writer_status === "ok" ? "checks passed" : draft.writer_status}
              </Badge>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {sectionsTotal > 0 && sectionsDone >= sectionsTotal && (
                <Button size="xs" variant="outline" className="gap-1 text-xs"
                  onClick={finalize} disabled={busy === "finalize" || running}>
                  {busy === "finalize" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  Run checks
                </Button>
              )}
              {draft && (
                <a href="/drafts" className="text-xs text-highlight-ink hover:underline flex items-center gap-1">
                  <FileText className="h-3 w-3" /> Open draft <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
            </div>
          </div>
        )}

        {/*
          The transcript, the streaming and the composer. `banner` is what renders between the two,
          which is exactly where the approval gate, the QA panel and the stall notice have always
          sat — above the composer, below the conversation.
        */}
        <ChatSurface
          ref={surfaceRef}
          mode="writer"
          sessionId={id}
          transport={transport}
          starters={STARTERS}
          emptyState={<p className="text-sm text-muted-foreground">Start a new post on the left.</p>}
          placeholder={composerPlaceholder}
          onEvent={handleEvent}
          onTurnEnd={handleTurnEnd}
          features={WRITER_FEATURES}
          className="pt-2"
          banner={
            <>
              {/* Outline approval: the gate */}
              {phase === "outline_pending" && outline && (
                <div className="border border-highlight/40 bg-highlight-soft rounded-lg p-4 space-y-3 max-h-[55vh] overflow-y-auto">
                  <div className="flex items-center gap-2 flex-wrap">
                    <ListTree className="h-4 w-4 text-highlight-ink" />
                    <p className="text-sm font-medium">Outline ready for your approval</p>
                    <span className="text-xs text-muted-foreground">
                      {outline.source_plan.length} sources · {outline.link_plan.length} internal links
                      {targetWords ? ` · ${plannedWords} / ${targetWords} planned words` : ""}
                    </span>
                    {!editingOutline && (
                      <Button size="xs" variant="outline" className="ml-auto gap-1.5" onClick={startOutlineEdit}>
                        <PencilLine className="h-3.5 w-3.5" /> Edit inline
                      </Button>
                    )}
                  </div>

                  {editingOutline && draftOutline ? (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">H1</label>
                        <Input value={draftOutline.h1}
                          onChange={(e) => setDraftOutline({ ...draftOutline, h1: e.target.value })} />
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs text-muted-foreground">
                          Sections — drag order with the arrows. Sources and links follow their section.
                        </label>
                        {draftOutline.sections.map((sec, i) => (
                          <div key={sec.key} className="flex items-start gap-1.5 rounded-lg border border-border bg-background p-2">
                            <div className="flex flex-col gap-0.5 pt-0.5">
                              <button type="button" aria-label="Move up" disabled={i === 0}
                                onClick={() => moveSection(i, -1)}
                                className="h-5 w-5 rounded hover:bg-muted disabled:opacity-25 flex items-center justify-center">
                                <ChevronUp className="h-3.5 w-3.5" />
                              </button>
                              <button type="button" aria-label="Move down" disabled={i === draftOutline.sections.length - 1}
                                onClick={() => moveSection(i, 1)}
                                className="h-5 w-5 rounded hover:bg-muted disabled:opacity-25 flex items-center justify-center">
                                <ChevronDown className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <div className="flex-1 min-w-0 space-y-1.5">
                              <Input value={sec.heading} placeholder="Heading"
                                onChange={(e) => patchSection(i, { heading: e.target.value })} />
                              <div className="flex items-center gap-2 flex-wrap">
                                <select value={sec.level} onChange={(e) => patchSection(i, { level: e.target.value })}
                                  className="h-9 rounded-md border border-input bg-background px-2 text-xs">
                                  <option value="h2">H2</option>
                                  <option value="h3">H3</option>
                                </select>
                                <Input type="number" min={40} max={2000} step={10} value={sec.target_words ?? ""}
                                  placeholder="words" className="h-9 w-24"
                                  onChange={(e) => patchSection(i, { target_words: Number(e.target.value) || undefined })} />
                                <span className="text-xs text-muted-foreground">
                                  {sourcesFor(sec.from)} sources · {linksFor(sec.from)} links
                                  {sec.from < 0 ? " · new" : ""}
                                </span>
                                <Button size="xs" variant="ghost" className="ml-auto text-destructive hover:text-destructive gap-1"
                                  disabled={draftOutline.sections.length < 2}
                                  onClick={() => dropSection(i)}>
                                  <Trash2 className="h-3.5 w-3.5" /> Remove
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))}
                        <Button size="xs" variant="outline" className="w-full gap-1.5" onClick={addSection}>
                          <Plus className="h-3.5 w-3.5" /> Add a section
                        </Button>
                      </div>

                      <div className="flex gap-2 pt-1">
                        <Button size="sm" className="gap-1.5" onClick={saveOutline} disabled={busy === "outline"}>
                          {busy === "outline" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                          Save outline
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDraftOutline(null)}>Cancel</Button>
                        <span className="text-xs text-muted-foreground self-center">
                          Saving does not approve it.
                        </span>
                      </div>
                    </div>
                  ) : (
                    <>
                      {outline.search_intent && (
                        <p className="text-xs text-muted-foreground">{outline.search_intent}</p>
                      )}
                      <p className="text-base font-medium leading-snug">{outline.h1}</p>
                      <ol className="text-sm space-y-1">
                        {outline.sections.map((sec, i) => (
                          <li key={i} className={cn("text-muted-foreground flex gap-2", sec.level === "h3" && "pl-5")}>
                            <span className="opacity-40 tabular-nums">{i + 1}.</span>
                            <span>
                              {sec.heading}
                              {sec.target_words ? <span className="opacity-60"> · {sec.target_words}w</span> : null}
                              {sec.is_faq ? <span className="text-highlight-ink/80"> · question</span> : null}
                            </span>
                          </li>
                        ))}
                      </ol>
                      <div className="flex gap-2 pt-1 flex-wrap">
                        <Button size="sm" className="gap-1.5" onClick={approve} disabled={busy === "approve" || running}>
                          {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                          Approve and write
                        </Button>
                        <span className="text-xs text-muted-foreground self-center">
                          or edit it above, or reply below with changes
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* QA panel */}
              {qa && qa.violations.length > 0 && (
                <div className={cn("border rounded-lg p-3 space-y-2",
                  qa.verdict === "failed" ? "border-destructive/40 bg-destructive/5" : "border-warning/40 bg-warning/5")}>
                  <div className="flex items-center gap-2">
                    {qa.verdict === "failed"
                      ? <AlertTriangle className="h-4 w-4 text-destructive" />
                      : <AlertTriangle className="h-4 w-4 text-warning" />}
                    <p className="text-sm font-medium">
                      {qa.verdict === "failed" ? "This one needs a human" : "Worth a look"}
                    </p>
                  </div>
                  <ul className="text-xs space-y-1">
                    {qa.violations.filter((v) => v.severity !== "auto_fix").map((v, i) => (
                      <li key={i} className="text-muted-foreground">• {v.detail}</li>
                    ))}
                  </ul>
                  {qa.repair_prompt && (
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={sendRepair} disabled={running}>
                      <Wrench className="h-3.5 w-3.5" /> Ask it to fix these
                    </Button>
                  )}
                </div>
              )}
              {qa && qa.violations.filter((v) => v.severity !== "auto_fix").length === 0 && (
                <div className="border border-success/40 bg-success/15 rounded-lg p-3 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  <p className="text-sm">All checks passed. Add a thumbnail in the editor, then publish.</p>
                </div>
              )}

              {stalled && (
                <div className="border border-warning/40 bg-warning/5 rounded-lg p-3 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                  <p className="text-sm">{stalled}</p>
                </div>
              )}
            </>
          }
        />
      </div>
      </div>
    </div>
  );
}

/* ─────── bits ─────── */

/**
 * The persisted writer transcript → the shared transcript item union.
 *
 * `<phase>` and `<section_assignment>` directives are already gone: GET /api/blog/writer/[id] runs
 * `stripDirectives` server-side so the UI cannot forget to. A block that was ENTIRELY a directive
 * comes back as an empty string, which is why the emptiness check is the filter.
 */
function toTranscriptItems(messages: readonly DisplayMsg[]): LegacyTranscriptItem[] {
  const items: LegacyTranscriptItem[] = [];
  for (const m of messages) {
    if (m.kind === "tool_use") {
      items.push({
        kind: "step",
        label: m.label ?? m.name ?? "Working",
        detail: m.detail,
        is_error: m.state === "error",
      });
      continue;
    }
    if (!m.text?.trim()) continue;
    items.push({ kind: "text", role: m.role, text: m.text });
  }
  return items;
}

/** Only used to seed a status object from a mid-turn progress event when none was loaded yet. */
const EMPTY_STATUS: Status = {
  phase: "writing", sections_written: 0, sections_total: 0, words: 0, target_words: null,
  sources_found: 0, real_questions_found: 0, writer_status: null, usage: {},
};
