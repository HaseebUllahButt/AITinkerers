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
  // 26px a row, and no floor: a two-row panel should be two rows tall, not a third of a screen.
  const height = rows.length * 26 + 8;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 44, bottom: 0, left: 0 }} barCategoryGap={4}>
        <XAxis type="number" domain={[0, max ?? "dataMax"]} hide />
        <YAxis
          type="category"
          dataKey="name"
          width={112}
          tickLine={false}
          axisLine={false}
          tick={{ fill: AXIS, fontSize: 12 }}
        />
        <Tooltip cursor={{ fill: "color-mix(in srgb, var(--muted-foreground) 12%, transparent)" }} content={<Tip suffix={suffix} />} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false}>
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
  // Our own profile score, NOT result.score. The two are different measures — result.score is
  // derived from the findings, a competitor's is the profile weighting — and charting one against
  // the other put two scales on one axis, which is the fastest way to a confidently wrong chart.
  const ourScore = result.comparison.us?.score ?? result.score;
  const rows: Row[] = [
    { name: result.domain, value: ourScore, isUs: true },
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

/** One sentence naming where the site stands, above the numbers that justify it. */
export function Verdict({ result }: { result: AuditResult }) {
  const critical = result.findings.filter((f) => f.severity === "critical").length;
  const share = result.share.ran ? Math.round(result.share.ourShare * 100) : null;
  const rival = result.share.brands.find((b) => !b.isUs && b.share > result.share.ourShare);
  const behind = result.comparison.ran ? result.comparison.gaps.length : 0;

  const parts: string[] = [];
  parts.push(
    critical > 0
      ? `${critical} critical ${critical === 1 ? "issue" : "issues"} is costing you visibility right now.`
      : "Nothing critical is blocking you.",
  );
  if (share !== null) {
    parts.push(
      rival
        ? `Assistants name you in ${share}% of buyer questions — ${rival.brand} beats you at ${Math.round(rival.share * 100)}%.`
        : `Assistants name you in ${share}% of buyer questions, ahead of every competitor tracked.`,
    );
  }
  if (behind) parts.push(`You trail on ${behind} ${behind === 1 ? "check" : "checks"} in the comparison below.`);

  return (
    <p className="max-w-3xl text-base leading-relaxed text-foreground">
      {parts.join(" ")}
    </p>
  );
}

/** The comparison as a table — a grid of values is read by scanning, not by charting. */
export function ComparisonTable({ result }: { result: AuditResult }) {
  const cmp = result.comparison;
  if (!cmp.ran || !cmp.rows.length) return null;
  const rivals = cmp.competitors.filter((c) => c.reachable);

  return (
    <Panel
      title="Side by side"
      subtitle={cmp.weLead ? "You lead overall on the same checks." : `${cmp.leaderDomain} leads overall.`}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="py-2 pr-4 text-left text-[10px] font-normal uppercase tracking-[0.2em] text-muted-foreground">Check</th>
              <th className="py-2 pr-4 text-right text-[10px] font-normal uppercase tracking-[0.2em] text-primary">{result.domain}</th>
              {rivals.map((c) => (
                <th key={c.domain} className="py-2 pr-4 text-right text-[10px] font-normal uppercase tracking-[0.2em] text-muted-foreground">
                  {c.domain.replace(/\.[a-z.]+$/, "")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cmp.rows.map((row) => (
              <tr key={row.check} className="border-b border-border/50 last:border-b-0">
                <td className="py-2 pr-4 text-muted-foreground">{row.check}</td>
                <td className={`py-2 pr-4 text-right tabular-nums ${row.weLead ? "text-foreground" : "text-destructive"}`}>
                  {row.us}
                </td>
                {rivals.map((c) => (
                  <td key={c.domain} className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                    {row.them[c.domain] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** What to do, with the generated files beside it. */
export function Actions({ result }: { result: AuditResult }) {
  const { suggestions, artifacts } = result.comparison;
  if (!suggestions.length && !artifacts.length) return null;
  const impactInk = { high: "text-destructive", medium: "text-warning", low: "text-muted-foreground" };

  return (
    <Panel title="What to do" subtitle="Built from the gaps above. Every rationale cites the comparison.">
      <ol className="space-y-3">
        {suggestions.map((s, i) => (
          <li key={i} className="flex gap-3 border-b border-border/50 pb-3 last:border-b-0 last:pb-0">
            <span className="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium">{s.title}</span>
                <span className={`text-[10px] uppercase tracking-wider ${impactInk[s.impact]}`}>{s.impact} impact</span>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.effort} effort</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{s.rationale}</p>
            </div>
          </li>
        ))}
      </ol>

      {artifacts.length > 0 && (
        <div className="mt-5 space-y-3 border-t border-border pt-5">
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Written for you — paste these in
          </p>
          {artifacts.map((a) => (
            <details key={a.id} className="border border-border">
              <summary className="cursor-pointer px-3 py-2 text-sm">
                {a.label} <code className="ml-2 text-xs text-muted-foreground">{a.target}</code>
              </summary>
              <pre className="max-h-72 overflow-auto border-t border-border bg-background p-3 text-xs leading-relaxed">
                <code>{a.content}</code>
              </pre>
            </details>
          ))}
        </div>
      )}
    </Panel>
  );
}
