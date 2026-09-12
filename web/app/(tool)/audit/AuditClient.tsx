"use client";

import { useState } from "react";

import type { AuditResult, Finding, Severity } from "@/lib/audit/run";
import { engineLabel } from "@/lib/audit/engines";

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };

const SEVERITY_STYLE: Record<Severity, { dot: string; label: string }> = {
  critical: { dot: "bg-destructive", label: "text-destructive" },
  warning: { dot: "bg-warning", label: "text-warning" },
  ok: { dot: "bg-success", label: "text-success" },
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-b-0">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-right text-sm tabular-nums">{value}</span>
    </div>
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

function FindingCard({ f }: { f: Finding }) {
  const s = SEVERITY_STYLE[f.severity];
  return (
    <article className="border-l-2 border-border py-3 pl-4" style={{ borderLeftColor: `var(--${f.severity === "ok" ? "success" : f.severity === "warning" ? "warning" : "destructive"})` }}>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-1.5 w-1.5 ${s.dot}`} aria-hidden />
        <span className={`text-[10px] uppercase tracking-[0.2em] ${s.label}`}>{f.severity}</span>
      </div>
      <h3 className="mt-1.5 text-sm font-medium">{f.title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{f.evidence}</p>
      {f.fix && <p className="mt-2 text-sm"><span className="text-muted-foreground">Fix — </span>{f.fix}</p>}
    </article>
  );
}

export default function AuditClient() {
  const [url, setUrl] = useState("");
  const [rivals, setRivals] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AuditResult | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, competitors: rivals.split(",").map((c) => c.trim()).filter(Boolean) }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "The audit failed.");
      else setResult(data as AuditResult);
    } catch {
      setError("Could not reach the audit service.");
    } finally {
      setBusy(false);
    }
  }

  const findings = result ? [...result.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) : [];

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-10">
      <header>
        <p className="text-[10px] uppercase tracking-[0.3em] text-primary">SearchOps</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Audit a site</h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          Reads the page, its robots.txt, llms.txt and sitemap. Runs synthetic buyer questions
          across several assistants to measure your share of voice against competitors, audits
          their sites on the same checks, then writes the fixes.
        </p>
      </header>

      <form onSubmit={run} className="mt-6 flex flex-col gap-2 sm:flex-row">
        <input
          id="audit-url"
          type="text"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="example.com"
          aria-label="URL to audit"
          className="h-11 flex-1 border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="h-11 bg-primary px-6 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Auditing…" : "Run audit"}
        </button>
      </form>

      <div className="mt-2">
        <input
          id="audit-rivals"
          type="text"
          value={rivals}
          onChange={(e) => setRivals(e.target.value)}
          placeholder="competitors, comma separated — optional"
          aria-label="Competitor domains"
          className="h-10 w-full border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          You know your competitors better than a model does. Leave it blank and the audit works
          out who they are from what the assistants name.
        </p>
      </div>

      {busy && (
        <p className="mt-4 text-sm text-muted-foreground">
          Fetching the page and its machine-readable files, running synthetic prompts across every
          configured assistant, profiling each competitor on the same checks, then writing the
          suggestions. This is a few minutes of real calls, not a spinner.
        </p>
      )}

      {error && (
        <div className="mt-6 border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>
      )}

      {result && (
        <div className="mt-8 space-y-5">
          <section className="border border-border bg-card p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">{result.brand}</h2>
                <p className="text-xs text-muted-foreground">{result.domain} · HTTP {result.status} · {(result.durationMs / 1000).toFixed(1)}s</p>
              </div>
              <div className="text-right">
                <div className="text-3xl font-semibold tabular-nums text-primary">{result.score}</div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">score</div>
              </div>
            </div>
          </section>

          <Panel title="Findings" subtitle="Ordered by what it costs you. Evidence first, then the fix.">
            <div className="space-y-1">
              {findings.map((f) => <FindingCard key={f.id} f={f} />)}
            </div>
          </Panel>

          <div className="grid gap-5 md:grid-cols-2">
            <Panel title="Machine-readable files" subtitle="What the site publishes about itself.">
              <Row label="robots.txt" value={result.robots.found ? `found · ${result.robots.groups.length} groups` : "missing"} />
              <Row label="llms.txt" value={result.llmsTxt.found ? `${result.llmsTxt.bytes} bytes` : "missing"} />
              <Row label="llms-full.txt" value={result.llmsTxt.fullFound ? "found" : "missing"} />
              <Row label="sitemap" value={result.sitemap.found ? `${result.sitemap.urlCount} URLs` : "missing"} />
              {result.sitemap.newestLastmod && <Row label="newest lastmod" value={result.sitemap.newestLastmod} />}
            </Panel>

            <Panel title="Page signals" subtitle={result.renderChecked ? "Raw HTML, diffed against the rendered page." : "Raw HTML only — set PLAYWRIGHT_ENABLED=true to diff against the rendered page."}>
              <Row label="title" value={result.onpage?.hasTitle ? "yes" : "no"} />
              <Row label="meta description" value={result.onpage?.hasMetaDescription ? "yes" : "no"} />
              <Row label="h1" value={result.onpage ? String(result.onpage.h1Count) : "—"} />
              <Row label="json-ld" value={result.onpage?.hasJsonLd ? "yes" : "no"} />
              <Row label="words" value={result.onpage ? result.onpage.wordCount.toLocaleString() : "—"} />
              <Row label="render mode" value={result.render ? result.render.mode : "not checked"} />
            </Panel>
          </div>

          <Panel title="AI crawler access" subtitle="Blocking a retrieval agent removes you from that product's answers. Blocking a training agent costs nothing in visibility — they are not the same decision.">
            <div className="space-y-1">
              {result.robots.aiAccess.map((a) => (
                <div key={a.bot.key} className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-b-0">
                  <div className="min-w-0">
                    <span className="text-sm">{a.bot.label}</span>
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">{a.bot.controls}</span>
                  </div>
                  <span className={`text-xs ${a.blocked ? (a.bot.controls === "retrieval" ? "text-destructive" : "text-muted-foreground") : "text-success"}`}>
                    {a.blocked ? "blocked" : "allowed"}
                  </span>
                </div>
              ))}
            </div>
          </Panel>

          {/* ── Share of voice ─────────────────────────────────────── */}
          {result.share.ran ? (
            <Panel
              title="Share of voice"
              subtitle={`${result.share.prompts.length} synthetic buyer questions across ${result.share.enginesUsed.map(engineLabel).join(", ")}. None of them name a brand — the measurement is who the assistant volunteers. ${result.share.answersCounted} answers counted.`}
            >
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="py-2 pr-4 text-xs font-normal uppercase tracking-wider text-muted-foreground">Brand</th>
                      <th className="py-2 pr-4 text-right text-xs font-normal uppercase tracking-wider text-muted-foreground">Share</th>
                      {result.share.enginesUsed.map((e) => (
                        <th key={e} className="py-2 pr-4 text-right text-xs font-normal uppercase tracking-wider text-muted-foreground">{engineLabel(e)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.share.brands.map((b) => (
                      <tr key={b.brand} className={`border-b border-border/60 ${b.isUs ? "text-primary" : ""}`}>
                        <td className="py-2 pr-4">
                          {b.brand}
                          {b.isUs && <span className="ml-2 text-[10px] uppercase tracking-wider">you</span>}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          <div className="flex items-center justify-end gap-2">
                            <span className="inline-block h-1.5 w-16 bg-muted">
                              <span className={`block h-full ${b.isUs ? "bg-primary" : "bg-muted-foreground/50"}`} style={{ width: `${Math.round(b.share * 100)}%` }} />
                            </span>
                            {Math.round(b.share * 100)}%
                          </div>
                        </td>
                        {result.share.enginesUsed.map((e) => (
                          <td key={e} className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                            {Math.round((b.byEngine[e] ?? 0) * 100)}%
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.share.note && <p className="mt-3 text-xs text-muted-foreground">{result.share.note}</p>}
            </Panel>
          ) : (
            <Panel title="Share of voice" subtitle="Not run.">
              <p className="text-sm text-muted-foreground">{result.share.note}</p>
            </Panel>
          )}

          {/* ── Competitor comparison ──────────────────────────────── */}
          {result.comparison.ran ? (
            <>
              <Panel
                title="Compared with competitors"
                subtitle={result.comparison.weLead ? "You lead overall on the same checks." : `${result.comparison.leaderDomain} leads overall. Every site is measured on the identical pass.`}
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left">
                        <th className="py-2 pr-4 text-xs font-normal uppercase tracking-wider text-muted-foreground">Check</th>
                        <th className="py-2 pr-4 text-xs font-normal uppercase tracking-wider text-primary">{result.domain}</th>
                        {result.comparison.competitors.filter((c) => c.reachable).map((c) => (
                          <th key={c.domain} className="py-2 pr-4 text-xs font-normal uppercase tracking-wider text-muted-foreground">{c.domain}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.comparison.rows.map((row) => (
                        <tr key={row.check} className="border-b border-border/60">
                          <td className="py-2 pr-4 text-muted-foreground">{row.check}</td>
                          <td className={`py-2 pr-4 tabular-nums ${row.weLead ? "text-success" : "text-destructive"}`}>{row.us}</td>
                          {result.comparison.competitors.filter((c) => c.reachable).map((c) => (
                            <td key={c.domain} className="py-2 pr-4 tabular-nums text-muted-foreground">{row.them[c.domain] ?? "—"}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.comparison.competitors.some((c) => !c.reachable) && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Not compared: {result.comparison.competitors.filter((c) => !c.reachable).map((c) => `${c.domain} (${c.error})`).join(", ")}
                  </p>
                )}
              </Panel>

              {result.comparison.suggestions.length > 0 && (
                <Panel title="What to do about it" subtitle="Built from the gaps above, ordered as given. Every rationale cites the comparison.">
                  <ol className="space-y-4">
                    {result.comparison.suggestions.map((s, i) => (
                      <li key={i} className="border-b border-border/60 pb-4 last:border-b-0 last:pb-0">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="text-xs tabular-nums text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                          <span className="text-sm font-medium">{s.title}</span>
                          <span className="text-[10px] uppercase tracking-wider text-primary">{s.impact} impact</span>
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.effort} effort</span>
                        </div>
                        <p className="mt-1 pl-7 text-sm text-muted-foreground">{s.rationale}</p>
                      </li>
                    ))}
                  </ol>
                </Panel>
              )}

              {result.comparison.artifacts.length > 0 && (
                <Panel title="Done for you" subtitle="The suggestions carried out as far as possible from here — finished files, not descriptions. Paste them in.">
                  <div className="space-y-4">
                    {result.comparison.artifacts.map((a) => (
                      <div key={a.id}>
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-sm font-medium">{a.label}</span>
                          <code className="text-xs text-muted-foreground">{a.target}</code>
                        </div>
                        <pre className="mt-2 max-h-72 overflow-auto border border-border bg-background p-3 text-xs leading-relaxed">
                          <code>{a.content}</code>
                        </pre>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
            </>
          ) : (
            <Panel title="Compared with competitors" subtitle="Not run.">
              <p className="text-sm text-muted-foreground">{result.comparison.note}</p>
            </Panel>
          )}

          {result.market.enabled ? (
            <>
              <Panel title="What the model says" subtitle={`Named in ${Math.round(result.market.mentionRate * 100)}% of the buyer questions below. One reply is not a trend — the question set is fixed so runs can be compared.`}>
                <div className="space-y-4">
                  {result.market.answers.map((a, i) => (
                    <div key={i} className="border-b border-border/60 pb-4 last:border-b-0 last:pb-0">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-medium">{a.question}</p>
                        <span className={`shrink-0 text-[10px] uppercase tracking-wider ${a.mentionsBrand ? "text-success" : "text-destructive"}`}>
                          {a.mentionsBrand ? "named" : "not named"}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">{a.answer.slice(0, 420)}{a.answer.length > 420 ? "…" : ""}</p>
                    </div>
                  ))}
                </div>
              </Panel>

              <div className="grid gap-5 md:grid-cols-2">
                <Panel title="Named instead of you" subtitle="Counted across the whole prompt set, not a single answer.">
                  {result.market.competitors.length ? (
                    <div className="space-y-1">
                      {result.market.competitors.map((c) => (
                        <Row key={c.domain ?? c.name} label={c.domain ?? c.name} value={`${c.mentions}×`} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No competing domains were named.</p>
                  )}
                </Panel>

                {result.market.demand && (
                  <Panel title="Demand" subtitle="The model's read, not a measurement.">
                    <div className="text-2xl font-semibold capitalize text-primary">{result.market.demand.band}</div>
                    <p className="mt-2 text-sm text-muted-foreground">{result.market.demand.summary}</p>
                    {result.market.demand.drivers.length > 0 && (
                      <ul className="mt-3 space-y-1">
                        {result.market.demand.drivers.map((d, i) => (
                          <li key={i} className="text-sm text-muted-foreground">— {d}</li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-3 text-xs text-muted-foreground">{result.market.demand.caveat}</p>
                  </Panel>
                )}
              </div>
            </>
          ) : (
            <Panel title="Market read" subtitle="Not run.">
              <p className="text-sm text-muted-foreground">{result.market.note}</p>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
