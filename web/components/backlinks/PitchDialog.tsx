"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Mail, PenLine, Lock, UserRound, Copy, ExternalLink, CheckCircle2, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { RewritePopover } from "@/components/outreach/RewritePopover";

// LinkedIn's connection-note cap. Kept as a local constant (like /emails' LINKEDIN_LIMIT) rather
// than imported from lib/email/linkedinNote, which is server code (it pulls in the LLM client).
const LINKEDIN_NOTE_LIMIT = 300;
// WhatsApp has no platform cap — this is the editorial "stops reading as a chat message" line
// from lib/email/whatsappNote, duplicated for the same server-code reason as above.
const WHATSAPP_NOTE_LIMIT = 500;

export interface PitchInfo {
  id: string;
  subject: string | null;
  body: string | null;
  status: string | null;
  sentAt: string | null;
  scheduledAt: string | null;
  editedAt: string | null;
  editedBy: string | null;
  editable: boolean;
}

export interface PitchTarget {
  domain: string;
  /** The article byline. */
  author: string | null;
  email: string | null;
  /** Set when the address belongs to someone OTHER than the byline (a Hunter alt contact). */
  emailOwner: string | null;
  emailOwnerPosition: string | null;
  prospectUrl: string;
  pitch: PitchInfo;
  /** For the LinkedIn note editor — the note row lives on (workflow, author). */
  workflowId?: string;
  authorId?: string;
  linkedinUrl?: string | null;
  /** The drafted DM-ready note; null/undefined = none, so the section doesn't render. */
  linkedinNote?: string | null;
  /** When a person recorded actually sending the DM (080). */
  linkedinNoteSentAt?: string | null;
  linkedinNoteSentBy?: string | null;
  /** The stored wa.me link; null = no number known yet (the dialog offers to save one). */
  whatsappUrl?: string | null;
  /** The drafted chat-sized first message; null = none yet. */
  whatsappNote?: string | null;
  /** When a person recorded actually sending the WhatsApp message (082). */
  whatsappNoteSentAt?: string | null;
  whatsappNoteSentBy?: string | null;
}

/**
 * Read and edit one AI-drafted pitch, in place on the Backlinks page.
 *
 * The gap this closes was reported verbatim: "I cannot find the option to see / edit the pitches written
 * by AI." It was accurate — the nightly cron writes them as `ready` outreach_emails and there was no
 * surface anywhere. 106 were queued and none had ever been opened. A queue of unreviewed AI drafts nobody
 * can read is worse than no drafts, because it looks like progress while being unauditable.
 *
 * Two things this deliberately makes impossible to miss:
 *
 *   - **Who it actually goes to.** When Hunter's domain-search found an editor rather than the byline, the
 *     recipient is a different person from the author. That is usually the better contact for a link, but
 *     an operator skimming a pitch would otherwise assume it is addressed to the writer.
 *   - **Whether it can still be changed.** A sent pitch is a record of a live conversation. Editing it
 *     would make the archive lie about what the recipient is replying to, so the form locks instead of
 *     silently failing on save.
 */
