"use client";

// The session rail, grouped by project.
//
// ══ What this is, and what it deliberately is not ═══════════════════════════════════════════════
//
// The rail's job has always been "get back to the conversation I was just in", and grouping is the
// one thing that can take that away. So three rules hold the shape:
//
//  1. **With no projects, this is the old rail.** No headings, no chrome, the same flat
//     recency-ordered list — plus the one control you need to make the first project. A "Projects"
//     heading over nothing, or an "Uncategorised" heading over everything, would make day one
//     strictly worse than day zero.
//
//  2. **Unfiled is a peer, not a leftovers bin.** Every conversation in the database is unfiled
//     right now, and unfiled is also where chats LAND when a project is deleted — it is a
//     destination, not a starting state. So it gets a real header with a real name ("Not in a
//     project"), and it sorts by the same rule as every project rather than being pinned above or
//     exiled below them. Today that puts it first, because it holds the most recent chat. That is
//     the sort doing its job, not a special case.
//
//  3. **Ordering is last activity, everywhere.** Groups sort by their most recent conversation, and
//     rows inside a group keep the order the session list gave them. `hermes_projects.updated_at`
//     is NOT that number — it has no trigger, so it moves on rename and nothing else — which is why
//     the API sends `lastActivity` and it is only fallen back to `updated_at` for a project with no
//     conversations to speak for it.
//
// ══ Where the data comes from ══════════════════════════════════════════════════════════════════
//
// Sessions arrive as a prop, from the page's existing /api/hermes/sessions fetch. Placement arrives
// separately from /api/hermes/projects, because that list's select names its columns and predates
// projects. Joining them here rather than widening that select keeps this feature to its own files;
// `resolveProject` below prefers a session's own `project_id` if it ever grows one, so the day that
// changes, nothing here has to.

import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderPlus, MoreHorizontal, Pencil, Trash2, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetchHonest } from "@/components/ui/load-failed";
import { cn } from "@/lib/utils";

import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { ProjectFormDialog } from "./ProjectFormDialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { SessionProjectMenu } from "./SessionProjectMenu";
import { projectDotClass, suggestProjectColor, type ProjectColor } from "./colors";
import type { ProjectRow, RailSession } from "./types";

export interface ProjectSessionRailProps {
  sessions: RailSession[];
  activeId: string | null;
  onSelect: (sessionId: string) => void;
  /** Remove a deleted chat from the page's own list. The rail does not own `sessions`. */
  onDeleted?: (sessionId: string) => void;
  /** The chat with a turn streaming right now, if any. */
  runningId?: string | null;
  /** Session id -> why it wants attention. Shown as a dot so it is findable without reading titles. */
  attention?: Record<string, string>;
}

/** session id → project id, or an explicit null for "taken out of a project". A missing key means
 *  the server never said, which is the same answer as null but must stay distinguishable so an
 *  optimistic unfile can be rolled back to "unknown" rather than to a guess. */
type AssignmentMap = Record<string, string | null>;

/** Which dialog is up. One value rather than three booleans, because exactly one can be true and
 *  the alternative is a state space with unreachable corners in it. */
type FormState =
  | { mode: "create"; session: RailSession | null }
  | { mode: "rename"; project: ProjectRow }
  | null;

interface RailGroup {
  key: string;
  /** null is the unfiled bucket — a group like any other, see rule 2 above. */
  project: ProjectRow | null;
  sessions: RailSession[];
  /** ISO timestamp this group was last used. The sort key. */
  last: string;
}

function setAssignment(map: AssignmentMap, sessionId: string, value: string | null | undefined): AssignmentMap {
  const next = { ...map };
  if (value === undefined) delete next[sessionId];
  else next[sessionId] = value;
  return next;
}

