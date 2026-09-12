// Telegram Bot API — inbound arrives at the webhook (/api/telegram/events), outbound is
// sendMessage. Approvals use inline keyboards: a callback_query update carries the action id,
// which the webhook resolves through the same path as a typed `approve <ref>`.
const API = "https://api.telegram.org";

async function call(
  method: string, body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; result?: any }> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return { ok: false, error: "no_bot_token" };
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return { ok: false, error: `telegram ${res?.status ?? "network"}` };
  const json = await res.json().catch(() => null);
  if (json && json.ok === false) return { ok: false, error: String(json.description ?? "api error") };
  return { ok: true, result: json?.result };
}

export async function sendTelegramMessage(
  chatId: string | number, text: string,
): Promise<{ ok: boolean; error?: string }> {
  // Telegram's 4096-char cap; paragraphs split like everywhere else.
  return call("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4000),
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

/** A proposal card: the summary plus Approve/Decline buttons carrying the action id. */
export async function sendTelegramProposal(
  chatId: string | number, text: string, actionId: string,
): Promise<{ ok: boolean; error?: string }> {
  return call("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4000),
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: "Approve", callback_data: `agent_approve:${actionId}` },
        { text: "Decline", callback_data: `agent_decline:${actionId}` },
      ]],
    },
  });
}

/** Dismiss the spinner on the person's client; the toast text is what they see. */
export async function answerTelegramCallback(
  callbackQueryId: string, text: string,
): Promise<{ ok: boolean; error?: string }> {
  return call("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text.slice(0, 190),
  });
}

/** Rewrite the proposal card to its outcome — the buttons go with the text. */
export async function editTelegramMessage(
  chatId: string | number, messageId: number, text: string,
): Promise<{ ok: boolean; error?: string }> {
  return call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4000),
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}
