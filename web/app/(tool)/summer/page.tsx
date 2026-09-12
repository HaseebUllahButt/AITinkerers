"use client";

// Hermes — the conversational operator. A session rail beside the shared SearchOps Agent surface.
//
// Everything that used to live here — the manual SSE reader, the live/thinking/steps overlays, the
// bubbles, the table and options renderers, the confirmation card — now belongs to
// src/components/agent. This page owns the rail, the routing, and the two things that are genuinely
// its own: the HTTP shape of the hermes API (the transport below) and the session-usage footer,
// which is server-authoritative and therefore cannot come from the stream.
//
// The one piece of behaviour that is still the point of the whole design is the confirmation card:
// the model proposes an irreversible action, the card shows exactly what it is, and the click is
// what executes it. It now renders in the transcript as a node — see components/agent/ask/
// ConfirmCard.tsx — and this page supplies the POST it makes.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { BrainCircuit, Plus, AlertCircle, TrendingUp, ListChecks, Search, Image as ImageIcon, PenLine, BellRing } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChatSurface, type ChatSurfaceHandle } from "@/components/agent/ChatSurface";
import { SearchPalette, useSearchHotkey } from "@/components/agent/SearchPalette";
import { ProjectSessionRail } from "@/components/agent/projects/ProjectSessionRail";
import { PersonSwitcher } from "@/components/agent/PersonSwitcher";
import { AttachmentChips, type ChipAttachment } from "@/components/agent/AttachmentChips";
import { ModelPicker, type ModelOption } from "@/components/agent/ModelPicker";
import { snapshotFromLegacyItems, type LegacyTranscriptItem } from "@/components/agent/store/legacyAdapter";
import { usePendingActions } from "@/components/agent/store/hooks";
import type {
  ActionRow,
  AgentEvent,
  AgentSnapshot,
  AgentTransport,
  Starter,
} from "@/components/agent/types";

/** A chip plus the server record the turn will send. `stored` is absent until the upload lands. */
type PendingAttachment = ChipAttachment & { stored?: Record<string, unknown> };

type SessionRow = {
  id: string; title: string | null; status: string;
  usage: Record<string, number>; created_at: string; updated_at: string;
  /** Which Claude model this conversation runs on; null means the default. */
  model?: string | null;
  /** Optional because /api/hermes/sessions does not send it — its select names its columns and
   *  predates projects. The rail takes placement from /api/hermes/projects instead and reads this
   *  only if it ever appears, so widening that select later changes nothing here. */
  project_id?: string | null;
};

/** The four keys the hermes API reports. Summed, never replaced — one turn is one increment. */
const USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

/** Module scope so the array identity is stable — the chips are memo'd on it. */
/**
 * One chip per THING SUMMER CAN DO, not one per question someone might ask. Each maps to a distinct
 * capability cluster in her tool surface, so the row doubles as the answer to "what is she for":
 * triage, research, imagery, writing, link-building and site health. The label is short enough to
 * scan; the prompt behind it is written the way you would actually brief her.
 */
const STARTERS: Starter[] = [
  {
    id: "attention",
    label: "What needs my attention?",
    prompt: "What needs my attention right now? Give me the short list, worst first, and say what you'd do about each.",
    icon: AlertCircle,
  },
  {
    id: "research",
    label: "Research a topic",
    prompt:
      "Research what's launching in AI image and video generation over the next few weeks, and tell me which of it is worth writing about for northwind.example — with the demand data behind your pick.",
    icon: Search,
  },
  {
    id: "assets",
    label: "Generate images",
    prompt:
      "Generate a hero image for a blog post about AI image generation. Show me what you plan to make and roughly what it will cost before you spend anything.",
    icon: ImageIcon,
  },
  {
    id: "draft",
    label: "Write a draft",
    prompt:
      "Draft a blog post for northwind.example. Ask me for the angle and the target keyword first, then plan the outline before you write anything.",
    icon: PenLine,
  },
  {
    id: "backlinks",
    label: "Find link prospects",
    prompt: "Show me the backlink campaigns and where each one is stuck. Who is worth chasing this week?",
    icon: TrendingUp,
  },
  {
    id: "health",
    label: "Check site health",
    prompt: "How healthy is the site right now — indexing, broken links, Core Web Vitals? Lead with anything that got worse.",
    icon: ListChecks,
  },
];

