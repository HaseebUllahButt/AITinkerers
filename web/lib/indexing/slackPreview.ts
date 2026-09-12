// Slack digest PREVIEW (PRD R5). Composes the severity-routed text that WOULD be posted —
// instant #seo-urgent for money-page P0 breakage, a batched digest for the rest — as a plain
// string the UI renders. Report-only: nothing is sent to Slack.
import type { IndexingReport } from "./types";

export function composeSlackPreview(report: IndexingReport): string {
  const { counts } = report;
  const lines: string[] = [];

  // ── #seo-urgent (money-page P0) ──
  const p0 = report.urls
    .filter((u) => u.isMoney && u.issues.some((i) => i.priority === "p0"))
    .slice(0, 25);
  lines.push(":rotating_light: *#seo-urgent — money-page P0*");
  if (p0.length === 0) {
    lines.push("_None — no money page is in a hard-broken state._");
  } else {
    for (const u of p0) {
      const worst = u.issues.find((i) => i.priority === "p0");
      lines.push(`• <${u.url}|${u.path}> — ${worst?.label ?? "issue"} → predicted "${u.predicted.state}"`);
    }
  }

  // ── digest (everything else) ──
  lines.push("");
  lines.push(":bar_chart: *Indexing + CWV digest*");
  lines.push(
    `Crawled *${report.analyzed}* URLs across *${counts.templates}* templates on ${report.target}. ` +
      `Gate: ${report.counts.verdicts.pass} pass / ${report.counts.verdicts.flag} flag / ${report.counts.verdicts.block} block. ` +
      `*${counts.jsGated}* js-gated. *${counts.issues}* issues (${counts.p0} P0).`,
  );

  const jsGatedTemplates = report.templates.filter((t) => t.jsGatedCount > 0);
  if (jsGatedTemplates.length) {
    lines.push("");
    lines.push(":warning: *JS-gated templates (rendering root cause)*");
    for (const t of jsGatedTemplates.slice(0, 12)) {
      lines.push(`• \`${t.template}\` — ${t.jsGatedCount}/${t.urlCount} js-gated (${t.renderMode})`);
    }
  }

  const failingCwv = report.cwv.filter((c) => c.hasField && !c.evaluation.passesField);
  if (failingCwv.length) {
    lines.push("");
    lines.push(":turtle: *CWV templates needing work (field p75)*");
    for (const c of failingCwv.slice(0, 12)) {
      lines.push(
        `• \`${c.template}\` — LCP ${c.vitals.lcpMs ?? "n/a"}ms / INP ${c.vitals.inpMs ?? "n/a"}ms / CLS ${c.vitals.cls ?? "n/a"}`,
      );
    }
  }

  const tickets = report.routing.filter((r) => r.kind === "ticket").length;
  const prs = report.routing.filter((r) => r.kind === "pr").length;
  lines.push("");
  lines.push(`:inbox_tray: *Routing:* ${prs} PR preview(s), ${tickets} ticket preview(s) — _nothing dispatched; a human merges._`);

  return lines.join("\n");
}
