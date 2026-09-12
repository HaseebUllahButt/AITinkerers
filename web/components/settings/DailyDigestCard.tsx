"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";

// Daily ops digest: per-person scheduled counts, template usage, and site usage, emailed once a
// day. Toggle off = the midnight cron skips it. Recipient is editable.
export function DailyDigestCard() {
  const [enabled, setEnabled] = useState(true);
  const [recipient, setRecipient] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    fetch("/api/digest/settings").then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d) { setEnabled(d.enabled !== false); setRecipient(d.recipient ?? ""); }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const save = async (patch: { enabled?: boolean; recipient?: string }) => {
    setSaving(true);
    try {
      const d = await fetch("/api/digest/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then((r) => r.json());
      setEnabled(d.enabled !== false); setRecipient(d.recipient ?? "");
      toast.success("Digest settings saved.");
    } catch { toast.error("Save failed."); } finally { setSaving(false); }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const d = await fetch("/api/digest/daily?force=1", { method: "POST" }).then((r) => r.json());
      if (d.sent) toast.success(`Test digest sent to ${d.recipient}.`);
      else toast.error(d.error ?? d.skipped ?? "Couldn't send.");
    } catch { toast.error("Send failed."); } finally { setTesting(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily digest email</CardTitle>
        <CardDescription>
          A once-a-day summary emailed automatically: how many emails each person has scheduled, template usage and richness, and which sites you&apos;re targeting. Goes to the recipient below with the whole team CC&apos;d. Toggle off and the nightly send is skipped.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-sm">Send the daily digest</Label>
          <Switch checked={enabled} disabled={!loaded || saving} onCheckedChange={(v) => save({ enabled: v })} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">Recipient</Label>
          <div className="flex gap-2">
            <Input type="email" placeholder="zain@imagine.art" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
            <Button variant="outline" onClick={() => save({ recipient })} disabled={saving || !recipient.trim()} className="shrink-0">
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Save
            </Button>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={sendTest} disabled={testing || !recipient.trim()}>
          {testing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}Send a test now
        </Button>
      </CardContent>
    </Card>
  );
}
