"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SlidersHorizontal, PauseCircle } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { fetchHonest } from "@/components/ui/load-failed";
import { cn } from "@/lib/utils";

interface Policy {
  workflow_id: string | null;
  enabled: boolean;
  daily_cap: number;
  min_trust: "verified" | "sourced";
  followups_enabled: boolean;
  weekly_link_goal: number | null;
  auto_source: boolean;
  retry_stale_days: number | null;
  max_offer: number | null;
  paused_reason: string | null;
}

// This campaign's standing policy — the per-campaign counterpart to the global AutopilotCard.
// A campaign without its own row follows the global default; the first edit here creates the row.
// The same policy is what Hermes changes via a set_policy confirm card, so this card and the chat
// agree by construction (one table, one validation).
export function PolicyCard({ workflowId, label }: { workflowId: string; label: string }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [own, setOwn] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  /** A failed load renders the card shell with the reason, never nothing — a vanished card is
   *  indistinguishable from "this campaign has no policy". */
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, reason } = await fetchHonest<{ policies: Policy[]; default: Policy }>("/api/automation/policy");
    if (data) {
      const mine = data.policies.find((p) => p.workflow_id === workflowId);
      setOwn(!!mine);
      setPolicy(mine ?? { ...data.default, workflow_id: workflowId });
      setLoadError(null);
    } else {
      setLoadError(reason); // keep any policy already on screen
    }
    setLoaded(true);
  }, [workflowId]);

  // `load` only setStates after an await; the rule cannot see through the promise. Same exemption
  // as src/app/summer/page.tsx.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    try {
      const d = await fetch("/api/automation/policy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: workflowId, patch }),
      }).then((r) => r.json());
      if (d?.ok) { setPolicy(d.policy); setOwn(true); }
      else toast.error(d?.error ?? "Could not save the policy.");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not save the policy."); }
    finally { setSaving(false); }
  }

  if (!loaded) return null;

  if (!policy) {
    return (
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md bg-muted p-2 text-muted-foreground">
            <SlidersHorizontal className="h-5 w-5" />
          </div>
          <div>
            <div className="font-medium">This campaign&apos;s autopilot</div>
            <p className="text-sm text-warning mt-1 max-w-xl">
              Couldn&apos;t load this campaign&apos;s policy{loadError ? ` (${loadError})` : ""} — whatever is
              set still applies, it just can&apos;t be shown right now.
            </p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className={cn("mt-0.5 rounded-md p-2", policy.enabled && !policy.paused_reason ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
            <SlidersHorizontal className="h-5 w-5" />
          </div>
          <div>
            <div className="font-medium flex items-center gap-2">
              This campaign's autopilot
              <Switch checked={policy.enabled} disabled={saving} onCheckedChange={(v) => save({ enabled: v })} />
            </div>
            <p className="text-sm text-muted-foreground mt-1 max-w-xl">
              {own
                ? <>Rules for <b>{label}</b> alone. The global autopilot above stays in charge of every campaign without its own rules.</>
                : <>Following the global settings above. Change anything here and <b>{label}</b> gets its own rules.</>}
            </p>
            {policy.paused_reason && (
              <div className="mt-2 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
                <PauseCircle className="h-4 w-4 shrink-0" />
                <span>{policy.paused_reason}</span>
                <Button size="sm" variant="outline" disabled={saving} onClick={() => save({ paused_reason: null })}>Resume</Button>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="space-y-1">
            <label className="block text-xs text-muted-foreground">Emails / day</label>
            <Input type="number" min={1} max={500} defaultValue={policy.daily_cap} disabled={saving}
              onBlur={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 500 && n !== policy.daily_cap) save({ daily_cap: Math.floor(n) }); }}
              className="w-24" />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-muted-foreground">Links / week goal</label>
            <Input type="number" min={1} max={100} placeholder="—" defaultValue={policy.weekly_link_goal ?? ""} disabled={saving}
              onBlur={(e) => {
                const raw = e.target.value.trim();
                const next = raw === "" ? null : Math.floor(Number(raw));
                if (next !== policy.weekly_link_goal && (next === null || (next >= 1 && next <= 100))) save({ weekly_link_goal: next });
              }}
              className="w-24" />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-muted-foreground" title="Which addresses may be queued automatically. 'Found or verified' is the normal gate; 'found only' skips pattern-built addresses entirely.">Address bar</label>
            <select
              className="h-9 w-40 rounded-md border border-input bg-background px-2 text-sm"
              value={policy.min_trust} disabled={saving}
              onChange={(e) => save({ min_trust: e.target.value })}
            >
              <option value="verified">Found or verified</option>
              <option value="sourced">Found only</option>
            </select>
          </div>
          <div className="flex items-center gap-2 pb-1.5" title="Day-2 nudges for this campaign's unanswered emails.">
            <Switch checked={policy.followups_enabled} disabled={saving} onCheckedChange={(v) => save({ followups_enabled: v })} />
            <span className="text-xs text-muted-foreground">Follow-ups</span>
          </div>
        </div>
      </div>
    </div>
  );
}
