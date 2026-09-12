"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Trash2, KeyRound, Search } from "lucide-react";

interface PoolKey { id: string; label: string; masked: string; active: boolean; exhaustedThisMonth: boolean }
interface Usage { enabled: boolean; used: number; limit: number; poolTotal: number; poolActive: number }

export function TavilyKeyManager() {
  const [keys, setKeys] = useState<PoolKey[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  async function load() {
    try {
      const d = await fetch("/api/admin/tavily-key").then((r) => r.json());
      setKeys(d.keys ?? []);
      setUsage(d.usage ?? null);
    } catch {}
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function addKeys() {
    if (!input.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/tavily-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: input }) });
      const d = await res.json();
      if (res.ok) { toast.success(`Added ${d.added} key${d.added === 1 ? "" : "s"} to the pool.`); setInput(""); setKeys(d.keys ?? []); load(); }
      else toast.error(d.error ?? "Couldn't add key");
    } catch { toast.error("Couldn't add key"); }
    setSaving(false);
  }

  async function removeKey(id: string) {
    setRemoving(id);
    try {
      const res = await fetch(`/api/admin/tavily-key?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const d = await res.json();
      if (res.ok) { setKeys(d.keys ?? []); toast.info("Key removed."); load(); }
    } catch { toast.error("Couldn't remove key"); }
    setRemoving(null);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Search className="h-5 w-5 text-highlight-ink" />
            <CardTitle>Tavily search keys</CardTitle>
          </div>
          {usage && (
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="outline" className={usage.poolActive > 0 || usage.enabled ? "border-success/40 text-success" : "border-destructive/50 text-destructive"}>
                {usage.poolActive}/{usage.poolTotal} keys active
              </Badge>
              <span className="text-muted-foreground tabular-nums">{usage.used.toLocaleString()} searches this month</span>
            </div>
          )}
        </div>
        <CardDescription>
          Add as many Tavily API keys as you want. Discovery uses one until it hits its monthly quota, then automatically rolls to the next — so you never run out. Exhausted keys reactivate on their own when the month resets.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Textarea
            placeholder={"Paste one or more Tavily keys (tvly-…), one per line or comma-separated"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="min-h-[72px] font-mono text-xs"
          />
          <Button size="sm" onClick={addKeys} disabled={saving || !input.trim()} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}Add to pool
          </Button>
        </div>

        <div className="rounded-lg border border-border divide-y divide-border">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-4"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
          ) : keys.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No keys in the pool yet. {usage?.enabled ? "Currently falling back to the TAVILY_API_KEY env var." : "Add one to enable Tavily search."}
            </div>
          ) : (
            keys.map((k) => (
              <div key={k.id} className="flex items-center gap-3 p-3">
                <KeyRound className={`h-4 w-4 shrink-0 ${k.active ? "text-success" : "text-muted-foreground"}`} />
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-sm truncate">{k.masked}{k.label ? <span className="text-muted-foreground font-sans"> · {k.label}</span> : null}</p>
                </div>
                {k.exhaustedThisMonth
                  ? <Badge variant="outline" className="border-warning/50 text-warning text-xs">quota used — resets next month</Badge>
                  : <Badge variant="outline" className="border-success/40 text-success text-xs">active</Badge>}
                <Button variant="ghost" size="sm" className="h-10 w-10 p-0 text-muted-foreground hover:text-destructive" disabled={removing === k.id} onClick={() => removeKey(k.id)}>
                  {removing === k.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
