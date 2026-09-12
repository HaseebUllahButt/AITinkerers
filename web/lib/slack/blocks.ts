import type { AgentEvent } from "@/lib/agent";
import type { AuditResult } from "@/lib/audit/run";

const SECTION_MAX = 2900;
const BLOCK_MAX = 45;
type Block = Record<string, unknown>;

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text: text.slice(0, SECTION_MAX) } };
}

function context(text: string): Block {
  return { type: "context", elements: [{ type: "mrkdwn", text: text.slice(0, 300) }] };
}

export function actionBlocks(actionId: string, kind: string, summary: string): Block[] {
  return [
    section(`*Proposed: ${kind}*\n${summary}`),
    {
      type: "actions",
      block_id: `agent_action:${actionId}`,
      elements: [
        {
          type: "button", style: "primary", action_id: `agent_approve:${actionId}`,
          text: { type: "plain_text", text: "Approve" }, value: actionId,
        },
        {
          type: "button", action_id: `agent_decline:${actionId}`,
          text: { type: "plain_text", text: "Decline" }, value: actionId,
        },
      ],
    },
  ];
}

export function renderTurn(events: AgentEvent[], appUrl: string, sessionId: string): Block[] {
  const blocks: Block[] = [];
  const text: string[] = [];
  const tools: string[] = [];

  for (const event of events) {
    if (event.type === "text") text.push(event.text);
    if (event.type === "tool_call") tools.push(event.name.replaceAll("_", " "));
    if (event.type === "proposal") {
      blocks.push(...actionBlocks(event.actionId, event.kind, event.summary));
    }
  }

  const answer = text.join("\n").trim();
  if (answer) blocks.unshift(section(answer));
  if (tools.length) blocks.push(context(`_${[...new Set(tools)].join(" · ")}_`));
  blocks.push(context(`<${appUrl}/audit|Open in SearchOps> · Session ${sessionId.slice(0, 8)}`));
  return blocks.slice(0, BLOCK_MAX);
}

export function renderAuditPost(result: AuditResult, appUrl: string): Block[] {
  const critical = result.findings.filter((f) => f.severity === "critical");
  const warnings = result.findings.filter((f) => f.severity === "warning");
  const top = [...critical, ...warnings].slice(0, 6);
  const share = result.share.ran
    ? `${Math.round(result.share.ourShare * 100)}% across ${result.share.enginesUsed.length} engine(s)`
    : "not measured — configure an AI provider key";
  const lines = top.length
    ? top.map((f) => `• *${f.title}* — ${f.evidence}`).join("\n")
    : "• No critical or warning findings.";

  return [
    section(`*${result.brand} audit — ${result.score}/100*\n${result.url}`),
    section(`*Share of voice:* ${share}\n*Findings:* ${critical.length} critical · ${warnings.length} warning`),
    section(lines),
    context(`<${appUrl}/audit?url=${encodeURIComponent(result.url)}|Open the full audit in SearchOps>`),
  ];
}