/** ISO-8601 from Postgres sorts lexicographically, so `>` is a real comparison and needs no Date. */
function newer(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function ProjectSessionRail({ sessions, activeId, onSelect, onDeleted, runningId, attention }: ProjectSessionRailProps) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [assignments, setAssignments] = useState<AssignmentMap>({});
  const [lastActivity, setLastActivity] = useState<Record<string, string>>({});
  /** Collapsed, keyed by group. Absent means expanded — the rail should open showing everything. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<FormState>(null);
  /**
   * The chat queued for deletion, or null.
   *
   * A dialog rather than window.confirm(), and not only for looks: a native confirm BLOCKS the
   * renderer, which froze the page hard enough that CDP could not reach past it during verification —
   * so the one destructive control here was the one control that could not be tested. The rail already
   * confirms project deletion with a dialog of its own, so this matches a pattern that exists.
   */
  const [pendingChat, setPendingChat] = useState<RailSession | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectRow | null>(null);
  /** A failed placement load, said out loud. Silently returning made every conversation render
   *  unfiled — the project structure looked deleted when only the fetch had failed. */
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    const { data, reason } = await fetchHonest<{
      projects?: ProjectRow[]; assignments?: AssignmentMap; lastActivity?: Record<string, string>;
    }>("/api/hermes/projects");
    if (!data) { setLoadError(reason); return; } // keep whatever grouping is already on screen
    setProjects((data.projects ?? []) as ProjectRow[]);
    setAssignments((data.assignments ?? {}) as AssignmentMap);
    setLastActivity((data.lastActivity ?? {}) as Record<string, string>);
    setLoadError(null);
  }, []);

  // Same shape, and the same exemption, as the page's `loadSessions`: these setState calls run
  // after an await, so they are not the synchronous cascading-render pattern the rule targets.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadProjects(); }, [loadProjects]);

  /** A session's project. The local map wins over the row's own column: it is the one that carries
   *  an optimistic move, and the sessions prop can be a refetch behind. */
  const resolveProject = useCallback(
    (s: RailSession): string | null => (s.id in assignments ? assignments[s.id] : s.project_id ?? null),
    [assignments],
  );

  const groups = useMemo<RailGroup[]>(() => {
    const buckets = new Map<string, RailSession[]>();
    for (const s of sessions) {
      const key = resolveProject(s) ?? "";
      const list = buckets.get(key);
      if (list) list.push(s);
      else buckets.set(key, [s]);
    }

    const out: RailGroup[] = [];
    for (const project of projects) {
      const list = buckets.get(project.id) ?? [];
      // Three candidates, newest wins. The visible sessions make a just-filed chat reorder the rail
      // immediately; `lastActivity` covers a project whose conversations are all older than the
      // page the rail was given; `updated_at` is the floor for a project with nothing in it at all.
      let last = project.updated_at;
      for (const s of list) last = newer(last, s.updated_at) ?? last;
      last = newer(last, lastActivity[project.id]) ?? last;
      out.push({ key: project.id, project, sessions: list, last });
    }

    const unfiled = buckets.get("") ?? [];
    // Rendered only when it has something in it — an empty "Not in a project" is a heading naming
    // the absence of a thing.
    if (unfiled.length > 0) {
      let last = unfiled[0].updated_at;
      for (const s of unfiled) last = newer(last, s.updated_at) ?? last;
      out.push({ key: "", project: null, sessions: unfiled, last });
    }

    out.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
    return out;
  }, [sessions, projects, lastActivity, resolveProject]);

  /** How many conversations a project really holds, across every session the user has rather than
   *  the page the rail was handed. Only the delete confirmation uses it — a group header showing a
   *  bigger number than the rows beneath it reads as a bug, but a promise about what survives a
   *  delete has to be about all of them. */
  const trueCount = useCallback(
    (projectId: string) => Object.values(assignments).filter((v) => v === projectId).length,
    [assignments],
  );

  const assign = useCallback(
    /** `projectName` is passed in only by the create-then-file path: the project it just made is
     *  not in `projects` yet from this closure's point of view, and looking it up there would name
     *  the move after nothing. */
    async (sessionId: string, projectId: string | null, projectName?: string) => {
      const previous = sessionId in assignments ? assignments[sessionId] : undefined;
      if (previous === projectId) return;
      // Optimistic: the row moves the moment you pick, because a rail that waits on a round trip to
      // reorder feels like it ignored the click.
      setAssignments((prev) => setAssignment(prev, sessionId, projectId));

      const res = await fetch("/api/hermes/projects/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, project_id: projectId }),
      });
      const r = await res.json().catch(() => null);
      if (!res.ok || !r?.ok) {
        setAssignments((prev) => setAssignment(prev, sessionId, previous));
        toast.error(r?.error ?? "Could not move that conversation.");
        return;
      }
      const name = projectId ? (projectName ?? projects.find((p) => p.id === projectId)?.name) : null;
      toast.success(name ? `Moved to “${name}”.` : "Taken out of its project.");
    },
    [assignments, projects],
  );

  const createProject = useCallback(
    async (values: { name: string; color: ProjectColor }, fileSession: RailSession | null): Promise<string | null> => {
      const res = await fetch("/api/hermes/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const r = await res.json().catch(() => null);
      // The 409 for a duplicate name is returned rather than toasted: it belongs beside the field
      // that caused it, in a dialog that stays open with the name still in it.
      if (!res.ok || !r?.ok) return r?.error ?? "Could not create that project.";

      const project = r.project as ProjectRow;
      setProjects((prev) => [project, ...prev]);
      if (fileSession) await assign(fileSession.id, project.id, project.name);
      else toast.success(`Created “${project.name}”.`);
      return null;
    },
    [assign],
  );

  const renameProject = useCallback(
    async (id: string, values: { name: string; color: ProjectColor }): Promise<string | null> => {
      const res = await fetch(`/api/hermes/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const r = await res.json().catch(() => null);
      if (!res.ok || !r?.ok) return r?.error ?? "Could not rename that project.";
      setProjects((prev) => prev.map((p) => (p.id === id ? (r.project as ProjectRow) : p)));
      return null;
    },
    [],
  );

  const deleteProject = useCallback(async (project: ProjectRow): Promise<string | null> => {
    const res = await fetch(`/api/hermes/projects/${project.id}`, { method: "DELETE" });
    const r = await res.json().catch(() => null);
    if (!res.ok || !r?.ok) return r?.error ?? "Could not delete that project.";

    setProjects((prev) => prev.filter((p) => p.id !== project.id));
    // Its conversations are still there — ON DELETE SET NULL put them back in the unfiled bucket,
    // and this mirrors that locally so they reappear under "Not in a project" without a refetch.
    setAssignments((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([, v]) => v !== project.id)),
    );
    const released = Number(r.released ?? 0);
    toast.success(
      released > 0
        ? `Deleted “${project.name}”. ${released} conversation${released === 1 ? "" : "s"} moved back to Not in a project.`
        : `Deleted “${project.name}”.`,
    );
    return null;
  }, []);

  /**
   * Delete a conversation.
   *
   * Confirmed, and named in the prompt — the rail shows two-line titles, so "Delete chat" on the wrong
   * row is an easy miss and there is no undo behind it. The list is updated by the page rather than
   * here, because the page owns `sessions` and also has to move off the chat if it was the open one.
   */
  const removeSession = useCallback(async (s: RailSession) => {
    const name = s.title ?? "Untitled";
    try {
      const r = await fetch(`/api/hermes/sessions/${s.id}`, { method: "DELETE" });
      const j = await r.json().catch(() => null);
      if (!j?.ok) { toast.error(j?.error ?? `Could not delete it (HTTP ${r.status}).`); return; }
      onDeleted?.(s.id);
      toast.success(`Deleted “${name}”.`);
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setPendingChat(null);
    }
  }, [onDeleted]);

  const renderRow = (s: RailSession) => (
    // A wrapper, because the menu's trigger is a button and cannot live inside the row's button.
    <div key={s.id} className="group/row relative">
      <button
        onClick={() => onSelect(s.id)}
        className={cn(
          "w-full rounded-md px-3 py-2 pr-9 text-left text-xs transition-colors hover:bg-muted",
          activeId === s.id && "bg-muted font-medium",
        )}
      >
        <span className="line-clamp-2">{s.title ?? "Untitled"}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
          {/* Two states, and they never both apply: a chat is either mid-turn or waiting for you. The
              label says which — a bare dot makes people guess, and "working" vs "needs you" are
              opposite instructions. */}
          {runningId === s.id ? (
            <>
              <Loader2 className="size-3 animate-spin text-highlight-ink" />
              <span className="text-highlight-ink">working…</span>
            </>
          ) : attention?.[s.id] ? (
            <>
              <span className="size-1.5 shrink-0 rounded-full bg-highlight-ink" aria-hidden />
              <span className="text-highlight-ink">needs you</span>
            </>
          ) : (
            new Date(s.updated_at).toLocaleDateString()
          )}
        </span>
      </button>
      <SessionProjectMenu
        projects={projects}
        value={resolveProject(s)}
        label={s.title ?? "Untitled"}
        onAssign={(projectId) => void assign(s.id, projectId)}
        onCreateProject={() => setForm({ mode: "create", session: s })}
        onDelete={onDeleted ? () => setPendingChat(s) : undefined}
        // Quiet until you go looking. Focus and an open menu both override it, so the control is
        // reachable by keyboard and does not vanish out from under its own popup.
        className="absolute top-2 right-1.5 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
      />
    </div>
  );

  return (
    <>
      {/* The only always-present projects chrome, and one line of it. With no projects this is an
          offer rather than an empty section; with projects it is where the next one comes from. */}
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setForm({ mode: "create", session: null })}
        className="justify-start gap-1.5 px-1.5 text-muted-foreground hover:text-foreground"
      >
        <FolderPlus className="size-3.5" /> New project
      </Button>

      {loadError && (
        <p className="px-1.5 pb-1 text-xs leading-snug text-warning">
          Couldn&apos;t load projects — grouping is temporarily unavailable ({loadError}).{" "}
          <button
            type="button"
            onClick={() => void loadProjects()}
            className="font-medium underline underline-offset-2 hover:text-foreground"
          >
            Try again
          </button>
        </p>
      )}

      <div className="flex-1 space-y-1 overflow-y-auto">
        {/* Rule 1: with nothing to group by, do not group. This is the rail as it was. */}
        {projects.length === 0
          ? sessions.map(renderRow)
          : groups.map((g) => {
              const open = !collapsed[g.key];
              return (
                <div key={g.key} className="space-y-0.5">
                  <div className="group/head flex items-center gap-1 pr-1">
                    <button
                      onClick={() => setCollapsed((prev) => ({ ...prev, [g.key]: open }))}
                      aria-expanded={open}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/60"
                    >
                      <ChevronRight
                        className={cn(
                          "size-3 shrink-0 text-muted-foreground transition-transform",
                          open && "rotate-90",
                        )}
                        aria-hidden
                      />
                      {/* A hollow ring for the unfiled group: it reads as "no colour chosen"
                          rather than as a colour that failed to load. */}
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          g.project ? projectDotClass(g.project.color) : "ring-1 ring-border",
                        )}
                        aria-hidden
                      />
                      <span className="truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        {g.project ? g.project.name : "Not in a project"}
                      </span>
                      {/* The count is what is under this header, not the project's global size —
                          see `trueCount`. */}
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground/70">
                        {g.sessions.length}
                      </span>
                    </button>
                    {g.project && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          aria-label={`Options for “${g.project.name}”`}
                          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors outline-none group-hover/head:opacity-100 hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:opacity-100"
                        >
                          <MoreHorizontal className="size-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem
                            onClick={() => setForm({ mode: "rename", project: g.project as ProjectRow })}
                          >
                            <Pencil /> Rename…
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setPendingDelete(g.project as ProjectRow)}
                          >
                            <Trash2 /> Delete project
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>

                  {open && (
                    <div className="space-y-1">
                      {g.sessions.map(renderRow)}
                      {g.sessions.length === 0 && (
                        // A project you just made, with nothing in it yet. Silence here looks like
                        // the create failed.
                        <p className="px-3 py-1 text-xs text-muted-foreground">
                          Nothing in here yet.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

        {sessions.length === 0 && projects.length === 0 && (
          <p className="px-1 pt-2 text-xs text-muted-foreground">No conversations yet.</p>
        )}
      </div>

        <Dialog open={pendingChat !== null} onOpenChange={(open) => { if (!open) setPendingChat(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Delete this chat?</DialogTitle>
              <DialogDescription>
                {/* The title is quoted because the rail shows two-line titles and "Delete chat" on the
                    wrong row is an easy miss. There is no undo behind this. */}
                “{pendingChat?.title ?? "Untitled"}” and every message in it are deleted for good.
                Drafts it produced are not touched — they live in their own table.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setPendingChat(null)}>Keep it</Button>
              <Button
                variant="destructive" size="sm"
                onClick={() => { if (pendingChat) void removeSession(pendingChat); }}
              >
                <Trash2 className="size-3.5" /> Delete chat
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

      {/* Mounted only while open, and keyed by subject, so the form seeds itself from props on
          mount and needs no effect to stay in sync. */}
      {form?.mode === "create" && (
        <ProjectFormDialog
          key="create"
          suggestedColor={suggestProjectColor(projects.length)}
          fileChatTitle={form.session ? (form.session.title ?? "Untitled") : null}
          onOpenChange={(open) => { if (!open) setForm(null); }}
          onSubmit={(values) => createProject(values, form.session)}
        />
      )}
      {form?.mode === "rename" && (
        <ProjectFormDialog
          key={`rename:${form.project.id}`}
          project={form.project}
          suggestedColor={suggestProjectColor(projects.length)}
          onOpenChange={(open) => { if (!open) setForm(null); }}
          onSubmit={(values) => renameProject(form.project.id, values)}
        />
      )}
      {pendingDelete && (
        <DeleteProjectDialog
          key={pendingDelete.id}
          project={pendingDelete}
          chatCount={trueCount(pendingDelete.id)}
          onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
          onConfirm={() => deleteProject(pendingDelete)}
        />
      )}
    </>
  );
}
