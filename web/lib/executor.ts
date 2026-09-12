// The executor — what runs when a human approves a proposal.
//
// Until now resolveAction flipped a status and stopped: every stage of the product dead-ended at
// "approved". This is the dispatch the agent's proposals were always pointing at — one place where
// an action kind becomes a real external mutation, so a proposal approved in Slack, Discord, or the
// web all runs the same code and lands the same way.
//
// Every executor resolves credentials the same way: the site's `connections` row wins (the
// customer's own token, decrypted from secret_enc), the shared env config is the fallback. A
// missing credential is an honest failure, not a silent no-op.
import nodemailer from "nodemailer";

import { decrypt } from "@/lib/connections/crypto";
import { queryOne } from "@/lib/db/pg";
import { gscProperty, submitSitemap } from "@/lib/indexing/gsc";
import { openPullRequest, repoForSite } from "@/lib/indexing/repo";
import { postToChannel } from "@/lib/surfaces/post";
import { channelsForSite, type Surface } from "@/lib/surfaces/store";
import type { AgentAction } from "@/lib/agent";

export interface ExecutionResult {
  ok: boolean;
  /** What happened, or why it didn't — stored on the action's `result` and shown to the approver. */
  result: Record<string, unknown>;
}

interface ConnectionRow {
  kind: string;
  config: Record<string, unknown>;
  secret_enc: string | null;
}

async function connectionFor(siteId: string, kind: string): Promise<ConnectionRow | null> {
  return queryOne<ConnectionRow>(
    `select kind, config, secret_enc from connections where site_id = $1 and kind = $2`,
    [siteId, kind],
  );
}

async function siteFor(sessionId: string): Promise<{ id: string; url: string; domain: string } | null> {
  return queryOne(
    `select s.id, s.url, s.domain
       from agent_sessions a join sites s on s.id = a.site_id
      where a.id = $1`,
    [sessionId],
  );
}

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" ? v.trim() : "";
}

// ── Executors ────────────────────────────────────────────────────────────────────────────────

/** open_pr — {title, body, files?: [{path, content}]}. Real branch → commit → PR on the
 *  connected repo, opened by the connected account. Never merges. */
async function execOpenPr(action: AgentAction, siteId: string | null): Promise<ExecutionResult> {
  const conn = siteId ? await repoForSite(siteId) : null;
  const repo = conn ?? null;
  if (!repo) {
    return { ok: false, result: { error: "No GitHub repository connected — connect one first." } };
  }
  const token = conn?.token ?? undefined;
  const title = str(action.params, "title") || action.summary;
  const body = str(action.params, "body") || action.summary;
  const files = Array.isArray(action.params.files)
    ? (action.params.files as { path?: unknown; content?: unknown }[])
        .filter((f) => typeof f.path === "string" && typeof f.content === "string")
        .map((f) => ({ path: f.path as string, content: f.content as string }))
    : [];

  // A proposal with no file edits still opens a PR — as a proposal document, clearly labeled,
  // not a guessed edit to a source file we cannot see.
  const changes = files.length
    ? files
    : [{ path: `searchops/proposals/${Date.now()}.md`, content: `# ${title}\n\n${body}\n` }];

  const pr = await openPullRequest({
    repo: { ...repo, section: "agent" },
    branch: `searchops/${Date.now()}`,
    title, body, changes, token,
  });
  return { ok: true, result: { pr: pr.url, number: pr.number, branch: pr.branch } };
}

/** resubmit_sitemap — {sitemapUrl?}. PUTs the sitemap to Search Console via the write-scoped
 *  service account. Property comes from the site's google connection, else GSC_PROPERTY. */
async function execResubmitSitemap(
  action: AgentAction, siteId: string | null, siteUrl: string | null,
): Promise<ExecutionResult> {
  const conn = siteId ? await connectionFor(siteId, "google") : null;
  const property = String(conn?.config?.property ?? "") || gscProperty();
  if (!property) {
    return { ok: false, result: { error: "No Search Console property connected or configured." } };
  }
  const sitemapUrl = str(action.params, "sitemapUrl")
    || (siteUrl ? `${siteUrl.replace(/\/$/, "")}/sitemap.xml` : "");
  if (!sitemapUrl) return { ok: false, result: { error: "No sitemap URL to submit." } };
  const submitted = await submitSitemap(property, sitemapUrl);
  return { ok: true, result: submitted };
}

/** send_email — {to, subject, body}. Sends via the site's connected SMTP account (Gmail app
 *  password). Falls back to the shared env transport when no connection exists. */
async function execSendEmail(action: AgentAction, siteId: string | null): Promise<ExecutionResult> {
  const to = str(action.params, "to");
  const subject = str(action.params, "subject");
  const body = str(action.params, "body");
  if (!to || !subject || !body) {
    return { ok: false, result: { error: "send_email needs to, subject, and body." } };
  }

  const conn = siteId ? await connectionFor(siteId, "smtp") : null;
  if (conn?.secret_enc) {
    const pass = decrypt(conn.secret_enc);
    const host = String(conn.config.host ?? "smtp.gmail.com");
    const port = Number(conn.config.port ?? 465);
    const user = String(conn.config.user ?? "");
    const fromName = String(conn.config.fromName ?? "");
    const tx = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
    try {
      const info = await tx.sendMail({
        from: fromName ? `"${fromName}" <${user}>` : user, to, subject,
        text: body, html: body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>"),
      });
      return { ok: true, result: { messageId: info.messageId, via: "connection", user } };
    } finally {
      tx.close();
    }
  }

  // Env transport fallback — same send, the shared account rather than the customer's.
  const { sendEmail } = await import("@/lib/email/smtp");
  const sent = await sendEmail({ to, subject, body });
  if (!sent.ok) return { ok: false, result: { error: sent.error ?? "send failed" } };
  return { ok: true, result: { messageId: sent.messageId, via: "env" } };
}

/** post_update — {text}. Fans the message out to every channel bound to the site, on every
 *  surface — the notify path's sibling for agent-written updates. */
async function execPostUpdate(action: AgentAction, siteId: string | null): Promise<ExecutionResult> {
  const text = str(action.params, "text") || action.summary;
  const channels = siteId ? await channelsForSite(siteId) : [];
  if (!channels.length) {
    return { ok: false, result: { error: "No channels bound to this site on any surface." } };
  }
  const posts = await Promise.all(channels.map((c) =>
    postToChannel(c.surface as Surface, c.channel_id, text)
      .then((r) => ({ surface: c.surface, channel: c.channel_id, ...r })),
  ));
  const failed = posts.filter((p) => !p.ok);
  return {
    ok: failed.length === 0,
    result: {
      posted: posts.length - failed.length,
      ...(failed.length ? { failed: failed.map((f) => `${f.surface}/${f.channel}: ${f.error}`) } : {}),
    },
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────────────────────

export async function executeAction(action: AgentAction): Promise<ExecutionResult> {
  const site = await siteFor(action.session_id).catch(() => null);
  try {
    switch (action.kind) {
      case "open_pr":
        return await execOpenPr(action, site?.id ?? null);
      case "resubmit_sitemap":
        return await execResubmitSitemap(action, site?.id ?? null, site?.url ?? null);
      case "send_email":
        return await execSendEmail(action, site?.id ?? null);
      case "post_update":
        return await execPostUpdate(action, site?.id ?? null);
      default:
        return {
          ok: false,
          result: { error: `No executor for kind "${action.kind}" — proposal recorded, nothing ran.` },
        };
    }
  } catch (e: unknown) {
    return { ok: false, result: { error: e instanceof Error ? e.message : "execution failed" } };
  }
}
