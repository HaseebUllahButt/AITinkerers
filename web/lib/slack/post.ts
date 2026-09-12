// How SearchOps posts to Slack, and why there are two ways.
//
// ── The webhook cannot do what was asked ────────────────────────────────────────────────────────
//
// An incoming webhook is bound to ONE channel at the moment it is minted, and Slack removed the
// ability to override that from the payload years ago so a leaked URL cannot spam a workspace. It
// also has no concept of a thread. SearchOps's webhook points at #sitemap-alerts.
//
// So "post notifications into the SearchOps-notifications-testing thread in #imagine-web-geo" is not
// something the webhook can be configured into. It needs chat.postMessage, which needs a bot token.
//
// ── The two paths, and which wins ───────────────────────────────────────────────────────────────
//
//   bot token + channel   chat.postMessage. Can pick a channel, can reply in a thread. Preferred.
//   webhook               one channel, no threads. The fallback, and still the only path today
//                         until a bot token is saved on the Link Audit page.
//
// The bot path is tried first and the webhook is used when it is absent OR when it fails, because a
// notification that reaches the wrong channel is worth far more than one that reaches nothing. Which
// path ran is always reported — a caller that cannot tell them apart cannot explain to a person why
// their message landed somewhere unexpected.
import { getBotToken, getWebhook, postToSlack as postViaWebhook } from "@/lib/linkaudit/slack";

export interface PostResult {
  ok: boolean;
  /** Which transport actually delivered it. Null when nothing did. */
  via: "bot" | "webhook" | null;
  /** The posted message's ts, when the bot path ran — this is what makes a reply threadable. */
  ts?: string;
  channel?: string;
  error?: string;
}

export interface PostOptions {
  /** Channel id. Falls back to SLACK_CHANNEL_ID. Ignored entirely by the webhook path. */
  channel?: string;
  /**
   * Reply inside a thread. Falls back to SLACK_THREAD_TS.
   *
   * Silently impossible over a webhook — so when a thread was asked for and only the webhook is
   * available, the result says so rather than posting to the channel root as though it had worked.
   */
  threadTs?: string;
  /** Also echo a threaded reply into the channel. Slack's reply_broadcast. */
  broadcast?: boolean;
}

/**
 * Turn a Slack error code into the thing a person should actually go and do.
 *
 * Every one of these is a five-second fix by someone with Slack open, and every one of them
 * arrives as a bare snake_case token that reads like a fault in SearchOps. `not_in_channel` in
 * particular is the one that WILL happen on first setup: a bot with chat:write can post, but only
 * to channels it has been invited to, and nothing in the install flow says so. Naming the remedy
 * next to the code is the difference between "Slack is broken" and "/invite @summit".
 */
function remedyFor(code: string, channel: string): string {
  switch (code) {
    case "not_in_channel":
    case "channel_not_found":
      // channel_not_found is the same cause seen from a private channel: the bot cannot see a
      // channel it is not in, so Slack will not even confirm it exists.
      return ` — the SearchOps bot is not in that channel. Run "/invite @summit" in <#${channel}> and it will work; nothing needs redeploying.`;
    case "missing_scope":
    case "not_allowed_token_type":
      return " — the bot token is missing a scope it needs. chat:write is required to post; re-install the Slack app with it and paste the new token.";
    case "invalid_auth":
    case "token_revoked":
    case "account_inactive":
      return " — the bot token is no longer valid. Generate a fresh one on the Slack app's OAuth page and update SLACK_BOT_TOKEN (or paste it in Site Audit → Broken links).";
    case "is_archived":
      return " — that channel is archived. Point SLACK_CHANNEL_ID at a live one.";
    case "msg_too_long":
      return " — the message exceeded Slack's length limit, which is a SearchOps bug rather than a configuration one.";
    default:
      return "";
  }
}

function envChannel(): string | undefined {
  return process.env.SLACK_CHANNEL_ID?.trim() || undefined;
}
function envThread(): string | undefined {
  return process.env.SLACK_THREAD_TS?.trim() || undefined;
}

/**
 * Post via chat.postMessage. Returns null when there is no bot token, so the caller falls through
 * to the webhook rather than treating "unconfigured" as "failed".
 */
