// Reading #imagine-general, which is where ImagineArt says what it shipped.
//
// ── Why read a Slack channel at all ─────────────────────────────────────────────────────────────
//
// The practitioner posts (src/lib/blog/practitioner.ts) are written from experience with a specific
// feature, and the hardest part of writing one is knowing what actually changed. The research sweep
// covers what OTHER vendors ship — it reads HuggingFace, vendor RSS, changelogs. It does not cover
// us: there is no imagine.art changelog feed, and Strapi only knows about pages that already exist.
//
// #imagine-general is where a launch is announced first, in the words of the person who built it,
// usually before any page describes it. That makes it the only durable record of "what is new here"
// this tool can read.
//
// ── Read-only, and deliberately so ──────────────────────────────────────────────────────────────
//
// This module calls conversations.history and nothing else. SearchOps's bot posts through slack/post.ts;
// nothing here writes, reacts, joins or invites. A writing surface that can also read a general
// channel is one prompt injection away from quoting an internal conversation into a public blog post,
// so the guard is at the other end too: practitioner.ts tells the writer that channel content is
// EVIDENCE THAT A THING SHIPPED, never quotable material and never a source to cite.
//
// ── Scope reality ───────────────────────────────────────────────────────────────────────────────
//
// The bot token carries `channels:history` but NOT `channels:read`, so a channel cannot be resolved
// by name — conversations.list returns missing_scope. The id is therefore configuration, not a
// lookup. And history on a public channel additionally requires the bot to be a MEMBER: without the
// invite the call returns `not_in_channel`, which is why that error is translated into the exact
// remedy rather than surfaced raw.

/** #imagine-general. Overridable, because a workspace can rename or replace a channel. */
export function updatesChannelId(): string | undefined {
  return process.env.SLACK_UPDATES_CHANNEL_ID?.trim() || "C06M31B0D0E";
}

export interface ChannelMessage {
  /** Slack ts, which doubles as the message id and its timestamp. */
  ts: string;
  at: string;
  user: string | null;
  text: string;
  /** Attachment/blocks text folded in, since launch posts often put the detail in an attachment. */
  extra: string;
  permalink: string;
}

export interface ChannelRead {
  ok: boolean;
  channel: string;
  messages: ChannelMessage[];
  /** Present when the read failed, written as the thing to actually do about it. */
  problem?: string;
}

/** Slack's ts is "1699999999.000100" — seconds with a counter suffix. */
function tsToIso(ts: string): string {
  const secs = Number(String(ts).split(".")[0]);
  return Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : "";
}

/** Blocks and attachments carry the body of a launch post more often than `text` does. */
function foldExtras(m: Record<string, unknown>): string {
  const out: string[] = [];
  const atts = Array.isArray(m.attachments) ? (m.attachments as Record<string, unknown>[]) : [];
  for (const a of atts) {
    for (const k of ["title", "text", "fallback", "pretext"]) {
      const v = a?.[k];
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  }
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const o = node as Record<string, unknown>;
    if (typeof o.text === "string" && o.text.trim()) out.push(o.text.trim());
    Object.values(o).forEach(walk);
  };
  walk(m.blocks);
  // Slack repeats the same string across fallback/text/blocks constantly.
  return [...new Set(out)].join("\n").slice(0, 4000);
}

/**
 * The last `limit` messages from the updates channel, newest first.
 *
 * Never throws: every failure comes back as `ok: false` with a `problem` naming the fix, because the
 * callers are a writing turn and an autopilot run, and neither should die because a bot is not in a
 * channel.
 */
export async function readUpdatesChannel(
  limit = 60,
  opts: { oldestDays?: number } = {},
): Promise<ChannelRead> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  const channel = updatesChannelId();
  if (!token) {
    return { ok: false, channel: channel ?? "", messages: [], problem: "SLACK_BOT_TOKEN is not set, so the updates channel cannot be read." };
  }
  if (!channel) {
    return { ok: false, channel: "", messages: [], problem: "SLACK_UPDATES_CHANNEL_ID is not set and there is no default." };
  }

  const qs = new URLSearchParams({ channel, limit: String(Math.min(Math.max(limit, 1), 200)) });
  if (opts.oldestDays) qs.set("oldest", String(Math.floor(Date.now() / 1000) - opts.oldestDays * 86_400));

  try {
    const res = await fetch(`https://slack.com/api/conversations.history?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!body?.ok) {
      const err = String(body?.error ?? `HTTP ${res.status}`);
      return { ok: false, channel, messages: [], problem: explain(err, channel) };
    }
    const raw = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
    const messages = raw
      // Joins, leaves, pins and channel renames are not launches.
      .filter((m) => !m.subtype || m.subtype === "bot_message" || m.subtype === "thread_broadcast")
      .map((m) => {
        const ts = String(m.ts ?? "");
        return {
          ts,
          at: tsToIso(ts),
          user: (m.user as string) ?? (m.bot_id as string) ?? null,
          text: String(m.text ?? "").slice(0, 4000),
          extra: foldExtras(m),
          permalink: `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`,
        };
      })
      .filter((m) => (m.text + m.extra).trim().length > 0);
    return { ok: true, channel, messages };
  } catch (e) {
    return { ok: false, channel, messages: [], problem: `The updates channel could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Slack's error strings say what is wrong, never what to do. These say what to do. */
function explain(err: string, channel: string): string {
  switch (err) {
    case "not_in_channel":
      return `SearchOps's bot is not in <#${channel}>. Someone in the workspace needs to run "/invite @summit" there once; the token already has channels:history.`;
    case "channel_not_found":
      return `Channel ${channel} does not exist or is private. Set SLACK_UPDATES_CHANNEL_ID to a public channel the bot can join.`;
    case "missing_scope":
      return "The Slack bot token is missing the channels:history scope. Add it in the Slack app config and reinstall the app.";
    case "invalid_auth":
    case "token_revoked":
      return "SLACK_BOT_TOKEN is no longer valid — regenerate it in the Slack app config.";
    case "ratelimited":
      return "Slack rate-limited the read. Try again in a minute.";
    default:
      return `Slack refused the read: ${err}`;
  }
}
