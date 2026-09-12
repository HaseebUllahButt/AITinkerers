// Telegram Bot API — the whole surface is one method away: inbound arrives at the webhook
// (/api/telegram/events), outbound is sendMessage. No workspace concept — a chat is a chat.
export async function sendTelegramMessage(
  chatId: string | number, text: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return { ok: false, error: "no_bot_token" };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      // Telegram's 4096-char cap; paragraphs split like everywhere else.
      text: text.slice(0, 4000),
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return { ok: false, error: `telegram ${res?.status ?? "network"}` };
  return { ok: true };
}
