"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw, Send, X, Search, Trophy, AlertTriangle, Archive, ArchiveRestore, Sparkles, Bot, Hand, MessageCircle, UserPlus, ClipboardPaste, Copy, ExternalLink, UserCircle2, Check, Pencil, Contact } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { chatMatchesOwner, OWNER_ALL, OWNER_MINE, OWNER_UNASSIGNED, type OwnerFilter } from "@/lib/whatsapp/owners";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuthorDrawer } from "@/components/prospects/useAuthorDrawer";
import { LoadFailed, fetchHonest } from "@/components/ui/load-failed";
import { PageHeader } from "@/components/layout/PageHeader";
import { SegmentedControl } from "@/components/ui/segmented-control";

/**
 * The WhatsApp page: every vendor chat, laid out the way WhatsApp itself is — chats on the left,
 * the open conversation on the right, nothing else.
 *
 * These threads used to live inside the email Inbox, behind that page's tabs and sentiment/intent
 * filters — all email concepts that mean nothing for a vendor chat. The verbatim feedback was
 * "need a separate whatsapp section because ese bilkul samajh nahi aa raha", plus a voice note
 * asking for exactly this layout. So the WhatsApp logic MOVED here (the Inbox is email-only now),
 * it did not fork: same routes, same trust model — SearchOps records, and unless the Cloud API or
 * bridge is cleared to send, the keypress in WhatsApp is the send.
 */

interface Chat {
  author_id: string; name: string; publication: string; avatar_url: string | null;
  /** The vendor's number, rendered from the stored wa.me link. */
  recipient: string;
  last_at: string | null; reply_excerpt: string | null;
  unread: boolean; dismissed: boolean; needs_reply: boolean;
  ai_managed: boolean; negotiation_status: string | null; success_at: string | null;
  whatsapp_url: string | null;
  /** Whose chat this is (094). Null = nobody has claimed it yet. */
  assigned_to: string | null; assigned_label: string | null;
  /** A person vouched for `name` (095). False = it's the display name the vendor set on their own
   *  WhatsApp profile, which the negotiator will not use to their face. */
  name_confirmed?: boolean;
}
interface TeamMember { email: string; label: string }
interface Msg {
  uid: number;
  waId: string; // whatsapp_thread_messages row id (undo)
  direction: "outbound" | "inbound";
  fromName: string;
  date: string; body: string;
  images: string[];
  waStatus?: "sent" | "delivered" | "read" | "failed" | "draft"; // delivery ticks (Cloud API receipts)
  waError?: string | null;
  waSource?: string; // composer | manual_paste | webhook | negotiator
}
interface WaAnchor {
  id: string; ai_managed: boolean; negotiation_status: string | null;
  agreed_price: number | null; deal_currency: string | null; intervention_ask: string | null;
  wa_suggested_reply?: string | null;
}

/** WhatsApp-style row time: clock for today, date otherwise. */
function chatTime(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch { return ""; }
}
function timeLabel(iso?: string | null): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}
function ListSkeleton() {
  return <div className="p-2 space-y-1">{Array.from({ length: 6 }).map((_, i) => (
    <div key={i} className="flex items-start gap-2.5 px-2 py-2.5 animate-pulse">
      <div className="h-10 w-10 rounded-full bg-muted shrink-0" />
      <div className="flex-1 space-y-1.5"><div className="h-3 bg-muted rounded w-2/3" /><div className="h-2.5 bg-muted/60 rounded w-1/2" /></div>
    </div>))}</div>;
}
function ThreadSkeleton() {
  return <div className="px-5 py-4 space-y-3">{[0, 1, 2].map((i) => (
    <div key={i} className={`flex ${i % 2 ? "justify-end" : "justify-start"} animate-pulse`}>
      <div className={`h-16 rounded-2xl bg-muted ${i % 2 ? "w-[55%]" : "w-[65%]"}`} />
    </div>))}</div>;
}

