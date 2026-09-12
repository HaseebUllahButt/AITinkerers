"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Loader2, Bot, BookOpen, Sparkles, RefreshCw, ShieldAlert, ChevronDown, ChevronRight, Send, Trash2, Play, Mail, Paperclip, UserRound } from "lucide-react";
import { toast } from "sonner";
import { LoadFailed, fetchHonest } from "@/components/ui/load-failed";
import { PageHeader } from "@/components/layout/PageHeader";
import { SegmentedControl } from "@/components/ui/segmented-control";

interface Thread {
  id: string; authorId: string; name: string; publication: string; host: string;
  dr: number | null; ceiling: number | null; category: string; status: string | null;
  replyKind: string | null; sentiment: string | null; negotiationStatus: string | null;
  aiManaged: boolean; subject: string; replyExcerpt: string | null;
  draftStatus: string | null; draftBody: string | null;
  repliedAt: string | null; sentAt: string | null; bouncedAt: string | null; sender: string | null;
  replyFrom: string | null;
  interventionType: string | null; interventionReason: string | null; interventionAsk: string | null;
  interventionAssistInput: string | null; interventionAssetName: string | null;
  stage: string | null;
  exchangeOffer: { current?: { url?: string | null; slug?: string | null; target_url?: string | null } | null } | null;
  worthiness: { score: number; band: string; hardNo: string | null } | null;
  // Unanswered-reply SLA (null/false when this thread is not waiting on us).
  ageHours: number | null; overSla: boolean; owner: "ai" | "human" | "nobody" | null; priced: boolean;
}
interface Msg { from: "us" | "them"; body: string; at: string | null }
interface Act { actor: string; action: string; detail: string | null; created_at: string }

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}

const CATS = [
  { key: "queued", label: "Queued" },
  { key: "needs_reply", label: "Needs reply" },
  { key: "needs_human", label: "Human intervention" },
  { key: "negotiating", label: "Negotiating" },
  { key: "agreed", label: "Agreed" },
  { key: "hard_no", label: "Hard no" },
  { key: "not_worth_it", label: "Not worth it" },
  { key: "automated", label: "Automated" },
  { key: "bounced", label: "Bounced" },
];

// What to ask the human for on the Assist path, per intervention type.
const ASSIST_FIELD: Record<string, { label: string; placeholder: string; kind: "text" | "url" | "email"; allowUpload?: boolean }> = {
  asset_request: { label: "Paste a link to the document, or upload it below", placeholder: "https://link-to-your-one-pager.pdf", kind: "url", allowUpload: true },
  identity_verification: { label: "Website / LinkedIn / registration or references", placeholder: "https://imagine.art  ·  linkedin.com/in/...", kind: "text" },
  scheduling: { label: "Your availability (with timezone) or a booking link", placeholder: "Tue/Wed 2-5pm PT, or https://cal.com/you", kind: "text" },
  redirect: { label: "Correct contact email to redirect this thread to", placeholder: "editor@publication.com", kind: "email" },
  payment_details: { label: "Invoice link / PO / billing detail to send", placeholder: "https://invoice-link  or  PO #12345", kind: "text", allowUpload: true },
  factual_question: { label: "The factual answer to send (in your words)", placeholder: "do-follow, permanent, ~5 day turnaround", kind: "text" },
  over_policy: { label: "Approved terms / higher budget, or a note", placeholder: "OK up to $600, no retainer", kind: "text" },
  complex_negotiation: { label: "How should we respond? (which of our pages/anchor to offer, or approve their ask)", placeholder: "Offer /blogs/best-ai-video-generators instead · or 'go with their option 2'", kind: "text" },
  link_exchange_failed: { label: "They declined the swap. Approve a paid offer + budget, or note to decline", placeholder: "OK up to $150 for a do-follow, else pass", kind: "text" },
  worthiness_review: { label: "Borderline site — say how to proceed (assisting marks it worth pursuing)", placeholder: "Worth it, relevance is strong · offer the swap as usual", kind: "text" },
  other: { label: "What should the AI say? (or upload a document)", placeholder: "Provide the info the AI should include", kind: "text", allowUpload: true },
};

