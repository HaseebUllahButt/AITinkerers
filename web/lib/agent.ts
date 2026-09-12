import OpenAI from "openai";
import type {
  ChatCompletionMessageParam, ChatCompletionTool,
} from "openai/resources/chat/completions";

import { runAudit, type AuditResult } from "@/lib/audit/run";
import { execute, query, queryOne } from "@/lib/db/pg";
import { executeAction } from "@/lib/executor";
import { listRepoFiles, readRepoFile, repoForSite } from "@/lib/indexing/repo";
import { DEEPSEEK_MODEL } from "@/lib/providers/llm";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "proposal"; actionId: string; kind: string; summary: string };

export interface AgentSession {
  id: string;
  site_id: string | null;
  title: string | null;
  created_by: string | null;
  created_at: string;
}

export interface AgentAction {
  id: string;
  session_id: string;
  kind: string;
  params: Record<string, unknown>;
  summary: string;
  status: "proposed" | "approved" | "executed" | "declined" | "expired" | "failed";
  result?: Record<string, unknown> | null;
}

type Emit = (event: AgentEvent) => void | Promise<void>;
type ToolInput = Record<string, unknown>;
type StoredBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: ToolInput }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

const auditCache = new Map<string, AuditResult>();

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "run_audit",
      description: "Run the existing SearchOps audit for a URL. Use this before discussing a site's current state.",
      parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute or bare website URL" },
        competitors: { type: "array", items: { type: "string" }, description: "Optional competitor domains" },
      },
      required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_findings",
      description: "Read the findings from an audit, including evidence, fixes, severity, and required connection.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_competitors",
      description: "Read discovered competitors and the measured comparison from an audit.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_share_of_voice",
      description: "Read measured share of voice across the configured AI engines from an audit.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_progress",
      description: "Read saved SearchOps progress: connected services, recent agent sessions, and human action decisions for a site.",
      parameters: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Optional site domain. Omit when the current session is already attached to a site." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_list_files",
      description: "List readable source files in the site's connected GitHub repository. Use before proposing a code fix so an open_pr proposal can carry real file edits.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_read_file",
      description: "Read one file from the site's connected GitHub repository. Read before editing — an open_pr proposal should carry the file's full corrected content.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path from repo_list_files" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_external_action",
      description: "Propose, but never perform, an action outside SearchOps. Use for code changes, GitHub, Google Search Console, Slack, email, or any other external mutation.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", description: "Short machine-readable action kind" },
          summary: { type: "string", description: "Human-readable description of exactly what would change" },
          params: { type: "object", description: "Non-secret inputs required for the action" },
        },
        required: ["kind", "summary", "params"],
      },
    },
  },
];

const SYSTEM = `You are the SearchOps audit agent. You diagnose AI-search visibility using the tools.
Never claim a check ran unless a tool returned it. Evidence and recommendations must stay distinct.
Any change outside the SearchOps database must use propose_external_action. That tool records a
proposal for a human; it does not perform the change. When a human approves one, it executes.
Use these action kinds so the executor can run them:
  open_pr            {title, body, repository?, files?: [{path, content}]} — branch+commit+PR on the connected repo
  resubmit_sitemap   {sitemapUrl?} — submit the site's sitemap to Search Console
  send_email         {to, subject, body} — outreach email via the site's connected Gmail/SMTP
  post_update        {text} — post a message to every channel bound to the site
Never ask for or place secrets in tool input. For code fixes: list the repo's files, read the
ones the finding implicates, and propose open_pr with the files' full corrected content — a
proposal with no files lands as a document, not a fix. Be concise. When an audit lacks configured
model providers, say which measurement did not run.`;

export async function createAgentSession(input: {
  siteId?: string | null;
  title?: string | null;
  createdBy?: string | null;
}): Promise<AgentSession> {
  const rows = await execute<AgentSession>(
    `insert into agent_sessions (site_id, title, created_by)
     values ($1, $2, $3)
     returning id, site_id, title, created_by, created_at`,
    [input.siteId ?? null, input.title ?? null, input.createdBy ?? null],
  );
  return rows[0];
}

export function getAgentSession(id: string): Promise<AgentSession | null> {
  return queryOne<AgentSession>(
    `select id, site_id, title, created_by, created_at from agent_sessions where id = $1`, [id],
  );
}

export function getAgentAction(id: string): Promise<AgentAction | null> {
  return queryOne<AgentAction>(
    `select id, session_id, kind, params, summary, status, result from agent_actions where id = $1`, [id],
  );
}

