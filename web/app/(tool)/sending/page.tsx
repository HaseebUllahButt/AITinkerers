"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Send, Loader2, CheckCircle2, XCircle, Clock, RefreshCw, Play, Globe, Edit2, Ban, Check, CalendarClock, ChevronRight, Trophy, CornerDownRight, ExternalLink, Users, Reply, Filter, X, Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useAuthorDrawer } from "@/components/prospects/useAuthorDrawer";
import { LoadFailed, fetchHonest } from "@/components/ui/load-failed";
import { RewritePopover } from "@/components/outreach/RewritePopover";
import { PageHeader } from "@/components/layout/PageHeader";
import { StatRow, StatTile } from "@/components/ui/stat-tile";
import { SegmentedControl } from "@/components/ui/segmented-control";

const TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "Europe/London", "Europe/Berlin", "Asia/Karachi", "Asia/Dubai", "Asia/Kolkata",
  "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "UTC",
];

const PER_PERSON = 8; // rows shown per sender before "load more"

interface StatusEmail {
  id: string;
  author_id?: string;
  sender_email?: string | null;
  sender_label?: string | null;
  sent_by_email?: string | null;
  author_name: string;
  publication: string;
  recipient?: string | null;
  subject: string;
  status: string;
  kind: string; // initial | followup
  parent_id?: string | null;
  scheduled_at?: string;
  sent_at?: string;
  error?: string;
  replied_at?: string | null;
  bounced_at?: string | null;
  reply_kind?: string | null;   // reply | bounce | auto
  reply_from?: string | null;
  reply_subject?: string | null;
  reply_excerpt?: string | null;
  success_at?: string | null;
  success_link?: string | null;
  success_notes?: string | null;
  tz: string;
  local_label: string | null;
  guess?: boolean;
}

interface Status {
  counts: Record<string, number>;
  roi: { replyRate: number; winRate: number; replyToWin: number };
  serverMailbox?: string | null;
  upcoming: StatusEmail[]; upcomingTotal: number;
  recent: StatusEmail[]; recentTotal: number;
  followups: StatusEmail[]; followupsTotal: number;
  replied: StatusEmail[]; repliedTotal: number;
  wins: StatusEmail[]; winsTotal: number;
}

type Tab = "queued" | "sent" | "replied" | "followups" | "wins";


function sentLabel(iso?: string | null): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}
function dayLabel(iso?: string | null): string {
  if (!iso) return "No date";
  try { return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); }
  catch { return "No date"; }
}
function senderKeyOf(e: StatusEmail): string {
  return e.sender_email ?? (e.status === "sent" ? "__server_fallback__" : "__default__");
}
// A row with no sender_email belongs to NOBODY's mailbox yet — these are cron-drafted pitches, and
// the old "Default account" label read like a shared inbox everyone could find their own work in.
// Name the state instead, so nobody hunts for their queue inside someone else's group.
// EXCEPT a row that already went out: those left via the retired env-SMTP fallback, from the
// shared server mailbox — a real account. Name it, because "not assigned to a sender yet" on a
// SENT email hid whose Gmail the recipient actually saw.
function senderLabelOf(e: StatusEmail, serverMailbox?: string | null): string {
  if (e.sender_label || e.sender_email) return (e.sender_label || e.sender_email) as string;
  if (e.status === "sent") {
    return serverMailbox
      ? `Sent from the shared server mailbox (${serverMailbox})`
      : "Sent from the shared server mailbox";
  }
  return "Not assigned to a sender yet";
}

