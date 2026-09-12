"use client";

import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";

interface SourceRow { source: string; authors: number; with_email: number; sent: number; replied: number; won: number }

/** Where prospects come from vs where links actually come from, over the last 90 days. This
 *  existed only as a Hermes tool; the numbers decide where Ahrefs units go, so the page that
 *  spends them should show it. Read-only by design. */
export function SourcingReportCard() {
  const [rows, setRows] = useState<SourceRow[] | null>(null);

  useEffect(() => {
    fetch("/api/backlinks/sourcing-report?days=90")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRows(d?.ok ? d.by_source : []))
      .catch(() => setRows([]));
  }, []);

  if (!rows || rows.length === 0) return null;

  return (
    <section className="rounded-2xl border border-[var(--glass-border)] bg-card p-5">
      <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <BarChart3 className="h-4 w-4" /> Which prospect source converts (90 days)
      </h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:px-3 [&_td]:py-2">
          <thead><tr className="border-b border-border">
            <th>Source</th><th className="text-right">Prospects</th><th className="text-right">With email</th>
            <th className="text-right">Sent</th><th className="text-right">Replied</th><th className="text-right">Links won</th>
          </tr></thead>
          <tbody>
            {rows.slice(0, 8).map((r) => (
              <tr key={r.source} className="border-b border-border/60 last:border-0 tabular-nums">
                <td className="font-medium">{r.source}</td>
                <td className="text-right">{r.authors}</td>
                <td className="text-right">{r.with_email}</td>
                <td className="text-right">{r.sent}</td>
                <td className="text-right">{r.replied}</td>
                <td className="text-right">{r.won > 0 ? <span className="text-success font-medium">{r.won}</span> : 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