async function saveMessage(sessionId: string, role: "user" | "assistant", content: unknown) {
  await execute(
    `insert into agent_messages (session_id, role, content) values ($1, $2, $3::jsonb)`,
    [sessionId, role, JSON.stringify(content)],
  );
}

async function history(sessionId: string): Promise<ChatCompletionMessageParam[]> {
  const rows = await query<{ role: "user" | "assistant"; content: StoredBlock[] }>(
    `select role, content from agent_messages where session_id = $1 order by created_at, id`,
    [sessionId],
  );
  return rows.flatMap((row): ChatCompletionMessageParam[] => {
    const text = row.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (row.role === "assistant") {
      const calls = row.content.filter((b) => b.type === "tool_use");
      return [{
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((call) => ({
          id: call.id, type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })) } : {}),
      }];
    }
    const results = row.content.filter((b) => b.type === "tool_result");
    if (results.length) return results.map((result) => ({
      role: "tool", tool_call_id: result.tool_use_id, content: result.content,
    }));
    return [{ role: "user", content: text }];
  });
}

function requiredString(input: ToolInput, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

async function auditFor(input: ToolInput): Promise<AuditResult> {
  const url = requiredString(input, "url");
  const cacheKey = url.trim().toLowerCase();
  const cached = auditCache.get(cacheKey);
  if (cached) return cached;
  const competitors = Array.isArray(input.competitors)
    ? input.competitors.filter((v): v is string => typeof v === "string").slice(0, 6)
    : [];
  const result = await runAudit(url, { competitors });
  auditCache.set(cacheKey, result);
  auditCache.set(result.url.toLowerCase(), result);
  return result;
}

async function propose(sessionId: string, input: ToolInput): Promise<AgentAction> {
  const kind = requiredString(input, "kind").slice(0, 80);
  const summary = requiredString(input, "summary").slice(0, 1000);
  const params = input.params && typeof input.params === "object" ? input.params : {};
  const rows = await execute<AgentAction>(
    `insert into agent_actions (session_id, kind, params, summary, status)
     values ($1, $2, $3::jsonb, $4, 'proposed')
     returning id, session_id, kind, params, summary, status`,
    [sessionId, kind, JSON.stringify(params), summary],
  );
  return rows[0];
}

async function callTool(sessionId: string, name: string, input: ToolInput, emit: Emit): Promise<unknown> {
  switch (name) {
    case "run_audit": {
      const r = await auditFor(input);
      return {
        url: r.url, brand: r.brand, score: r.score, reachable: r.reachable,
        findings: r.findings.length, competitors: r.discovery.competitors.length,
        shareOfVoiceRan: r.share.ran, durationMs: r.durationMs,
      };
    }
    case "read_findings": {
      const r = await auditFor(input);
      return r.findings;
    }
    case "read_competitors": {
      const r = await auditFor(input);
      return { discovery: r.discovery, comparison: r.comparison };
    }
    case "read_share_of_voice": {
      const r = await auditFor(input);
      return r.share;
    }
    case "read_progress": {
      const current = await getAgentSession(sessionId);
      const domain = typeof input.domain === "string"
        ? input.domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").toLowerCase()
        : null;
      const site = current?.site_id
        ? await queryOne<{ id: string; url: string; domain: string; brand: string | null }>(
            `select id, url, domain, brand from sites where id = $1`, [current.site_id],
          )
        : domain
          ? await queryOne<{ id: string; url: string; domain: string; brand: string | null }>(
              `select id, url, domain, brand from sites where domain = $1`, [domain],
            )
          : null;
      if (!site) return { found: false, message: "Name a saved site domain to read its progress." };
      const connections = await query<{ kind: string; config: Record<string, unknown>; created_at: string }>(
        `select kind, config, created_at from connections where site_id = $1 order by kind`, [site.id],
      );
      const sessions = await query<{ id: string; title: string | null; created_by: string | null; created_at: string }>(
        `select id, title, created_by, created_at from agent_sessions
          where site_id = $1 order by created_at desc limit 10`, [site.id],
      );
      const actions = await query<{
        id: string; kind: string; summary: string; status: string;
        proposed_at: string; resolved_at: string | null; resolved_by: string | null;
      }>(
        `select a.id, a.kind, a.summary, a.status, a.proposed_at, a.resolved_at, a.resolved_by
           from agent_actions a join agent_sessions s on s.id = a.session_id
          where s.site_id = $1 order by a.proposed_at desc limit 20`,
        [site.id],
      );
      return { found: true, site, connections, recentSessions: sessions, actions };
    }
    case "repo_list_files": {
      const session = await getAgentSession(sessionId);
      const repo = session?.site_id ? await repoForSite(session.site_id) : null;
      if (!repo) {
        return { error: "No GitHub repository connected to this site — the report's connect card is the fix." };
      }
      const files = await listRepoFiles(repo);
      return { repo: `${repo.owner}/${repo.repo}#${repo.baseBranch}`, count: files.length, files: files.map((f) => f.path) };
    }
    case "repo_read_file": {
      const session = await getAgentSession(sessionId);
      const repo = session?.site_id ? await repoForSite(session.site_id) : null;
      if (!repo) {
        return { error: "No GitHub repository connected to this site." };
      }
      const path = requiredString(input, "path");
      const file = await readRepoFile(repo, path);
      if (!file) return { error: `No readable file at ${path}.` };
      return file;
    }
    case "propose_external_action": {
      const action = await propose(sessionId, input);
      await emit({
        type: "proposal", actionId: action.id, kind: action.kind, summary: action.summary,
      });
      return {
        actionId: action.id, status: action.status,
        message: "Proposal recorded. No external change was made.",
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function runAgentTurn(sessionId: string, text: string, emit: Emit = () => {}) {
  const session = await getAgentSession(sessionId);
  if (!session) throw new Error("Agent session not found.");
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error("OPENROUTER_API_KEY is not set — the agent cannot answer.");
  }

  const messages = await history(sessionId);
  const userContent: StoredBlock[] = [{ type: "text", text }];
  await saveMessage(sessionId, "user", userContent);
  messages.push({ role: "user", content: text });

  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: { "X-OpenRouter-Title": "SearchOps" },
  });
  for (let step = 0; step < 6; step += 1) {
    const response = await client.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_tokens: 1800,
      tools,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
    });
    const message = response.choices[0]?.message;
    if (!message) throw new Error("The agent returned no message.");
    const uses = message.tool_calls?.filter((call) => call.type === "function") ?? [];
    const assistantBlocks: StoredBlock[] = [];
    if (message.content) {
      assistantBlocks.push({ type: "text", text: message.content });
      await emit({ type: "text", text: message.content });
    }
    for (const use of uses) {
      let input: ToolInput = {};
      try { input = JSON.parse(use.function.arguments) as ToolInput; } catch { /* tool reports validation */ }
      assistantBlocks.push({ type: "tool_use", id: use.id, name: use.function.name, input });
      await emit({ type: "tool_call", id: use.id, name: use.function.name, input });
    }
    await saveMessage(sessionId, "assistant", assistantBlocks);
    messages.push(message);
    if (!uses.length || response.choices[0].finish_reason !== "tool_calls") return;

    const results: StoredBlock[] = [];
    for (const use of uses) {
      let input: ToolInput = {};
      try { input = JSON.parse(use.function.arguments) as ToolInput; } catch { /* handled below */ }
      try {
        const output = await callTool(sessionId, use.function.name, input, emit);
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(output) });
        messages.push({ role: "tool", tool_call_id: use.id, content: JSON.stringify(output) });
      } catch (error) {
        const errorText = error instanceof Error ? error.message : "Tool failed";
        results.push({
          type: "tool_result", tool_use_id: use.id, is_error: true,
          content: errorText,
        });
        messages.push({ role: "tool", tool_call_id: use.id, content: errorText });
      }
    }
    await saveMessage(sessionId, "user", results);
  }
  throw new Error("Agent stopped after six tool rounds.");
}

