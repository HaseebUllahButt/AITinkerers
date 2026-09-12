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


// ── Markdown → Slack ────────────────────────────────────────────────────────
//
// The model writes Markdown. Slack does not speak Markdown — it speaks "mrkdwn", which looks
// similar and is not: bold is *one* asterisk not two, there are no headings at all, and there is no
// table syntax whatsoever. Posting the model's output raw is what produced messages full of literal
// `##` and pipe-delimited rows that never line up.
//
// Tables are the interesting case. Slack has no table element, so the only way to keep columns
// aligned is a fixed-width code block — which is exactly what a code block is for, and it degrades
// readably on mobile where a real table would not have fitted anyway.
function mdToSlack(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A table is a run of pipe rows whose second line is the |---|---| separator. Anything else
    // starting with a pipe is just text and is left alone.
    const isRow = (l: string | undefined) => !!l && /^\s*\|.*\|\s*$/.test(l);
    const isSep = (l: string | undefined) => !!l && /^\s*\|[\s:-]*\|[\s:|-]*$/.test(l);
    if (isRow(line) && isSep(lines[i + 1])) {
      const rows: string[][] = [];
      let j = i;
      while (j < lines.length && isRow(lines[j])) {
        if (!isSep(lines[j])) {
          rows.push(lines[j].trim().replace(/^\||\|$/g, "").split("|").map((c) => cellText(c)));
        }
        j++;
      }
      const cols = Math.max(...rows.map((r) => r.length));
      // Cap the width so one long evidence cell cannot push every other column off the screen.
      const widths = Array.from({ length: cols }, (_, c) =>
        Math.min(38, Math.max(...rows.map((r) => (r[c] ?? "").length))));
      const fmt = (r: string[]) =>
        widths.map((w, c) => (r[c] ?? "").slice(0, w).padEnd(w)).join("  ").trimEnd();
      const body = [fmt(rows[0]), widths.map((w) => "-".repeat(w)).join("  "), ...rows.slice(1).map(fmt)];
      out.push("```" + body.join("\n") + "```");
      i = j - 1;
      continue;
    }

    out.push(inline(line));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A table cell: inline conversion, and no stray pipes left to break the alignment. */
function cellText(c: string): string {
  return inline(c.trim()).replace(/\|/g, "/");
}

function inline(line: string): string {
  let l = line;
  // Headings first: Slack has none, so they become bold on their own line.
  l = l.replace(/^\s{0,3}#{1,6}\s+(.*)$/, (_m, t) => `*${String(t).replace(/[*_]/g, "").trim()}*`);
  // Bullets before bold, or a "* item" bullet gets eaten by the bold rule below.
  l = l.replace(/^(\s*)[-*+]\s+/, "$1• ");
  // Links: [text](url) → <url|text>
  l = l.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>");
  // Bold: ** → *. Done after bullets so a leading "*" is already gone.
  l = l.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  // Markdown italics with underscores already match Slack's, so they are left alone.
  return l;
}

/** Slack rejects a section over 3000 chars outright, so a long answer becomes several. */
function sections(text: string): Block[] {
  const out: Block[] = [];
  let rest = text;
  while (rest.length && out.length < 12) {
    if (rest.length <= SECTION_MAX) { out.push(section(rest)); break; }
    // Break on a blank line where possible so a code block is not cut in half.
    const cut = rest.lastIndexOf("\n\n", SECTION_MAX);
    const at = cut > SECTION_MAX / 2 ? cut : SECTION_MAX;
    out.push(section(rest.slice(0, at)));
    rest = rest.slice(at).trimStart();
  }
  return out;
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
  let audited = "";

  for (const event of events) {
    if (event.type === "text") text.push(event.text);
    if (event.type === "tool_call") {
      tools.push(event.name.replaceAll("_", " "));
      // Remember what was audited so the footer link can carry it. Without this the link lands on
      // an empty audit form, which reads as the product being broken rather than as a missing
      // query string.
      if (event.name === "run_audit" && event.input && typeof event.input === "object") {
        const u = (event.input as { url?: unknown }).url;
        if (typeof u === "string" && u.trim()) audited = u.trim();
      }
    }
    if (event.type === "proposal") {
      blocks.push(...actionBlocks(event.actionId, event.kind, event.summary));
    }
  }

  const answer = text.join("\n").trim();
  if (answer) blocks.unshift(...sections(mdToSlack(answer)));
  if (tools.length) blocks.push(context(`_${[...new Set(tools)].join(" · ")}_`));
  // /audit reads ?url= and runs on load, so this link reproduces the audit rather than showing a
  // blank form. It re-runs rather than replaying a stored result — there is nowhere to store one yet.
  const link = audited ? `${appUrl}/audit?url=${encodeURIComponent(audited)}` : `${appUrl}/audit`;
  blocks.push(context(`<${link}|Open in SearchOps> · Session ${sessionId.slice(0, 8)}`));
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
