"use client";

// The "rewrite this pitch with AI" affordance, shared by the three pitch editors (the Backlinks
// pitch dialog, /emails' edit sheet, /sending's edit sheet). Mirrors the blog editor's Rewrite
// popover: the server returns a PROPOSAL, this splices it into the host editor's state via
// onProposal, and the person reviews and saves through the editor's normal Save — so the save
// records THEM as the reviewer, and Undo is one click while the editor stays open.
//
// After a rewrite lands, editors that know their workflow (workflowId prop) also offer "Apply to
// all": the same tone + instruction runs across every OTHER unsent pitch in the workflow, each
// grounded in its own recipient and article. That path writes server-side and clears the pitches'
// reviewed stamps — see /api/workflows/[id]/revise-emails for why — so this component's job is to
// say that plainly before the click and show honest progress after it.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, RotateCcw, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { PITCH_TONES, toneLabel } from "@/lib/email/pitchTones";

export function RewritePopover({
  emailId,
  current,
  disabled,
  onProposal,
  workflowId,
  onBulkDone,
}: {
  emailId: string;
  /** The editor's CURRENT (possibly unsaved) text — that's what gets rewritten. */
  current: { subject: string; body: string };
  disabled?: boolean;
  /** Splice the proposal (or the undo snapshot) into the host editor's state. */
  onProposal: (p: { subject: string; body: string }) => void;
  /** When set, a successful rewrite offers "apply the same to every unsent pitch here".
   *  Editors without a workflow in scope (/sending spans them all) just omit it. */
  workflowId?: string;
  /** Called once a workflow-wide apply finishes, so the host can refetch its rows. */
  onBulkDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tone, setTone] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  // What the editor held before the last splice. One level — this is a convenience next to an
  // editor whose Cancel already discards everything.
  const [snapshot, setSnapshot] = useState<{ subject: string; body: string } | null>(null);
  // The ask behind the last accepted proposal — what "Apply to all" replays. Cleared by Undo:
  // a rejected rewrite is not something to run eighty more times.
  const [applied, setApplied] = useState<{ tone: string | null; instruction: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const bulkTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Closing the editor mid-run only stops the POLLING — the run itself lives on the server.
  // Clicking Apply to all again after reopening lands on alreadyRunning and resumes the progress.
  useEffect(() => () => { if (bulkTimer.current) clearInterval(bulkTimer.current); }, []);

  const rewrite = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/emails/${emailId}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tone: tone ?? undefined, instruction, subject: current.subject, body: current.body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        toast.error(data?.error ?? "The rewrite failed.");
        return;
      }
      setSnapshot({ ...current });
      setApplied({ tone, instruction });
      onProposal({ subject: data.subject ?? current.subject, body: data.body ?? "" });
      setOpen(false);
      toast.success("Rewritten. Review it — nothing is saved until you press Save.");
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const undo = () => {
    if (!snapshot) return;
    onProposal(snapshot);
    setSnapshot(null);
    setApplied(null);
  };

  const pollBulk = () => {
    if (!workflowId) return;
    if (bulkTimer.current) clearInterval(bulkTimer.current);
    const tick = async () => {
      const st = await fetch(`/api/workflows/${workflowId}/generate-status?channel=revise`).then((r) => r.json()).catch(() => null);
      if (!st) return;
      // The tracker answering "cannot know" (Redis quota spent) is not "finished with 0" — stop
      // polling and say so, instead of announcing a zero-pitch result over a run still working.
      if (st.unavailable) {
        if (bulkTimer.current) { clearInterval(bulkTimer.current); bulkTimer.current = null; }
        setBulk(null);
        toast.info("The rewrite is running, but its progress counter stopped answering — check the pitches in a few minutes.");
        onBulkDone?.();
        return;
      }
      setBulk({ done: st.done, total: st.total });
      if (!st.running) {
        if (bulkTimer.current) { clearInterval(bulkTimer.current); bulkTimer.current = null; }
        setBulk(null);
        toast.success(`Applied the rewrite to ${st.done} of ${st.total} pitches${st.errors?.length ? `, ${st.errors.length} errors` : ""}. They're back in the review queue.`);
        if (st.errors?.length) toast.error(`${st.errors[0]}${st.errors.length > 1 ? ` (+${st.errors.length - 1} more)` : ""}`);
        onBulkDone?.();
      }
    };
    void tick();
    bulkTimer.current = setInterval(tick, 2500);
  };

  const applyAll = async () => {
    if (!workflowId || !applied) return;
    setConfirmOpen(false);
    setBulk({ done: 0, total: 0 });
    try {
      const res = await fetch(`/api/workflows/${workflowId}/revise-emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tone: applied.tone ?? undefined,
          instruction: applied.instruction || undefined,
          exclude_email_id: emailId,
        }),
      });
      const data = await res.json().catch(() => null) ?? { error: `The server answered ${res.status} with an unreadable response.` };
      if (data?.alreadyRunning) { toast.info("A rewrite is already running for this workflow — showing its progress."); pollBulk(); return; }
      if (!res.ok || !data?.started) {
        setBulk(null);
        toast.error(data?.reason ?? data?.error ?? "Couldn't start the workflow-wide rewrite.");
        return;
      }
      // Degraded mode: the run is real but has no live counter (Redis quota spent) — polling
      // would show 0/0 forever, so skip it and say what actually happened.
      if (data.progress === false) {
        setBulk(null);
        toast.success(`Rewriting ${data.total} pitches in the background — the live counter is unavailable right now, so give it a few minutes and refresh to see them.`);
        onBulkDone?.();
        return;
      }
      setBulk({ done: 0, total: data.total });
      toast.success(`Rewriting ${data.total} pitches in the background. This one stays yours to save.`);
      pollBulk();
    } catch {
      setBulk(null);
      toast.error("Could not reach the server.");
    }
  };

  return (
    // flex-wrap: this row can hold three buttons at once (Apply to all pitches / Rewrite / Undo),
    // and in a narrow host they must wrap, not overflow onto the editor's own labels.
    <div className="flex flex-wrap items-center gap-1.5">
      {/* "Apply to all pitches" leads the row, as a primary button — it used to trail the Undo
          button in outline style and was reported as too hidden to find. It only exists after a
          rewrite has landed (there is nothing to replay before one), so when present it is the
          most consequential control here and should read like it. */}
      {bulk !== null ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Rewriting {bulk.done}/{bulk.total || "…"}
        </span>
      ) : applied !== null && workflowId ? (
        <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
          <PopoverTrigger
            render={(props) => (
              <Button {...props} size="sm" className="gap-1.5" disabled={busy} title="Run the same rewrite across every other unsent pitch in this workflow.">
                <Wand2 className="h-3.5 w-3.5" /> Apply to all pitches
              </Button>
            )}
          />
          <PopoverContent className="w-80 p-3 space-y-2.5">
            <p className="text-xs font-medium">Apply this rewrite to the whole workflow?</p>
            <p className="text-xs text-muted-foreground">
              Every other unsent pitch in this workflow gets the same treatment
              {applied.tone ? <> (tone: {toneLabel(applied.tone)}{applied.instruction.trim() ? ", plus your instruction" : ""})</> : applied.instruction.trim() ? " (your instruction)" : ""},
              each rewritten against its own recipient and article. Their current drafts are replaced
              and each goes back to awaiting review. Sent pitches are never touched.
            </p>
            <Button size="sm" className="w-full gap-1.5" onClick={() => void applyAll()}>
              <Wand2 className="h-3.5 w-3.5" /> Rewrite them all
            </Button>
          </PopoverContent>
        </Popover>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={(props) => (
            <Button {...props} size="sm" variant="outline" className="gap-1.5" disabled={disabled || busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              Rewrite with AI
            </Button>
          )}
        />
        <PopoverContent className="w-80 p-3 space-y-2.5">
          <p className="text-xs font-medium">Tone</p>
          <div className="flex flex-wrap gap-1.5">
            {PITCH_TONES.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant="outline"
                className={cn("h-7 px-2.5 text-xs", tone === t.id && "border-primary bg-primary/10 text-primary")}
                onClick={() => setTone((cur) => (cur === t.id ? null : t.id))}
                disabled={busy}
              >
                {t.label}
              </Button>
            ))}
          </div>
          <p className="text-xs font-medium">What should change?</p>
          <Textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            className="min-h-[72px] text-sm"
            placeholder="Shorter and more direct. Lead with why their piece specifically. Drop the second paragraph."
          />
          <p className="text-xs text-muted-foreground">
            It keeps the greeting and the article link, invents no facts, and never names a price.
            Leave both empty to just tighten it.
            {/* Said up front, because the button itself only appears after a rewrite lands — people
                looked for a bulk option here and concluded there wasn't one. */}
            {workflowId ? " Once it lands, an “Apply to all pitches” button appears to run the same change across every unsent pitch in this workflow." : ""}
          </p>
          <Button size="sm" className="w-full gap-1.5" disabled={busy} onClick={() => void rewrite()}>
            <Wand2 className="h-3.5 w-3.5" /> Rewrite
          </Button>
        </PopoverContent>
      </Popover>
      {snapshot !== null && (
        <Button size="sm" variant="ghost" className="gap-1.5 text-highlight-ink" onClick={undo} disabled={busy} title="Put back what was here before the rewrite.">
          <RotateCcw className="h-3.5 w-3.5" /> Undo
        </Button>
      )}
    </div>
  );
}
