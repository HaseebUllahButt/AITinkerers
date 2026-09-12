// Thin Slack Web API calls. lib/slack/post.ts owns notification posting (bot-then-webhook fallback);
// this is the conversational path, which needs a bot token unconditionally — a webhook cannot thread
// and cannot update a message, and both are required to answer in place.
async function call(method: string, body: Record<string, unknown>) {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return { ok: false, error: "no_bot_token" };
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).catch((e: unknown) => {
    throw new Error(`slack ${method}: ${e instanceof Error ? e.message : "network error"}`);
  });
  return (await res.json()) as { ok: boolean; ts?: string; error?: string };
}

export function postMessage(channel: string, text: string, blocks?: unknown[], threadTs?: string) {
  return call("chat.postMessage", { channel, text, blocks, thread_ts: threadTs });
}

export function updateMessage(channel: string, ts: string, text: string, blocks?: unknown[]) {
  return call("chat.update", { channel, ts, text, blocks });
}

/**
 * Reply to a slash command through its `response_url`.
 *
 * This is the one Slack write that needs NO bot token: the url is a one-time-ish capability Slack
 * mints per command invocation. It is also the only way to answer AFTER the 3-second window with
 * something the person sees as a reply to what they typed — `ephemeral` shows it to them alone,
 * `in_channel` shows everyone. `replace_original` swaps out the acknowledgement the route returned
 * inline, so a person never ends up with both "Checking…" and the answer stacked under one command.
 */
export async function respond(
  responseUrl: string,
  body: { text: string; response_type?: "ephemeral" | "in_channel"; replace_original?: boolean },
): Promise<void> {
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: true, ...body }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e: unknown) => console.error(
    "[slack] response_url post failed:", e instanceof Error ? e.message : e,
  ));
}