async function postViaBot(text: string, opts: PostOptions): Promise<PostResult | null> {
  const token = await getBotToken().catch(() => null);
  if (!token) return null;
  const channel = opts.channel ?? envChannel();
  if (!channel) return null;

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        channel,
        text,
        ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
        ...(opts.broadcast && opts.threadTs ? { reply_broadcast: true } : {}),
        // SearchOps writes its own links and does not want Slack expanding every one of them into a
        // preview card — a digest of twenty URLs becomes unreadable.
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // chat.postMessage answers HTTP 200 with {ok:false, error:"..."} on a real failure. Treating the
    // 200 as success is the classic way to believe a message was delivered when it was not.
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; ts?: string; channel?: string } | null;
    if (!body?.ok) {
      const code = body?.error ?? `HTTP ${res.status}`;
      return { ok: false, via: null, error: `chat.postMessage: ${code}${remedyFor(code, channel)}` };
    }
    return { ok: true, via: "bot", ts: body.ts, channel: body.channel };
  } catch (e) {
    return { ok: false, via: null, error: e instanceof Error ? e.message : "chat.postMessage failed" };
  }
}

/**
 * Post one message, by whichever route is available.
 *
 * Never throws. A Slack outage must never fail the work that produced the message — the draft, the
 * audit, the sweep are all real whether or not anybody was told about them.
 */
/**
 * Channels SearchOps reads but must never write to.
 *
 * #imagine-general was opened to the bot on 2026-09-08 for ONE reason: so the blog pipeline can read
 * what shipped (src/lib/slack/read.ts). It is the company's general channel, not a bot channel, and
 * the instruction was explicit — read it, never post in it.
 *
 * The guard lives here rather than in the callers because there are many callers and one poster. It
 * also closes the injection route: a writing surface that can read a general channel AND post to it
 * could be talked into echoing an internal conversation back into the room by something it read.
 *
 * Checked against the resolved channel, so a caller passing the id explicitly, an env var pointed at
 * it, and the webhook's own channel are all covered.
 */
const READ_ONLY_CHANNELS = new Set(["C06M31B0D0E"]);

/** #imagine-general and anything else we may only read. */
export function isReadOnlyChannel(channel: string | undefined | null): boolean {
  return !!channel && READ_ONLY_CHANNELS.has(channel.trim());
}

export async function slackPost(text: string, opts: PostOptions = {}): Promise<PostResult> {
  const threadTs = opts.threadTs ?? envThread();
  const wanted: PostOptions = { ...opts, threadTs };

  // Refused before anything is attempted, and NOT fallen through to the webhook — a fallback that
  // posted into the forbidden channel anyway would defeat the whole guard.
  const target = opts.channel ?? envChannel();
  if (isReadOnlyChannel(target)) {
    return {
      ok: false,
      via: null,
      error: `Refusing to post into <#${target}>: SearchOps may read that channel but never write to it. `
        + "Point SLACK_CHANNEL_ID (or the channel argument) at a bot channel instead.",
    };
  }

  const bot = await postViaBot(text, wanted);
  if (bot?.ok) return bot;

  const webhook = await getWebhook().catch(() => null);
  if (!webhook) {
    return {
      ok: false,
      via: null,
      error: bot?.error
        ? `${bot.error} — and no webhook is configured as a fallback.`
        : "No Slack bot token and no webhook are configured, so nothing was posted.",
    };
  }

  const res = await postViaWebhook(text);
  if (!res.ok) return { ok: false, via: null, error: res.error ?? "the webhook post failed" };

  return {
    ok: true,
    via: "webhook",
    // Said out loud rather than left for someone to discover. Both of these are surprising, and both
    // are the webhook's nature rather than a bug worth hunting.
    error: threadTs
      ? "Posted, but via the webhook — it cannot reply in a thread, so this went to the webhook's own channel root. Save a bot token on the Link Audit page to use the thread."
      : opts.channel
        ? "Posted, but via the webhook — it ignores the requested channel and always posts to the one it was minted for."
        : undefined,
  };
}

/** Is the threaded, channel-addressable path available? Used to tell a person why, not to gate. */
export async function slackThreadingAvailable(): Promise<{ ok: boolean; reason: string | null }> {
  const token = await getBotToken().catch(() => null);
  if (!token) return { ok: false, reason: "No Slack bot token is saved (Site Audit → Broken links → Slack settings)." };
  if (!envChannel()) return { ok: false, reason: "SLACK_CHANNEL_ID is not set, so there is no channel to post into." };
  if (!envThread()) return { ok: false, reason: "SLACK_THREAD_TS is not set, so messages go to the channel root rather than a thread." };
  return { ok: true, reason: null };
}
