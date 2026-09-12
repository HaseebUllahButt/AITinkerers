// Plain-text renderings for the surfaces that don't take Slack blocks. WhatsApp, Telegram and
// Discord all render a *bold*/-italic dialect of lightweight markup, so one writer serves all
// three — keep to `*bold*`, bullets and bare URLs and every one of them displays it cleanly.
import type { AgentEvent } from "@/lib/agent";
import type { AuditResult } from "@/lib/audit/run";

export function renderAuditText(result: AuditResult, appUrl: string): string {
  const critical = result.findings.filter((f) => f.severity === "critical");
  const warnings = result.findings.filter((f) => f.severity === "warning");
  const top = [...critical, ...warnings].slice(0, 6);
  const share = result.share.ran
    ? `${Math.round(result.share.ourShare * 100)}% across ${result.share.enginesUsed.length} engine(s)`
    : "not measured — configure an AI provider key";
  const lines = top.length
    ? top.map((f) => `• *${f.title}* — ${f.evidence}`)
    : ["• No critical or warning findings."];

  return [
    `*${result.brand} audit — ${result.score}/100*`,
    result.url,
    "",
    `Share of voice: ${share}`,
    `Findings: ${critical.length} critical · ${warnings.length} warning`,
    "",
    ...lines,
    "",
    `Full audit: ${appUrl}/audit?url=${encodeURIComponent(result.url)}`,
  ].join("\n");
}

export function renderTurnText(
  events: AgentEvent[], appUrl: string, sessionId: string,
  opts: { proposals?: "inline" | "separate" } = {},
): string {
  const answer: string[] = [];
  const tools: string[] = [];
  const proposals: string[] = [];
  let audited = "";

  for (const event of events) {
    if (event.type === "text") answer.push(event.text);
    if (event.type === "tool_call") {
      tools.push(event.name.replaceAll("_", " "));
      if (event.name === "run_audit" && event.input && typeof event.input === "object") {
        const u = (event.input as { url?: unknown }).url;
        if (typeof u === "string" && u.trim()) audited = u.trim();
      }
    }
    if (event.type === "proposal" && (opts.proposals ?? "inline") === "inline") {
      // The typed command resolves through this chat's own session — every text surface speaks
      // it, and the short ref is the same one the surface's native buttons carry in full.
      proposals.push(
        `*Proposed: ${event.kind}*\n${event.summary}\n` +
        `_Reply "approve ${event.actionId.slice(0, 8)}" to run it or "decline ${event.actionId.slice(0, 8)}" to drop it._`,
      );
    }
  }

  const out = [...answer.map((t) => t.trim()).filter(Boolean), ...proposals];
  if (tools.length) out.push(`_${[...new Set(tools)].join(" · ")}_`);
  const link = audited ? `${appUrl}/audit?url=${encodeURIComponent(audited)}` : `${appUrl}/audit`;
  out.push(link);
  out.push(`_session ${sessionId.slice(0, 8)}_`);
  return out.filter(Boolean).join("\n\n");
}
