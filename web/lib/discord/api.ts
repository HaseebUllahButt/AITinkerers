// Discord Bot API — the outbound half of the Discord surface. Inbound arrives at
// /api/discord/interactions; these are the plain REST writes: post to a bound channel,
// follow up on an interaction, update a message after a turn finishes.
const API = "https://discord.com/api/v10";

async function call(
  path: string, body: Record<string, unknown>, method = "POST",
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) return { ok: false, error: "no_bot_token" };
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bot ${token}` },
    body: JSON.stringify(body),
  }).catch((e: unknown) => ({ status: 0, json: async () => ({}), text: async () => String(e) }) as unknown as Response);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `discord ${res.status}: ${detail.slice(0, 200)}` };
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { ok: true, id: data.id };
}

/** Post into a bound channel. Discord's message cap is 2000 chars — split on paragraph breaks. */
export async function postChannelMessage(
  channelId: string, text: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  let rest = text;
  let last: { ok: boolean; id?: string; error?: string } = { ok: true };
  while (rest.length) {
    const cut = rest.length > 1990 ? rest.lastIndexOf("\n\n", 1990) : -1;
    const part = rest.slice(0, cut > 400 ? cut : 1990);
    rest = rest.slice(part.length).trimStart();
    last = await call(`/channels/${channelId}/messages`, { content: part });
    if (!last.ok) return last;
  }
  return last;
}

/**
 * Follow up on an interaction AFTER the initial ack. The interaction token is a short-lived
 * capability Discord mints per invocation — it authenticates the followup, no bot token needed.
 */
export async function followup(
  applicationId: string, interactionToken: string, text: string,
): Promise<void> {
  await fetch(`${API}/webhooks/${applicationId}/${interactionToken}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text.slice(0, 1990) }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e: unknown) => console.error(
    "[discord] followup failed:", e instanceof Error ? e.message : e,
  ));
}
