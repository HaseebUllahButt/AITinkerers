import { after, NextRequest, NextResponse } from "next/server";

import { runAgentTurn, type AgentEvent } from "@/lib/agent";
import { internalUrl, publicUrl } from "@/lib/appUrl";
import {
  matchActionCommand, pendingActionByRef, resolveActionForSurface,
} from "@/lib/surfaces/approvals";
import { handleBindingCommand, matchBindingCommand } from "@/lib/surfaces/commands";
import {
  ensureSurfaceUser, findOrCreateSession, resolveSurfaceUser, surfaceHandle,
} from "@/lib/surfaces/store";
import { renderTurnText } from "@/lib/surfaces/text";
import {
  answerTelegramCallback, editTelegramMessage, sendTelegramMessage, sendTelegramProposal,
} from "@/lib/telegram/api";

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

  // A button tap on a proposal card. callback_data carries the full action id; the same
  // resolveAction claim that guards the Slack card makes a double-tap a no-op, not a double run.
  const callback = body.callback_query;
  if (callback?.id && callback.from?.id) {
    const data = String(callback.data ?? "");
    const m = data.match(/^agent_(approve|decline):([0-9a-f-]{36})$/);
    if (!m) {
      void answerTelegramCallback(callback.id, "Unknown button.");
      return NextResponse.json({ ok: true });
    }
    const chatId = String(callback.message?.chat?.id ?? "");
    const messageId = Number(callback.message?.message_id ?? 0);
    const userId = String(callback.from.id);
    const decision = m[1] === "approve" ? "approved" : "declined";
    after(async () => {
      const workspaceId = callback.message?.chat?.type === "private" ? "dm" : chatId;
      try {
        await ensureSurfaceUser("telegram", workspaceId, userId);
        const identity = await resolveSurfaceUser("telegram", workspaceId, userId);
        const actor = identity?.user_email || surfaceHandle("telegram", workspaceId, userId);
        const line = await resolveActionForSurface({
          actionId: m[2], decision, resolvedBy: actor, via: "telegram",
        });
        await answerTelegramCallback(callback.id, line);
        if (chatId && messageId) {
          const original = String(callback.message?.text ?? "").trim();
          await editTelegramMessage(chatId, messageId, `${original}\n\n${line}`);
        }
      } catch (e) {
        await answerTelegramCallback(callback.id, `Failed: ${e instanceof Error ? e.message : "error"}`.slice(0, 190));
      }
    });
    return NextResponse.json({ ok: true });
  }

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

      // Typed approvals — the fallback when the buttons are gone or an older card is quoted.
      const act = matchActionCommand(text);
      if (act) {
        const pending = await pendingActionByRef("telegram", workspaceId, chatId, "chat", act.ref);
        if (!pending) return void await reply("No pending proposal matches that reference here.");
        const identity = await resolveSurfaceUser("telegram", workspaceId, userId);
        const actor = identity?.user_email || surfaceHandle("telegram", workspaceId, userId);
        return void await reply(await resolveActionForSurface({
          actionId: pending.id, decision: act.decision, resolvedBy: actor, via: "telegram",
        }));
      }

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
      // Proposals go out as their own cards with real buttons, not inline in the reply text —
      // the card is what a human taps.
      await reply(renderTurnText(events, publicUrl() ?? internalUrl(), thread.sessionId, { proposals: "separate" }));
      for (const event of events) {
        if (event.type !== "proposal") continue;
        await sendTelegramProposal(
          chat.id,
          `*Proposed: ${event.kind}*\n${event.summary}\n\n_Or reply "approve ${event.actionId.slice(0, 8)}"_`,
          event.actionId,
        );
      }
    } catch (e) {
      await reply(`Failed: ${e instanceof Error ? e.message : "agent failed"}`.slice(0, 500));
    }
  });
  return NextResponse.json({ ok: true });
}