/**
 * `initialSessionId` comes from /summer/<id>. The page still owns `sid` after that: switching chats
 * rewrites the URL in place rather than navigating, because a real navigation would remount the
 * transcript and throw away a running turn's stream.
 */
export default function HermesPage({ initialSessionId }: { initialSessionId?: string } = {}) {
  const { data: session } = useSession();
  // First token only — "Afternoon, Raamiz", not the full legal name on the Google account.
  const firstName = session?.user?.name?.trim().split(/\s+/)[0];
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  /**
   * The rail's load state, kept SEPARATE from the list itself. The previous shape — swallow any
   * failure and leave `sessions` as its initial [] — rendered a database timeout as an empty
   * account: refresh during a DB incident and every conversation "disappeared". Nothing was gone;
   * the fetch had failed and nothing said so. An error here never clears what is already shown,
   * and the rail says "couldn't load" instead of showing nothing.
   */
  const [railStatus, setRailStatus] = useState<{ phase: "loading" | "ready" | "error"; detail?: string }>({ phase: "loading" });
  const [configured, setConfigured] = useState(true);
  const [sid, setSid] = useState<string | null>(null);
  /**
   * The model allowlist, from the server rather than a client copy — the picker must not be able to
   * offer something the PATCH route rejects. Empty until the rail loads, and the picker simply does
   * not render until then.
   */
  const [models, setModels] = useState<ModelOption[]>([]);
  /**
   * The CURRENT conversation's model, or the one a not-yet-existing conversation will open on.
   *
   * Held here rather than read out of `sessions` because the two disagree at exactly the wrong
   * moment: the rail is refetched after a turn, so between switching model and finishing a turn the
   * list still holds the old value and the label would flip back on its own.
   */
  const [model, setModel] = useState<string | null>(null);
  /**
   * Mirrored into a ref for the same reason `viewingAs` is: `newSession` must stay a stable function
   * closing over setState only, because `startWithPrompt` memoises it with an empty dep array. Read
   * `model` directly in there and a starter clicked after picking Haiku would open the conversation
   * on the default — the picker would say one thing and the session would be another.
   */
  const modelRef = useRef<string | null>(null);
  modelRef.current = model;
  /** Server-authoritative session total, seeded on open and incremented from the stream. */
  const [usage, setUsage] = useState<Record<string, number>>({});
  const surfaceRef = useRef<ChatSurfaceHandle>(null);
  /**
   * A starter clicked with no thread open. We cannot send it here: `newSession` only sets state, and
   * the transport is memoised on `sid`, so sending in the same tick would use the previous session's
   * transport (or none). Park it, and let the effect below fire once the new session is live.
   */
  const pendingPromptRef = useRef<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  /** A turn is streaming. Events only arrive during one, so the first event is the signal. */
  const [running, setRunning] = useState(false);
  /**
   * Session ids that finished or asked something while the tab was in the background.
   *
   * The whole point of auto-continuation is that a long fill needs no babysitting — but "you can look
   * away" is only true if something tells you when to look back. Kept per session id so the banner can
   * open the right chat rather than whichever one happens to be selected.
   */
  const [attention, setAttention] = useState<Record<string, string>>({});
  // ?prompt= — the research board hands a briefed prompt across rather than an empty composer.
  // Parked in a ref and replayed once, the same way a clicked starter is: the transport is memoised
  // on `sid`, so writing it before a session exists would post into the previous session or none.
  const searchParams = useSearchParams();
  const deepLinkPrompt = searchParams.get("prompt");
  const deepLinkFiredRef = useRef(false);
  /**
   * Whose conversations are on screen. null = your own, and that is the only state anyone but the
   * superuser can ever be in — the switcher does not render for them and every route refuses `as`.
   *
   * Mirrored into a ref because loadSessions reads it without depending on it (see the note there).
   */

  /**
   * Mirror the open chat into the address bar, without navigating.
   *
   * replaceState rather than router.push: a push remounts this page, which kills the in-flight SSE
   * stream and loses the transcript that has not been persisted yet. The URL is for linking and for
   * the attention banner's "open that chat" — it is not the source of truth, `sid` is.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const want = sid ? `/summer/${sid}` : "/summer";
    if (window.location.pathname !== want) {
      window.history.replaceState(null, "", want + window.location.search);
    }
  }, [sid]);

  /** Whose conversations are on screen. null = your own. */
  const [viewingAs, setViewingAs] = useState<string | null>(null);
  const viewingAsRef = useRef<string | null>(null);
  /**
   * Files attached to the message being composed. Mirrored into a ref for the same reason as
   * `viewingAs`: the transport is memoised on `sid` and must not rebuild on every upload.
   */
  const [attached, setAttached] = useState<PendingAttachment[]>([]);
  const attachedRef = useRef<PendingAttachment[]>([]);

  /** Keep the ref and the rendered list in step — every write goes through here. */
  const writeAttached = useCallback((next: PendingAttachment[]) => {
    attachedRef.current = next;
    setAttached(next);
  }, []);

  /**
   * Upload dropped/pasted/picked files, one request for the batch.
   *
   * Chips appear immediately in an `uploading` state and are replaced in place by the server's
   * verdict per file. A file the server refuses KEEPS its chip and shows why — a file that vanishes
   * reads as a bug, where "PDFs cannot be read yet" is an answer.
   */
  const handleAttach = useCallback(async (files: File[]) => {
    if (!sid) {
      toast.error("Open a conversation first, then attach files to it.");
      return;
    }
    const pending: PendingAttachment[] = files.map((f, i) => ({
      key: `${Date.now()}-${i}-${f.name}`, name: f.name, status: "uploading" as const,
    }));
    writeAttached([...attachedRef.current, ...pending]);

    const form = new FormData();
    for (const f of files) form.append("files", f);

    try {
      const res = await fetch(`/api/hermes/sessions/${sid}/attachments`, { method: "POST", body: form });
      const r = await res.json().catch(() => null);
      if (!r?.ok) {
        // The whole batch failed. Mark the chips rather than dropping them silently.
        writeAttached(attachedRef.current.map((a) => pending.some((p) => p.key === a.key)
          ? { ...a, status: "rejected" as const, reason: r?.error ?? `upload failed (HTTP ${res.status})` }
          : a));
        return;
      }
      // Positional pairing: the route answers one record per file, in the order they were sent.
      writeAttached(attachedRef.current.map((a) => {
        const at = pending.findIndex((p) => p.key === a.key);
        if (at === -1) return a;
        const got = r.attachments[at];
        if (!got) return { ...a, status: "rejected" as const, reason: "no answer for this file" };
        return got.kind === "rejected"
          ? { ...a, status: "rejected" as const, reason: got.reason }
          : { ...a, status: "ready" as const, kind: got.kind, url: got.url, stored: got };
      }));
    } catch (e) {
      writeAttached(attachedRef.current.map((a) => pending.some((p) => p.key === a.key)
        ? { ...a, status: "rejected" as const, reason: e instanceof Error ? e.message : "network error" }
        : a));
    }
  }, [sid, writeAttached]);

  const loadSessions = useCallback(async () => {
    try {
      // `viewingAs` is read through a ref rather than a dependency: making it one would rebuild
      // loadSessions, which the mount effect depends on, and re-fire the whole load on every
      // unrelated render. The switcher calls loadSessions explicitly when it changes person.
      const as = viewingAsRef.current;
      const res = await fetch(`/api/hermes/sessions${as ? `?as=${encodeURIComponent(as)}` : ""}`);
      const r = await res.json().catch(() => null);
      if (r?.ok) {
        setSessions(r.sessions);
        setConfigured(r.configured !== false);
        // Only ever widened, never narrowed: a later load that omits `models` (an older deploy
        // answering a warm page) must not empty a picker that is already on screen.
        if (Array.isArray(r.models) && r.models.length) setModels(r.models as ModelOption[]);
        setRailStatus({ phase: "ready" });
      } else {
        // Route-reported failure (a saturated database answers this way). Keep the current list.
        setRailStatus({ phase: "error", detail: r?.error ?? `the server did not answer (HTTP ${res.status})` });
      }
    } catch (e) {
      setRailStatus({ phase: "error", detail: e instanceof Error ? e.message : "network error" });
    }
  }, []);

  // A failed rail load retries itself while the tab is open — a refresh mid-incident self-heals
  // instead of stranding an "empty" rail until the person thinks to reload again.
  useEffect(() => {
    if (railStatus.phase !== "error") return;
    const t = setTimeout(() => { void loadSessions(); }, 15_000);
    return () => clearTimeout(t);
  }, [railStatus, loadSessions]);

  // `loadSessions` is async: its setState calls run after an await, so they are not the synchronous
  // cascading-render pattern the rule targets. It used to need a suppression here; reading
  // `viewingAs` through a ref rather than a dependency removed whatever the rule was still seeing,
  // and a disable directive that no longer disables anything is worse than none — the next person
  // reads it as "this rule is known to misfire here" long after it stopped being true.
  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => {
    fetch("/api/usage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "view", surface: "/summer" }),
    }).catch(() => {});
  }, []);

  /**
   * The hermes wire, and nothing else. Memoised on `sid` because §2.2 requires the transport to be
   * referentially stable per session — the surface hands it to memo'd cards.
   */
  const transport = useMemo<AgentTransport>(() => {
    const id = sid;
    const requireSession = (): string => {
      if (!id) throw new Error("No conversation is open.");
      return id;
    };
    return {
      async startTurn({ message, signal, continuation }) {
        // A continuation is the machine driving itself onward after a clean cutoff — no human typed
        // anything. It has to be declared, and it must NOT carry attachments: the files belong to the
        // message the person actually sent, and re-sending them on every segment would re-ask the
        // question about the same screenshot several times over. This is the shape the writer's
        // transport has always used (`continuation ? {} : { message }`); Summer's ignored the flag and
        // posted `{message: ""}`, which its route answers with 400 "message is required" — so the
        // continuation loop could never have worked even once the flag reached the client.
        if (continuation) {
          return fetch(`/api/hermes/sessions/${requireSession()}/turn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ continuation: true }),
            signal,
          });
        }
        // Attachments ride with the message and are cleared the moment the turn starts, so the
        // next message does not silently re-send the last one's files. Read through a ref because
        // the transport is memoised on `sid` — a dependency on the list would rebuild it on every
        // upload and break the referential stability the surface relies on (§2.2).
        const files = attachedRef.current.filter((a) => a.status === "ready" && a.stored);
        attachedRef.current = [];
        setAttached([]);
        return fetch(`/api/hermes/sessions/${requireSession()}/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, attachments: files.map((a) => a.stored) }),
          signal,
        });
      },
      async stopTurn() {
        // Fire-and-forget by contract: the surface has already stopped locally (§5.6 / D8).
        await fetch(`/api/hermes/sessions/${requireSession()}/stop`, { method: "POST" }).catch(() => {});
      },
      async answerAsk({ askId, answer }) {
        // There is no ask endpoint on this wire yet. `show_options` is answered by sending the
        // chosen option back as an ordinary message — exactly what the old option buttons did — and
        // the surface owns that translation so the card still settles. Retired by P1.2.
        surfaceRef.current?.answerLegacyAsk(askId, answer);
      },
      async decideAction({ actionId, decision }) {
        const res = await fetch(`/api/hermes/actions/${actionId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        });
        const r = await res.json().catch(() => null);
        // Surface the server's own error string rather than a status code: it is the only place
        // that knows WHY an action refused to run, and the card prints whatever we throw.
        if (!res.ok || !r?.action) {
          throw new Error(r?.error ?? `That did not execute (${r?.outcome ?? res.status}).`);
        }
        return r.action as ActionRow;
      },
      async submitFeedback({ runId, value, comment }) {
        // Resolve = written, reject = not written. FeedbackButtons moves its thumb ONLY inside the
        // resolved branch, so throwing here correctly leaves the control where the person left it —
        // a thumb that lights up and then reverts destroys trust in every other control on the page.
        //
        // `session_id` rides along so a reopened thread can show its ratings already set, and so a
        // pattern is findable later ("what went wrong in that conversation"). The prompt revision is
        // stamped SERVER-side, not here: the point is attributing a rating to the prompt that
        // produced it, and a client could send anything.
        const res = await fetch("/api/hermes/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            run_id: runId,
            value,                       // null is meaningful — it deletes the rating
            comment,
            session_id: sid ?? null,
            surface: "summer",
          }),
        });
        const r = await res.json().catch(() => null);
        if (!res.ok || !r?.ok) throw new Error(r?.error ?? "Could not save that rating.");
      },
      async loadTranscript(): Promise<AgentSnapshot> {
        const r = await fetch(`/api/hermes/sessions/${requireSession()}`)
          .then((x) => x.json())
          .catch(() => null);
        if (!r?.ok) throw new Error(r?.error ?? "Couldn't load that conversation.");
        // The usage total rides along with the transcript, and this is the only fetch that carries
        // it. Setting page state from inside the transport is deliberate: the alternative is a
        // second round trip for one number.
        setUsage((r.session?.usage ?? {}) as Record<string, number>);
        // Same round trip, same reason: opening a conversation is the moment the picker has to show
        // that conversation's model, and this is the only fetch that carries it.
        setModel((r.session?.model ?? null) as string | null);
        return snapshotFromLegacyItems(
          (r.items ?? []) as LegacyTranscriptItem[],
          (r.actions ?? []) as ActionRow[],
        );
      },
    };
  }, [sid]);

  /**
   * The side channel (§2.2). Called from the reader loop, never from render.
   *
   * Errors are toasted AS WELL AS rendered: the reducer puts an error with no node into the
   * transcript so it survives the toast, but a failure the user has scrolled past still deserves to
   * interrupt them once.
   */
  const handleEvent = useCallback((event: AgentEvent) => {
    // Events only flow while a turn is streaming, so any event means "running". Cheaper and more
    // truthful than a separate onTurnStart the surface would have to remember to fire.
    setRunning(true);
    // A question asked while the person is looking elsewhere is the one thing that genuinely stalls
    // the run — auto-continuation cannot answer it for them.
    if (event.t === "ask" && document.visibilityState === "hidden" && sid) {
      setAttention((a) => ({ ...a, [sid]: "Summer asked you something" }));
    }
    if (event.t === "usage") {
      const u = event.usage ?? {};
      setUsage((prev) => {
        const next = { ...prev };
        for (const k of USAGE_KEYS) next[k] = (next[k] ?? 0) + (u[k] ?? 0);
        return next;
      });
    } else if (event.t === "error") {
      toast.error(event.message);
    }
    // `sid` is read to key the attention flag, so it has to be a dependency — an event arriving after
    // the person switched chats would otherwise flag the previous one.
  }, [sid]);

  /** The rail shows title and last-touched, both of which the turn just changed. */
  const handleTurnEnd = useCallback((reason?: string) => {
    setRunning(false);
    void loadSessions();
    // Only flag it when they are not watching. A banner for a turn that finished on screen in front of
    // them is noise, and noise is what makes people stop reading banners.
    if (document.visibilityState === "hidden" && sid) {
      setAttention((a) => ({
        ...a,
        [sid]: reason === "error" ? "That turn ended with an error"
          : reason === "continue" ? "Summer stopped and needs you"
          : "Summer finished",
      }));
    }
  }, [loadSessions, sid]);

  /**
   * The tab title carries the state, because it is the only part of this page visible from another tab.
   *
   * It deliberately does NOT set an idle title, and that is not laziness: Next resolves the layout's
   * metadata after hydration, so a title written once on mount is overwritten a moment later and the
   * effect never re-runs to correct it. Measured — the idle string never survived. Writing only when
   * there is something to say means every write happens on a state CHANGE, well after hydration, where
   * it wins. Restoring the original on the way back out keeps that honest.
   */
  const restTitleRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const waiting = Object.keys(attention).length;
    if (!waiting && !running) {
      if (restTitleRef.current) { document.title = restTitleRef.current; restTitleRef.current = null; }
      return;
    }
    if (!restTitleRef.current) restTitleRef.current = document.title;
    document.title = waiting
      ? `(${waiting}) Summer needs you — SearchOps`
      : "● Summer is working — SearchOps";
  }, [running, attention]);

  /** Coming back to the tab clears the flag for the chat they are actually looking at. */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      if (document.visibilityState !== "visible" || !sid) return;
      setAttention((a) => {
        if (!(sid in a)) return a;
        const next = { ...a };
        delete next[sid];
        return next;
      });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [sid]);

  async function newSession() {
    // The picked model travels with the CREATE, so the first turn already runs on it. Setting it
    // afterwards would run turn one on the default and then pay a cache write to switch.
    const r = await fetch("/api/hermes/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelRef.current ?? "" }),
    }).then((x) => x.json()).catch(() => null);
    if (!r?.ok) { toast.error(r?.error ?? "Could not start a session."); return; }
    setSessions((s) => [r.session, ...s]);
    setSid(r.session.id);
    setModel((r.session.model ?? null) as string | null);
    setUsage({});
  }

  // Replay a parked prompt once the session it needed actually exists.
  //
  // A ref rather than state: nothing renders from it, and clearing it inside the effect would be a
  // synchronous setState in an effect body — the cascading-render pattern React 19 lints against.
  useEffect(() => {
    if (!sid) return;
    const prompt = pendingPromptRef.current;
    if (!prompt) return;
    pendingPromptRef.current = null;
    surfaceRef.current?.send(prompt);
  }, [sid]);

  const startWithPrompt = useCallback((prompt: string) => {
    pendingPromptRef.current = prompt;
    void newSession();
    // `newSession` is a stable function declaration closing over setState only, so it needs no dep.
  }, []);

  // The chat named in /summer/<id>. Applied once and only when nothing is open, so it cannot fight
  // the rail: clicking another chat wins from then on.
  const routeSessionRef = useRef(false);
  useEffect(() => {
    if (routeSessionRef.current || !initialSessionId) return;
    routeSessionRef.current = true;
    setSid(initialSessionId);
  }, [initialSessionId]);

  // Fires once per page load. Not keyed on the value: a re-render must not re-send it, and the ref
  // is what makes "once" mean once rather than "once per identical string".
  useEffect(() => {
    if (!deepLinkPrompt || deepLinkFiredRef.current) return;
    deepLinkFiredRef.current = true;
    if (sid) surfaceRef.current?.setDraft(deepLinkPrompt);
    else startWithPrompt(deepLinkPrompt);
  }, [deepLinkPrompt, sid, startWithPrompt]);

  useSearchHotkey(useCallback(() => setSearchOpen(true), []));

  const totalTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-4">
      {/* Session rail */}
      <aside className="w-60 shrink-0 flex flex-col gap-2">
        <div className="flex items-center gap-2 px-1 pb-1">
          <BrainCircuit className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Summer</span>
          <span className="text-xs uppercase tracking-wide text-muted-foreground">the brain</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button onClick={newSession} className="min-w-0 flex-1 justify-start gap-2" variant="outline" disabled={!configured}>
            <Plus className="h-4 w-4" /> New chat
          </Button>
          {/* Search sits beside New chat rather than above the list: it acts on the whole archive,
              not on what happens to be rendered in the rail. The shortcut is shown because a
              palette nobody knows the shortcut for gets used once. */}
          <Button
            variant="outline"
            size="icon"
            onClick={() => setSearchOpen(true)}
            aria-label="Search conversations"
            title="Search conversations (⌘K)"
            className="shrink-0"
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>
        {!configured && (
          <p className="text-xs text-muted-foreground px-1">
            ANTHROPIC_API_KEY is not set, so Summer cannot think. Add it and reload.
          </p>
        )}
        {railStatus.phase === "loading" && sessions.length === 0 && (
          <p className="text-xs text-muted-foreground px-1">Loading conversations…</p>
        )}
        {railStatus.phase === "error" && (
          <div className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-warning">
            <p className="flex items-start gap-1.5">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Couldn&apos;t load your conversations — they are <b>not</b> gone ({railStatus.detail}).
                Retrying automatically.
              </span>
            </p>
            <Button size="sm" variant="outline" className="mt-1.5 h-7" onClick={() => void loadSessions()}>
              Try again now
            </Button>
          </div>
        )}
        {/* Superuser only, and absent entirely for everyone else — see PersonSwitcher. Placed above
            the list because it changes what the whole list means. */}
        <PersonSwitcher
          viewingAs={viewingAs}
          onChange={(email) => {
            // Order matters: the ref is what loadSessions reads, and the open conversation must be
            // dropped before the new rail arrives or the transcript pane would keep showing one
            // person's chat under another person's rail.
            viewingAsRef.current = email;
            setViewingAs(email);
            setSid(null);
            setRailStatus({ phase: "loading" });
            void loadSessions();
          }}
        />
        {/* The list itself, and the projects over it. This page still owns which conversation is
            open — the rail only reports the click — but grouping, filing and the project dialogs
            are the rail's own problem, and none of them need anything from here. With no projects
            it renders the same flat recency list this was before. */}
        <ProjectSessionRail
          sessions={sessions}
          activeId={sid}
          onSelect={setSid}
          runningId={running ? sid : null}
          attention={attention}
          // Deleting the OPEN chat has to move off it, or the transcript pane keeps rendering a
          // conversation the server no longer has and the next turn posts into a missing session.
          onDeleted={(id) => {
            setSessions((prev) => prev.filter((x) => x.id !== id));
            if (sid === id) { setSid(null); setUsage({}); }
          }}
        />
      </aside>

      {/* Conversation */}
      <section className="flex-1 flex flex-col min-w-0">
        <SearchPalette
          open={searchOpen}
          onOpenChange={setSearchOpen}
          // Opening a result is the same action as clicking it in the rail.
          onSelect={(id) => { setSid(id); setUsage({}); }}
          viewingAs={viewingAs}
        />

        {/* One banner, naming the chat and opening it. Rendered above the transcript rather than as a
            toast because a toast for something that happened while you were away has usually gone by
            the time you get back. */}
        {Object.keys(attention).length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-highlight/40 bg-highlight-soft px-3 py-2 text-xs">
            <BellRing className="h-3.5 w-3.5 shrink-0 text-highlight-ink" />
            {Object.entries(attention).map(([id, why]) => (
              <button
                key={id}
                onClick={() => {
                  setSid(id);
                  setAttention((a) => { const n = { ...a }; delete n[id]; return n; });
                }}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-medium text-highlight-ink underline-offset-2 hover:underline"
              >
                {why} in “{(sessions.find((x) => x.id === id)?.title ?? "Untitled").slice(0, 40)}” →
              </button>
            ))}
            <button
              onClick={() => setAttention({})}
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        )}

        <ChatSurface
          ref={surfaceRef}
          mode="hermes"
          sessionId={sid}
          transport={transport}
          // Read-only while viewing somebody else. The server refuses it anyway — the turn route
          // still checks `session.user_email !== email` and was deliberately left untouched — so
          // this is the UI agreeing with the server rather than being the thing that enforces it.
          // Starters are dropped too: a chip that cannot fire is worse than no chip.
          starters={viewingAs ? [] : STARTERS}
          onRequireSession={viewingAs ? undefined : startWithPrompt}
          heading={<WelcomeHeading firstName={firstName} />}
          emptyState={<EmptyState configured={configured} onStart={newSession} firstName={firstName} />}
          placeholder={viewingAs
            ? `Read-only — these are ${viewingAs}'s conversations`
            : 'Ask anything — "what needs my attention?", "how is the /ai-image-generator campaign doing?"'}
          banner={<PendingProposalsBanner />}
          // No attaching into somebody else's conversation — the route refuses it anyway, and
          // without onAttach the paperclip and the drop target are simply not there.
          onAttach={viewingAs ? undefined : handleAttach}
          attachmentSlot={
            <AttachmentChips
              items={attached}
              onRemove={(key) => writeAttached(attachedRef.current.filter((a) => a.key !== key))}
            />
          }
          // Not offered while reading somebody else's chat: the PATCH route refuses it, and the
          // whole point of the superuser read is that it changes nothing about their conversation.
          composerSlot={
            !viewingAs && models.length > 0 ? (
              <ModelPicker options={models} value={model} sessionId={sid} onChange={setModel} />
            ) : undefined
          }
          onEvent={handleEvent}
          onTurnEnd={handleTurnEnd}
          // The surface can only count what it streamed this page-load; the number below is the
          // server's cumulative total for the session, including cached reads. One footer, and it
          // is the honest one.
          features={HERMES_FEATURES}
        />

        {totalTokens > 0 && (
          <p className="text-xs text-muted-foreground mt-1.5 shrink-0">
            Session usage: {totalTokens.toLocaleString()} tokens
            {usage.cache_read_input_tokens ? ` · ${Number(usage.cache_read_input_tokens).toLocaleString()} cached reads` : ""}
          </p>
        )}
      </section>
    </div>
  );
}

