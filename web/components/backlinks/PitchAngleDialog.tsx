"use client";

// The "write the pitches MY way" control for one backlink campaign.
//
// Every initial pitch is drafted from the stock angle (a paid collaboration), and the only steer
// a person had was rewriting drafts after the fact with the popover — the feedback was that the
// NEXT run went straight back to the paid ask. This dialog sets the angle at the campaign level,
// in exactly the two steps the team asked for:
//
//   1. say the angle in your own words → a sample pitch is drafted against a real prospect
//   2. read it → "Apply to every prospect"
//
// Applying does two writes, in this order, and says so before the click:
//   - the angle is SAVED on the campaign, so every pitch written from now on (the Write pitches
//     button, tonight's cron) is drafted from it — this is what fixes "initial pitches are
//     always paid" rather than treating the symptom
//   - every existing UNSENT pitch is rewritten to the angle, each against its own recipient and
//     article, via the same workflow-wide machinery as the popover's "Apply to all" — so they all
//     go back to awaiting review, and sent mail is never touched
//
// Closing the dialog mid-rewrite only stops the POLLING — the run lives on the server. Reopening
// and applying again lands on alreadyRunning and resumes the progress display.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Compass, Loader2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

interface Preview {
  domain: string;
  recipient: string | null;
  subject: string;
  body: string;
  sampledFrom: "existing" | "fresh";
}