export default function WhatsappPage() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed load must not read as "no chats" — it keeps the current list and says why.
  const [listErr, setListErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Chat | null>(null);

  // Ownership (094): who can be assigned, who you are, and which slice you are looking at. The
  // chosen slice is remembered per browser — picking "My chats" once should not have to be picked
  // again every morning, and a preference this small does not belong in the database.
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [owner, setOwner] = useState<OwnerFilter>(OWNER_ALL);
  const [assigning, setAssigning] = useState(false);
  // Naming (095): the chat header's name is WhatsApp's pushname until someone says otherwise.
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [naming, setNaming] = useState(false);
  const [syncingNames, setSyncingNames] = useState(false);
  useEffect(() => {
    // After mount, not in the initial state: localStorage does not exist on the server, and seeding
    // from it during render would make the server and the client disagree about which chips are lit.
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("wa.ownerFilter") : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setOwner(saved);
  }, []);
  function pickOwnerFilter(next: OwnerFilter) {
    setOwner(next);
    try { window.localStorage.setItem("wa.ownerFilter", next); } catch { /* private mode — the filter still works, it just won't persist */ }
  }

  const [messages, setMessages] = useState<Msg[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadErr, setThreadErr] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<WaAnchor | null>(null);
  const [apiOn, setApiOn] = useState(false);
  const [sendMode, setSendMode] = useState<"cloud" | "bridge" | "manual">("manual");
  const [bridgeReadOnly, setBridgeReadOnly] = useState(false);

  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [takingOver, setTakingOver] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [lang, setLang] = useState<"roman_ur" | "en" | "auto">("roman_ur");
  const [instruction, setInstruction] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasting, setPasting] = useState(false);
  const [vendorFormOpen, setVendorFormOpen] = useState(false);
  const [vendorName, setVendorName] = useState("");
  const [vendorNumber, setVendorNumber] = useState("");
  const [vendorSaving, setVendorSaving] = useState(false);

  const threadEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Which chat is open, readable synchronously. A poll that started before a click must not paint
  // the previous vendor's messages into the chat you just opened.
  const openIdRef = useRef<string | null>(null);
  // How many messages the last read put on screen, so a poll can tell "something new arrived" from
  // "the same thread again" without diffing every row.
  const msgCountRef = useRef(0);
  const { openAuthor, drawer } = useAuthorDrawer();

  /** The chat list. `quiet` is the poll path: same data, no skeleton and no spinning refresh icon.
   *  A failed read never empties the list — it keeps what is on screen and says why. */
  const loadList = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    const { data, reason } = await fetchHonest<{ vendors?: Chat[]; team?: TeamMember[]; me?: string | null }>("/api/whatsapp/vendors");
    if (data) {
      const next = data.vendors ?? [];
      setChats(next);
      setTeam(data.team ?? []);
      setMe(data.me ?? null);
      // Keep the open chat's header in step with the list (name, deal badges, needs-reply) without
      // disturbing the selection. A chat that has dropped off the list stays open as it was.
      setSelected((cur) => (cur ? next.find((v) => v.author_id === cur.author_id) ?? cur : cur));
      setListErr(null);
    } else setListErr(reason);
    if (!quiet) setLoading(false);
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);

  // A WhatsApp thread row → the bubble shape this page renders.
  const waMsg = (r: {
    id: string; direction: "outbound" | "inbound"; body: string; sent_by?: string | null;
    sent_at?: string | null; created_at?: string | null; media_url?: string | null;
    media_type?: string | null; status?: Msg["waStatus"]; error?: string | null; source?: string;
  }, i: number): Msg => ({
    uid: i, waId: r.id, direction: r.direction,
    fromName: r.direction === "outbound"
      ? (r.sent_by === "negotiator@agent" ? "AI negotiator" : r.sent_by ? String(r.sent_by).split("@")[0] : "You")
      : "",
    date: r.sent_at ?? r.created_at ?? "", body: r.body,
    images: r.media_url && String(r.media_type ?? "").startsWith("image/") ? [r.media_url] : [],
    waStatus: r.status, waError: r.error ?? null, waSource: r.source,
  });

  /** One chat's messages + deal state. `quiet` is the poll path, and it is deliberately careful on
   *  a screen somebody is reading: it does not blank the thread first (that flickers), does not
   *  show the skeleton, and does not yank the scroll — it follows the conversation down only when
   *  something new actually arrived AND the reader was already at the bottom. */
  const fetchThread = useCallback(async (authorId: string, quiet = false) => {
    if (!quiet) { setThreadLoading(true); setThreadErr(null); setMessages([]); setAnchor(null); msgCountRef.current = 0; }
    // Where the reader is, decided BEFORE the repaint moves the box.
    const box = scrollRef.current;
    const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    try {
      const res = await fetch(`/api/whatsapp/${authorId}`);
      const d = await res.json().catch(() => ({}));
      if (openIdRef.current !== authorId) return; // they opened another chat while this was in flight
      if (!res.ok) throw new Error(d?.error ?? `The chat did not load (HTTP ${res.status}).`);
      const next: Msg[] = (d.messages ?? []).map(waMsg);
      const grew = next.length > msgCountRef.current;
      msgCountRef.current = next.length;
      setMessages(next);
      setAnchor(d.anchor ?? null); setApiOn(!!d.apiConfigured);
      setSendMode(d.sendMode ?? "manual"); setBridgeReadOnly(!!d.bridgeReadOnly);
      setThreadErr(d.error ?? null);
      if (!quiet || (grew && atBottom)) setTimeout(() => threadEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch (e) {
      // A failed read is not an empty chat: whatever is on screen stays, with a banner saying why.
      if (openIdRef.current === authorId) setThreadErr(e instanceof Error ? e.message : "Failed to load the chat");
    }
    if (!quiet) setThreadLoading(false);
  }, []);

  const loadThread = useCallback((p: Chat) => fetchThread(p.author_id, false), [fetchThread]);

  // Vendor messages arrive from the WAHA bridge straight into the database, and nothing tells this
  // page. Without a poll the chat list stayed frozen in whatever order it had when the page was
  // opened, so a vendor who had just written never rose to the top; and an open conversation showed
  // nothing new until somebody thought to press Refresh, which is what "the chat has to be synced
  // to receive messages" was describing. Visibility-gated, the NotificationCenter convention — a
  // background tab polling a chat nobody is looking at is pure cost.
  const openId = selected?.author_id ?? null;
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void loadList(true);
      if (openId) void fetchThread(openId, true);
    };
    const id = setInterval(tick, 8_000);
    // Returning to the tab catches up at once instead of waiting out the interval.
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [loadList, fetchThread, openId]);

  function selectChat(p: Chat) {
    openIdRef.current = p.author_id;
    setSelected(p); setReplyText(""); setPasteOpen(false); setPasteText(""); setInstruction(""); loadThread(p);
    if (p.unread) setChats((cs) => cs.map((x) => x.author_id === p.author_id ? { ...x, unread: false } : x));
  }

  // Same per-viewer inbox_state as the email inbox (keyed by author) — archiving here and there
  // is the same act.
  async function archive(p: Chat, dismissed: boolean, e?: React.MouseEvent) {
    e?.stopPropagation();
    setChats((cs) => cs.map((x) => x.author_id === p.author_id ? { ...x, dismissed } : x));
    await fetch(`/api/inbox/${p.author_id}/dismiss`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dismissed }) }).catch(() => {});
    toast.info(dismissed ? `${p.name} archived.` : `${p.name} restored.`);
  }

  async function undo(id: string) {
    const res = await fetch(`/api/whatsapp/${selected?.author_id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    }).then((r) => r.json()).catch(() => ({ error: "network error" }));
    if (res.ok) { setMessages((m) => m.filter((x) => x.waId !== id)); msgCountRef.current -= 1; }
    else toast.error(res.error ?? "Couldn't unlog that message.");
  }

  async function send() {
    if (!selected || !replyText.trim()) return;
    setSending(true);
    const res = await fetch(`/api/whatsapp/${selected.author_id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "send", body: replyText }),
    }).then((r) => r.json()).catch(() => ({ error: "network error" }));
    setSending(false);
    if (res.ok) {
      setMessages((m) => [...m, waMsg(res.message, m.length)]);
      msgCountRef.current += 1; // keep the poll's "something new arrived" test honest
      setReplyText("");
      if (res.mode === "api") {
        // The Cloud API sent it from the business number — nothing left to press.
        toast.success("Sent on WhatsApp from the business number.");
      } else if (res.mode === "bridge") {
        // The WAHA bridge sent it from the linked number — nothing left to press.
        toast.success("Sent from the linked WhatsApp number.");
      } else {
        // Manual flow: the chat opens with the message pre-typed; the keypress is the send.
        if (res.waUrl) window.open(res.waUrl, "_blank", "noopener");
        if (res.apiError) toast.warning(`API send failed (${res.apiError}) — send it from WhatsApp instead.`);
        else if (res.windowClosed) toast.info("Their 24h window is closed, so the API can't send free-form — send it from WhatsApp.", { duration: 6000 });
        else toast.success("Logged — now press send in WhatsApp.", { action: { label: "Undo", onClick: () => void undo(res.message.id) } });
      }
      setTimeout(() => threadEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } else toast.error(res.error ?? "Couldn't log the message.");
  }

  async function takeover() {
    if (!selected) return;
    setTakingOver(true);
    const res = await fetch(`/api/whatsapp/${selected.author_id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "takeover" }),
    }).then((r) => r.json()).catch(() => ({ error: "network error" }));
    setTakingOver(false);
    if (res.ok) {
      toast.success(res.alreadyYours ? "This chat was already yours." : "Taken over — the negotiator has stopped answering this vendor.");
      await loadThread(selected); await loadList();
    } else toast.error(res.error ?? "Couldn't take over the chat.");
  }

  async function draft() {
    if (!selected) return;
    setDrafting(true);
    const res = await fetch(`/api/whatsapp/${selected.author_id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "draft", instruction: instruction.trim() || undefined, lang: lang === "auto" ? undefined : lang }),
    }).then((r) => r.json()).catch(() => ({ error: "network error" }));
    setDrafting(false);
    if (res.draft) setReplyText(res.draft);
    else toast.error(res.error ?? "Couldn't draft a reply.");
  }

  async function logPaste(mode: "single" | "parse") {
    if (!selected || !pasteText.trim()) return;
    setPasting(true);
    const res = await fetch(`/api/whatsapp/${selected.author_id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: mode === "single"
        ? JSON.stringify({ kind: "log", direction: "inbound", body: pasteText })
        : JSON.stringify({ kind: "paste", text: pasteText }),
    }).then((r) => r.json()).catch(() => ({ error: "network error" }));
    setPasting(false);
    if (res.ok) {
      toast.success(mode === "single" ? `Logged ${selected.name}'s message.` : `Filed ${res.inserted} messages into the chat.`);
      setPasteText(""); setPasteOpen(false);
      await loadThread(selected); await loadList();
    } else toast.error(res.error ?? "Couldn't log that.");
  }

  /** Hand a chat to a colleague, or release it (email = null). Optimistic, then reconciled by the
   *  refresh — the server is what decides, and it refuses an address that isn't on the team. */
  async function assign(p: Chat, email: string | null) {
    setAssigning(true);
    const label = email ? (team.find((m) => m.email.toLowerCase() === email.toLowerCase())?.label ?? email) : null;
    setChats((cs) => cs.map((x) => x.author_id === p.author_id ? { ...x, assigned_to: email, assigned_label: label } : x));
    setSelected((cur) => cur && cur.author_id === p.author_id ? { ...cur, assigned_to: email, assigned_label: label } : cur);
    const res = await fetch(`/api/whatsapp/${p.author_id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "assign", email }),
    }).then((r) => r.json()).catch(() => ({ error: "network error" }));
    setAssigning(false);
    if (res.ok) {
      toast.success(email
        ? `${p.name} is now ${email.toLowerCase() === (me ?? "").toLowerCase() ? "yours" : `${label}'s`}.`
        : `${p.name} is unassigned.`);
    } else {
      toast.error(res.error ?? "Couldn't assign that chat.");
    }
    await loadList(true); // put the real answer on screen either way
  }

  /** Take every chat's name from the phone's address book. Reports what actually changed rather
   *  than a bare "done": a rename the person didn't expect is worth seeing. */
  async function syncNames() {
    setSyncingNames(true);
    const res = await fetch(`/api/whatsapp/sync-names`, { method: "POST" })
      .then((r) => r.json()).catch(() => ({ error: "network error" }));
    setSyncingNames(false);
    if (!res.ok) { toast.error(res.error ?? "Couldn't read your phone's contacts."); return; }
    const parts = [
      res.renamed ? `${res.renamed} renamed` : null,
      res.confirmed ? `${res.confirmed} already matched` : null,
      res.unsaved ? `${res.unsaved} not in your contacts` : null,
    ].filter(Boolean);
    toast.success(parts.length ? `Names synced: ${parts.join(", ")}.` : "Every chat already matches your contacts.");
    // A partial failure has to say so — the counts above would otherwise read as a clean run.
    if (res.failures?.length) toast.error(`${res.failures.length} couldn't be saved: ${res.failures[0]}`);
    await loadList();
    if (selected) await loadThread(selected);
  }

  /** Set (or simply confirm) the name the team knows this vendor by. Confirming the existing name
   *  is not a no-op: it is what tells the negotiator the name is safe to use — see 095. */
  async function saveName() {
    if (!selected || !nameDraft.trim()) return;
    const name = nameDraft.trim();
    setNaming(true);
    const res = await fetch(`/api/whatsapp/${selected.author_id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "rename", name }),
    }).then((r) => r.json()).catch(() => ({ error: "network error" }));
    setNaming(false);
    if (res.ok) {
      setChats((cs) => cs.map((x) => x.author_id === selected.author_id ? { ...x, name, name_confirmed: true } : x));
      setSelected((cur) => cur && cur.author_id === selected.author_id ? { ...cur, name, name_confirmed: true } : cur);
      setNameOpen(false);
      toast.success(`Confirmed. Replies will call them ${name}.`);
      await loadList(true);
    } else toast.error(res.error ?? "Couldn't save that name.");
  }

  async function addVendor() {
    if (!vendorName.trim() || !vendorNumber.trim()) return;
    setVendorSaving(true);
    const res = await fetch(`/api/whatsapp/vendors`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: vendorName, number: vendorNumber }),
    }).then((r) => r.json()).catch(() => ({ error: "network error" }));
    setVendorSaving(false);
    if (res.ok) {
      toast.success(res.existing ? "That number is already a vendor — opening their chat." : `${vendorName.trim()} added.`);
      setVendorFormOpen(false); setVendorName(""); setVendorNumber("");
      // A vendor you add by hand is almost always yours, and leaving it unassigned would drop it
      // straight back into the pile this feature exists to thin out. Never on an EXISTING number:
      // that chat may already be a colleague's, and adding a duplicate must not take it from them.
      if (!res.existing && me) {
        await fetch(`/api/whatsapp/${res.author_id}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "assign", email: me }),
        }).catch(() => {});
      }
      await loadList();
      // A brand-new vendor has no messages yet, so the list won't show them until something is
      // logged — open the chat directly so the paste-in box is one click away.
      selectChat({
        author_id: res.author_id, name: vendorName.trim() || "Vendor", publication: "", avatar_url: null,
        recipient: "", last_at: null, reply_excerpt: null, unread: false, dismissed: false, needs_reply: false,
        ai_managed: false, negotiation_status: null, success_at: null, whatsapp_url: null,
        assigned_to: !res.existing && me ? me : null, assigned_label: !res.existing && me ? "You" : null,
        name_confirmed: !res.existing, // you just typed it
      });
    } else toast.error(res.error ?? "Couldn't add the vendor.");
  }

  // Once the Cloud API (or a send-cleared bridge) exists and the negotiator manages the chat, a
  // human reply would collide with an auto-reply mid-flight — same guard as the email inbox, same
  // Take over escape hatch. Without a transport the negotiator cannot send, so the composer stays open.
  const aiLocked = apiOn && !!anchor?.ai_managed && [null, "negotiating"].includes(anchor?.negotiation_status ?? null);

  const match = (p: Chat) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.publication.toLowerCase().includes(q.toLowerCase()) || p.recipient.toLowerCase().includes(q.toLowerCase());
  const inView = (p: Chat) => chatMatchesOwner(owner, p.assigned_to, me) && match(p);
  const active = chats.filter((p) => !p.dismissed && inView(p));
  const archived = chats.filter((p) => p.dismissed && inView(p));
  const shown = showArchived ? archived : active;

  // Counts are over UNARCHIVED chats and ignore the search box, so a chip always answers "how much
  // is waiting in there", not "how much of what I typed is in there".
  const live = chats.filter((p) => !p.dismissed);
  const tally = (f: OwnerFilter) => {
    const rows = live.filter((p) => chatMatchesOwner(f, p.assigned_to, me));
    return { total: rows.length, unread: rows.filter((p) => p.unread).length };
  };
  const viewingTeammate = ![OWNER_ALL, OWNER_MINE, OWNER_UNASSIGNED].includes(owner);
  const ownerLabel = (email: string | null) =>
    !email ? null : email.toLowerCase() === (me ?? "").toLowerCase() ? "You"
      : team.find((m) => m.email.toLowerCase() === email.toLowerCase())?.label ?? email.split("@")[0];

  const chatRow = (p: Chat) => (
    <div key={p.author_id} onClick={() => selectChat(p)} className={`group w-full text-left px-3 py-2.5 border-b border-border/60 flex items-center gap-3 hover:bg-muted/40 cursor-pointer ${selected?.author_id === p.author_id ? "bg-muted/50" : ""}`}>
      <Avatar className="h-10 w-10 shrink-0"><AvatarImage src={p.avatar_url ?? undefined} /><AvatarFallback className="text-xs">{p.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-sm truncate flex-1 ${p.unread ? "font-semibold" : "font-medium"}`}>{p.name}</span>
          <span className={`text-xs shrink-0 ${p.unread ? "text-success font-medium" : "text-muted-foreground"}`}>{chatTime(p.last_at)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <p className={`text-xs truncate flex-1 ${p.unread ? "text-foreground" : "text-muted-foreground"}`}>{p.reply_excerpt || p.recipient || "No messages yet"}</p>
          {p.unread && <span className="h-2.5 w-2.5 rounded-full bg-success shrink-0" title="New messages" />}
        </div>
        {(p.assigned_to || p.success_at || p.negotiation_status === "needs_human" || p.needs_reply || (p.ai_managed && [null, "negotiating"].includes(p.negotiation_status))) && (
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {/* Whose chat this is. Clicking it filters the list to that person — the fastest way to
                answer "what is Arham carrying right now", and the only discoverable route to a
                per-teammate view without a second dropdown in a 320px pane. */}
            {p.assigned_to && (
              <button
                onClick={(e) => { e.stopPropagation(); pickOwnerFilter(p.assigned_to!.toLowerCase() === (me ?? "").toLowerCase() ? OWNER_MINE : p.assigned_to!); }}
                title={`Show only ${p.assigned_label ?? p.assigned_to}'s chats`}
                className="text-xs text-muted-foreground border border-border rounded px-1 inline-flex items-center gap-1 hover:text-foreground hover:border-foreground/40"
              >
                <UserCircle2 className="h-3 w-3" />{ownerLabel(p.assigned_to)}
              </button>
            )}
            {p.success_at && <Trophy className="h-3 w-3 text-warning" />}
            {p.ai_managed && [null, "negotiating"].includes(p.negotiation_status) && (
              <span className="text-xs text-highlight-ink border border-highlight/40 bg-highlight-soft rounded px-1 inline-flex items-center gap-1" title="The AI negotiator is handling this chat."><Bot className="h-3 w-3" />AI</span>
            )}
            {p.negotiation_status === "needs_human" && <span className="text-xs text-warning border border-warning/40 bg-warning/10 rounded px-1 inline-flex items-center gap-1"><Hand className="h-3 w-3" />needs you</span>}
            {p.needs_reply && <span className="text-xs text-warning border border-warning/40 bg-warning/10 rounded px-1">needs reply</span>}
          </div>
        )}
      </div>
      <button onClick={(e) => archive(p, !p.dismissed, e)} title={p.dismissed ? "Restore" : "Archive"} className="opacity-0 group-hover:opacity-100 shrink-0 text-muted-foreground hover:text-foreground p-1">
        {p.dismissed ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
      </button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader icon={MessageCircle} title="WhatsApp" description="Vendor chats. The negotiator drafts; a person sends or takes over." />
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
      {/* Chat list — w-80 matches the list-pane width used by every other two-pane screen. */}
      <div className="w-80 shrink-0 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-card">
        <div className="p-3 border-b border-border flex items-center gap-2 shrink-0">
          <MessageCircle className="h-4 w-4 text-success shrink-0" />
          <p className="text-sm font-medium flex-1">Chats</p>
          {/* Chats filed under a vendor's own WhatsApp profile name instead of the one on the
              phone. One pass makes the tool agree with the contact list. */}
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => void syncNames()} disabled={syncingNames}
            title="Take every chat's name from your phone's contacts">
            {syncingNames ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Contact className="h-3.5 w-3.5" />}
          </Button>
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setVendorFormOpen((v) => !v)}><UserPlus className="h-3.5 w-3.5" />Add vendor</Button>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => void loadList()} title="Refresh"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /></Button>
        </div>
        {vendorFormOpen && (
          <div className="shrink-0 border-b border-border px-3 py-2 space-y-1.5">
            <p className="text-xs text-muted-foreground">A vendor you already deal with on WhatsApp</p>
            <Input placeholder="Name (as you know them)" value={vendorName} onChange={(e) => setVendorName(e.target.value)} className="h-8 text-sm" />
            <div className="flex gap-1.5">
              <Input placeholder="+92 300 1234567" value={vendorNumber} onChange={(e) => setVendorNumber(e.target.value)} className="h-8 text-sm flex-1" onKeyDown={(e) => { if (e.key === "Enter") void addVendor(); }} />
              <Button size="sm" className="h-8 shrink-0" disabled={vendorSaving || !vendorName.trim() || !vendorNumber.trim()} onClick={() => void addVendor()}>
                {vendorSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
              </Button>
            </div>
          </div>
        )}
        <div className="px-3 py-2 border-b border-border relative shrink-0">
          <Search className="absolute left-5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Search chats…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8 text-sm" />
        </div>
        {/* Whose chats you are looking at. One number serves the whole team, so without this every
            person reads every conversation to find their own. */}
        <div className="px-3 py-2 border-b border-border shrink-0 flex items-center gap-1.5 flex-wrap">
          <SegmentedControl
            size="sm"
            aria-label="Whose chats"
            value={owner}
            onChange={pickOwnerFilter}
            options={[
              ...(me ? [{ value: OWNER_MINE, label: "Mine", count: tally(OWNER_MINE).total, attention: tally(OWNER_MINE).unread > 0 }] : []),
              { value: OWNER_UNASSIGNED, label: "Unassigned", count: tally(OWNER_UNASSIGNED).total, attention: tally(OWNER_UNASSIGNED).unread > 0 },
              { value: OWNER_ALL, label: "Everyone", count: tally(OWNER_ALL).total, attention: tally(OWNER_ALL).unread > 0 },
            ]}
          />
          {viewingTeammate && (
            <button
              onClick={() => pickOwnerFilter(OWNER_ALL)}
              className="text-xs rounded-full border border-foreground bg-foreground text-background px-2 py-0.5 inline-flex items-center gap-1"
              title="Back to everyone"
            >
              {ownerLabel(owner)}
              <span className="opacity-70">{tally(owner).total}</span>
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {listErr && <LoadFailed nothing="your chats" detail={listErr} onRetry={() => void loadList()} className="m-2 shrink-0" />}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? <ListSkeleton /> : shown.length === 0 ? (
            <div className="px-4 py-10 text-center space-y-2">
              <MessageCircle className="h-7 w-7 opacity-20 mx-auto" />
              {/* An empty view must say WHY it is empty. With a filter on, "no vendor chats yet" is
                  a lie about the account rather than a fact about the view. */}
              <p className="text-xs text-muted-foreground">
                {showArchived ? "No archived chats."
                  : q ? "No chats match your search."
                  : owner === OWNER_MINE ? "No chats are assigned to you yet."
                  : owner === OWNER_UNASSIGNED ? "Every chat has an owner."
                  : viewingTeammate ? `No chats are assigned to ${ownerLabel(owner)}.`
                  : "No vendor chats yet. Add a vendor to start one."}
              </p>
              {!showArchived && !q && owner !== OWNER_ALL && live.length > 0 && (
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => pickOwnerFilter(OWNER_ALL)}>
                  Show everyone&apos;s ({live.length})
                </Button>
              )}
              {!showArchived && !q && owner === OWNER_ALL && (
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setVendorFormOpen(true)}><UserPlus className="h-3.5 w-3.5" />Add vendor</Button>
              )}
            </div>
          ) : shown.map(chatRow)}
        </div>
        {archived.length > 0 && (
          <button onClick={() => setShowArchived((v) => !v)} className="shrink-0 border-t border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground text-left flex items-center gap-1.5">
            <Archive className="h-3.5 w-3.5" />
            {showArchived ? "Back to chats" : `Archived (${archived.length})`}
          </button>
        )}
      </div>

      {/* Conversation — the second pane. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-card">
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
            <MessageCircle className="h-8 w-8 opacity-20" /><p className="text-sm">Pick a chat to see the conversation and reply.</p>
          </div>
        ) : (
          <>
            <div className="px-5 py-3 border-b border-border flex items-center gap-3 shrink-0">
              <Avatar className="h-9 w-9 shrink-0"><AvatarImage src={selected.avatar_url ?? undefined} /><AvatarFallback className="text-xs">{selected.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <button onClick={() => openAuthor(selected.author_id)} className="text-sm font-semibold hover:text-highlight-ink hover:underline text-left truncate" title="View profile">{selected.name}</button>
                  {/* An unconfirmed name is whatever the vendor typed into their own WhatsApp
                      profile — a persona or a shop name as often as a name. Saying so here is the
                      only way the person reading knows the negotiator is deliberately not using
                      it, and the fix is the same click either way: correct it, or confirm it. */}
                  <button
                    onClick={() => { setNameDraft(selected.name); setNameOpen((v) => !v); }}
                    className={`shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs border transition-colors ${
                      selected.name_confirmed
                        ? "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                        : "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"}`}
                    title={selected.name_confirmed
                      ? "The team confirmed this name. Click to change it."
                      : "This is the name they set on their own WhatsApp profile, so replies won't use it. Click to confirm or correct it."}
                  >
                    <Pencil className="h-3 w-3" />{selected.name_confirmed ? "" : "unconfirmed name"}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground truncate">{selected.recipient || "no number saved"}</p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {anchor?.negotiation_status === "agreed" && (
                  <span className="text-xs text-success border border-success/40 bg-success/10 rounded px-1.5 py-0.5 inline-flex items-center gap-1"><Trophy className="h-3 w-3" />agreed{anchor.agreed_price != null ? ` · ${anchor.agreed_price} ${anchor.deal_currency ?? ""}` : ""}</span>
                )}
                {anchor?.negotiation_status === "declined" && (
                  <span className="text-xs text-muted-foreground border border-border rounded px-1.5 py-0.5">declined</span>
                )}
                {anchor?.negotiation_status === "needs_human" && (
                  <span className="text-xs text-warning border border-warning/40 bg-warning/10 rounded px-1.5 py-0.5 inline-flex items-center gap-1" title={anchor.intervention_ask ?? undefined}><Hand className="h-3 w-3" />needs you{anchor.intervention_ask ? `: ${anchor.intervention_ask.slice(0, 48)}` : ""}</span>
                )}
                {aiLocked && <span className="text-xs text-highlight-ink border border-highlight/40 bg-highlight-soft rounded px-1.5 py-0.5 inline-flex items-center gap-1" title="The AI negotiator answers this vendor on its own."><Bot className="h-3.5 w-3.5" />AI negotiating</span>}
                {/* Whose chat this is. A label the whole team can see and change — not a lock, so
                    handing a vendor over mid-negotiation is one click and nothing is hidden from
                    the person taking it on. */}
                <DropdownMenu>
                  {/* Base UI's Trigger renders its own button, so it wears the Button variants
                      rather than wrapping one — same look as its neighbours in this header. */}
                  <DropdownMenuTrigger
                    className={buttonVariants({ variant: "outline", size: "sm", className: "h-9 gap-1.5" })}
                    disabled={assigning}
                    title="Whose chat is this?"
                  >
                    {assigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserCircle2 className="h-3.5 w-3.5" />}
                    {selected.assigned_to ? ownerLabel(selected.assigned_to) : "Unassigned"}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                      Moves this chat into their list. Everyone can still open it under &ldquo;Everyone&rdquo;.
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {me && (
                      <DropdownMenuItem onClick={() => void assign(selected, me)}>
                        <UserCircle2 className="h-3.5 w-3.5" />Me
                        {selected.assigned_to?.toLowerCase() === me.toLowerCase() && <Check className="h-3.5 w-3.5 ml-auto" />}
                      </DropdownMenuItem>
                    )}
                    {team.filter((m) => m.email.toLowerCase() !== (me ?? "").toLowerCase()).map((m) => (
                      <DropdownMenuItem key={m.email} onClick={() => void assign(selected, m.email)}>
                        {m.label}
                        {selected.assigned_to?.toLowerCase() === m.email.toLowerCase() && <Check className="h-3.5 w-3.5 ml-auto" />}
                      </DropdownMenuItem>
                    ))}
                    {!team.length && !me && (
                      // The roster read failed or is empty — say so rather than showing an empty menu.
                      <DropdownMenuItem disabled>No team members to assign to</DropdownMenuItem>
                    )}
                    {selected.assigned_to && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => void assign(selected, null)}>
                          <X className="h-3.5 w-3.5" />Unassign
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                {selected.whatsapp_url && (
                  <Button size="sm" variant="outline" className="h-9 gap-1.5" onClick={() => window.open(selected.whatsapp_url!, "_blank", "noopener")}><ExternalLink className="h-3.5 w-3.5" />Open in WhatsApp</Button>
                )}
                <Button size="sm" variant="ghost" className="h-9 w-9 p-0" onClick={() => loadThread(selected)} title="Refresh"><RefreshCw className={`h-3.5 w-3.5 ${threadLoading ? "animate-spin" : ""}`} /></Button>
              </div>
            </div>

            {/* Renaming a vendor. Saving an UNCHANGED name is the point as much as correcting one:
                either way a person has now said "this is them", which is what releases the name for
                use in replies. */}
            {nameOpen && (
              <div className="px-5 py-2.5 border-b border-border bg-muted/25 shrink-0 space-y-2">
                <p className="text-xs text-muted-foreground">
                  {selected.name_confirmed
                    ? "The name replies use for this vendor."
                    : `WhatsApp says "${selected.name}" — that's the vendor's own profile name, so replies won't use it until you confirm it. Correct it, or save it as-is.`}
                </p>
                <div className="flex gap-2">
                  <Input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void saveName(); if (e.key === "Escape") setNameOpen(false); }}
                    placeholder="Name (as you know them)"
                    className="h-8 text-sm flex-1"
                    autoFocus
                  />
                  <Button size="sm" className="h-8 shrink-0" disabled={naming || !nameDraft.trim()} onClick={() => void saveName()}>
                    {naming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : selected.name_confirmed ? "Save" : "Confirm"}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8 shrink-0" onClick={() => setNameOpen(false)}>Cancel</Button>
                </div>
              </div>
            )}

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-0">
              {/* Shown even when the thread already has messages on screen. A silently failing
                  refresh is indistinguishable from a vendor who has gone quiet, which is the exact
                  confusion this page was reported for. */}
              {threadErr && (
                <div className="flex items-start gap-2 text-sm text-warning bg-warning/8 border border-warning/25 rounded-md px-3 py-2"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />{threadErr}</div>
              )}
              {threadLoading ? <ThreadSkeleton /> : messages.length === 0 && !threadErr ? (
                <p className="text-sm text-muted-foreground">Nothing logged yet. Paste the chat so far below, or draft the first message.</p>
              ) : messages.map((m) => {
                const mine = m.direction === "outbound";
                return (
                  <div key={m.waId ?? m.uid} className={`group flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm ${mine ? "bg-highlight-soft text-white rounded-br-sm" : "bg-muted rounded-bl-sm"}`}>
                      <div className={`flex items-center gap-2 mb-1 text-xs ${mine ? "text-white/70" : "text-muted-foreground"}`}>
                        <span className="font-semibold">{mine ? m.fromName : selected.name}</span>
                        <span className="ml-auto">{timeLabel(m.date)}</span>
                        {mine && m.waStatus === "sent" && m.waSource !== "manual_paste" && <span title="Sent">✓</span>}
                        {mine && m.waStatus === "delivered" && <span title="Delivered">✓✓</span>}
                        {mine && m.waStatus === "read" && <span className="font-bold" title="Read">✓✓</span>}
                        {mine && m.waStatus === "failed" && <span className="text-destructive inline-flex items-center gap-0.5" title={m.waError ?? "send failed"}><AlertTriangle className="h-3 w-3" />failed</span>}
                        {m.waId && ["composer", "manual_paste"].includes(m.waSource ?? "") && (
                          <button onClick={() => void undo(m.waId)} title="Unlog (this was filed by hand)" className={`opacity-0 group-hover:opacity-100 ${mine ? "hover:text-white" : "hover:text-destructive"}`}><X className="h-3 w-3" /></button>
                        )}
                      </div>
                      <div className="whitespace-pre-wrap leading-relaxed break-words">{m.body || <span className="opacity-60 italic">(no text)</span>}</div>
                      {m.images?.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {m.images.map((src, i) => (
                            <a key={i} href={src} target="_blank" rel="noreferrer">
                              <img src={src} alt="" loading="lazy" className="max-h-40 max-w-[220px] rounded-md border border-border/50 object-contain bg-white/5" />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={threadEndRef} />
            </div>

            <div className="border-t border-border p-3 shrink-0">
              {aiLocked && (
                <div className="mb-2 flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
                  <Bot className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">The AI negotiator answers this vendor on its own. Take it over to reply yourself.</span>
                  <Button size="xs" variant="outline" className="shrink-0 gap-1.5" disabled={takingOver} onClick={() => void takeover()}>
                    {takingOver ? <Loader2 className="h-3 w-3 animate-spin" /> : <Hand className="h-3 w-3" />}
                    Take over
                  </Button>
                </div>
              )}
              {/* Read-only bridge: the negotiator drafted a reply but is not cleared to send it.
                  Offer it as a one-tap suggestion the person sends themselves. */}
              {anchor?.wa_suggested_reply && !replyText.trim() && (
                <div className="mb-2 rounded-md border border-highlight/30 bg-highlight-soft/50 p-2">
                  <div className="flex items-center gap-1.5 mb-1 text-xs text-highlight-ink">
                    <Bot className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-medium">Suggested reply</span>
                    <span className="text-muted-foreground">— the negotiator drafted this; you send it</span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap leading-relaxed mb-1.5">{anchor.wa_suggested_reply}</p>
                  <div className="flex items-center gap-1.5">
                    <Button size="xs" variant="outline" className="gap-1" onClick={() => { setReplyText(anchor.wa_suggested_reply ?? ""); setAnchor((a) => a ? { ...a, wa_suggested_reply: null } : a); }}>Use this</Button>
                    <Button size="xs" variant="ghost" onClick={() => setAnchor((a) => a ? { ...a, wa_suggested_reply: null } : a)}>Dismiss</Button>
                  </div>
                </div>
              )}
              {pasteOpen && (
                <div className="mb-2 rounded-md border border-border bg-muted/20 p-2 space-y-1.5">
                  <p className="text-xs text-muted-foreground">Paste one message from {selected.name}, or a whole chat (WhatsApp export or straight off the screen) — SearchOps files each message on the right side.</p>
                  <Textarea placeholder="Paste here…" value={pasteText} onChange={(e) => setPasteText(e.target.value)} className="min-h-[80px] max-h-48 resize-none text-sm" />
                  <div className="flex items-center gap-1.5">
                    <Button size="xs" variant="outline" disabled={pasting || !pasteText.trim()} onClick={() => void logPaste("single")}>Log as their message</Button>
                    <Button size="xs" variant="outline" disabled={pasting || !pasteText.trim()} onClick={() => void logPaste("parse")} className="gap-1">
                      {pasting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}Parse whole chat
                    </Button>
                    <Button size="xs" variant="ghost" className="ml-auto" onClick={() => { setPasteOpen(false); setPasteText(""); }}>Close</Button>
                  </div>
                </div>
              )}
              <div className="mb-2 flex items-center gap-1.5">
                <select value={lang} onChange={(e) => setLang(e.target.value as "roman_ur" | "en" | "auto")} title="Draft language" className="h-8 rounded-md border border-border bg-background px-1.5 text-xs outline-none focus:ring-1 focus:ring-ring shrink-0">
                  <option value="roman_ur">Roman Urdu</option>
                  <option value="en">English</option>
                  <option value="auto">Match thread</option>
                </select>
                <Input placeholder="Steer the draft (optional): counter at 40, ask TAT…" value={instruction} onChange={(e) => setInstruction(e.target.value)} className="h-8 text-xs flex-1" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void draft(); } }} />
                <Button size="sm" variant="outline" className="h-8 shrink-0 gap-1.5" disabled={drafting} onClick={() => void draft()}>
                  {drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Draft
                </Button>
              </div>
              <div className="flex items-end gap-2">
                <Button variant="ghost" size="sm" className="h-10 w-10 p-0 shrink-0" onClick={() => setPasteOpen((v) => !v)} title="Log received messages / paste chat"><ClipboardPaste className="h-4 w-4" /></Button>
                <Textarea placeholder={aiLocked ? "The negotiator is on this chat — take it over above to reply yourself." : `Message ${selected.name}…`} disabled={aiLocked} className="min-h-[44px] max-h-40 flex-1 resize-none disabled:opacity-60" value={replyText} onChange={(e) => setReplyText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
                <Button variant="ghost" size="sm" className="h-10 w-10 p-0 shrink-0" title="Copy message" disabled={!replyText.trim()} onClick={() => { navigator.clipboard.writeText(replyText).then(() => toast.info("Copied.")).catch(() => toast.error("Couldn't copy.")); }}><Copy className="h-4 w-4" /></Button>
                <Button size="sm" className="h-10 shrink-0 gap-1.5" disabled={sending || !replyText.trim() || aiLocked} onClick={() => void send()}>{sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}Send</Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1 pl-11">{sendMode === "cloud" ? "Sends from the business number while their 24h window is open; otherwise opens the chat for your keypress"
                : sendMode === "bridge" ? "Sends from the linked WhatsApp number via the bridge"
                : bridgeReadOnly ? "Read-only bridge: the negotiator drafts, you send. Opens the chat with the message pre-typed"
                : "Logs the message here and opens the chat with it pre-typed — the send itself is your keypress in WhatsApp"}
                {" · ⌘/Ctrl+Enter to send"}</p>
            </div>
          </>
        )}
      </div>
      {drawer}
      </div>
    </div>
  );
}
