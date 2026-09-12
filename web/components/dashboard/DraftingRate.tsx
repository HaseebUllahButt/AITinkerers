"use client";

// Blog drafting rate, before and after Summit — on the dashboard because it is the one number that
// answers "is this tool worth it".
//
// Two honesty rules shape what this renders, and both cost a bit of visual punch:
//
//  1. Rates are PER DAY. The current month is partial, so a bar chart of monthly totals shows the
//     present month as a dip that does not exist. Per-day removes that artefact in both directions.
//  2. The review backlog is on the card, not buried in the report. Drafting more than doubled while
//     PUBLISHING did not move, because most drafts are queued for a human. A chart that showed only
//     the gain would be technically true and would misread the situation — the bottleneck moved from
//     writing to reviewing, and that is the actionable part.

import { useEffect, useState } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine, Legend,
} from "recharts";
import { TrendingUp, TrendingDown, Minus, AlertCircle, Loader2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface MonthPoint {
  month: string; days: number;
  strapiCreated: number; summitDrafts: number; summitSynced: number;
  unique: number; perDay: number; summitEra: boolean;
}
interface Report {
  ok: boolean;
  months: MonthPoint[];
  summitStart: string;
  before: { from: string; to: string; items: number; days: number; perDay: number };
  after: { from: string; to: string; items: number; days: number; perDay: number };
  changePct: number;
  bestMonth: { month: string; perDay: number };
  review: { summitTotal: number; synced: number; awaitingReview: number; syncFailed: number };
  problems: string[];
  error?: string;
}

const PRE = "var(--chart-3)";
const POST = "var(--chart-1)";

/** `2026-08` → `Aug 26`. The axis has a dozen of these and the year matters at the boundary. */
function label(month: string): string {
  const [y, m] = month.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m) - 1] ?? m} ${y.slice(2)}`;
}

export function DraftingRate() {
  const [r, setR] = useState<Report | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // No set-state-in-effect suppression needed here: every setState lands after an await, so the
  // rule cannot see it as a synchronous cascading render.
  useEffect(() => {
    let live = true;
    fetch("/api/reports/drafting-rate")
      .then((res) => res.json())
      .then((d: Report) => { if (!live) return; if (d.ok) setR(d); else setFailed(d.error ?? "the report could not be built"); })
      .catch((e: unknown) => { if (live) setFailed(e instanceof Error ? e.message : "network error"); });
    return () => { live = false; };
  }, []);

  if (failed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl font-semibold">Blog drafting rate</CardTitle>
        </CardHeader>
        <CardContent>
          {/* A failed load is NOT a flat line. Saying so is the whole point — a zeroed chart here
              would read as "the tool stopped working". */}
          <p className="flex items-start gap-1.5 text-sm text-warning">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Couldn&apos;t build the report — this is <b>not</b> a zero result ({failed}).</span>
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!r) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl font-semibold">Blog drafting rate</CardTitle>
          <CardDescription>Reading the CMS history and Summit&apos;s drafts…</CardDescription>
        </CardHeader>
        <CardContent className="flex h-[240px] items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const up = r.changePct > 0;
  const flat = r.changePct === 0;
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  const data = r.months.map((m) => ({ ...m, name: label(m.month) }));
  // The boundary sits between the last pre-Summit month and the first Summit one.
  const firstEra = data.find((d) => d.summitEra)?.name;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-xl font-semibold">Blog drafting rate</CardTitle>
            <CardDescription>
              Blog content created per day — the CMS history, plus what Summit has drafted since{" "}
              {r.summitStart}. Counted once: a Summit draft that reached the CMS is not counted twice.
            </CardDescription>
          </div>
          <div className="flex items-baseline gap-2 shrink-0">
            <span className={`flex items-center gap-1 text-2xl font-semibold ${up ? "text-success" : flat ? "" : "text-warning"}`}>
              <Icon className="h-5 w-5" />
              {up ? "+" : ""}{r.changePct}%
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
          <span className="text-muted-foreground">
            Before <span className="font-mono text-foreground">{r.before.perDay}/day</span>{" "}
            <span className="text-xs">({r.before.items} over {r.before.days}d, {r.before.from}–{r.before.to})</span>
          </span>
          <span className="text-muted-foreground">
            Since Summit <span className="font-mono text-foreground">{r.after.perDay}/day</span>{" "}
            <span className="text-xs">({r.after.items} over {r.after.days}d)</span>
          </span>
          <span className="text-xs text-muted-foreground">
            Best month: {label(r.bestMonth.month)} at {r.bestMonth.perDay}/day
          </span>
        </div>

        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 4 }}>
            <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={48} />
            <YAxis yAxisId="l" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11 }} width={34} />
            <Tooltip
              contentStyle={{ borderRadius: 8, fontSize: 12 }}
              formatter={(v: unknown, name: unknown) =>
                name === "perDay" ? [`${v}/day`, "Rate"] : [`${v}`, "Items drafted"]}
              labelFormatter={(l: unknown) => {
                const p = data.find((d) => d.name === l);
                if (!p) return String(l);
                return `${l} · ${p.days} day${p.days === 1 ? "" : "s"}${p.summitEra ? " · Summit era" : ""}`;
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => (v === "perDay" ? "per day" : "items")} />
            {/* Marks where Summit's pipeline starts, so the step is attributable rather than implied
                by colour alone. */}
            {firstEra && <ReferenceLine yAxisId="l" x={firstEra} stroke="var(--muted-foreground)" strokeDasharray="3 3" />}
            <Bar yAxisId="l" dataKey="unique" name="items" radius={[3, 3, 0, 0]} fill={POST}>
              {data.map((d) => <Cell key={d.month} fill={d.summitEra ? POST : PRE} />)}
            </Bar>
            <Line yAxisId="r" type="monotone" dataKey="perDay" name="perDay" stroke={POST} strokeWidth={2} dot={{ r: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>

        {/* ── The caveat, on the card ──────────────────────────────────────────────────────────
            Drafting is not publishing. Most of what Summit produced is still queued for review, so
            the gain above is throughput into the review queue, not posts on the site. */}
        <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Drafting, not publishing.</span>{" "}
          Of {r.review.summitTotal} drafts Summit has produced, <b className="text-foreground">{r.review.synced}</b> reached the CMS
          and <b className="text-foreground">{r.review.awaitingReview}</b> are still awaiting review
          {r.review.syncFailed > 0 && <> ({r.review.syncFailed} failed to sync)</>}. The gain above is
          throughput into the review queue — the bottleneck has moved from writing to reviewing.
          {r.after.days < 60 && (
            <> Measured over {r.after.days} days, so treat it as an early signal rather than a settled trend.</>
          )}
        </div>

        {r.problems.length > 0 && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>Partial data: {r.problems.join(" ")}</span>
          </p>
        )}

        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="text-xs">pre-Summit</Badge>
          <Badge variant="outline" className="border-highlight/40 text-highlight text-xs">Summit era</Badge>
        </div>
      </CardContent>
    </Card>
  );
}
