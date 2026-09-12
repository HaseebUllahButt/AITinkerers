"use client";

import { useEffect, useState } from "react";
import { Users, TrendingUp, TriangleAlert, Target, RefreshCw, Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { AdoptionReport, Metric } from "@/lib/adoption/report";

/**
 * Adoption and outcomes, for reporting upward.
 *
 * Three deliberate choices, because this is the one screen whose numbers get quoted to someone who
 * cannot check them:
 *
 *   1. Every figure shows its source column. If a number gets challenged in the meeting, the answer is
 *      on screen rather than in someone's memory of how it was computed.
 *   2. Losses sit at the same visual weight as wins. A report that buries the failures is a pitch.
 *   3. Caveats are rendered, not hidden. dev@local being in the roster, or visit tracking having no
 *      history before today, would otherwise silently distort the story.
 */
export function AdoptionPanel() {
  const [data, setData] = useState<AdoptionReport | null>(null);
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/adoption?days=${days}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 ? "Admin access required (set ADMIN_EMAILS)." : `Failed (${r.status})`);
        return r.json();
      })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [days]);

  /** A CSV of the per-person roster, because the report gets pasted into a deck or a sheet. */
  function exportCsv() {
    if (!data) return;
    const head = ["email", "first_seen", "last_seen", "active_days", "drafts", "ai_sessions", "clusters", "assets", "emails_sent", "replies_won"];
    const rows = data.people.map((p) => [
      p.email, p.firstSeen?.slice(0, 10) ?? "", p.lastSeen?.slice(0, 10) ?? "", p.activeDays,
      p.draftsCreated, p.aiSessions, p.assetsGenerated, p.emailsSent, p.repliesWon,
    ]);
    const csv = [head, ...rows].map((r) => r.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `summit-adoption-${days}d.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading && !data) {
    return <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">Reading activity across the platform…</CardContent></Card>;
  }
  if (error) {
    return <Card><CardContent className="py-10 text-center text-sm text-destructive">{error}</CardContent></Card>;
  }
  if (!data) return null;

  const peak = Math.max(1, ...data.trend.map((t) => Math.max(t.drafts + t.sessions, t.emails)));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Adoption &amp; outcomes</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Last {data.windowDays} days · {data.totals.activePeople} people active · generated {new Date(data.generatedAt).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {[30, 90, 180].map((d) => (
            <Button key={d} size="sm" variant={d === days ? "default" : "outline"} onClick={() => setDays(d)}>
              {d}d
            </Button>
          ))}
          <Button size="sm" variant="outline" onClick={exportCsv}><Download className="h-4 w-4" /> CSV</Button>
          <Button size="sm" variant="outline" onClick={() => setDays((d) => d)} disabled={loading}>
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          </Button>
        </div>
      </div>

      {/* Headline volume. tabular-nums so the figures do not shuffle between refreshes. */}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["People active", data.totals.activePeople],
          ["Drafts created", data.totals.draftsCreated],
          ["AI writer runs", data.totals.articlesWritten],
          ["Images generated", data.totals.assetsGenerated],
          ["Emails sent", data.totals.emailsSent],
        ].map(([label, value]) => (
          <Card key={label as string}>
            <CardContent className="p-4">
              <div className="text-2xl font-light tabular-nums">{(value as number).toLocaleString()}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{label as string}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <MetricCard title="Wins" icon={<TrendingUp className="h-4 w-4 text-success" />} metrics={data.wins}
          blurb="Outcomes the tool produced." />
        <MetricCard title="Losses" icon={<TriangleAlert className="h-4 w-4 text-warning" />} metrics={data.losses}
          blurb="Counted with the same rigour as the wins." />
        <MetricCard title="Opportunities" icon={<Target className="h-4 w-4 text-highlight-ink" />} metrics={data.opportunities}
          blurb="Work started and not finished." />
      </div>

      {/* Weekly trend, hand-drawn bars: this is two numbers a week, and a charting dependency for that
          would cost more than it explains. */}
      {data.trend.length > 1 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Weekly activity</CardTitle>
            <CardDescription>Content work and outreach volume, oldest week first.</CardDescription></CardHeader>
          <CardContent>
            <div className="flex items-end gap-2 overflow-x-auto pb-1">
              {data.trend.map((t) => (
                <div key={t.week} className="flex min-w-14 flex-1 flex-col items-center gap-1.5">
                  <div className="flex h-24 w-full items-end justify-center gap-1">
                    <div className="w-1/3 rounded-t bg-highlight" style={{ height: `${((t.drafts + t.sessions) / peak) * 100}%` }}
                      title={`${t.drafts} drafts, ${t.sessions} AI runs`} />
                    <div className="w-1/3 rounded-t bg-muted-foreground/40" style={{ height: `${(t.emails / peak) * 100}%` }}
                      title={`${t.emails} emails`} />
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">{t.week.slice(5)}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-highlight" /> content</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-muted-foreground/40" /> outreach</span>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><Users className="h-4 w-4" /> Who is using it</CardTitle>
          <CardDescription>
            Active days counts distinct days with recorded activity, so steady use and one busy afternoon do not look alike.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium">Person</th>
                  <th className="px-3 py-2.5 text-right font-medium">Active days</th>
                  <th className="px-3 py-2.5 text-right font-medium">Drafts</th>
                  <th className="px-3 py-2.5 text-right font-medium">AI runs</th>
                  <th className="px-3 py-2.5 text-right font-medium">Sent</th>
                  <th className="px-3 py-2.5 text-right font-medium">Replies</th>
                  <th className="px-3 py-2.5 text-left font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.email} className="border-b border-border/60 last:border-0">
                    <td className="max-w-[240px] px-4 py-3">
                      <span className="block truncate">{p.email}</span>
                      {p.email === "dev@local" && (
                        <span className="text-xs text-muted-foreground">local development account</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{p.activeDays}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{p.draftsCreated || "—"}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{p.aiSessions || "—"}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{p.emailsSent || "—"}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{p.repliesWon || "—"}</td>
                    <td className="px-3 py-3 text-muted-foreground">{p.lastSeen?.slice(0, 10) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {data.caveats.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Read this before quoting the numbers</CardTitle></CardHeader>
          <CardContent className="space-y-2 pt-0">
            {data.caveats.map((c) => (
              <p key={c} className="flex gap-2 text-sm text-muted-foreground">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />{c}
              </p>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MetricCard({ title, icon, metrics, blurb }: { title: string; icon: React.ReactNode; metrics: Metric[]; blurb: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">{icon} {title}</CardTitle>
        <CardDescription>{blurb}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {metrics.map((m) => (
          <div key={m.label} className="space-y-0.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-sm">{m.label}</span>
              <span className="shrink-0 tabular-nums">
                <span className="text-base">{m.value.toLocaleString()}</span>
                {m.outOf != null && (
                  <span className="text-xs text-muted-foreground">
                    {" "}/ {m.outOf.toLocaleString()}
                    {m.outOf > 0 && <> · {Math.round((m.value / m.outOf) * 100)}%</>}
                  </span>
                )}
              </span>
            </div>
            {m.detail && <p className="text-xs text-muted-foreground">{m.detail}</p>}
            {/* The provenance line. This is what makes a quoted figure defensible. */}
            <p className="font-mono text-xs text-muted-foreground/70">{m.source}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
