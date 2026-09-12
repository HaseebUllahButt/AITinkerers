"use client";

import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { AuditResult } from "@/lib/audit/run";
import { engineLabel } from "@/lib/audit/engines";

// ── Colour ────────────────────────────────────────────────────────────────────
//
// Two roles, not a categorical series: the audited site and everyone else. Orange means "you" in
// every chart on the page, so a reader never has to re-learn the legend between panels.
//
// There is deliberately no per-engine hue. Three engine colours failed CVD validation every way
// they were tried — blue and violet collapse under protan and deutan — and orange was already
// spoken for. So the per-engine view is small multiples instead: same two roles repeated, which is
// colourblind-safe by construction because identity comes from the panel title, not the fill.
const US = "var(--primary)";
const THEM = "color-mix(in srgb, var(--muted-foreground) 55%, transparent)";
const AXIS = "var(--muted-foreground)";

function Tip({ active, payload, suffix }: { active?: boolean; payload?: any[]; suffix: string }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-popover-foreground">{d.name}</div>
      <div className="mt-0.5 tabular-nums text-muted-foreground">
        {d.value}
        {suffix}
        {d.isUs ? " · you" : ""}
      </div>
    </div>
  );
}

interface Row {
  name: string;
  value: number;
  isUs: boolean;
}

/** One horizontal bar chart. Thin marks, recessive axes, values labelled directly. */
function Bars({ rows, suffix, max }: { rows: Row[]; suffix: string; max?: number }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">Nothing to chart yet.</p>;
  // 28px a row keeps bars thin and the panel proportional to its content.
  const height = Math.max(120, rows.length * 30 + 16);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 44, bottom: 0, left: 0 }} barCategoryGap={6}>
        <XAxis type="number" domain={[0, max ?? "dataMax"]} hide />
        <YAxis
          type="category"
          dataKey="name"
          width={132}
          tickLine={false}
          axisLine={false}
          tick={{ fill: AXIS, fontSize: 12 }}
        />
        <Tooltip cursor={{ fill: "color-mix(in srgb, var(--muted-foreground) 12%, transparent)" }} content={<Tip suffix={suffix} />} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false}>
          {rows.map((r) => (
            <Cell key={r.name} fill={r.isUs ? US : THEM} />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            formatter={(v: number) => `${v}${suffix}`}
            style={{ fill: AXIS, fontSize: 11, fontVariantNumeric: "tabular-nums" }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="border border-border bg-card p-5">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function ScoreComparison({ result }: { result: AuditResult }) {
  const rows: Row[] = [
    { name: result.domain, value: result.score, isUs: true },
    ...result.comparison.competitors
      .filter((c) => c.reachable)
      .map((c) => ({ name: c.domain, value: c.score, isUs: false })),
  ].sort((a, b) => b.value - a.value);

  if (rows.length < 2) return null;
  return (
    <Panel
      title="Score against competitors"
      subtitle="Every site measured on the identical pass — same checks, same weighting."
    >
      <Bars rows={rows} suffix="" max={100} />
    </Panel>
  );
}

export function ShareOfVoiceChart({ result }: { result: AuditResult }) {
  const share = result.share;
  if (!share.ran || !share.brands.length) return null;
  const rows: Row[] = share.brands
    .map((b) => ({ name: b.brand, value: Math.round(b.share * 100), isUs: b.isUs }))
    .filter((r) => r.value > 0 || r.isUs);

  return (
    <Panel
      title="Share of voice"
      subtitle={`How often each brand is named across ${share.answersCounted} answers to ${share.prompts.length} buyer questions. The questions name no brand — the measurement is who the assistant volunteers.`}
    >
      <Bars rows={rows} suffix="%" max={100} />
    </Panel>
  );
}

export function ShareByEngine({ result }: { result: AuditResult }) {
  const share = result.share;
  if (!share.ran || share.enginesUsed.length < 2) return null;

  // Configured and available, but produced no usable answer in this run.
  const silent = share.engineStatuses
    .filter((st) => st.available && !share.enginesUsed.includes(st.engine))
    .map((st) => st.engine);

  return (
    <Panel
      title="Share of voice by engine"
      subtitle={
        `One panel per assistant. A brand can be strong in one and absent from another, and a blended number would hide exactly that.` +
        (silent.length
          ? ` ${silent.map(engineLabel).join(" and ")} ${silent.length > 1 ? "were" : "was"} asked but returned nothing, so ${silent.length > 1 ? "they are" : "it is"} not shown.`
          : "")
      }
    >
      <div className="grid gap-6 md:grid-cols-3">
        {share.enginesUsed.map((engine) => {
          const rows: Row[] = share.brands
            .map((b) => ({ name: b.brand, value: Math.round((b.byEngine[engine] ?? 0) * 100), isUs: b.isUs }))
            .filter((r) => r.value > 0 || r.isUs);
          return (
            <div key={engine}>
              <h3 className="mb-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                {engineLabel(engine)}
              </h3>
              <Bars rows={rows} suffix="%" max={100} />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/**
 * The headline figures.
 *
 * Deliberately not a chart: four unrelated numbers with no shared scale have nothing to compare
 * against each other, and a donut of "findings by severity" would take a three-number list and
 * make it harder to read.
 */
export function Scorecards({ result }: { result: AuditResult }) {
  const critical = result.findings.filter((f) => f.severity === "critical").length;
  const warning = result.findings.filter((f) => f.severity === "warning").length;
  const tiles = [
    { label: "Score", value: String(result.score), tone: "accent" as const },
    { label: "Critical", value: String(critical), tone: critical ? ("bad" as const) : ("good" as const) },
    { label: "Warnings", value: String(warning), tone: warning ? ("warn" as const) : ("good" as const) },
    {
      label: "Share of voice",
      value: result.share.ran ? `${Math.round(result.share.ourShare * 100)}%` : "—",
      tone: "accent" as const,
    },
  ];
  const toneClass = {
    accent: "text-primary",
    good: "text-success",
    warn: "text-warning",
    bad: "text-destructive",
  };

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="border border-border bg-card p-4">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{t.label}</div>
          <div className={`mt-1 text-3xl font-semibold tabular-nums ${toneClass[t.tone]}`}>{t.value}</div>
        </div>
      ))}
    </div>
  );
}
