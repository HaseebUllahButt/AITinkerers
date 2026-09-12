"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, CreditCard, RefreshCw, Check, Mail, ChevronDown, ChevronRight, User } from "lucide-react";
import { toast } from "sonner";
import { LoadFailed, fetchHonest } from "@/components/ui/load-failed";
import { PageHeader } from "@/components/layout/PageHeader";
import { SegmentedControl } from "@/components/ui/segmented-control";

interface PayThread {
  id: string; name: string; publication: string; host: string; dr: number | null;
  sender: string | null; sentBy: string | null; agreedPrice: number | null; paidAmount: number | null;
  status: string | null; paidAt: string | null; requestedAt: string | null; subject: string;
}
interface Msg { from: "us" | "them"; body: string; at: string | null }

export default function PaymentsPage() {
  const [threads, setThreads] = useState<PayThread[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed load must not read as "$0 owed" — money is the one number that must never lie low.
  // Failure keeps whatever ledger is already shown and puts the reason here instead.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"owed" | "paid">("owed");
  const [open, setOpen] = useState<string | null>(null);
  const [convo, setConvo] = useState<Record<string, Msg[]>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, reason } = await fetchHonest<{ threads?: PayThread[] }>("/api/payments");
    if (data) { setThreads(data.threads ?? []); setLoadError(null); }
    else setLoadError(reason);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const owed = threads.filter((t) => t.status !== "paid");
  const paid = threads.filter((t) => t.status === "paid");
  const rows = tab === "owed" ? owed : paid;
  const totalOwed = owed.reduce((s, t) => s + (t.agreedPrice ?? 0), 0);
  const totalPaid = paid.reduce((s, t) => s + (t.paidAmount ?? t.agreedPrice ?? 0), 0);

  const toggle = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    if (!convo[id]) {
      const d = await fetch(`/api/payments/${id}`).then((r) => r.json()).catch(() => ({ conversation: [] }));
      setConvo((c) => ({ ...c, [id]: d.conversation ?? [] }));
    }
  };

  const act = async (id: string, action: "paid" | "request" | "reset") => {
    setBusy(id);
    try {
      const r = await fetch(`/api/payments/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).then((x) => x.json());
      if (r.error) toast.error(r.error);
      else if (action === "paid") toast.success("Marked as paid");
      else if (action === "request") toast.success(`Payment request emailed to ${r.emailedTo}`);
      else toast.success("Reset to owed");
      load();
    } catch (e: any) { toast.error(e?.message ?? "failed"); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <PageHeader icon={CreditCard} title="Payments" description="Deals the AI closed. Open one to read the thread, then pay and mark it done." />
        <Button variant="ghost" size="icon-sm" onClick={load}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {loadError && <LoadFailed nothing="the payments ledger" detail={loadError} onRetry={() => void load()} />}

      <div className="flex items-center gap-3">
        <SegmentedControl
          aria-label="Ledger"
          value={tab}
          onChange={setTab}
          options={[
            { value: "owed", label: "Requires payment", count: owed.length },
            { value: "paid", label: "Paid", count: paid.length },
          ]}
        />
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground pr-1">
          {/* While the load is failing, a dollar figure would be a guess dressed as a fact. */}
          <span>Owed: <b className="text-foreground tabular-nums">{loadError ? "—" : `$${totalOwed.toLocaleString()}`}</b></span>
          <span>Paid: <b className="text-foreground tabular-nums">{loadError ? "—" : `$${totalPaid.toLocaleString()}`}</b></span>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-10 justify-center"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : rows.length === 0 ? (
        <p className="text-center text-muted-foreground py-10 text-sm">{tab === "owed" ? "No deals awaiting payment yet." : "Nothing paid yet."}</p>
      ) : (
        <Card><CardContent className="p-0 divide-y divide-border">
          {rows.map((t) => (
            <div key={t.id}>
              <div className="flex items-center gap-3 p-3">
                <button onClick={() => toggle(t.id)} className="text-muted-foreground hover:text-foreground shrink-0">
                  {open === t.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{t.name}</span>
                    <span className="text-xs text-muted-foreground">{t.publication}</span>
                    {t.dr != null && <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4">DR {Math.round(t.dr)}</Badge>}
                    {t.status === "requested" && <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 text-warning border-warning/40 bg-warning/10">requested</Badge>}
                    {t.status === "paid" && <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 text-success border-success/40 bg-success/15">paid</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1"><User className="h-3 w-3" /> under {t.sender ?? "unknown inbox"}{t.sentBy && t.sentBy !== t.sender ? ` (sent by ${t.sentBy})` : ""}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-base font-bold tabular-nums">${(t.agreedPrice ?? 0).toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">agreed</div>
                </div>
                {tab === "owed" ? (
                  <div className="flex flex-col gap-1 shrink-0">
                    <Button size="sm" className="bg-primary hover:bg-primary text-primary-foreground" disabled={busy === t.id} onClick={() => act(t.id, "paid")}><Check className="h-4 w-4 mr-1" />Mark paid</Button>
                    <Button size="sm" variant="outline" disabled={busy === t.id} onClick={() => act(t.id, "request")}><Mail className="h-4 w-4 mr-1" />Email to pay</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => act(t.id, "reset")}>Undo</Button>
                )}
              </div>
              {open === t.id && (
                <div className="px-4 pb-4 pl-11 space-y-2 bg-muted/30">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground pt-2">Conversation</p>
                  {(convo[t.id] ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">Loading conversation…</p>
                  ) : (convo[t.id] ?? []).map((m, i) => (
                    <div key={i} className={`text-xs rounded-lg p-2 max-w-[85%] whitespace-pre-wrap break-words ${m.from === "us" ? "bg-highlight-soft ml-auto" : "bg-muted"}`}>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-0.5">{m.from === "us" ? "Us" : t.name}</div>
                      {m.body}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </CardContent></Card>
      )}
    </div>
  );
}