export async function resolveAction(input: {
  actionId: string;
  decision: "approved" | "declined";
  resolvedBy: string;
  resolvedVia: "web" | "slack" | "discord" | "whatsapp" | "telegram";
}): Promise<AgentAction | null> {
  // Claim first: `where status = 'proposed'` makes the decision single-use — two surfaces racing
  // the same card can only both say "already resolved", never both execute.
  const claimed = await execute<AgentAction>(
    `update agent_actions set status = $2, resolved_at = now(), resolved_by = $3, resolved_via = $4
     where id = $1 and status = 'proposed'
     returning id, session_id, kind, params, summary, status, result`,
    [input.actionId, input.decision, input.resolvedBy, input.resolvedVia],
  );
  const action = claimed[0] ?? null;
  if (!action || input.decision === "declined") return action;

  // Approved proposals EXECUTE. The result — PR url, message id, channel posts, or the honest
  // error — is stored on the action so the record says what actually happened, not that a
  // human clicked a button.
  const exec = await executeAction(action);
  const rows = await execute<AgentAction>(
    `update agent_actions set status = $2, result = $3::jsonb
     where id = $1
     returning id, session_id, kind, params, summary, status, result`,
    [action.id, exec.ok ? "executed" : "failed", JSON.stringify(exec.result)],
  );
  return rows[0] ?? action;
}
