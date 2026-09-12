import { after, NextRequest, NextResponse } from "next/server";

import { runAgentTurn, type AgentEvent } from "@/lib/agent";
import { internalUrl, publicUrl } from "@/lib/appUrl";
import { handleBindingCommand, matchBindingCommand } from "@/lib/surfaces/commands";
import {
  ensureSurfaceUser, findOrCreateSession, resolveSurfaceUser, surfaceHandle,
} from "@/lib/surfaces/store";
import { renderTurnText } from "@/lib/surfaces/text";
import { sendTelegramMessage } from "@/lib/telegram/api";

export const maxDuration = 300;

// Telegram webhooks have no signature scheme — the secret token Telegram echoes back in this
// header is the verification. It is set when the webhook is registered (`setWebhook` with
// secret_token), and fail-closed when unset like every other surface.
export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    console.warn("[telegram] rejected update:", secret ? "bad secret token" : "secret not set");
    return new NextResponse("unauthorized", { status: 401 });
  }

  let body: Record<string, any>;
  try { body = await req.json() as Record<string, any>; }
  catch { return NextResponse.json({ ok: true }); }

  const message = body.message ?? body.edited_message;
  const chat = message?.chat;
  const from = message?.from;
  if (!message || !chat?.id || !from?.id || from.is_bot) return NextResponse.json({ ok: true });

  const chatId = String(chat.id);
  // A Telegram group is the workspace; a DM's workspace is the chat itself.
  const workspaceId = chat.type === "private" ? "dm" : String(chat.id);
  const userId = String(from.id);
  const text = String(message.text ?? "").replace(/@\w+/g, "").trim();
  if (!text) return NextResponse.json({ ok: true });

  after(async () => {
    const reply = (t: string) => sendTelegramMessage(chat.id, t);
    try {
      await ensureSurfaceUser("telegram", workspaceId, userId);

      const stripped = text.replace(/^\//, "");
      const sub = matchBindingCommand(stripped);
      if (sub) {
        const out = await handleBindingCommand({
          surface: "telegram", workspaceId, channelId: chatId, userId, verb: sub.verb, arg: sub.arg,
        });
        return void await reply(out.text);
      }

      const identity = await resolveSurfaceUser("telegram", workspaceId, userId);
      const createdBy = identity?.user_email || surfaceHandle("telegram", workspaceId, userId);
      const thread = await findOrCreateSession({
        surface: "telegram", workspaceId, channelId: chatId,
        threadId: "chat", createdBy, title: text,
      });
      const events: AgentEvent[] = [];
      await runAgentTurn(thread.sessionId, text, (event) => { events.push(event); });
      await reply(renderTurnText(events, publicUrl() ?? internalUrl(), thread.sessionId));
    } catch (e) {
      await reply(`Failed: ${e instanceof Error ? e.message : "agent failed"}`.slice(0, 500));
    }
  });
  return NextResponse.json({ ok: true });
}