/** `feedback` is ON: /api/hermes/feedback persists the rating, and the comments left on BAD turns are
 *  read back into every later turn's ops block (see recentAgentCorrections + opsDirective), which is
 *  the whole point — a rating nothing reads is a survey, not a loop. */
const HERMES_FEATURES = { usageFooter: false, feedback: true } as const;

/** "Morning" before 12, "Afternoon" before 18, "Evening" after. Computed on the client only — see
 *  the mount gate in WelcomeHeading, because the server and the browser can disagree about the hour
 *  and a hydration mismatch on the first line of the page is not worth a greeting. */
/** Never emits — the flag it backs only ever flips once, at hydration. Module scope so the
 *  identity is stable and useSyncExternalStore does not resubscribe on every render. */
function subscribeNever(): () => void {
  return () => {};
}

function partOfDay(d: Date): string {
  const h = d.getHours();
  return h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
}

function WelcomeHeading({ firstName }: { firstName?: string }) {
  // Rendered empty on the server, filled after mount. `new Date()` during SSR would bake the
  // server's timezone into the markup and flash the wrong greeting on hydration.
  //
  // useSyncExternalStore with a no-op subscribe is the hydration-safe way to say "am I on the
  // client yet": it returns the server snapshot during SSR and the client one after, with no
  // effect and no setState. The obvious useState+useEffect version is a synchronous setState in an
  // effect, which is the cascading-render pattern React 19 lints against.
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  const greeting = mounted ? partOfDay(new Date()) : null;

  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <h1 className="flex items-center gap-2.5 text-3xl font-medium tracking-tight md:text-4xl">
        <BrainCircuit className="h-7 w-7 shrink-0 text-highlight-ink md:h-8 md:w-8" aria-hidden />
        {/* min-h reserves the line so the heading does not jump when the greeting resolves. */}
        <span className="min-h-[1.2em]">
          {greeting ? `${greeting}${firstName ? `, ${firstName}` : ""}` : " "}
        </span>
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Summer runs this tool. Ask what needs attention, dig into any campaign, thread or draft, and
        run the work — anything irreversible comes back to you as a confirmation card first.
      </p>
    </div>
  );
}

function EmptyState({
  configured,
  onStart,
  firstName,
}: {
  configured: boolean;
  onStart: () => void;
  firstName?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center">
      <WelcomeHeading firstName={firstName} />
      {/* Deliberately quiet and secondary: the composer below is the real way in, and typing into
          it starts a session on its own. This is the affordance for someone who wants an explicit
          button, not the primary call to action — a loud button here competes with the input. */}
      <Button variant="ghost" size="sm" onClick={onStart} className="gap-2 text-muted-foreground" disabled={!configured}>
        <Plus className="h-4 w-4" /> New conversation
      </Button>
    </div>
  );
}

/**
 * "N proposals waiting", above the composer.
 *
 * It reads the store directly — legal because `banner` is rendered INSIDE the surface's provider,
 * and `usePendingActions` is a narrow subscription that fires only when a card is proposed or
 * resolved. The page itself still holds no transcript state.
 */
function PendingProposalsBanner() {
  const pending = usePendingActions();
  if (pending.length === 0) return null;
  return (
    <p className="text-xs text-warning dark:text-warning">
      {pending.length} proposal{pending.length === 1 ? "" : "s"} waiting for your decision above.
    </p>
  );
}
