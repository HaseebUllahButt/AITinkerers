"use client";

// SEO ROI — what the organic work earned, per landing page.
//
// ── Why this page exists next to Site Audit and Render Lab ──────────────────────────────────────
//
// Every other SEO surface in SearchOps stops at the click: impressions, positions, broken links, render
// diffs. None of them can answer the only question anyone outside the SEO team asks, which is whether
// the work made money. That answer is in Mixpanel, keyed on the page a person first landed on, and
// until now it lived in a Mixpanel board nobody in this app could see.
//
// ── The number this page refuses to flatter ─────────────────────────────────────────────────────
//
// "Organic" here excludes paid. A large share of referrals on this property are self-referrals from
// northwind.example carrying utm_medium=ppc — an ad click that bounced through our own site — and any filter
// that just looks for a search-engine host counts those as SEO revenue. They are filtered out, which
// makes the organic number smaller and correct. The channel table below shows paid separately so the
// comparison is visible rather than hidden.

import { useCallback, useEffect, useState } from "react";
import { TrendingUp, Loader2, AlertTriangle, Search, X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/PageHeader";

type Scope = "organic" | "ai" | "all";

interface PageRoi {
  page: string; section: string; signups: number; purchases: number;
  revenue: number; generations: number; conversion: number | null;
}
interface ChannelRoi { channel: string; label: string; purchases: number; revenue: number }
interface SectionRow { section: string; pages: number; revenue: number; signups: number }
interface Report {
  ok: boolean; configured: boolean; error?: string;
  from?: string; to?: string; scope?: Scope;
  totals?: { signups: number; purchases: number; revenue: number; generations: number; conversion: number | null; revenuePerPurchase: number | null };
  pages?: PageRoi[]; channels?: ChannelRoi[]; sections?: SectionRow[]; notes?: string[];
}

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const num = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toLocaleString();
const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${n.toFixed(2)}%`;

const CHANNEL_TONE: Record<string, string> = {
  organic: "text-emerald-600 dark:text-emerald-400",
  ai: "text-violet-600 dark:text-violet-400",
  paid: "text-amber-600 dark:text-amber-400",
};

export default function RoiPage() {
  const [scope, setScope] = useState<Scope>("organic");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [section, setSection] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/roi?scope=${scope}&days=${days}`)
      .then(async (r) => { const j = await r.json(); if (!r.ok && !j.configured) throw new Error(j.error ?? `HTTP ${r.status}`); return j as Report; })
      .then((j) => { if (alive) { setData(j); setErr(j.ok ? null : (j.error ?? "query failed")); setLoading(false); } })
      .catch((e: unknown) => { if (alive) { setErr(e instanceof Error ? e.message : "could not load"); setLoading(false); } });
    return () => { alive = false; };
  }, [scope, days, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const q = search.trim().toLowerCase();
  const pages = (data?.pages ?? []).filter((p) =>
    (!section || p.section === section) && (!q || p.page.toLowerCase().includes(q)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="SEO ROI"
        icon={TrendingUp}
        description="Signups, generations and revenue attributed to the page people first landed on."
        actions={
          <>
            <Seg value={scope} set={(v) => { setScope(v); setSection(null); }}
                 options={[["organic", "Organic"], ["ai", "AI assistants"], ["all", "All traffic"]]} />
            <Seg value={String(days)} set={(v) => setDays(Number(v))}
                 options={[["7", "7d"], ["30", "30d"], ["90", "90d"]]} />
            <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
              Refresh
            </Button>
          </>
        }
      />

      {data && !data.configured && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-medium"><AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />Mixpanel is not configured</p>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            This page reads product analytics directly from Mixpanel&rsquo;s Query API. Add a service
            account to <code>.env.local</code> (and to Vercel for the deployed app), then reload:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg border bg-muted/40 px-4 py-3 text-xs leading-relaxed">{`MIXPANEL_PROJECT_ID=3287199
MIXPANEL_SA_USERNAME=<service-account>.mp-service-account
MIXPANEL_SA_SECRET=<secret>`}</pre>
          <p className="mt-3 text-[13px] text-muted-foreground">
            Mixpanel → Settings → Organization → Service Accounts. Read access to the project is enough.
          </p>
        </div>
      )}

      {err && data?.configured && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-4 text-[13px] text-destructive">{err}</div>
      )}

      {loading && !data?.totals && (
        <div className="flex items-center gap-2.5 py-20 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />Querying Mixpanel…
        </div>
      )}

      {data?.totals && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Revenue" value={money(data.totals.revenue)} sub={`${data.from} → ${data.to}`} accent />
            <Stat label="Purchases" value={num(data.totals.purchases)} sub={`${money(data.totals.revenuePerPurchase)} each`} />
            <Stat label="Signups" value={num(data.totals.signups)} sub={`${pct(data.totals.conversion)} convert to paid`} />
            <Stat label="Generations" value={num(data.totals.generations)} sub="the activation signal" />
            <Stat label="Pages earning" value={num(data.pages?.filter((p) => p.revenue > 0).length)} sub={`of ${num(data.pages?.length)} with traffic`} />
          </div>

          {data.notes?.map((n, i) => (
            <div key={i} className="rounded-xl border bg-muted/30 px-5 py-3 text-[13px] text-muted-foreground">{n}</div>
          ))}

          {!!data.channels?.length && (
            <section className="overflow-hidden rounded-xl border">
              <div className="flex items-baseline justify-between border-b px-5 py-3.5">
                <h2 className="text-sm font-semibold">Where the money came from</h2>
                <span className="text-xs text-muted-foreground">all traffic, not just the current scope</span>
              </div>
              <table className="w-full text-[13px]">
                <thead className="border-b bg-muted/20 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-5 py-2 text-left font-medium">Channel</th>
                    <th className="px-5 py-2 text-right font-medium">Purchases</th>
                    <th className="px-5 py-2 text-right font-medium">Revenue</th>
                    <th className="px-5 py-2 text-right font-medium">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(() => {
                    const total = data.channels!.reduce((n, c) => n + c.revenue, 0);
                    return data.channels!.map((c) => (
                      <tr key={c.channel} className="hover:bg-muted/30">
                        <td className={cn("px-5 py-2.5 font-medium", CHANNEL_TONE[c.channel] ?? "")}>{c.label}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums">{num(c.purchases)}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums font-medium">{money(c.revenue)}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">
                          {total > 0 ? `${((c.revenue / total) * 100).toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
            </section>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search pages…"
                     className="h-9 w-64 pl-8 pr-8 text-[13px]" />
              {search && (
                <button onClick={() => setSearch("")} aria-label="Clear search"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            {!!data.sections?.length && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip active={!section} onClick={() => setSection(null)}>All</Chip>
                {data.sections.slice(0, 10).map((s) => (
                  <Chip key={s.section} active={section === s.section} onClick={() => setSection(section === s.section ? null : s.section)}>
                    /{s.section} <span className="opacity-60">{money(s.revenue)}</span>
                  </Chip>
                ))}
              </div>
            )}
            {(search || section) && (
              <span className="text-[13px] text-muted-foreground">showing {pages.length} of {data.pages?.length}</span>
            )}
          </div>

          <section className="overflow-hidden rounded-xl border">
            <div className="flex items-baseline justify-between border-b px-5 py-3.5">
              <h2 className="text-sm font-semibold">Landing pages, best earning first</h2>
              <span className="text-xs text-muted-foreground">attributed on first page view</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="border-b bg-muted/20 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-5 py-2 text-left font-medium">Page</th>
                    <th className="px-5 py-2 text-right font-medium">Revenue</th>
                    <th className="px-5 py-2 text-right font-medium">Purchases</th>
                    <th className="px-5 py-2 text-right font-medium">Signups</th>
                    <th className="px-5 py-2 text-right font-medium">Conv.</th>
                    <th className="px-5 py-2 text-right font-medium">Generations</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {pages.slice(0, 300).map((p) => (
                    <tr key={p.page} className="hover:bg-muted/30">
                      <td className="max-w-md px-5 py-2.5">
                        <a href={`https://www.northwind.example${p.page}`} target="_blank" rel="noopener noreferrer"
                           className="block truncate font-mono text-xs hover:text-primary hover:underline">
                          {p.page || "(no landing page recorded)"}
                        </a>
                      </td>
                      <td className={cn("px-5 py-2.5 text-right tabular-nums", p.revenue > 0 && "font-medium text-emerald-600 dark:text-emerald-400")}>
                        {p.revenue > 0 ? money(p.revenue) : "—"}
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{p.purchases || "—"}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{num(p.signups)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">{pct(p.conversion)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">{num(p.generations)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages.length === 0 && (
              <div className="px-5 py-14 text-center text-sm text-muted-foreground">
                Nothing matches {search && <>“{search}”</>}{search && section && " in "}{section && <>/{section}</>}.
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1.5 text-2xl font-light tabular-nums", accent && "text-emerald-600 dark:text-emerald-400")}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={cn("rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
      {children}
    </button>
  );
}

function Seg<T extends string>({ value, set, options }: { value: T; set: (v: T) => void; options: Array<[T, string]> }) {
  return (
    <div className="flex rounded-lg border p-1">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => set(v)}
          className={cn("rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
            value === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
          {label}
        </button>
      ))}
    </div>
  );
}