export function PitchAngleDialog({
  open,
  onOpenChange,
  campaignId,
  workflowId,
  campaignLabel,
  currentAngle,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  campaignId: string;
  workflowId: string;
  campaignLabel: string;
  /** What the campaign is set to right now. Null = the stock paid angle. */
  currentAngle: string | null;
  /** Called after any write lands (angle saved / cleared / bulk rewrite finished). */
  onApplied: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "apply" | "clear">("");
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const bulkTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Opening always starts from what the campaign actually holds; a half-typed instruction from a
  // dismissed session must not masquerade as the stored angle.
  useEffect(() => {
    if (open) { setInstruction(currentAngle ?? ""); setPreview(null); }
  }, [open, currentAngle]);
  useEffect(() => () => { if (bulkTimer.current) clearInterval(bulkTimer.current); }, []);

  const close = () => { onOpenChange(false); setPreview(null); setBulk(null); if (bulkTimer.current) { clearInterval(bulkTimer.current); bulkTimer.current = null; } };

  // Parse-safe POST: a crashed serverless function answers with a BLANK or HTML page, and an
  // unguarded res.json() turned that into a thrown parse error and a toast that named nothing
  // ("Couldn't apply the angle" — the measured failure, root cause a spent Redis quota). The
  // status code is the one fact always available, so it is what the fallback message carries.
  const post = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    return data ?? { error: `The server answered ${res.status} with an unreadable response.` };
  };

  const draftSample = async () => {
    setBusy("preview");
    try {
      const d = await post(`/api/backlinks/${campaignId}/action`, { action: "pitch-angle-preview", instruction });
      if (d?.ok && d.preview) setPreview(d.preview as Preview);
      else toast.error(String(d?.error ?? "Couldn't draft the sample."));
    } catch { toast.error("Couldn't draft the sample — the server did not answer."); }
    finally { setBusy(""); }
  };

  const pollBulk = () => {
    if (bulkTimer.current) clearInterval(bulkTimer.current);
    const tick = async () => {
      const st = await fetch(`/api/workflows/${workflowId}/generate-status?channel=revise`).then((r) => r.json()).catch(() => null);
      if (!st) return;
      // "Cannot know" from the tracker, not "finished with 0": stop polling and say so, instead
      // of announcing a zero-pitch result over a run that is still working.
      if (st.unavailable) {
        if (bulkTimer.current) { clearInterval(bulkTimer.current); bulkTimer.current = null; }
        toast.info("The rewrite is running, but its progress counter stopped answering — check the pitches in a few minutes.");
        onApplied();
        close();
        return;
      }
      setBulk({ done: st.done, total: st.total });
      if (!st.running) {
        if (bulkTimer.current) { clearInterval(bulkTimer.current); bulkTimer.current = null; }
        toast.success(`Angle applied to ${st.done} of ${st.total} pitches — they're back in the review queue.`);
        if (st.errors?.length) toast.error(`${st.errors[0]}${st.errors.length > 1 ? ` (+${st.errors.length - 1} more)` : ""}`);
        onApplied();
        close();
      }
    };
    void tick();
    bulkTimer.current = setInterval(tick, 2500);
  };

  const applyAll = async () => {
    setBusy("apply");
    try {
      // Save first: even if the bulk rewrite can't start, "every pitch from now on" must hold.
      const saved = await post(`/api/backlinks/${campaignId}/action`, { action: "set-pitch-angle", instruction });
      if (!saved?.ok) { toast.error(String(saved?.error ?? "Couldn't save the angle.")); return; }

      const d = await post(`/api/workflows/${workflowId}/revise-emails`, { instruction });
      if (d?.alreadyRunning) { setBulk({ done: 0, total: 0 }); toast.info("A rewrite is already running for this campaign — showing its progress."); pollBulk(); return; }
      if (d?.started && d.progress === false) {
        // Degraded mode: the run is real but has no lock and no live counter (Redis quota spent).
        // The angle is saved and the rewrite is underway — the only honest loss is the number.
        toast.success(`Angle saved. Rewriting ${d.total} pitch${d.total === 1 ? "" : "es"} in the background — the live counter is unavailable right now, so give it a few minutes and reload the page to see them.`);
        onApplied();
        close();
        return;
      }
      if (d?.started) { setBulk({ done: 0, total: Number(d.total) || 0 }); pollBulk(); return; }
      // The angle IS saved from here down — the split matters, because "nothing to rewrite" is a
      // finished job while an error means the existing pitches still carry the old angle.
      if (d?.error) {
        toast.error(`The angle is saved and every new pitch will use it, but the existing pitches were not rewritten: ${d.error}`);
        onApplied();
        close();
        return;
      }
      toast.success(`Angle saved — every pitch written for ${campaignLabel} from now on uses it.${d?.reason ? ` ${d.reason}` : ""}`);
      onApplied();
      close();
    } catch { toast.error("Couldn't apply the angle — the server did not answer."); }
    finally { setBusy(""); }
  };

  const clearAngle = async () => {
    setBusy("clear");
    try {
      const d = await post(`/api/backlinks/${campaignId}/action`, { action: "set-pitch-angle", instruction: "" });
      if (d?.ok) {
        toast.success("Back to the standard pitch for new drafts. Already-written pitches were not changed.");
        onApplied();
        close();
      } else toast.error(String(d?.error ?? "Couldn't clear the angle."));
    } catch { toast.error("Couldn't clear the angle — the server did not answer."); }
    finally { setBusy(""); }
  };

  const applying = busy === "apply" || bulk !== null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); else onOpenChange(v); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Compass className="h-5 w-5" /> Pitch angle</DialogTitle>
          <DialogDescription>
            Pitches for {campaignLabel} are written as a paid collaboration unless you say otherwise
            here. Describe the angle you want, read the sample it drafts, and apply it to every
            prospect — existing unsent pitches are rewritten, and everything written after (the
            &ldquo;Write pitches&rdquo; button, the nightly run) starts from your angle.
          </DialogDescription>
        </DialogHeader>

        {preview === null ? (
          <>
            <Textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={5}
              className="text-sm"
              placeholder={"e.g. Never lead with payment. Pitch it as a genuine resource for their readers: what ImagineArt does, why it fits their piece, and offer to collaborate however suits them."}
              disabled={busy !== ""}
            />
            <div className="flex items-center justify-between gap-4">
              <span className="text-xs text-muted-foreground">
                {currentAngle ? "This campaign already has an angle — edit it above, or remove it." : "The sample is drafted against a real prospect from this campaign. Nothing is saved until you apply."}
              </span>
              <div className="flex gap-2">
                {currentAngle && (
                  <Button variant="ghost" onClick={() => void clearAngle()} disabled={busy !== ""}
                    title="New drafts go back to the standard paid-collaboration pitch. Pitches already written stay as they are.">
                    {busy === "clear" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Remove the angle
                  </Button>
                )}
                <Button onClick={() => void draftSample()} disabled={busy !== "" || !instruction.trim()}>
                  {busy === "preview" ? <><Loader2 className="h-4 w-4 animate-spin" /> Drafting…</> : <><Wand2 className="h-4 w-4" /> Draft a sample</>}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-2">
              <div className="text-xs text-muted-foreground">
                Sample for {preview.domain}{preview.recipient ? ` — ${preview.recipient}` : ""}
                {preview.sampledFrom === "existing" ? " (rewritten from its current draft)" : " (drafted fresh — no pitches written yet)"}
              </div>
              <div className="text-sm font-medium">{preview.subject}</div>
              <div className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">{preview.body}</div>
            </div>
            <p className="text-xs text-muted-foreground">
              Applying saves this angle on the campaign and rewrites every unsent pitch the same way,
              each against its own recipient and article. They all go back to awaiting review; sent
              pitches are never touched.
            </p>
            <div className="flex items-center justify-between gap-4">
              {bulk !== null ? (
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground tabular-nums">
                  <Loader2 className="h-4 w-4 animate-spin" /> Rewriting {bulk.done}/{bulk.total || "…"}
                </span>
              ) : <span />}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setPreview(null)} disabled={applying}>Change the angle</Button>
                <Button onClick={() => void applyAll()} disabled={applying}>
                  {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Apply to every prospect
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
