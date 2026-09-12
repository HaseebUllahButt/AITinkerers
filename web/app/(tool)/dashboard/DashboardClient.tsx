"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { ProviderStatus } from "@/app/api/status/route";
import { loadHistory, clearHistory, type AuditRecord } from "@/lib/audit/history";

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

export default function DashboardClient() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [history, setHistory] = useState<AuditRecord[]>([]);

  useEffect(() => {
    setHistory(loadHistory());
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
          <p className="text-[10px] uppercase tracking-[0.3em] text-primary">SearchOps</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Dashboard</h1>
        </div>
        <Link href="/audit" className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground">
          Open the audit →
        </Link>
      </header>

      <form
        className="mt-6 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) router.push(`/audit?url=${encodeURIComponent(url.trim())}`);
        }}
      >
        <input
          id="dash-url"
          type="text"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="example.com"
          aria-label="URL to audit"
          className="h-11 flex-1 border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button type="submit" disabled={!url.trim()} className="h-11 bg-primary px-6 text-sm font-medium text-primary-foreground disabled:opacity-50">
          Audit a site
        </button>
      </form>

      <div className="mt-8 space-y-5">
        <Panel
          title="What's working"
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
            <p className="text-sm text-muted-foreground">
              Nothing yet. Audit a site above and it will appear here.
            </p>
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
