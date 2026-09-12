"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Trash2, BookOpen, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";

interface PricingRule { min_dr?: number; min_traffic?: number; min_us_share?: number; max_offer: number; label?: string }
interface Settings {
  ai_autonomy: boolean; handbook: string; tone: string; max_thread_length: number;
  min_price: number; currency: string; anti_highball: string; pricing_rules: PricingRule[];
  link_exchange_first: boolean; ai_handles_money: boolean; link_exchange_brief: string;
  worthiness_gate: boolean; worthiness_green: number; worthiness_amber: number;
  aggressiveness: "gentle" | "balanced" | "firm"; opening_percent: number; style_rules: string;
}

export default function HandbookPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/negotiation/settings").then((r) => r.json()).then((d) => { setS(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => (p ? { ...p, [k]: v } : p));
  const setRule = (i: number, patch: Partial<PricingRule>) =>
    setS((p) => (p ? { ...p, pricing_rules: p.pricing_rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : p));
  const addRule = () => setS((p) => (p ? { ...p, pricing_rules: [...p.pricing_rules, { min_dr: 50, min_traffic: 10000, min_us_share: 50, max_offer: 100, label: "" }] } : p));
  const delRule = (i: number) => setS((p) => (p ? { ...p, pricing_rules: p.pricing_rules.filter((_, j) => j !== i) } : p));

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      const res = await fetch("/api/negotiation/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) });
      if (!res.ok) throw new Error((await res.json()).error ?? "save failed");
      setS(await res.json());
      toast.success("Handbook saved");
    } catch (e: any) { toast.error(e?.message ?? "save failed"); }
    finally { setSaving(false); }
  };

  if (loading || !s) {
    return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-6">
        <PageHeader icon={BookOpen} title="Handbook" description="The brief your AI negotiator follows: goals, tone, limits and price." />
        <Button onClick={save} disabled={saving} className="bg-primary hover:bg-primary text-primary-foreground">
          {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Save
        </Button>
      </div>

      {/* Master autonomy toggle */}
      <Card className={s.ai_autonomy ? "border-warning/40" : ""}>
        <CardContent className="p-4 flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label className="flex items-center gap-2 text-sm font-medium"><ShieldAlert className={`h-4 w-4 ${s.ai_autonomy ? "text-warning" : "text-muted-foreground"}`} />AI autonomy</Label>
            <p className="text-xs text-muted-foreground max-w-xl">
              When <b>off</b> (recommended), the AI <b>drafts</b> every negotiation reply and waits for you to approve and send it.
              When <b>on</b>, the AI sends replies on its own within these rules. Hard-no's and unsubscribes are never auto-sent.
            </p>
          </div>
          <Switch checked={s.ai_autonomy} onCheckedChange={(v) => set("ai_autonomy", v)} />
        </CardContent>
      </Card>

      {/* Link-exchange ladder */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Link exchange ladder</CardTitle>
          <CardDescription>Lead with a reciprocal link swap; money and complex counters are handled the way you choose below.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Link exchange first</Label>
              <p className="text-xs text-muted-foreground max-w-xl">
                When <b>on</b> (recommended), the AI opens with a free link swap (offering one of our relevant blog posts), pushes once if they hesitate, and only then escalates. When off, it negotiates on price from the start.
              </p>
            </div>
            <Switch checked={s.link_exchange_first ?? true} onCheckedChange={(v) => set("link_exchange_first", v)} />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Let the AI negotiate money</Label>
              <p className="text-xs text-muted-foreground max-w-xl">
                When <b>off</b> (recommended), a failed link exchange is handed to a human with the price ceiling noted — the AI never talks money on its own. When on, the AI escalates to a paid offer within your pricing tiers itself.
              </p>
            </div>
            <Switch checked={s.ai_handles_money ?? false} onCheckedChange={(v) => set("ai_handles_money", v)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Exchange brief (tone & what to ask for)</Label>
            <Textarea rows={4} value={s.link_exchange_brief ?? ""} onChange={(e) => set("link_exchange_brief", e.target.value)} placeholder="Lead with a link exchange, no money. Offer a relevant post of ours; ask for a mention + link back…" />
          </div>
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Partner worthiness gate</Label>
              <p className="text-xs text-muted-foreground max-w-xl">
                Before offering anything, score the partner site 0–100 against the quality bar (DR, traffic, relevance, indexing, spam profile, outbound links). <b>Green</b> proceeds, <b>amber</b> goes to a human, <b>red</b> (or any hard-no niche) is never negotiated with.
              </p>
            </div>
            <Switch checked={s.worthiness_gate ?? true} onCheckedChange={(v) => set("worthiness_gate", v)} />
          </div>
          {(s.worthiness_gate ?? true) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Green at ≥</Label>
                <Input type="number" min={0} max={100} value={s.worthiness_green ?? 60} onChange={(e) => set("worthiness_green", parseInt(e.target.value) || 0)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Amber at ≥ (below is red)</Label>
                <Input type="number" min={0} max={100} value={s.worthiness_amber ?? 40} onChange={(e) => set("worthiness_amber", parseInt(e.target.value) || 0)} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Negotiation brief */}
      <Card>
        <CardHeader><CardTitle className="text-base">Negotiation brief</CardTitle><CardDescription>What we want, and how to get there. This is the core instruction the model reads.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Goal & criteria</Label>
            <Textarea rows={5} value={s.handbook} onChange={(e) => set("handbook", e.target.value)} placeholder="e.g. Get ImagineArt featured in their article…" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Tone</Label>
            <Input value={s.tone} onChange={(e) => set("tone", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Handling high openers (anti-highball)</Label>
            <Textarea rows={2} value={s.anti_highball} onChange={(e) => set("anti_highball", e.target.value)} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Max messages / thread</Label>
              <Input type="number" min={1} value={s.max_thread_length} onChange={(e) => set("max_thread_length", parseInt(e.target.value) || 1)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Min price (floor)</Label>
              <Input type="number" min={0} value={s.min_price} onChange={(e) => set("min_price", parseFloat(e.target.value) || 0)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Currency</Label>
              <Input value={s.currency} onChange={(e) => set("currency", e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Strategy & style */}
      <Card>
        <CardHeader><CardTitle className="text-base">Strategy &amp; style</CardTitle><CardDescription>How hard to push, where to open in the price range, and hard writing rules for every email.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">How aggressive</Label>
            <div className="flex gap-2">
              {(["gentle", "balanced", "firm"] as const).map((a) => (
                <Button key={a} type="button" variant={s.aggressiveness === a ? "default" : "outline"} size="sm"
                  className={s.aggressiveness === a ? "bg-primary hover:bg-primary text-primary-foreground capitalize" : "capitalize"}
                  onClick={() => set("aggressiveness", a)}>{a}</Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {s.aggressiveness === "gentle" ? "Concede slowly, settle low, lean to free inclusion if they hesitate."
                : s.aggressiveness === "firm" ? "Hold near the opening number, concede minimally, approach the ceiling only for high-value placements."
                : "Move in modest steps and land comfortably under the ceiling."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Open at {s.opening_percent}% of the range</Label>
            <input type="range" min={0} max={100} step={5} value={s.opening_percent} onChange={(e) => set("opening_percent", parseInt(e.target.value))} className="w-full accent-primary" />
            <p className="text-xs text-muted-foreground">0% opens at the floor, 100% opens at the tier ceiling. Lower opening = more room to negotiate up.</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Writing rules (applied to every email)</Label>
            <Textarea rows={3} value={s.style_rules} onChange={(e) => set("style_rules", e.target.value)} placeholder="e.g. No em dashes. Plain text. Short." />
            <p className="text-xs text-muted-foreground">These are enforced on top of an automatic em dash and en dash strip on every generated email.</p>
          </div>
        </CardContent>
      </Card>

      {/* Pricing tiers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pricing tiers</CardTitle>
          <CardDescription>The most we&apos;ll offer, by the site&apos;s Domain Rating and US traffic. The negotiator uses the highest tier a site qualifies for and never exceeds it. Metrics we can&apos;t verify yet (traffic/US) don&apos;t block a tier.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="hidden sm:grid grid-cols-[1fr_1fr_1fr_1fr_1.4fr_auto] gap-2 text-xs uppercase tracking-wide text-muted-foreground px-1">
            <span>Min DR</span><span>Min traffic</span><span>Min US %</span><span>Max offer ({s.currency})</span><span>Label</span><span />
          </div>
          {s.pricing_rules.map((r, i) => (
            <div key={i} className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_1fr_1fr_1.4fr_auto] gap-2 items-center">
              <Input type="number" value={r.min_dr ?? ""} onChange={(e) => setRule(i, { min_dr: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="—" />
              <Input type="number" value={r.min_traffic ?? ""} onChange={(e) => setRule(i, { min_traffic: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="—" />
              <Input type="number" value={r.min_us_share ?? ""} onChange={(e) => setRule(i, { min_us_share: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="—" />
              <Input type="number" value={r.max_offer} onChange={(e) => setRule(i, { max_offer: Number(e.target.value) })} />
              <Input value={r.label ?? ""} onChange={(e) => setRule(i, { label: e.target.value })} placeholder="label" />
              <Button variant="ghost" size="icon-sm" onClick={() => delRule(i)}><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addRule}><Plus className="h-4 w-4 mr-1" />Add tier</Button>
          {s.pricing_rules.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Current default: <Badge variant="secondary" className="font-normal">up to {s.currency} {Math.max(...s.pricing_rules.map((r) => r.max_offer))}</Badge> for the top tier.
              Sites below every tier get a placement-only ask (no money offered).
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
