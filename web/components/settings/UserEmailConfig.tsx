"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Check, KeyRound, ExternalLink, Send } from "lucide-react";
import type { UserEmailConfig } from "@/lib/types";
import { dailyCapacity } from "@/lib/email/schedule";

const TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "Europe/London", "Europe/Berlin", "Asia/Karachi", "Asia/Dubai", "Asia/Kolkata",
  "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "UTC",
];

export function UserEmailConfigCard() {
  const [cfg, setCfg] = useState<UserEmailConfig | null>(null);
  const [pw, setPw] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  async function sendTest() {
    setTesting(true);
    const res = await fetch("/api/user/email-config/test", { method: "POST" }).then((r) => r.json()).catch(() => ({ ok: false }));
    if (res.ok) toast.success(`Test email sent to ${cfg?.user_email} — check your inbox.`);
    else toast.error(res.error ?? "Test failed — double-check your app password.");
    setTesting(false);
  }

  useEffect(() => {
    fetch("/api/user/email-config").then((r) => r.ok ? r.json() : null).then((d) => { if (d) setCfg(d); }).catch(() => {});
  }, []);

  async function save() {
    if (!cfg) return;
    setSaving(true);
    const body: Record<string, unknown> = {
      from_name: cfg.from_name, timezone: cfg.timezone,
      send_hour_start: cfg.send_hour_start, send_hour_end: cfg.send_hour_end,
      gap_minutes: cfg.gap_minutes, daily_cap: cfg.daily_cap,
    };
    if (pw.trim()) body.app_password = pw.trim();
    const res = await fetch("/api/user/email-config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) {
      const saved = await res.json();
      setCfg(saved); setPw("");
      // Say whether the queue that already exists was moved onto the new pacing — the whole
      // point of the change is usually the queue sitting there right now.
      if (saved.respaceError) toast.warning(`Settings saved, but the emails already queued could not be re-spaced (${saved.respaceError}). They keep their old send times.`);
      else if (saved.respaced) toast.success(`Sending settings saved. ${saved.respaced} already-queued email${saved.respaced === 1 ? "" : "s"} re-spaced onto the new schedule.`);
      else toast.success("Sending settings saved.");
    }
    else toast.error("Couldn't save.");
    setSaving(false);
  }

  if (!cfg) return null;

  // How many this account's window + gap actually allow in a day. Quoted next to both inputs so
  // "why is my 100-email campaign taking a week" is answered before it is asked.
  const perDay = dailyCapacity(cfg);

  return (
    <Card className={cfg.hasPassword ? "" : "border-warning/30 bg-warning/5"}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-highlight-ink" />Your sending email</CardTitle>
          <Badge variant="outline" className={cfg.hasPassword ? "border-success/40 text-success" : "border-warning/50 text-warning"}>
            {cfg.hasPassword ? "✓ app password set" : "⚠ app password required"}
          </Badge>
        </div>
        <CardDescription>You send outreach from your own Gmail (<span className="text-foreground">{cfg.user_email}</span>) using a Gmail <b>app password</b> — never your normal password.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Setup steps */}
        <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground space-y-1.5">
          <p className="font-semibold text-foreground">How to get a Gmail app password</p>
          <p>1. Turn on 2-Step Verification: <a className="text-highlight-ink hover:underline inline-flex items-center gap-0.5" href="https://myaccount.google.com/signinoptions/two-step-verification" target="_blank" rel="noreferrer">Google 2-Step <ExternalLink className="h-3 w-3" /></a></p>
          <p>2. Create an app password (pick “Mail”): <a className="text-highlight-ink hover:underline inline-flex items-center gap-0.5" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords <ExternalLink className="h-3 w-3" /></a></p>
          <p>3. Paste the 16-character code below (spaces are fine).</p>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>App password {cfg.hasPassword && <span className="text-success text-xs">(set — type to replace)</span>}</Label>
            <Input type="password" placeholder={cfg.hasPassword ? "•••• •••• •••• ••••" : "abcd efgh ijkl mnop"} value={pw} onChange={(e) => setPw(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>From name</Label>
            <Input placeholder="Your Name" value={cfg.from_name ?? ""} onChange={(e) => setCfg({ ...cfg, from_name: e.target.value })} />
          </div>
        </div>

        <div className="grid sm:grid-cols-4 gap-3">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Timezone</Label>
            <select className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm" value={cfg.timezone} onChange={(e) => setCfg({ ...cfg, timezone: e.target.value })}>
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Send from (hr)</Label>
            <Input type="number" min={0} max={23} value={cfg.send_hour_start} onChange={(e) => setCfg({ ...cfg, send_hour_start: Number(e.target.value) })} />
          </div>
          <div className="space-y-1.5">
            <Label>Send until (hr)</Label>
            <Input type="number" min={1} max={24} value={cfg.send_hour_end} onChange={(e) => setCfg({ ...cfg, send_hour_end: Number(e.target.value) })} />
          </div>
        </div>

        {/* Back on screen after the burst experiment removed them. These two values were never
            removed from the DATABASE — every account still had gap_minutes 15 and a daily cap —
            so for a month the tool stored a pacing policy, and the sender ignored it. */}
        <div className="grid sm:grid-cols-4 gap-3">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Minimum gap between emails (min)</Label>
            <Input
              type="number" min={1} max={240} value={cfg.gap_minutes}
              onChange={(e) => setCfg({ ...cfg, gap_minutes: Number(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">
              Actual gaps land between this and double it, at random — {cfg.gap_minutes || 15} to {(cfg.gap_minutes || 15) * 2} minutes.
              A mailbox sending exactly every {cfg.gap_minutes || 15} minutes is its own machine signature.
            </p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Max per day</Label>
            <Input
              type="number" min={1} max={500} value={cfg.daily_cap}
              onChange={(e) => setCfg({ ...cfg, daily_cap: Number(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">
              A ceiling on top of the window. Your window already allows about {perDay} a day.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          <p>
            <b className="text-foreground">Paced sending:</b> emails leave one at a time, {cfg.gap_minutes || 15}-{(cfg.gap_minutes || 15) * 2} minutes
            apart, only between {cfg.send_hour_start}:00 and {cfg.send_hour_end}:00 in your timezone. That fits
            about <b>{perDay} a day</b> from this account; anything past that waits for tomorrow&apos;s window and keeps rolling.
          </p>
          <p className="mt-1.5">
            So a 100-prospect campaign from this one address takes roughly {Math.max(1, Math.ceil(100 / Math.max(1, perDay)))} working days.
            To move faster, widen the hours above, or spread the campaign across more sending accounts — not by removing the gap,
            which is what protects the address.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={sendTest} disabled={testing || !cfg.hasPassword} title={cfg.hasPassword ? "Send a test email to yourself" : "Save an app password first"}>
            {testing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
            Send test email
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Check className="h-4 w-4 mr-1.5" />}
            Save sending settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
