import { after, NextRequest, NextResponse } from "next/server";

import { runAgentTurn, type AgentEvent } from "@/lib/agent";
import { internalUrl, publicUrl } from "@/lib/appUrl";
import { handleBindingCommand, matchBindingCommand } from "@/lib/surfaces/commands";
import {
  ensureSurfaceUser, findOrCreateSession, resolveSurfaceUser, surfaceHandle,
} from "@/lib/surfaces/store";
import { renderTurnText } from "@/lib/surfaces/text";
import { sendWhatsApp } from "@/lib/whatsapp/api";

export const maxDuration = 300;

// Inbound WhatsApp — the bridge service (services/whatsapp-bridge) holds the Baileys socket and
// forwards each message here. There is no WhatsApp signature scheme over this hop; the shared
// WHATSAPP_BRIDGE_SECRET is the verification, and the bridge is expected to be a local process
// bound to the same machine or network as the app.
export async function POST(req: NextRequest) {
  const secret = process.env.WHATSAPP_BRIDGE_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    console.warn("[whatsapp] rejected event:", secret ? "bad bridge secret" : "secret not set");
    return new NextResponse("unauthorized", { status: 401 });
  }

  let body: { self?: string; chat?: string; from?: string; pushName?: string; text?: string };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ ok: true }); }

  const chat = String(body.chat ?? "");
  const from = String(body.from ?? "");
  const text = String(body.text ?? "").trim();
  // The bridge account's own number is the workspace — it is what a second deployment would
  // collide on, the same way a second Slack workspace would.
  const workspaceId = String(body.self ?? "default");
  if (!chat || !from || !text) return NextResponse.json({ ok: true });

  after(async () => {
    const reply = (t: string) => sendWhatsApp(chat, t);
    try {
      await ensureSurfaceUser("whatsapp", workspaceId, from);

      const stripped = text.replace(/^\//, "");
      const sub = matchBindingCommand(stripped);
      if (sub) {
        const out = await handleBindingCommand({
          surface: "whatsapp", workspaceId, channelId: chat, userId: from,
          verb: sub.verb, arg: sub.arg,
        });
        return void await reply(out.text);
      }

      const identity = await resolveSurfaceUser("whatsapp", workspaceId, from);
      const createdBy = identity?.user_email || surfaceHandle("whatsapp", workspaceId, from);
      const thread = await findOrCreateSession({
        surface: "whatsapp", workspaceId, channelId: chat,
        // WhatsApp has no threads — the chat IS the conversation.
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