// Short label for the ladder stage a thread is at, shown as a badge.
const STAGE_LABEL: Record<string, string> = {
  link_exchange: "Link exchange",
  link_exchange_push: "Exchange · pushing",
  money: "Money",
  done: "Closed",
};

// Worthiness band → badge styling (the §6 quality-bar verdict).
const WORTH_BAND: Record<string, string> = {
  green: "text-success border-success/40 bg-success/15",
  amber: "text-warning border-warning/40 bg-warning/10",
  red: "text-destructive border-destructive/40 bg-destructive/10",
};
function assistField(type: string | null) { return ASSIST_FIELD[type ?? "other"] ?? ASSIST_FIELD.other; }
const SENTIMENT: Record<string, string> = {
  positive: "text-success border-success/40 bg-success/15",
  negative: "text-destructive border-destructive/40 bg-destructive/10",
  neutral: "text-muted-foreground",
};

export default function NegotiationPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  // null = not known (never loaded, or the load failed). Defaulting to false claimed "Autonomy
  // OFF" about a setting we never read — unknown must render as unknown, not as a value.
  const [autonomy, setAutonomy] = useState<boolean | null>(null);
  const [currency, setCurrency] = useState("USD");
  // A failed load must not read as empty buckets — the threads are not gone, the fetch failed.
  // Failure keeps whatever is already shown; the next good load clears this.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState("queued");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [priceOpen, setPriceOpen] = useState(false);
  const [useDefaults, setUseDefaults] = useState(true);
  const [priceForm, setPriceForm] = useState({ max_offer: "", criteria: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [collapsedSenders, setCollapsedSenders] = useState<Set<string>>(new Set());
  const [convo, setConvo] = useState<Record<string, Msg[]>>({});
  const [activity, setActivity] = useState<Record<string, Act[]>>({}); // who-did-what audit per thread
  const [editBody, setEditBody] = useState<Record<string, string>>({});
  const [processing, setProcessing] = useState(false);
  const [senderFilter, setSenderFilter] = useState(""); // "" = all senders; else filter to one sending account
  const [assistText, setAssistText] = useState<Record<string, string>>({}); // per-thread assist input
  const [assetName, setAssetName] = useState<Record<string, string>>({});    // staged upload filename

  const load = useCallback(async () => {
    const { data, reason } = await fetchHonest<{ threads?: Thread[]; autonomy?: boolean; currency?: string }>("/api/negotiation/threads");
    if (data) {
      setThreads(data.threads ?? []); setAutonomy(!!data.autonomy); setCurrency(data.currency ?? "USD");
      setLoadError(null);
    } else setLoadError(reason);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // How many rows each sender group shows. 457 threads rendered at once made a 21,000px page with
  // 1,300 badges; a group opens on its first page and grows by a page per click.
  const GROUP_PAGE = 25;
  const [groupShown, setGroupShown] = useState<Record<string, number>>({});

  const rows = threads.filter((t) => t.category === tab && (!senderFilter || t.sender === senderFilter));
  // Distinct sending accounts across all threads — powers the "sent from" searchable filter.
  // One option per sending account, with a count of how many threads that sender has IN THE CURRENT
  // TAB (e.g. how many "Negotiating" each teammate has) shown beside their name.
  const senderOptions = [...new Set(threads.map((t) => t.sender).filter(Boolean))].sort().map((s) => ({
    id: s as string,
    label: s as string,
    hint: threads.filter((t) => t.category === tab && t.sender === s).length,
  }));
  const dateOf = (t: Thread) => t.repliedAt ?? t.bouncedAt ?? t.sentAt ?? null;
  // Group the current tab's threads by the account they were sent from (mirrors the Sending page),
  // newest activity first within each account and across accounts.
  const senderGroups = (() => {
    const m = new Map<string, { key: string; label: string; items: Thread[] }>();
    for (const t of rows) {
      const key = t.sender || "__default__";
      const label = t.sender || "Default account";
      if (!m.has(key)) m.set(key, { key, label, items: [] });
      m.get(key)!.items.push(t);
    }
    const groups = [...m.values()];
    // Needs reply is a queue, not a feed: the person who has waited longest (and anyone with a
    // price on the table) comes first. Every other tab stays newest-first.
    const byWait = (a: Thread, b: Thread) => Number(b.priced) - Number(a.priced) || (b.ageHours ?? 0) - (a.ageHours ?? 0);
    for (const g of groups) g.items.sort(tab === "needs_reply" ? byWait : (a, b) => (dateOf(b) ?? "").localeCompare(dateOf(a) ?? ""));
    groups.sort((a, b) => (dateOf(b.items[0]) ?? "").localeCompare(dateOf(a.items[0]) ?? ""));
    return groups;
  })();
  const toggleSender = (key: string) => setCollapsedSenders((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const countFor = (k: string) => threads.filter((t) => t.category === k).length;
  const toggle = (id: string) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAllVisible = () => setSel(new Set(rows.map((r) => r.id)));
  const clearSel = () => setSel(new Set());

  const expand = async (t: Thread) => {
    if (open === t.id) { setOpen(null); return; }
    setOpen(t.id);
    if (!convo[t.id]) {
      const d = await fetch(`/api/negotiation/${t.id}`).then((r) => r.json()).catch(() => ({ conversation: [], draft: null, activity: [] }));
      setConvo((c) => ({ ...c, [t.id]: d.conversation ?? [] }));
      setActivity((a) => ({ ...a, [t.id]: d.activity ?? [] }));
      if (d.draft?.body && editBody[t.id] === undefined) setEditBody((e) => ({ ...e, [t.id]: d.draft.body }));
    }
    if (t.draftBody && editBody[t.id] === undefined) setEditBody((e) => ({ ...e, [t.id]: t.draftBody as string }));
  };

  // The reply was answered outside the app (straight from Gmail). Recording it is what takes the
  // thread out of Needs reply — and out of the digest's unanswered list — honestly.
  const markAnswered = async (t: Thread) => {
    setBusy(t.id);
    const r = await fetch(`/api/negotiation/${t.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "mark_answered" }) })
      .then((x) => x.json()).catch((e) => ({ error: e?.message }));
    setBusy(null);
    if (r?.error) { toast.error(r.error); return; }
    toast.success("Marked as answered");
    await load();
  };

  const applyAI = async (managed: boolean) => {
    const ids = [...sel];
    if (ids.length === 0) return;
    setBusy("bulk");
    try {
      const payload: any = { ids, managed };
      if (managed && !useDefaults) {
        if (priceForm.max_offer !== "") payload.max_offer = Number(priceForm.max_offer);
        if (priceForm.criteria) payload.criteria = priceForm.criteria;
      }
      await fetch("/api/emails/ai-manage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      toast.success(managed ? `AI negotiation enabled for ${ids.length}${useDefaults ? " (Handbook defaults)" : ""}` : `AI turned off for ${ids.length}`);
      setPriceOpen(false); setPriceForm({ max_offer: "", criteria: "" }); clearSel(); load();
    } catch (e: any) { toast.error(e?.message ?? "failed"); } finally { setBusy(null); }
  };

  // Generate the AI reply. Autonomy ON => sends immediately. OFF => saves a draft and opens it.
  const draft = async (t: Thread) => {
    setBusy(t.id);
    try {
      const r = await fetch("/api/negotiation/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emailId: t.id }) }).then((x) => x.json());
      if (r.error) { toast.error(r.error); return; }
      if (r.sent) toast.success(`AI replied and sent (${r.statusHint}${r.suggestedOffer ? ", offer " + currency + " " + r.suggestedOffer : ""})`);
      else if (r.sendError) toast.error(`AI drafted but send failed: ${r.sendError}`);
      else if (r.recipientMissing) toast.error("No recipient email on file, saved as draft");
      else toast.success("Draft ready — review and send below");
      setEditBody((e) => ({ ...e, [t.id]: r.body }));
      setConvo((c) => { const n = { ...c }; delete n[t.id]; return n; }); // force reload of conversation
      setOpen(t.id);
      await load();
      if (open === t.id || !r.sent) { const d = await fetch(`/api/negotiation/${t.id}`).then((x) => x.json()).catch(() => ({ conversation: [] })); setConvo((c) => ({ ...c, [t.id]: d.conversation ?? [] })); }
    } catch (e: any) { toast.error(e?.message ?? "failed"); } finally { setBusy(null); }
  };

  // Process now: check for new replies over IMAP and (if autonomy is on) auto-negotiate them,
  // same as the Sending page's button — so you don't have to leave this page to make it run.
  const processNow = async () => {
    setProcessing(true);
    try {
      const r = await fetch("/api/emails/process", { method: "POST" }).then((x) => x.json());
      const rep = r?.replies?.repliesFound ?? 0;
      const neg = r?.negotiations;
      const negTxt = neg && (neg.sent || neg.drafted) ? ` · AI: ${neg.sent} sent, ${neg.drafted} drafted` : "";
      toast.success(`Checked replies (${rep} new)${negTxt}`);
      load();
    } catch { toast.error("Process failed"); } finally { setProcessing(false); }
  };

  // Human intervention — Assist: send the human-provided input (+ any uploaded doc), get a truthful
  // draft back, and drop it into the editable draft box for review/send.
  const assist = async (t: Thread) => {
    setBusy(t.id);
    try {
      const r = await fetch(`/api/negotiation/${t.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "assist", assistInput: assistText[t.id] ?? "" }),
      }).then((x) => x.json());
      if (r.error) { toast.error(r.error); return; }
      // Force the conversation to refetch and show the new truthful draft for review.
      setConvo((c) => { const n = { ...c }; delete n[t.id]; return n; });
      if (r.draft) setEditBody((e) => ({ ...e, [t.id]: r.draft }));
      toast.success("Draft ready, review and send below.");
    } catch (e: any) { toast.error(e?.message ?? "failed"); } finally { setBusy(null); }
  };

  // Human intervention — Handoff: take the thread out of AI management (a person handles it).
  const handoff = async (t: Thread) => {
    setBusy(t.id);
    try {
      const r = await fetch(`/api/negotiation/${t.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "handoff" }) }).then((x) => x.json());
      if (r.error) toast.error(r.error);
      else { toast.success("Handed off, removed from AI. Reply from your own inbox."); setOpen(null); load(); }
    } catch (e: any) { toast.error(e?.message ?? "failed"); } finally { setBusy(null); }
  };

  const uploadAsset = async (t: Thread, file: File) => {
    setBusy(t.id);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch(`/api/negotiation/${t.id}/asset`, { method: "POST", body: fd }).then((x) => x.json());
      if (r.error) toast.error(r.error);
      else { setAssetName((s) => ({ ...s, [t.id]: r.name })); toast.success(`Attached ${r.name}`); }
    } catch (e: any) { toast.error(e?.message ?? "upload failed"); } finally { setBusy(null); }
  };

  const sendOrDiscard = async (t: Thread, action: "send" | "discard") => {
    setBusy(t.id);
    try {
      const r = await fetch(`/api/negotiation/${t.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, body: editBody[t.id] }) }).then((x) => x.json());
      if (r.error) toast.error(r.error);
      else if (action === "send") { toast.success(`Sent to ${r.to}`); setOpen(null); }
      else toast.success("Draft discarded");
      // Clear the editable draft + cached conversation for this thread so a sent/discarded reply
      // can't linger as a re-sendable textarea (the sent copy now lives only in the conversation).
      if (!r.error) {
        setEditBody((s) => { const n = { ...s }; delete n[t.id]; return n; });
        setConvo((c) => { const n = { ...c }; delete n[t.id]; return n; });
      }
      load();
    } catch (e: any) { toast.error(e?.message ?? "failed"); } finally { setBusy(null); }
  };

  const renderThread = (t: Thread) => (
    <div key={t.id}>
      <div className="flex items-start gap-3 p-3">
        <Checkbox checked={sel.has(t.id)} onCheckedChange={() => toggle(t.id)} className="mt-1" />
        <button onClick={() => expand(t)} className="text-muted-foreground hover:text-foreground mt-0.5 shrink-0">
          {open === t.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="flex-1 min-w-0 space-y-1 cursor-pointer" onClick={() => expand(t)}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{t.name}</span>
            <span className="text-xs text-muted-foreground">{t.publication}</span>
            {t.dr != null && <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4">DR {Math.round(t.dr)}</Badge>}
            <Badge variant="outline" className="text-xs px-1.5 py-0 h-4">{t.ceiling != null ? `≤ ${currency} ${t.ceiling}` : "placement-only"}</Badge>
            {t.aiManaged && <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 text-highlight-ink border-highlight/40 bg-highlight-soft"><Bot className="h-2.5 w-2.5 mr-0.5" />AI</Badge>}
            {t.stage && STAGE_LABEL[t.stage] && <Badge variant="outline" className="text-xs px-1.5 py-0 h-4">{STAGE_LABEL[t.stage]}</Badge>}
            {t.worthiness && <Badge variant="outline" className={`text-xs px-1.5 py-0 h-4 ${WORTH_BAND[t.worthiness.band] ?? ""}`}>worth {Math.round(t.worthiness.score)}</Badge>}
            {t.sentiment && <Badge variant="outline" className={`text-xs px-1.5 py-0 h-4 ${SENTIMENT[t.sentiment] ?? ""}`}>{t.sentiment}</Badge>}
            {t.draftStatus && <Badge variant="outline" className="text-xs px-1.5 py-0 h-4">{t.draftStatus === "sent" ? "AI replied" : t.draftStatus === "failed" ? "send failed" : "AI draft ready"}</Badge>}
            {t.ageHours != null && (
              <Badge variant="outline" className={`text-xs px-1.5 py-0 h-4 ${t.overSla ? "text-warning border-warning/40 bg-warning/10" : ""}`} title={t.overSla ? "Past the reply SLA" : "Inside the reply SLA"}>
                {t.ageHours < 48 ? `${t.ageHours}h` : `${Math.floor(t.ageHours / 24)}d`} unanswered{t.priced ? " · priced" : ""}
              </Badge>
            )}
            {t.ageHours != null && t.owner === "nobody" && <Badge variant="outline" className="text-xs px-1.5 py-0 h-4" title="This thread was not scheduled with AI replies on, so the AI drafts but never sends here">draft only, no AI send</Badge>}
            {dateOf(t) && <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">{fmtDate(dateOf(t))}</span>}
          </div>
          {t.replyExcerpt && <p className="text-xs text-muted-foreground line-clamp-2 break-words">&ldquo;{t.replyExcerpt.slice(0, 240)}&rdquo;</p>}
          {t.exchangeOffer?.current?.url && <p className="text-xs text-muted-foreground break-words">Offered: <span className="font-mono">/blogs/{t.exchangeOffer.current.slug}</span>{t.exchangeOffer.current.target_url ? ` ↔ link to ${t.exchangeOffer.current.target_url}` : ""}</p>}
        </div>
        {(t.category === "needs_reply" || t.category === "negotiating") && (
          <Button size="sm" variant="outline" disabled={busy === t.id} onClick={() => draft(t)} className="shrink-0">
            {busy === t.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Sparkles className="h-4 w-4 mr-1.5" />{t.draftBody ? "Regenerate" : autonomy ? "AI reply" : "Draft AI reply"}</>}
          </Button>
        )}
        {t.category === "needs_reply" && (
          <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => markAnswered(t)} className="shrink-0" title="You answered this from Gmail — record it so it leaves Needs reply">
            Mark answered
          </Button>
        )}
        {t.category === "queued" && (
          <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
            {t.status === "sent" ? "Sent · awaiting reply" : t.status === "scheduled" ? "Queued to send" : (t.status ?? "queued")}
          </span>
        )}
      </div>

      {open === t.id && (
        <div className="px-4 pb-4 pl-11 space-y-3 bg-muted/20">
          <div className="pt-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Conversation</p>
            {(convo[t.id] ?? []).length === 0 ? <p className="text-xs text-muted-foreground">Loading…</p> : (convo[t.id] ?? []).map((m, i) => (
              <div key={i} className={`text-xs rounded-lg p-2 mb-1.5 max-w-[85%] whitespace-pre-wrap break-words ${m.from === "us" ? "bg-highlight-soft ml-auto" : "bg-muted"}`}>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-0.5">{m.from === "us" ? "Us" : t.name}</div>{m.body}
              </div>
            ))}
          </div>
          {t.category === "needs_human" ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 space-y-1">
                <div className="flex items-center gap-1.5">
                  <ShieldAlert className="h-3.5 w-3.5 text-warning" />
                  <span className="text-xs uppercase tracking-wide text-warning">Needs a human{t.interventionType ? ` · ${t.interventionType.replace(/_/g, " ")}` : ""}</span>
                </div>
                {t.interventionAsk && <p className="text-sm"><span className="text-muted-foreground">They asked: </span>{t.interventionAsk}</p>}
                {t.interventionReason && <p className="text-xs text-muted-foreground">{t.interventionReason}</p>}
              </div>
              {editBody[t.id] !== undefined ? (
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">AI draft reply (truthful, edit before sending)</p>
                  <Textarea rows={7} value={editBody[t.id]} onChange={(e) => setEditBody((s) => ({ ...s, [t.id]: e.target.value }))} className="text-sm" />
                  <div className="flex gap-2">
                    <Button size="sm" className="bg-primary hover:bg-primary text-primary-foreground" disabled={busy === t.id} onClick={() => sendOrDiscard(t, "send")}><Send className="h-4 w-4 mr-1" />Send reply{t.interventionAssetName ? " + doc" : ""}</Button>
                    <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => setEditBody((s) => { const n = { ...s }; delete n[t.id]; return n; })}>Back</Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Give the AI what it needs, then it replies</p>
                  <label className="text-xs text-muted-foreground block">{assistField(t.interventionType).label}</label>
                  <input
                    type={assistField(t.interventionType).kind}
                    placeholder={assistField(t.interventionType).placeholder}
                    value={assistText[t.id] ?? (t.interventionAssistInput ?? "")}
                    onChange={(e) => setAssistText((s) => ({ ...s, [t.id]: e.target.value }))}
                    className="w-full h-9 rounded-md border border-input bg-background px-2.5 text-sm"
                  />
                  {assistField(t.interventionType).allowUpload && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <label className="text-xs cursor-pointer inline-flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1.5 hover:bg-muted/40">
                        <Paperclip className="h-3.5 w-3.5" />{(assetName[t.id] || t.interventionAssetName) ? "Replace document" : "Upload document"}
                        <input type="file" className="hidden" disabled={busy === t.id} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAsset(t, f); }} />
                      </label>
                      {(assetName[t.id] || t.interventionAssetName) && <span className="text-xs text-success">{assetName[t.id] || t.interventionAssetName} attached</span>}
                    </div>
                  )}
                  <div className="flex gap-2 pt-1 flex-wrap">
                    <Button size="sm" disabled={busy === t.id} onClick={() => assist(t)}>{busy === t.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Sparkles className="h-4 w-4 mr-1" />Assist &amp; draft reply</>}</Button>
                    <Button size="sm" variant="outline" disabled={busy === t.id} onClick={() => handoff(t)}><UserRound className="h-4 w-4 mr-1" />I&apos;ll handle it</Button>
                  </div>
                  <p className="text-xs text-muted-foreground pt-1">&ldquo;I&apos;ll handle it&rdquo; removes this thread from the AI so you can reply from your own inbox.</p>
                </div>
              )}
            </div>
          ) : t.category === "not_worth_it" ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
              <div className="flex items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5 text-destructive" />
                <span className="text-xs uppercase tracking-wide text-destructive">Not worth pursuing{t.worthiness ? ` · scored ${Math.round(t.worthiness.score)}/100` : ""}</span>
              </div>
              {t.worthiness?.hardNo && <p className="text-sm"><span className="text-muted-foreground">Hard no: </span>{t.worthiness.hardNo}</p>}
              <p className="text-xs text-muted-foreground">The AI stopped negotiating: this site fails the partner quality bar. Nothing was sent. Take it over if you disagree.</p>
              <Button size="sm" variant="outline" disabled={busy === t.id} onClick={() => handoff(t)}><UserRound className="h-4 w-4 mr-1" />I&apos;ll handle it</Button>
            </div>
          ) : t.draftStatus === "sent" ? (
            <p className="text-xs uppercase tracking-wide text-success flex items-center gap-1.5"><Send className="h-3 w-3" />AI reply sent, shown above in the conversation</p>
          ) : editBody[t.id] !== undefined ? (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">AI draft reply (edit before sending)</p>
              <Textarea rows={7} value={editBody[t.id]} onChange={(e) => setEditBody((s) => ({ ...s, [t.id]: e.target.value }))} className="text-sm" />
              <div className="flex gap-2">
                <Button size="sm" className="bg-primary hover:bg-primary text-primary-foreground" disabled={busy === t.id} onClick={() => sendOrDiscard(t, "send")}><Send className="h-4 w-4 mr-1" />Send reply</Button>
                <Button size="sm" variant="outline" disabled={busy === t.id} onClick={() => draft(t)}><RefreshCw className="h-4 w-4 mr-1" />Regenerate</Button>
                <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => sendOrDiscard(t, "discard")}><Trash2 className="h-4 w-4 mr-1" />Discard</Button>
              </div>
            </div>
          ) : (t.category === "needs_reply" || t.category === "negotiating") ? (
            <Button size="sm" variant="outline" disabled={busy === t.id} onClick={() => draft(t)}><Sparkles className="h-4 w-4 mr-1.5" />Draft AI reply</Button>
          ) : null}
          {(activity[t.id]?.length ?? 0) > 0 && (
            <div className="pt-2 border-t border-border/50">
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Activity log</p>
              <div className="space-y-0.5">
                {activity[t.id].map((a, i) => (
                  <p key={i} className="text-xs text-muted-foreground">
                    <span className={a.actor === "ai-autonomy" ? "text-highlight-ink font-medium" : "text-foreground font-medium"}>{a.actor === "ai-autonomy" ? "AI (autonomy)" : a.actor}</span>{" "}
                    {a.detail || a.action} · {fmtDate(a.created_at)}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <PageHeader icon={Bot} title="Negotiation" description="Replies triaged by state. The AI negotiates within each site's DR ceiling and your Handbook." />
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={autonomy ? "text-warning border-warning/40 bg-warning/10" : "text-muted-foreground"}>
            <ShieldAlert className="h-3 w-3 mr-1" />{autonomy === null ? "Autonomy unknown — not loaded yet" : autonomy ? "Autonomy ON — AI sends itself" : "Autonomy OFF — AI drafts for approval"}
          </Badge>
          <Button variant="outline" size="sm" disabled={processing} onClick={processNow} title="Check for new replies now and, if autonomy is on, auto-negotiate them">
            {processing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Play className="h-4 w-4 mr-1.5" />}Process now
          </Button>
          <Link href="/handbook"><Button variant="outline" size="sm"><BookOpen className="h-4 w-4 mr-1.5" />Handbook</Button></Link>
          <Button variant="ghost" size="icon-sm" onClick={load}><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>

      {loadError && <LoadFailed nothing="the negotiation threads" detail={loadError} onRetry={() => void load()} />}

      <SegmentedControl
        aria-label="Thread state"
        value={tab}
        onChange={(k) => { setTab(k); clearSel(); }}
        options={CATS.map((c) => ({ value: c.key, label: c.label, count: countFor(c.key) }))}
      />

      <div className="flex items-center justify-between gap-3 min-h-9">
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={selectAllVisible} disabled={rows.length === 0}>Select all ({rows.length})</Button>
          {sel.size > 0 && <Button variant="ghost" size="sm" onClick={clearSel}>Clear ({sel.size})</Button>}
          {senderOptions.length > 0 && (
            <SearchableSelect
              value={senderFilter}
              onChange={setSenderFilter}
              options={senderOptions}
              noneLabel="All senders"
              placeholder="Filter by sender…"
              searchPlaceholder="Search a teammate…"
              className="w-60"
              menuWidth="w-72"
            />
          )}
        </div>
        {sel.size > 0 && (
          <div className="flex items-center gap-2">
            <Button size="sm" className="bg-primary hover:bg-primary text-primary-foreground" onClick={() => setPriceOpen(true)}>
              <Sparkles className="h-4 w-4 mr-1.5" />Enable AI ({sel.size})
            </Button>
            <Button size="sm" variant="outline" disabled={busy === "bulk"} onClick={() => applyAI(false)}>Turn AI off</Button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-10 justify-center"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : rows.length === 0 ? (
        <p className="text-center text-muted-foreground py-10 text-sm">Nothing in this bucket.</p>
      ) : (
        <div className="space-y-3">
          {senderGroups.map((g) => {
            const collapsed = collapsedSenders.has(`${tab}:${g.key}`);
            const last = dateOf(g.items[0]);
            return (
              <Card key={g.key}>
                <button
                  onClick={() => toggleSender(`${tab}:${g.key}`)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
                >
                  {collapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
                  <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium truncate">{g.label}</span>
                  <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4">{g.items.length}</Badge>
                  {last && <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">{fmtDate(last)}</span>}
                </button>
                {!collapsed && (
                  <CardContent className="p-0 divide-y divide-border border-t">
                    {g.items.slice(0, groupShown[`${tab}:${g.key}`] ?? GROUP_PAGE).map((t) => renderThread(t))}
                    {g.items.length > (groupShown[`${tab}:${g.key}`] ?? GROUP_PAGE) && (
                      <button
                        type="button"
                        onClick={() => setGroupShown((m) => ({ ...m, [`${tab}:${g.key}`]: (m[`${tab}:${g.key}`] ?? GROUP_PAGE) + GROUP_PAGE }))}
                        className="w-full px-3 py-2.5 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
                      >
                        Show {Math.min(GROUP_PAGE, g.items.length - (groupShown[`${tab}:${g.key}`] ?? GROUP_PAGE))} more
                        <span className="ml-1.5 font-tabular">· {g.items.length - (groupShown[`${tab}:${g.key}`] ?? GROUP_PAGE)} left</span>
                      </button>
                    )}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={priceOpen} onOpenChange={setPriceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable AI negotiation for {sel.size} thread{sel.size === 1 ? "" : "s"}</DialogTitle>
            <DialogDescription>By default the AI uses your Handbook (pricing tiers by DR, tone, lowball strategy). Turn off &ldquo;Use Handbook defaults&rdquo; only if you want to override the price or add notes for this selection.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm">Use Handbook defaults</Label>
              <Switch checked={useDefaults} onCheckedChange={setUseDefaults} />
            </div>
            {!useDefaults && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">Max offer override ({currency})</Label>
                  <Input type="number" min={0} placeholder="use pricing tiers" value={priceForm.max_offer} onChange={(e) => setPriceForm((f) => ({ ...f, max_offer: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">Criteria / notes for these threads</Label>
                  <Textarea rows={3} placeholder="e.g. only pay for a do-follow link" value={priceForm.criteria} onChange={(e) => setPriceForm((f) => ({ ...f, criteria: e.target.value }))} />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPriceOpen(false)}>Cancel</Button>
            <Button className="bg-primary hover:bg-primary text-primary-foreground" disabled={busy === "bulk"} onClick={() => applyAI(true)}>
              {busy === "bulk" && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Enable AI
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
