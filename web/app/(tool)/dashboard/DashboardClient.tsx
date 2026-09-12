"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { ProviderStatus } from "@/app/api/status/route";
import { clearHistory, clearLastResult, loadHistory, loadLastResult, type AuditRecord } from "@/lib/audit/history";
import type { AuditResult, Severity } from "@/lib/audit/run";
import { DEMO_AUDIT } from "@/lib/demo";
import {
  Actions,
  ComparisonTable,
  ScoreComparison,
  Scorecards,
  ShareByEngine,
  ShareOfVoiceChart,
  Verdict,
} from "@/components/audit/ResultCharts";

const GROUP_LABEL: Record<ProviderStatus["group"], string> = {
  model: "Reasoning",
  engine: "Answer engines",
  search: "Web search",
};

const GROUP_NOTE: Record<ProviderStatus["group"], string> = {
  model: "Writes the prompt sets, the suggestions and the generated files. Everything below degrades without it.",
  engine: "Where share of voice is measured. Each one is a separate audience.",
  search: "How competitors are discovered. One working provider is enough.",
};

function Dot({ status }: { status: ProviderStatus }) {
  const colour = !status.configured
    ? "bg-muted-foreground/40"
    : status.working === false
      ? "bg-destructive"
      : status.working === true
        ? "bg-success"
        : "bg-warning";
  return <span className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 ${colour}`} aria-hidden />;
}

function Panel({ title, subtitle, children, action }: {
  title: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <section className="border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

interface PendingAction {
  id: string;
  kind: string;
  summary: string;
  status: string;
  proposed_at: string;
  result?: { error?: string; pr?: string; messageId?: string } | null;
}

function ApprovalsPanel({ domain }: { domain: string }) {
  const [actions, setActions] = useState<PendingAction[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    fetch(`/api/actions?domain=${encodeURIComponent(domain)}`)
      .then((r) => r.json())
      .then((d) => setActions(d.actions ?? []))
      .catch(() => setActions([]));
  };
  useEffect(load, [domain]);

  async function decide(actionId: string, decision: "approved" | "declined") {
    setBusy(actionId);
    try {
      await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionId, decision }),
      });
      load();
    } finally {
      setBusy(null);
    }
  }

  const pending = actions.filter((a) => a.status === "proposed");
  const recent = actions.filter((a) => a.status !== "proposed").slice(0, 5);

  return (
    <Panel
      title="Approvals"
      subtitle="What the agent wants to do outside SearchOps. Approving runs it — a PR opens, an email sends, a post lands."
    >
      {actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing proposed yet. Ask the agent — in Slack, Discord, WhatsApp, or Telegram — to act on this audit.
        </p>
      ) : (
        <div className="space-y-3">
          {pending.map((a) => (
            <article key={a.id} className="border border-border p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{a.kind.replaceAll("_", " ")}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{new Date(a.proposed_at).toLocaleDateString()}</span>
              </div>
              <p className="mt-1 text-sm">{a.summary}</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy === a.id}
                  onClick={() => void decide(a.id, "approved")}
                  className="bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
                >
                  Approve — run it
                </button>
                <button
                  type="button"
                  disabled={busy === a.id}
                  onClick={() => void decide(a.id, "declined")}
                  className="border border-input px-3 py-1.5 text-xs text-muted-foreground disabled:opacity-50"
                >
                  Decline
                </button>
              </div>
            </article>
          ))}
          {recent.map((a) => (
            <article key={a.id} className="border-l-2 border-border py-1 pl-3">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-muted-foreground">{a.kind.replaceAll("_", " ")}</span>
                <span className={a.status === "executed" ? "text-success" : a.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                  {a.status}
                </span>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {a.result?.error ? String(a.result.error) : a.result?.pr ? String(a.result.pr) : a.summary}
              </p>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };
const SEVERITY_INK: Record<Severity, string> = {
  critical: "text-destructive",
  warning: "text-warning",
  ok: "text-success",
};

function FindingsPanel({ result }: { result: AuditResult }) {
  const findings = [...result.findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  return (
    <Panel title="Findings" subtitle="Ordered by what it costs you. Evidence first, then the fix.">
      <div className="space-y-3">
        {findings.map((f) => (
          <article
            key={f.id}
            className="border-l-2 py-2 pl-4"
            style={{
              borderLeftColor:
                f.severity === "ok"
                  ? "var(--success)"
                  : f.severity === "warning"
                    ? "var(--warning)"
                    : "var(--destructive)",
            }}
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className={`text-[10px] uppercase tracking-[0.2em] ${SEVERITY_INK[f.severity]}`}>
                {f.severity}
              </span>
              <span className="text-sm font-medium">{f.title}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{f.evidence}</p>
            {f.fix && (
              <p className="mt-1 text-sm">
                <span className="text-muted-foreground">Fix — </span>
                {f.fix}
              </p>
            )}
          </article>
        ))}
      </div>
    </Panel>
  );
}

export default function DashboardClient() {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [history, setHistory] = useState<AuditRecord[]>([]);
  const [result, setResult] = useState<AuditResult | null>(null);

  useEffect(() => {
    setHistory(loadHistory());
    setResult(loadLastResult<AuditResult>());
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => setProviders(d.providers ?? []))
      .catch(() => setProviders([]));
  }, []);

  const groups: ProviderStatus["group"][] = ["model", "engine", "search"];
  const degraded = providers?.filter((p) => !p.configured || p.working === false) ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-10">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {result ? result.brand : "Dashboard"}
          </h1>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            {result
              ? `${result.domain} · audited ${new Date(result.fetchedAt).toLocaleString()} in ${(result.durationMs / 1000).toFixed(0)}s`
              : "What is answering, and what you have looked at. Run an audit from the landing page or the sidebar."}
          </p>
        </div>
        {result && (
          <button
            onClick={() => { clearLastResult(); setResult(null); }}
            className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            Dismiss results
          </button>
        )}
      </header>

      {result && (
        <div className="mt-6 space-y-6">
          {/* Verdict first: what happened, before the numbers that justify it. */}
          <Verdict result={result} />
          <Scorecards result={result} />

          {/* Two columns on desktop — these panels are short, and stacking them left a column of
              white space beside every one. */}
          <div className="grid gap-6 lg:grid-cols-2">
            <ShareOfVoiceChart result={result} />
            <ScoreComparison result={result} />
          </div>

          <ShareByEngine result={result} />
          <ComparisonTable result={result} />
          <Actions result={result} />
          <FindingsPanel result={result} />
          <ApprovalsPanel domain={result.domain} />
        </div>
      )}

      <div className="mt-8 space-y-5">
        <Panel
          title={result ? "Providers" : "What's working"}
          subtitle={
            providers === null
              ? "Checking…"
              : degraded.length
                ? `${degraded.length} of ${providers.length} providers need attention. Probed live, not read from config.`
                : "Every provider is answering."
          }
        >
          {providers === null ? (
            <p className="text-sm text-muted-foreground">Probing providers…</p>
          ) : (
            <div className="space-y-5">
              {groups.map((g) => {
                const rows = providers.filter((p) => p.group === g);
                if (!rows.length) return null;
                return (
                  <div key={g}>
                    <h3 className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{GROUP_LABEL[g]}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{GROUP_NOTE[g]}</p>
                    <div className="mt-2 space-y-1">
                      {rows.map((p) => (
                        <div key={`${p.group}-${p.id}`} className="flex items-start gap-2 border-b border-border/60 py-2 last:border-b-0">
                          <Dot status={p} />
                          <div className="min-w-0 flex-1">
                            <span className="text-sm">{p.label}</span>
                            <p className="mt-0.5 break-words text-xs text-muted-foreground">{p.detail}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel
          title="Recent audits"
          subtitle="Kept in this browser only — there is no server-side store yet, so this list is yours alone and does not sync."
          action={
            history.length > 0 ? (
              <button
                onClick={() => { clearHistory(); setHistory([]); }}
                className="text-xs uppercase tracking-wider text-muted-foreground hover:text-destructive"
              >
                Clear
              </button>
            ) : undefined
          }
        >
          {history.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Nothing yet. Run an audit from the landing page or the sidebar.
              </p>
              <button
                onClick={() => setResult(DEMO_AUDIT)}
                className="border border-border px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-primary"
              >
                Load demo data
              </button>
              <p className="text-xs text-muted-foreground">
                A complete audit of a site that does not exist, so every panel can be seen without
                spending a minute of real crawls and model calls.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {history.map((h) => (
                <Link
                  key={`${h.domain}-${h.at}`}
                  href={`/audit?url=${encodeURIComponent(h.url)}`}
                  className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-b-0 hover:text-primary"
                >
                  <div className="min-w-0">
                    <span className="text-sm">{h.brand}</span>
                    <code className="ml-2 text-xs text-muted-foreground">{h.domain}</code>
                  </div>
                  <div className="flex shrink-0 items-baseline gap-3 text-xs text-muted-foreground">
                    <span>{h.criticals > 0 ? `${h.criticals} critical` : "no criticals"}</span>
                    <span className="tabular-nums">{new Date(h.at).toLocaleDateString()}</span>
                    <span className="w-8 text-right text-sm tabular-nums text-primary">{h.score}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