export function PitchDialog({
  target,
  open,
  onOpenChange,
  onSaved,
}: {
  target: PitchTarget | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved?: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  // Local so the dialog reflects a mark/unmark immediately — the funnel reload behind it
  // replaces the list, but the open dialog still holds the old target object.
  const [noteSent, setNoteSent] = useState<{ at: string; by: string | null } | null>(null);
  const [waNote, setWaNote] = useState("");
  const [savingWa, setSavingWa] = useState(false);
  const [waSent, setWaSent] = useState<{ at: string; by: string | null } | null>(null);
  // The wa.me link is local state too: saving a number mid-dialog must unlock the WhatsApp
  // section immediately, while the stale target object still says there is no number.
  const [waUrl, setWaUrl] = useState<string | null>(null);
  const [waNumber, setWaNumber] = useState("");

  // Reset from the target every time it changes, so reopening on a different prospect never shows the
  // previous one's text — the failure mode that makes someone edit the wrong pitch.
  useEffect(() => {
    setSubject(target?.pitch.subject ?? "");
    setBody(target?.pitch.body ?? "");
    setNote(target?.linkedinNote ?? "");
    setNoteSent(target?.linkedinNoteSentAt ? { at: target.linkedinNoteSentAt, by: target.linkedinNoteSentBy ?? null } : null);
    setWaNote(target?.whatsappNote ?? "");
    setWaSent(target?.whatsappNoteSentAt ? { at: target.whatsappNoteSentAt, by: target.whatsappNoteSentBy ?? null } : null);
    setWaUrl(target?.whatsappUrl ?? null);
    setWaNumber("");
  }, [target]);

  if (!target) return null;
  const { pitch } = target;
  const dirty = subject !== (pitch.subject ?? "") || body !== (pitch.body ?? "");
  const hasNote = target.linkedinNote != null && !!target.workflowId && !!target.authorId;
  const noteDirty = note !== (target.linkedinNote ?? "");
  // Unlike the LinkedIn block (which needs a drafted note), the WhatsApp block unlocks on the
  // NUMBER alone: a number pasted mid-negotiation has no overnight draft yet, and the person
  // standing here with WhatsApp open should not have to wait for one.
  const hasWa = !!waUrl && !!target.workflowId && !!target.authorId;
  const waDirty = waNote !== (target.whatsappNote ?? "");
  // One tap opens their chat with the message already typed. Digits derived from the stored
  // wa.me URL (its only digits are the number's).
  const waChatHref = waUrl
    ? `https://wa.me/${waUrl.replace(/\D+/g, "")}${waNote.trim() ? `?text=${encodeURIComponent(waNote.trim())}` : ""}`
    : null;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/backlinks/pitch/${pitch.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Could not save the pitch.");
        return;
      }
      toast.success("Pitch saved. It will send with your wording.");
      onSaved?.();
      onOpenChange(false);
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  const saveNote = async () => {
    if (!target.workflowId || !target.authorId) return;
    setSavingNote(true);
    try {
      const res = await fetch(`/api/workflows/${target.workflowId}/linkedin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author_id: target.authorId, body: note }),
      });
      if (!res.ok) { toast.error("Could not save the note."); return; }
      toast.success("Note saved.");
      onSaved?.();
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setSavingNote(false);
    }
  };

  const copyNote = async () => {
    try {
      await navigator.clipboard.writeText(note);
      toast.success("Note copied — paste it into the connection request.");
    } catch {
      toast.error("Couldn't copy. Select the text and copy it by hand.");
    }
  };

  // Record (or undo) that the DM actually went out. An edited-but-unsaved note rides along in the
  // same PATCH, so marking never silently discards wording changes.
  const markDmed = async (sent: boolean) => {
    if (!target.workflowId || !target.authorId) return;
    setSavingNote(true);
    try {
      const res = await fetch(`/api/workflows/${target.workflowId}/linkedin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author_id: target.authorId, mark_sent: sent, ...(noteDirty ? { body: note } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data?.error ?? "Could not record it."); return; }
      setNoteSent(sent ? { at: new Date().toISOString(), by: null } : null);
      toast.success(sent ? "Recorded as DM'd — the funnel will show it as Sent." : "Un-marked.");
      onSaved?.();
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setSavingNote(false);
    }
  };

  // The WhatsApp handlers mirror the LinkedIn ones against their own route. Same contract:
  // marking sent carries unsaved wording along, so it never silently discards an edit.
  const patchWhatsapp = async (payload: Record<string, unknown>): Promise<{ ok: boolean; data: any }> => {
    const res = await fetch(`/api/workflows/${target.workflowId}/whatsapp`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author_id: target.authorId, ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  };

  const saveWaNumber = async () => {
    if (!target.workflowId || !target.authorId || !waNumber.trim()) return;
    setSavingWa(true);
    try {
      const { ok, data } = await patchWhatsapp({ number: waNumber });
      if (!ok) { toast.error(data?.error ?? "Could not save the number."); return; }
      setWaUrl(data?.whatsappUrl ?? null);
      setWaNumber("");
      toast.success("Number saved — write the message below and send it from your phone.");
      onSaved?.();
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setSavingWa(false);
    }
  };

  const saveWaNote = async () => {
    if (!target.workflowId || !target.authorId) return;
    setSavingWa(true);
    try {
      const { ok, data } = await patchWhatsapp({ body: waNote });
      if (!ok) { toast.error(data?.error ?? "Could not save the message."); return; }
      toast.success("Message saved.");
      onSaved?.();
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setSavingWa(false);
    }
  };

  const copyWaNote = async () => {
    try {
      await navigator.clipboard.writeText(waNote);
      toast.success("Message copied — paste it into their chat.");
    } catch {
      toast.error("Couldn't copy. Select the text and copy it by hand.");
    }
  };

  const markWaSent = async (sent: boolean) => {
    if (!target.workflowId || !target.authorId) return;
    setSavingWa(true);
    try {
      // A number saved this session may have no message row yet; mark_sent needs one to stamp,
      // so the current wording rides along whenever it's unsaved OR no row exists yet.
      const { ok, data } = await patchWhatsapp({ mark_sent: sent, ...(waDirty || target.whatsappNote == null ? { body: waNote } : {}) });
      if (!ok) { toast.error(data?.error ?? "Could not record it."); return; }
      setWaSent(sent ? { at: new Date().toISOString(), by: null } : null);
      toast.success(sent ? "Recorded as sent — the funnel will show it as Sent." : "Un-marked.");
      onSaved?.();
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setSavingWa(false);
    }
  };

  const recipientLine = target.emailOwner
    ? `${target.emailOwner}${target.emailOwnerPosition ? ` · ${target.emailOwnerPosition}` : ""}`
    : target.author;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 94vw, not 60vw: at 60vw a split-screen window (the reported screenshot was ~760px wide)
          left a ~456px dialog with the subject clipped and the rewrite buttons piled onto the
          Message label. The dialog should give the pitch the whole window before it gives it a
          scrollbar. */}
      <DialogContent className="max-h-[85vh] w-[min(94vw,1000px)] max-w-none overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Pitch to {target.domain}
          </DialogTitle>
          <DialogDescription>
            Written by AI. Read it, change anything, and it sends with your wording.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Who this reaches. Spelled out rather than implied, because the address is not always the
              byline's and a pitch addressed to the wrong person cannot be taken back. */}
          <div className="glass-inset space-y-1 p-3 text-sm">
            <div className="flex items-center gap-2">
              <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">Goes to</span>
              <span className="font-medium">{recipientLine ?? "unknown"}</span>
              {target.email && <span className="text-muted-foreground">· {target.email}</span>}
            </div>
            {target.emailOwner && (
              <p className="text-xs text-warning">
                This address belongs to {target.emailOwner}, not to {target.author ?? "the byline"} who wrote
                the article. Often the better contact for a link, but the pitch is addressed to them, not the
                writer.
              </p>
            )}
            <div className="text-xs text-muted-foreground">
              About{" "}
              <a href={target.prospectUrl} target="_blank" rel="noreferrer" className="underline">
                {target.prospectUrl.replace(/^https?:\/\//, "").slice(0, 70)}
              </a>
            </div>
          </div>

          {!pitch.editable && (
            <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 p-3 text-sm">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>
                Already sent{pitch.sentAt ? ` on ${new Date(pitch.sentAt).toLocaleDateString()}` : ""}, so it
                cannot be edited — this is the record of a live conversation. To follow up, reply on the
                thread from the Inbox.
              </span>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="pitch-subject">Subject</Label>
            <Input
              id="pitch-subject"
              value={subject}
              disabled={!pitch.editable || saving}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            {/* flex-wrap: in a narrow window the rewrite buttons drop to their own line rather
                than covering the label. */}
            <div className="flex flex-wrap items-center justify-between gap-y-1.5">
              <Label htmlFor="pitch-body">Message</Label>
              {/* Proposal only: the rewrite lands in these fields unsaved, and Save (below) is what
                  commits it — recording the person, not the model, as the reviewer. */}
              {pitch.editable && (
                <RewritePopover
                  emailId={pitch.id}
                  current={{ subject, body }}
                  disabled={saving}
                  onProposal={(p) => { setSubject(p.subject); setBody(p.body); }}
                  workflowId={target.workflowId}
                  // The batch cleared those pitches' reviewed stamps — reload so the funnel's
                  // Review buttons tell the truth straight away.
                  onBulkDone={() => onSaved?.()}
                />
              )}
            </div>
            <Textarea
              id="pitch-body"
              value={body}
              disabled={!pitch.editable || saving}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-[320px] font-mono text-xs leading-relaxed"
            />
          </div>

          {/* The DM-ready note for a LinkedIn-only prospect. Separate from the email body above:
              that one is letter-shaped and unclamped, and pasted into a connection request it gets
              cut mid-sentence at 300 characters. Sending stays manual by design — no LinkedIn API. */}
          {hasNote && (
            <div className="space-y-1.5 rounded-xl border border-border p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="pitch-linkedin-note">LinkedIn note</Label>
                <span className={cn("text-xs tabular-nums", note.length > LINKEDIN_NOTE_LIMIT ? "text-destructive" : "text-muted-foreground")}>
                  {note.length}/{LINKEDIN_NOTE_LIMIT}
                </span>
              </div>
              <Textarea
                id="pitch-linkedin-note"
                value={note}
                disabled={savingNote}
                onChange={(e) => setNote(e.target.value)}
                className="min-h-[90px] text-sm"
              />
              <p className="text-xs text-muted-foreground">
                A short connection-request note for their LinkedIn. You send it by hand: copy, open the
                profile, paste. LinkedIn cuts notes at {LINKEDIN_NOTE_LIMIT} characters.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={copyNote} className="gap-1.5">
                  <Copy className="h-3.5 w-3.5" /> Copy note
                </Button>
                {target.linkedinUrl && (
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => window.open(target.linkedinUrl!, "_blank", "noopener,noreferrer")}>
                    <ExternalLink className="h-3.5 w-3.5" /> Open profile
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={saveNote} disabled={savingNote || !noteDirty}>
                  {savingNote && <Loader2 className="h-4 w-4 animate-spin" />}
                  {noteDirty ? "Save note" : "Saved"}
                </Button>
                {/* The one record that this DM ever happened — sending is copy-paste, so only a
                    person can say so. Drives the funnel stage to Sent. */}
                {noteSent ? (
                  <span className="flex items-center gap-1.5 text-xs text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    DM&apos;d {new Date(noteSent.at).toLocaleDateString()}{noteSent.by ? ` by ${noteSent.by.split("@")[0]}` : ""}
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs text-muted-foreground" onClick={() => void markDmed(false)} disabled={savingNote}>
                      Undo
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" onClick={() => void markDmed(true)} disabled={savingNote} className="gap-1.5">
                    {savingNote && <Loader2 className="h-4 w-4 animate-spin" />}
                    Mark as DM&apos;d
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* The WhatsApp route. Same manual-send contract as the LinkedIn note above, one
              difference: it unlocks on the number alone (see hasWa), because numbers usually
              arrive mid-conversation ("WhatsApp me at…"), after the overnight drafts ran. */}
          {hasWa ? (
            <div className="space-y-1.5 rounded-xl border border-border p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="pitch-whatsapp-note">WhatsApp message</Label>
                <span className={cn("text-xs tabular-nums", waNote.length > WHATSAPP_NOTE_LIMIT ? "text-warning" : "text-muted-foreground")}>
                  {waNote.length}/{WHATSAPP_NOTE_LIMIT}
                </span>
              </div>
              <Textarea
                id="pitch-whatsapp-note"
                value={waNote}
                disabled={savingWa}
                onChange={(e) => setWaNote(e.target.value)}
                className="min-h-[90px] text-sm"
              />
              <p className="text-xs text-muted-foreground">
                A chat-sized first message. You send it yourself: “Open chat” opens their WhatsApp
                conversation with this text already typed. Nothing here sends automatically. The
                {" "}{WHATSAPP_NOTE_LIMIT}-character line is taste, not a limit — past it this stops
                reading like a chat message.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={copyWaNote} className="gap-1.5">
                  <Copy className="h-3.5 w-3.5" /> Copy message
                </Button>
                {waChatHref && (
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => window.open(waChatHref, "_blank", "noopener,noreferrer")}>
                    <MessageCircle className="h-3.5 w-3.5" /> Open chat
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={saveWaNote} disabled={savingWa || !waDirty}>
                  {savingWa && <Loader2 className="h-4 w-4 animate-spin" />}
                  {waDirty ? "Save message" : "Saved"}
                </Button>
                {/* The one record that this DM ever happened — sending is from their own phone,
                    so only a person can say so. Drives the funnel stage to Sent. */}
                {waSent ? (
                  <span className="flex items-center gap-1.5 text-xs text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Sent {new Date(waSent.at).toLocaleDateString()}{waSent.by ? ` by ${waSent.by.split("@")[0]}` : ""}
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs text-muted-foreground" onClick={() => void markWaSent(false)} disabled={savingWa}>
                      Undo
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" onClick={() => void markWaSent(true)} disabled={savingWa} className="gap-1.5">
                    {savingWa && <Loader2 className="h-4 w-4 animate-spin" />}
                    Mark as sent
                  </Button>
                )}
              </div>
            </div>
          ) : target.workflowId && target.authorId ? (
            /* No number known. The paste field lives here — not buried in settings — because the
               moment a number appears is mid-thread, with this dialog already open. */
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border p-3">
              <MessageCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Have their WhatsApp? Save the number and a chat-ready message unlocks here.</span>
              <Input
                value={waNumber}
                onChange={(e) => setWaNumber(e.target.value)}
                placeholder="+1 555 010 2030"
                disabled={savingWa}
                className="h-8 w-[180px] text-sm"
              />
              <Button size="sm" variant="outline" onClick={() => void saveWaNumber()} disabled={savingWa || !waNumber.trim()}>
                {savingWa && <Loader2 className="h-4 w-4 animate-spin" />}
                Save number
              </Button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="text-xs">{pitch.status ?? "draft"}</Badge>
            {pitch.editedAt ? (
              <span className="flex items-center gap-1">
                <PenLine className="h-3 w-3" />
                Edited by {pitch.editedBy ?? "someone"} on {new Date(pitch.editedAt).toLocaleDateString()}
              </span>
            ) : (
              <span>Not yet reviewed by a person.</span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {pitch.editable ? "Cancel" : "Close"}
          </Button>
          {pitch.editable && (
            <Button onClick={save} disabled={saving || !dirty}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {dirty ? "Save pitch" : "No changes"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