function SendingContent() {
  const searchParams = useSearchParams();
  const workflowId = searchParams.get("workflow_id");
  const filterLabel = searchParams.get("label");

  const [status, setStatus] = useState<Status | null>(null);
  // Why the last status load failed, if it did. The old empty `catch {}` turned a dead database
  // into a dashboard of zeros ("No emails scheduled") — the queue was never gone, the fetch was.
  // A failure keeps whatever is already on screen; the 5s poll clears this when it next succeeds.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [tab, setTab] = useState<Tab>("queued");
  const [sentFilter, setSentFilter] = useState<"all" | "replied" | "bounced" | "wins" | "followups">("all");

  // Fetch windows (bumped by the per-tab "load older from server" button).
  const [upcomingShown, setUpcomingShown] = useState(200);
  const [recentShown, setRecentShown] = useState(80);
  const [followupsShown, setFollowupsShown] = useState(200);
  const [repliedShown, setRepliedShown] = useState(200);
  const [winsShown, setWinsShown] = useState(200);

  // Two-level grouping UI state (keys are prefixed by tab, e.g. "queued:arooj@…").
  const [collapsedSenders, setCollapsedSenders] = useState<Set<string>>(new Set());
  const [perPersonShown, setPerPersonShown] = useState<Record<string, number>>({});
  function toggleSender(k: string) {
    setCollapsedSenders((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const tzAbbr = now ? new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value : "";

  const [editing, setEditing] = useState<StatusEmail | null>(null);
  const [editForm, setEditForm] = useState({ subject: "", body: "" });
  const [editLoading, setEditLoading] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  const [reschedId, setReschedId] = useState<string | null>(null);
  const [reschedVal, setReschedVal] = useState("");
  const [savingResched, setSavingResched] = useState(false);
  const [sendingNowId, setSendingNowId] = useState<string | null>(null);
  const [togglingFu, setTogglingFu] = useState<string | null>(null);

  // Auto follow-up global kill switch
  const [followupsOn, setFollowupsOn] = useState<boolean | null>(null);
  useEffect(() => { fetch("/api/emails/followups").then((r) => r.ok ? r.json() : null).then((d) => d && setFollowupsOn(d.enabled)).catch(() => {}); }, []);
  async function toggleFollowups(on: boolean) {
    setFollowupsOn(on);
    await fetch("/api/emails/followups", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: on }) }).catch(() => {});
    toast.info(on ? "Auto follow-ups ON — no-reply emails get a threaded nudge scheduled after 2 days." : "Auto follow-ups paused — no new follow-ups will be scheduled.");
  }

  // Auto-send (the send autopilot). Without this control the queue could reach a state nothing in
  // the app could clear: a drafted email sits at status 'ready' with no send time, and ONLY the
  // autopilot turns it into a scheduled send. "Process now" sends what is already scheduled, so
  // with the autopilot paused those emails waited forever with no way to arm them in bulk.
  // null = not loaded yet (never render it as "off", which is a claim we cannot make yet).
  const [autopilot, setAutopilot] = useState<{ enabled: boolean; cap: number } | null>(null);
  const [toppingUp, setToppingUp] = useState(false);
  useEffect(() => {
    fetch("/api/emails/autopilot").then((r) => r.ok ? r.json() : null)
      .then((d) => d && setAutopilot({ enabled: !!d.enabled, cap: Number(d.cap ?? 0) })).catch(() => {});
  }, []);
  async function toggleAutopilot(on: boolean) {
    const prev = autopilot;
    setAutopilot((p) => (p ? { ...p, enabled: on } : p));
    const res = await fetch("/api/emails/autopilot", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: on }) })
      .then((r) => r.json()).catch(() => null);
    if (!res?.ok) { setAutopilot(prev); toast.error("Couldn't change auto-send. Nothing was changed."); return; }
    setAutopilot({ enabled: !!res.enabled, cap: Number(res.cap ?? 0) });
    toast.info(on
      ? `Auto-send ON — each campaign's queue is topped up to ${res.cap}/day and goes out at each recipient's local time.`
      : "Auto-send paused — nothing new gets queued. Emails already scheduled still send.");
  }
  // Arm the waiting drafts now: respects each campaign's daily cap and trust floor (force means
  // "now", not "more" or "worse"), so this can never exceed what auto-send itself would do.
  async function topUpQueue() {
    setToppingUp(true);
    const res = await fetch("/api/emails/autopilot?force=1", { method: "POST" }).then((r) => r.json()).catch(() => null);
    setToppingUp(false);
    if (!res?.ok) { toast.error(res?.error ?? "Couldn't top up the queue."); return; }
    const n = Number(res.result?.scheduled ?? 0);
    const sum = (k: "skippedTrust" | "skippedNoSender") =>
      (res.result?.perWorkflow ?? []).reduce((a: number, w: Record<string, number>) => a + Number(w[k] ?? 0), 0);
    const skippedTrust = sum("skippedTrust");
    const skippedNoSender = sum("skippedNoSender");
    // Armed emails go out as the person who clicked, so a missing app password is the blocker to
    // name first — the alternative was sending from the server identity, out of nobody's Sent box.
    if (res.result?.needsAppPassword) {
      toast.error(res.result.needsAppPassword.reason, { action: { label: "Settings", onClick: () => { window.location.href = "/settings"; } } });
      await load();
      return;
    }
    const tail = [
      skippedTrust ? `${skippedTrust} skipped, address not trusted enough to send` : "",
      skippedNoSender ? `${skippedNoSender} left alone, nobody owns the send yet` : "",
    ].filter(Boolean).join(" · ");
    if (n > 0) toast.success(`Scheduled ${n} email${n === 1 ? "" : "s"}, sending as you${tail ? ` · ${tail}` : ""}.`);
    else if (tail) toast.info(`Nothing scheduled — ${tail}.`);
    // The report does not distinguish "no address" from "already at cap", so don't claim either.
    else toast.info("Nothing new could be scheduled — the rest are missing an address or already at their campaign's daily cap.");
    await load();
  }

  // Success popup
  const [successFor, setSuccessFor] = useState<StatusEmail | null>(null);
  const [successForm, setSuccessForm] = useState({ link: "", notes: "" });
  const [savingSuccess, setSavingSuccess] = useState(false);

  const [sendTz, setSendTz] = useState<string>("");
  const [applyingTz, setApplyingTz] = useState(false);

  const [reading, setReading] = useState<StatusEmail | null>(null);
  const [readContent, setReadContent] = useState<{ subject: string; body: string } | null>(null);
  const { openAuthor, drawer } = useAuthorDrawer();

  async function openReader(e: StatusEmail) {
    setReading(e); setReadContent(null);
    const full = await fetch(`/api/emails/${e.id}`).then((r) => r.ok ? r.json() : null).catch(() => null);
    setReadContent({ subject: full?.subject ?? e.subject ?? "", body: full?.body ?? "" });
  }

  const load = useCallback(async () => {
    const wf = workflowId ? `&workflow_id=${encodeURIComponent(workflowId)}` : "";
    const { data, reason } = await fetchHonest<Status>(`/api/emails/status?recent_limit=${recentShown}&upcoming_limit=${upcomingShown}&followup_limit=${followupsShown}&replied_limit=${repliedShown}&wins_limit=${winsShown}${wf}`);
    if (data) {
      setStatus(data);
      setSendTz((prev) => prev || data.upcoming?.[0]?.tz || data.recent?.[0]?.tz || "");
      setLoadError(null);
    } else {
      setLoadError(reason); // keep the stale status — a failed poll must not zero the dashboard
    }
    setLoading(false);
  }, [recentShown, upcomingShown, followupsShown, repliedShown, winsShown, workflowId]);

  useEffect(() => {
    load();
    timer.current = setInterval(load, 5000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  async function processNow() {
    setProcessing(true);
    try {
      const res = await fetch("/api/emails/process", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        const extra = [data.replies?.repliesFound ? `${data.replies.repliesFound} new replies` : "", data.followups?.scheduled ? `${data.followups.scheduled} follow-ups scheduled` : ""].filter(Boolean).join(", ");
        toast.success(data.skipped ? "A send run is already in progress." : `Processed — ${data.sent} sent of ${data.due} due${extra ? ` · ${extra}` : ""}.`);
      } else toast.error(data.error ?? "Processing failed");
      await load();
    } catch { toast.error("Processing failed"); }
    setProcessing(false);
  }

  async function sendNow(e: StatusEmail) {
    setSendingNowId(e.id);
    const res = await fetch(`/api/emails/${e.id}/send-now`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json()).catch(() => ({ ok: false }));
    setSendingNowId(null);
    if (res.ok) toast.success(`Sent to ${e.author_name} from your Gmail.`);
    else if (res.needsAppPassword) toast.error(res.error ?? "Add your Gmail app password in Settings first.", { action: { label: "Settings", onClick: () => { window.location.href = "/settings"; } } });
    else toast.error(res.error ?? "Send failed.");
    await load();
  }

  async function cancelScheduled(e: StatusEmail) {
    setCancelling(e.id);
    await fetch(`/api/emails/${e.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "ready", scheduled_at: null }) }).catch(() => {});
    setCancelling(null);
    toast.info(`Unscheduled — ${e.author_name} won't be sent until you re-schedule.`);
    await load();
  }

  async function toggleFollowupArmed(e: StatusEmail, armed: boolean) {
    setTogglingFu(e.id);
    const res = await fetch(`/api/emails/${e.id}/followup-toggle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ armed }) }).then((r) => r.json()).catch(() => ({ ok: false }));
    setTogglingFu(null);
    if (res.ok) toast.info(armed ? `Follow-up to ${e.author_name} re-armed — it will send.` : `Follow-up to ${e.author_name} turned off — it won't send.`);
    else toast.error(res.error ?? "Couldn't update follow-up.");
    await load();
  }

  async function openEditor(e: StatusEmail) {
    setEditing(e);
    setEditForm({ subject: e.subject ?? "", body: "" });
    setEditLoading(true);
    const full = await fetch(`/api/emails/${e.id}`).then((r) => r.ok ? r.json() : null).catch(() => null);
    if (full) setEditForm({ subject: full.subject ?? "", body: full.body ?? "" });
    setEditLoading(false);
  }

  function toLocalInput(iso?: string): string {
    const d = iso ? new Date(iso) : new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async function reschedule(id: string, iso: string, note: string) {
    setSavingResched(true);
    const res = await fetch(`/api/emails/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scheduled_at: iso, status: "scheduled" }) }).then((r) => r.json()).catch(() => ({ ok: false }));
    setSavingResched(false);
    // A cron-drafted pitch can't be scheduled until the sender has a Gmail app password, or it
    // would go out from the server identity. Surface that instead of pretending it scheduled.
    if (res?.needsAppPassword) { toast.error(res.error ?? "Add your Gmail app password in Settings to schedule this.", { action: { label: "Settings", onClick: () => { window.location.href = "/settings"; } } }); await load(); return; }
    if (res?.ok === false) { toast.error(res.error ?? "Couldn't schedule."); await load(); return; }
    setReschedId(null); toast.success(note); await load();
  }

  async function saveEdit() {
    if (!editing) return;
    setSavingEdit(true);
    await fetch(`/api/emails/${editing.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editForm) }).catch(() => {});
    setSavingEdit(false); setEditing(null); toast.success("Email updated."); await load();
  }

  function openSuccess(e: StatusEmail) {
    setSuccessFor(e);
    setSuccessForm({ link: e.success_link ?? "", notes: e.success_notes ?? "" });
  }
  async function saveSuccess() {
    if (!successFor) return;
    setSavingSuccess(true);
    await fetch(`/api/emails/${successFor.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success_at: new Date().toISOString(), success_link: successForm.link.trim() || null, success_notes: successForm.notes.trim() || null }),
    }).catch(() => {});
    setSavingSuccess(false); setSuccessFor(null);
    toast.success("Logged as a win — counted in your stats.");
    await load();
  }
  async function clearSuccess(e: StatusEmail) {
    await fetch(`/api/emails/${e.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success_at: null, success_link: null, success_notes: null }) }).catch(() => {});
    toast.info("Removed from wins."); await load();
  }

  async function applyTimezone() {
    if (!sendTz) return;
    setApplyingTz(true);
    try {
      const res = await fetch("/api/emails/reschedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timezone: sendTz }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) toast.success(`Rescheduled ${d.rescheduled ?? 0} queued email${d.rescheduled === 1 ? "" : "s"} to ${sendTz}.`);
      else toast.error(d.error ?? "Reschedule failed");
      await load();
    } catch { toast.error("Reschedule failed"); }
    setApplyingTz(false);
  }

  const c = status?.counts ?? {};
  const scheduled = c.scheduled ?? 0;
  const sent = c.sent ?? 0;
  const replied = c.replied ?? 0;
  const wins = c.success ?? 0;
  const roi = status?.roi ?? { replyRate: 0, winRate: 0, replyToWin: 0 };
  const upcoming = status?.upcoming ?? [];
  const upcomingTotal = status?.upcomingTotal ?? 0;
  // Drafted but with no send time: these are NOT waiting for a send window, nothing will send them
  // until they are armed. Counted from what we fetched, so the copy below says "of the N here".
  const notScheduled = upcoming.filter((e) => !e.scheduled_at).length;
  const recentAll = status?.recent ?? [];
  const recentTotal = status?.recentTotal ?? 0;
  const followupsAll = status?.followups ?? [];
  const followupsTotal = status?.followupsTotal ?? 0;
  const repliedAll = status?.replied ?? [];
  const repliedTotal = status?.repliedTotal ?? 0;
  const winsAll = status?.wins ?? [];
  const winsTotal = status?.winsTotal ?? 0;

  // ── Two-level grouped list: sender ("who sent it") → date, with per-sender load more ──
  function GroupedList({ tabKey, items, dateOf, sortWithin, renderRow, emptyText, fetchedCount, total, onLoadServer }: {
    tabKey: string;
    items: StatusEmail[];
    dateOf: (e: StatusEmail) => string | undefined;
    sortWithin: (a: StatusEmail, b: StatusEmail) => number;
    renderRow: (e: StatusEmail) => React.ReactNode;
    emptyText: string;
    fetchedCount: number;
    total: number;
    onLoadServer: () => void;
  }) {
    if (items.length === 0) return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{emptyText}</p>;

    const bySender = new Map<string, { label: string; emails: StatusEmail[] }>();
    for (const e of items) {
      const k = senderKeyOf(e);
      if (!bySender.has(k)) bySender.set(k, { label: senderLabelOf(e, status?.serverMailbox), emails: [] });
      bySender.get(k)!.emails.push(e);
    }
    const senders = [...bySender.entries()].sort((a, b) => b[1].emails.length - a[1].emails.length || a[1].label.localeCompare(b[1].label));

    return (
      <div>
        {senders.map(([sk, { label, emails }]) => {
          emails.sort(sortWithin);
          const stateKey = `${tabKey}:${sk}`;
          const collapsed = collapsedSenders.has(stateKey);
          const shown = perPersonShown[stateKey] ?? PER_PERSON;
          const slice = emails.slice(0, shown);
          const byDate = new Map<string, StatusEmail[]>();
          for (const e of slice) {
            const dk = dayLabel(dateOf(e));
            if (!byDate.has(dk)) byDate.set(dk, []);
            byDate.get(dk)!.push(e);
          }
          return (
            <div key={sk} className="border-b border-border last:border-b-0">
              <button
                onClick={() => toggleSender(stateKey)}
                className="w-full flex items-center gap-2 px-4 py-2.5 bg-[var(--glass-bar)] backdrop-blur-[24px] border-b border-border text-left hover:bg-muted/50 sticky top-0 z-20 shadow-[0_1px_4px_-1px_rgba(0,0,0,0.4)]"
              >
                <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground/60 transition-transform shrink-0 ${collapsed ? "" : "rotate-90"}`} />
                <Users className="h-3.5 w-3.5 text-highlight-ink shrink-0" />
                <span className="text-sm font-semibold flex-1 truncate">{label}</span>
                <span className="text-xs text-muted-foreground rounded-full bg-muted px-1.5 py-0.5 tabular-nums">{emails.length}</span>
              </button>
              {!collapsed && (
                <div>
                  {[...byDate.entries()].map(([day, dayEmails]) => (
                    <div key={day}>
                      <div className="px-4 py-1.5 pl-9 bg-muted border-b border-border/60 text-xs font-medium text-muted-foreground">
                        {day} <span className="font-normal text-muted-foreground/60">· {dayEmails.length}</span>
                      </div>
                      <div className="divide-y divide-border bg-card">
                        {dayEmails.map((e) => <div key={e.id} className="pl-9 pr-4 bg-card">{renderRow(e)}</div>)}
                      </div>
                    </div>
                  ))}
                  {emails.length > shown && (
                    <button
                      onClick={() => setPerPersonShown((p) => ({ ...p, [stateKey]: shown + PER_PERSON }))}
                      className="w-full py-2 pl-9 text-left text-xs text-highlight-ink hover:bg-muted/30"
                    >
                      Load more from {label} ({emails.length - shown} more)
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {fetchedCount < total && (
          <button onClick={onLoadServer} className="w-full py-2.5 text-xs text-highlight-ink hover:bg-muted/30 border-t border-border">
            Load older from server ({total - fetchedCount} more)
          </button>
        )}
      </div>
    );
  }

  // ── Row renderers ──
  const queuedRow = (e: StatusEmail) => (
    <div className="py-3 group">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium flex items-center gap-1.5 min-w-0">
            <button onClick={() => openAuthor(e.author_id)} className="truncate hover:text-highlight-ink hover:underline text-left">{e.author_name}</button>
            {!e.scheduled_at && <span className="text-xs uppercase tracking-wide text-highlight-ink border border-highlight/40 rounded px-1 shrink-0">draft</span>}
            {e.guess && <span className="text-xs uppercase tracking-wide text-warning border border-warning/40 rounded px-1 shrink-0">guess</span>}
          </p>
          <p className="text-xs text-highlight-ink/90 truncate font-mono">{e.recipient || <span className="text-destructive italic font-sans">no email address</span>}</p>
          <p className="text-xs text-muted-foreground truncate">{e.subject || e.publication}</p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-xs font-medium ${e.scheduled_at ? "text-highlight-ink" : "text-highlight-ink"}`}>{e.scheduled_at ? e.local_label : "Not scheduled"}</p>
          <p className="text-xs text-muted-foreground">{e.tz.split("/").pop()?.replace("_", " ")}</p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button variant="ghost" size="sm" className="h-10 px-2 text-xs text-success hover:text-success" title="Send now" disabled={sendingNowId === e.id} onClick={() => sendNow(e)}>
            {sendingNowId === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Send className="h-3.5 w-3.5 mr-1" />Send</>}
          </Button>
          <Button variant="ghost" size="sm" className="h-10 w-10 p-0" title="Reschedule" onClick={() => { setReschedId(reschedId === e.id ? null : e.id); setReschedVal(toLocalInput(e.scheduled_at)); }}>
            <CalendarClock className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-10 w-10 p-0" title="Edit" onClick={() => openEditor(e)}>
            <Edit2 className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-10 w-10 p-0 text-muted-foreground hover:text-destructive" title="Cancel — remove from queue" disabled={cancelling === e.id} onClick={() => cancelScheduled(e)}>
            {cancelling === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
      {reschedId === e.id && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-muted/30 border border-border p-2">
          <input type="datetime-local" value={reschedVal} onChange={(ev) => setReschedVal(ev.target.value)} className="h-8 rounded-md border border-input bg-background px-2 text-xs" />
          <Button size="sm" className="h-10 text-xs" disabled={savingResched || !reschedVal} onClick={() => reschedule(e.id, new Date(reschedVal).toISOString(), `Rescheduled ${e.author_name}.`)}>
            {savingResched ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save time"}
          </Button>
          <Button size="sm" variant="ghost" className="h-10 text-xs" onClick={() => setReschedId(null)}>Cancel</Button>
          <span className="text-xs text-muted-foreground w-full">Time is in your local zone ({tzAbbr}).</span>
        </div>
      )}
    </div>
  );

  const sentRow = (e: StatusEmail) => (
    <div className="py-3 flex items-center gap-3 group">
      {e.success_at ? <Trophy className="h-4 w-4 text-warning shrink-0" />
        : e.status === "sent" ? <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
        : <XCircle className="h-4 w-4 text-destructive shrink-0" />}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium flex items-center gap-1.5 min-w-0">
          {e.kind === "followup" && <CornerDownRight className="h-3 w-3 text-highlight-ink shrink-0" />}
          <button onClick={() => openAuthor(e.author_id)} className="truncate text-left hover:text-highlight-ink hover:underline">{e.author_name}</button>
          {e.kind === "followup" && <span className="text-xs uppercase tracking-wide text-highlight-ink border border-highlight/40 rounded px-1 shrink-0">follow-up</span>}
          {e.replied_at && <span className="text-xs uppercase tracking-wide text-highlight-ink border border-highlight/40 rounded px-1 shrink-0">replied</span>}
          {e.bounced_at && <span className="text-xs uppercase tracking-wide text-destructive border border-destructive/40 rounded px-1 shrink-0">bounced</span>}
          {e.reply_kind === "auto" && !e.replied_at && !e.bounced_at && <span className="text-xs uppercase tracking-wide text-muted-foreground border border-border rounded px-1 shrink-0">auto-reply</span>}
          {e.success_at && <span className="text-xs uppercase tracking-wide text-warning border border-warning/40 rounded px-1 shrink-0">win</span>}
        </p>
        <p className="text-xs text-muted-foreground truncate">
          {e.status === "failed" ? <span className="text-destructive">{e.error}</span>
            : e.bounced_at ? <span className="text-destructive">{e.reply_subject || "Delivery failed — address not found"}</span>
            : (e.subject || e.publication)}
        </p>
        {e.success_link && <a href={e.success_link} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()} className="text-xs text-warning hover:underline inline-flex items-center gap-1 truncate max-w-full">coverage: {e.success_link.replace(/^https?:\/\/(www\.)?/, "")}<ExternalLink className="h-2.5 w-2.5 shrink-0" /></a>}
        {e.sent_at && <p className="text-xs text-muted-foreground/70 truncate">sent {sentLabel(e.sent_at)}{e.sent_by_email && e.sent_by_email !== e.sender_email ? ` by ${e.sent_by_email}` : ""}</p>}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {e.reply_kind && (
          <Button variant="ghost" size="sm" className={`h-10 px-2 text-xs ${e.bounced_at ? "text-destructive hover:text-destructive" : e.replied_at ? "text-highlight-ink hover:text-highlight-ink" : "text-muted-foreground"}`} title={e.bounced_at ? "Read the bounce notice" : "Read their reply"} onClick={() => openReader(e)}>
            <Reply className="h-3.5 w-3.5 mr-1" />{e.bounced_at ? "Bounce" : e.reply_kind === "auto" ? "Auto" : "Reply"}
          </Button>
        )}
        {e.status === "sent" && !e.bounced_at && (
          e.success_at
            ? <Button variant="ghost" size="sm" className="h-10 px-2 text-xs text-warning" title="Edit / remove win" onClick={() => openSuccess(e)}><Trophy className="h-3.5 w-3.5" /></Button>
            : <Button variant="ghost" size="sm" className="h-10 px-2 text-xs text-muted-foreground hover:text-warning" title="Mark as a win (they covered us)" onClick={() => openSuccess(e)}><Trophy className="h-3.5 w-3.5 mr-1" />Win</Button>
        )}
        {/* A parked row's error says "use Send now" — so the button has to exist here. Goes out
            from the clicking person's own Gmail; the machine-park guards (role address, already
            contacted, replied parent) are re-checked by the send-now route, so a deliberate retry
            can't sneak past them. */}
        {e.status === "failed" && (
          <Button variant="ghost" size="sm" className="h-10 px-2 text-xs text-success hover:text-success" title="Send now — goes out from your own Gmail" disabled={sendingNowId === e.id} onClick={() => sendNow(e)}>
            {sendingNowId === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Send className="h-3.5 w-3.5 mr-1" />Send</>}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-10 px-2 text-xs" title="Read the sent email" onClick={() => openReader(e)}>Read</Button>
      </div>
    </div>
  );

  const followupRow = (e: StatusEmail) => {
    const unsent = e.status !== "sent" && e.status !== "failed";
    const armed = e.status === "scheduled";
    return (
      <div className="py-3 flex items-center gap-3 group">
        {e.status === "sent" ? <CornerDownRight className="h-4 w-4 text-success shrink-0" />
          : e.status === "failed" ? <XCircle className="h-4 w-4 text-destructive shrink-0" />
          : armed ? <Clock className="h-4 w-4 text-highlight-ink shrink-0" />
          : <Ban className="h-4 w-4 text-muted-foreground shrink-0" />}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium flex items-center gap-1.5 min-w-0">
            <button onClick={() => openAuthor(e.author_id)} className="truncate text-left hover:text-highlight-ink hover:underline">{e.author_name}</button>
            {e.replied_at && <span className="text-xs uppercase tracking-wide text-highlight-ink border border-highlight/40 rounded px-1 shrink-0">replied</span>}
          </p>
          <p className="text-xs text-muted-foreground truncate">{e.subject || e.publication}</p>
          <p className="text-xs text-muted-foreground/70 truncate">
            {e.status === "sent" ? `sent ${sentLabel(e.sent_at)}`
              : e.status === "failed" ? <span className="text-destructive">{e.error}</span>
              : armed ? `sends ${e.local_label ?? sentLabel(e.scheduled_at)}`
              : "paused — won't send"}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {unsent && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground mr-1" title={armed ? "On — this follow-up will send. Toggle off to stop it." : "Off — this follow-up won't send. Toggle on to re-arm it."}>
              {togglingFu === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Switch checked={armed} onCheckedChange={(v) => toggleFollowupArmed(e, v)} />}
            </label>
          )}
          {armed && (
            <Button variant="ghost" size="sm" className="h-10 px-2 text-xs text-success hover:text-success" title="Send this follow-up now" disabled={sendingNowId === e.id} onClick={() => sendNow(e)}>
              {sendingNowId === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            </Button>
          )}
          {unsent && <Button variant="ghost" size="sm" className="h-10 w-10 p-0" title="Edit follow-up" onClick={() => openEditor(e)}><Edit2 className="h-3.5 w-3.5" /></Button>}
          <Button variant="ghost" size="sm" className="h-10 px-2 text-xs" title="Read the follow-up" onClick={() => openReader(e)}>Read</Button>
        </div>
      </div>
    );
  };

  // filtered sent list
  const sentFiltered = recentAll.filter((e) =>
    sentFilter === "replied" ? !!e.replied_at
    : sentFilter === "bounced" ? !!e.bounced_at
    : sentFilter === "wins" ? !!e.success_at
    : sentFilter === "followups" ? e.kind === "followup"
    : true);

  const fuSort = (a: StatusEmail, b: StatusEmail) => {
    const au = a.status !== "sent" && a.status !== "failed";
    const bu = b.status !== "sent" && b.status !== "failed";
    if (au !== bu) return au ? -1 : 1;
    if (au) return (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "");
    return (b.sent_at ?? "").localeCompare(a.sent_at ?? "");
  };

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "queued", label: "Queued", count: upcomingTotal },
    { key: "sent", label: "Sent & failed", count: recentTotal },
    { key: "replied", label: "Replied", count: repliedTotal },
    { key: "followups", label: "Follow-ups", count: followupsTotal },
    { key: "wins", label: "Wins", count: winsTotal },
  ];

  return (
    <div className="space-y-6">
      {workflowId && (
        <div className="flex items-center gap-2 rounded-lg border border-highlight/40 bg-highlight-soft px-4 py-2.5 text-sm text-highlight-ink">
          <Filter className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            Showing only <b>{filterLabel || "this campaign"}</b>&apos;s emails.
          </span>
          <Link href="/sending" className="flex items-center gap-1 text-xs text-highlight-ink hover:underline shrink-0">
            <X className="h-3 w-3" /> Show all
          </Link>
        </div>
      )}
      <div className="space-y-4">
        {/* Titled "Status" rather than "Sending" because that is the job it actually does: this is
            the watchtower over every campaign at once — what is queued, what went out, who replied,
            what was won — and the place to override any of it by hand. */}
        <PageHeader
          icon={Activity}
          title="Status"
          description="Everything in flight across all campaigns. Send, reschedule, edit, pause or cancel any email below."
        />
        <div className="flex items-center gap-2 flex-wrap">
          {now && (
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm tabular-nums shrink-0 whitespace-nowrap" title="Your current local time">
              <Clock className="h-3.5 w-3.5 text-highlight-ink shrink-0" />
              <span className="font-medium">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span className="text-xs text-muted-foreground">{tzAbbr}</span>
            </div>
          )}
          <label
            className={`flex items-center gap-1.5 rounded-md border bg-card px-3 h-9 text-xs ${autopilot && !autopilot.enabled && notScheduled > 0 ? "border-warning/50" : "border-border"}`}
            title={autopilot === null ? "Loading…" : autopilot.enabled ? `On — each campaign's queue is topped up to ${autopilot.cap}/day` : "Off — drafted emails stay unscheduled until you arm them"}
          >
            <Switch checked={!!autopilot?.enabled} disabled={autopilot === null} onCheckedChange={toggleAutopilot} />
            Auto-send
          </label>
          {notScheduled > 0 && (
            <Button variant="outline" size="sm" onClick={topUpQueue} disabled={toppingUp} className="gap-1.5"
              title={`Give the ${notScheduled} waiting draft${notScheduled === 1 ? "" : "s"} a send time now, sending from your own Gmail, within each campaign's daily cap${autopilot ? ` (${autopilot.cap}/day)` : ""} and its trust floor`}>
              {toppingUp ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarClock className="h-3.5 w-3.5" />}Top up queue
            </Button>
          )}
          <label className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 h-9 text-xs" title="When on, an unanswered email gets an AI follow-up scheduled in the same thread after 2 days">
            <Switch checked={!!followupsOn} disabled={followupsOn === null} onCheckedChange={toggleFollowups} />
            Auto follow-ups
          </label>
          <div className="flex items-center gap-1.5" title="Reschedule every queued email into this timezone">
            <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={sendTz} onChange={(e) => setSendTz(e.target.value)}>
              {!sendTz && <option value="">Timezone…</option>}
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
            <Button variant="outline" size="sm" onClick={applyTimezone} disabled={applyingTz || !sendTz || scheduled === 0} className="gap-1.5">
              {applyingTz ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}Apply
            </Button>
          </div>
          <Button variant="outline" size="sm" onClick={load} className="h-9 w-9 p-0" title="Refresh" aria-label="Refresh">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" onClick={processNow} disabled={processing} className="gap-1.5" title="Send due emails + check replies + schedule any due follow-ups now">
            {processing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}Process now
          </Button>
        </div>
      </div>

      {/* Above the stats as well as the tabs: the zeros below are exactly what this failure fakes. */}
      {loadError && <LoadFailed nothing="the send queue" detail={loadError} onRetry={() => void load()} />}

      {/* ROI stats — all-time */}
      {/* Ink for counts, one accent for the figure this page exists to move (wins). The old row
          coloured three tiles teal and three amber with no rule behind it, so the colours said nothing. */}
      <StatRow>
        <StatTile label="In pipeline" value={scheduled.toLocaleString()} hint="not yet sent" />
        <StatTile label="Emails sent" value={sent.toLocaleString()} hint="all time" />
        <StatTile label="Replies" value={replied.toLocaleString()} hint="from the mailbox" />
        <StatTile label="Reply rate" value={`${roi.replyRate}%`} hint="replies ÷ sent" />
        <StatTile label="Wins" value={wins.toLocaleString()} hint="coverage secured" tone="accent" />
        <StatTile label="Win rate" value={`${roi.winRate}%`} hint="wins ÷ sent" tone="accent" />
        <StatTile label="Reply→Win" value={`${roi.replyToWin}%`} hint="wins ÷ replies" tone="accent" />
      </StatRow>

      {/* Tabs */}
      <div className="rounded-xl border border-border overflow-hidden bg-card">
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border bg-card">
          <SegmentedControl
            aria-label="Queue view"
            value={tab}
            onChange={(k) => setTab(k)}
            options={tabs.map((t) => ({ value: t.key, label: t.label, count: t.count }))}
          />
          <span className="ml-auto text-xs text-muted-foreground pr-1 flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" /> grouped by sender, then date
          </span>
        </div>

        {tab === "queued" && (
          <>
            {/* The old copy said all of these "are queued for one send time … and go out together in
                a burst", which was false for any row with no send time: those are drafts nothing
                will ever send on its own. Say which is which, and how to arm the waiting ones. */}
            {notScheduled > 0 ? (
              <div className="px-4 py-2 text-xs bg-warning/10 border-b border-warning/30 text-foreground">
                <b>{notScheduled} of these {upcoming.length} have no send time yet</b>, so nothing will send them on its own.
                {autopilot === null
                  ? " "
                  : autopilot.enabled
                    ? ` Auto-send is on (${autopilot.cap}/day per campaign), so it arms them as capacity frees up. `
                    : " Auto-send is off, so they will keep waiting. "}
                Use <b>Top up queue</b> above to give them a time now, or set one on a single email with the clock icon.
                {upcoming.length > notScheduled && ` The other ${upcoming.length - notScheduled} are scheduled and go out at each recipient's local time.`}
              </div>
            ) : upcomingTotal > 0 && (
              <div className="px-4 py-2 text-xs text-muted-foreground bg-highlight-soft border-b border-border">
                All {upcomingTotal} have a send time and go out one at a time, spaced 15-30 minutes apart inside each sender&apos;s window. A queue bigger than one day&apos;s window carries on into the following days.
              </div>
            )}
            <div className="max-h-[560px] overflow-y-auto">
              <GroupedList
                tabKey="queued" items={upcoming} dateOf={(e) => e.scheduled_at}
                sortWithin={(a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "")}
                renderRow={queuedRow} emptyText="No emails scheduled"
                fetchedCount={upcoming.length} total={upcomingTotal} onLoadServer={() => setUpcomingShown((n) => n + 200)}
              />
            </div>
          </>
        )}

        {tab === "sent" && (
          <>
            <div className="px-3 py-2 border-b border-border flex items-center gap-1 text-xs">
              <span className="text-muted-foreground mr-1">Show:</span>
              {([["all", "all"], ["replied", "replied"], ["bounced", "bounced"], ["wins", "wins"], ["followups", "followed up"]] as const).map(([f, label]) => (
                <button key={f} onClick={() => setSentFilter(f)} className={`px-2 py-0.5 rounded-full ${sentFilter === f ? "bg-highlight-soft text-highlight-ink" : "text-muted-foreground hover:bg-muted/40"}`}>{label}</button>
              ))}
              <span className="ml-auto text-muted-foreground/60">Pending follow-ups live in the Follow-ups tab.</span>
            </div>
            <div className="max-h-[560px] overflow-y-auto">
              <GroupedList
                tabKey="sent" items={sentFiltered} dateOf={(e) => e.sent_at}
                sortWithin={(a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? "")}
                renderRow={sentRow} emptyText="Nothing here yet"
                fetchedCount={recentAll.length} total={recentTotal} onLoadServer={() => setRecentShown((n) => n + 80)}
              />
            </div>
          </>
        )}

        {tab === "replied" && (
          <>
            <div className="px-4 py-2 text-xs text-muted-foreground bg-highlight-soft border-b border-border">
              Genuine human replies only — bounces (&ldquo;address not found&rdquo;) and auto-replies are excluded and shown under Sent &amp; failed. Click <span className="text-highlight-ink">Reply</span> to read what they said.
            </div>
            <div className="max-h-[560px] overflow-y-auto">
              <GroupedList
                tabKey="replied" items={repliedAll} dateOf={(e) => e.replied_at ?? undefined}
                sortWithin={(a, b) => (b.replied_at ?? "").localeCompare(a.replied_at ?? "")}
                renderRow={sentRow} emptyText="No replies yet"
                fetchedCount={repliedAll.length} total={repliedTotal} onLoadServer={() => setRepliedShown((n) => n + 200)}
              />
            </div>
          </>
        )}

        {tab === "followups" && (
          <>
            <div className="px-4 py-2 text-xs text-muted-foreground bg-highlight-soft border-b border-border">
              One follow-up per recipient, sent as a reply in the original thread. Each has a send date and its own on/off switch — turn any off before it sends. The header toggle pauses all new follow-ups.
            </div>
            <div className="max-h-[560px] overflow-y-auto">
              <GroupedList
                tabKey="followups" items={followupsAll} dateOf={(e) => e.scheduled_at ?? e.sent_at}
                sortWithin={fuSort} renderRow={followupRow} emptyText="No follow-ups yet — they're scheduled automatically 2 days after an unanswered send."
                fetchedCount={followupsAll.length} total={followupsTotal} onLoadServer={() => setFollowupsShown((n) => n + 200)}
              />
            </div>
          </>
        )}

        {tab === "wins" && (
          <>
            <div className="px-4 py-2 text-xs text-muted-foreground bg-warning/5 border-b border-border">
              Coverage secured — sends you marked as a win. Use the win button to edit the coverage link or notes.
            </div>
            <div className="max-h-[560px] overflow-y-auto">
              <GroupedList
                tabKey="wins" items={winsAll} dateOf={(e) => e.success_at ?? undefined}
                sortWithin={(a, b) => (b.success_at ?? "").localeCompare(a.success_at ?? "")}
                renderRow={sentRow} emptyText="No wins logged yet — mark a reply as a win with the win button."
                fetchedCount={winsAll.length} total={winsTotal} onLoadServer={() => setWinsShown((n) => n + 200)}
              />
            </div>
          </>
        )}
      </div>

      {/* Edit sheet */}
      <Sheet open={!!editing} onOpenChange={(v) => { if (!v) setEditing(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col p-0 gap-0 overflow-hidden">
          <SheetHeader className="px-6 py-4 border-b border-border shrink-0">
            <SheetTitle>{editing?.kind === "followup" ? "Edit follow-up" : "Edit queued email"}</SheetTitle>
            {editing && <p className="text-sm text-muted-foreground">{editing.author_name} · {editing.local_label ? `sends ${editing.local_label} (${editing.tz.split("/").pop()?.replace("_", " ")})` : "not scheduled"}</p>}
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {editLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div> : (
              <>
                <div className="space-y-1.5"><Label>Subject</Label><Input value={editForm.subject} onChange={(e) => setEditForm((f) => ({ ...f, subject: e.target.value }))} /></div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>Body</Label>
                    {editing && (
                      <RewritePopover emailId={editing.id} current={editForm} disabled={savingEdit} onProposal={(p) => setEditForm(p)} />
                    )}
                  </div>
                  <Textarea className="min-h-[320px] font-mono text-sm" value={editForm.body} onChange={(e) => setEditForm((f) => ({ ...f, body: e.target.value }))} />
                </div>
              </>
            )}
          </div>
          <div className="px-6 py-4 border-t border-border flex justify-end gap-2 shrink-0">
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={saveEdit} disabled={savingEdit || editLoading}>{savingEdit && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}<Check className="h-4 w-4 mr-1.5" />Save</Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Read sheet */}
      <Sheet open={!!reading} onOpenChange={(v) => { if (!v) setReading(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col p-0 gap-0 overflow-hidden">
          <SheetHeader className="px-6 py-4 border-b border-border shrink-0">
            <SheetTitle>{reading?.kind === "followup" ? "Follow-up email" : "Sent email"}</SheetTitle>
            {reading && <p className="text-sm text-muted-foreground">{reading.author_name}{reading.sent_at ? ` · sent ${sentLabel(reading.sent_at)}` : reading.scheduled_at ? ` · sends ${reading.local_label ?? sentLabel(reading.scheduled_at)}` : ""}</p>}
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {reading?.reply_kind && (
              <div className={`rounded-md border p-3 space-y-1.5 ${reading.bounced_at ? "border-destructive/40 bg-destructive/5" : reading.replied_at ? "border-highlight/40 bg-highlight-soft" : "border-border bg-muted/20"}`}>
                <p className={`text-xs font-semibold uppercase tracking-widest ${reading.bounced_at ? "text-destructive" : reading.replied_at ? "text-highlight-ink" : "text-muted-foreground"}`}>
                  {reading.bounced_at ? "Bounce notice — address didn't accept mail" : reading.reply_kind === "auto" ? "Automatic reply (not counted as a reply)" : "Their reply"}
                </p>
                {reading.reply_from && <p className="text-xs text-muted-foreground">from {reading.reply_from}</p>}
                {reading.reply_subject && <p className="text-sm font-medium">{reading.reply_subject}</p>}
                {reading.reply_excerpt && <div className="text-sm whitespace-pre-wrap leading-relaxed pt-1 text-foreground/90">{reading.reply_excerpt}</div>}
              </div>
            )}
            {!readContent ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div> : (
              <>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Your sent email</p>
                <div><p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1">Subject</p><p className="text-sm font-medium">{readContent.subject || <span className="text-muted-foreground italic">(none)</span>}</p></div>
                <div><p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1">Body</p><div className="text-sm whitespace-pre-wrap leading-relaxed rounded-md border border-border bg-muted/20 p-3">{readContent.body || <span className="text-muted-foreground italic">(empty)</span>}</div></div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Success popup */}
      <Dialog open={!!successFor} onOpenChange={(v) => { if (!v) setSuccessFor(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Trophy className="h-4 w-4 text-warning" />Mark as a win</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1 text-sm">
            <p className="text-muted-foreground">{successFor?.author_name} covered us. Log where, so it counts toward your win rate.</p>
            <div className="space-y-1.5"><Label>Coverage link</Label><Input placeholder="https://… where they wrote about us" value={successForm.link} onChange={(e) => setSuccessForm((f) => ({ ...f, link: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label>Notes <span className="text-muted-foreground font-normal">(optional)</span></Label><Textarea className="min-h-[70px]" placeholder="e.g. included in their roundup, front page, etc." value={successForm.notes} onChange={(e) => setSuccessForm((f) => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <DialogFooter>
            {successFor?.success_at && <Button variant="ghost" className="text-destructive mr-auto" onClick={() => { const e = successFor; setSuccessFor(null); if (e) clearSuccess(e); }}>Remove win</Button>}
            <Button variant="outline" onClick={() => setSuccessFor(null)}>Cancel</Button>
            <Button onClick={saveSuccess} disabled={savingSuccess} className="bg-warning hover:bg-warning text-white">{savingSuccess && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Save win</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {drawer}
    </div>
  );
}

export default function SendingPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <SendingContent />
    </Suspense>
  );
}
