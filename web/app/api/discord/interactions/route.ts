import { after, NextRequest, NextResponse } from "next/server";

import { getAgentAction, resolveAction, runAgentTurn, type AgentEvent } from "@/lib/agent";
import { internalUrl, publicUrl } from "@/lib/appUrl";
import { followup } from "@/lib/discord/api";
import { verifyDiscordRequest } from "@/lib/discord/verify";
import { handleBindingCommand, matchBindingCommand } from "@/lib/surfaces/commands";
import {
  ensureSurfaceUser, findOrCreateSession, resolveSurfaceUser, surfaceHandle,
} from "@/lib/surfaces/store";
import { renderTurnText } from "@/lib/surfaces/text";

export const maxDuration = 300;

const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const verified = verifyDiscordRequest(raw, req.headers);
  if (!verified.ok) {
    console.warn("[discord] rejected interaction:", verified.reason);
    return new NextResponse("unauthorized", { status: 401 });
  }

  let body: Record<string, any>;
  try { body = JSON.parse(raw) as Record<string, any>; }
  catch { return new NextResponse("bad request", { status: 400 }); }

  // Discord's handshake — must answer PING before anything else is real.
  if (body.type === PING) return NextResponse.json({ type: PING });

  const appId = String(body.application_id ?? process.env.DISCORD_APPLICATION_ID ?? "");
  const token = String(body.token ?? "");
  const workspaceId = String(body.guild_id ?? "dm");
  const channelId = String(body.channel_id ?? "");
  const userId = String(body.member?.user?.id ?? body.user?.id ?? "");

  if (body.type === MESSAGE_COMPONENT) {
    const customId = String(body.data?.custom_id ?? "");
    const actionId = customId.replace(/^agent_(approve|decline):/, "");
    const approved = customId.startsWith("agent_approve:");
    const declined = customId.startsWith("agent_decline:");
    if ((!approved && !declined) || actionId === customId) return NextResponse.json({ type: 6 });

    after(async () => {
      const note = (text: string) => followup(appId, token, text);
      try {
        await ensureSurfaceUser("discord", workspaceId, userId);
        const identity = await resolveSurfaceUser("discord", workspaceId, userId);
        const actor = identity?.user_email || surfaceHandle("discord", workspaceId, userId);
        const existing = await getAgentAction(actionId);
        if (!existing) return void await note("That proposal no longer exists.");
        const resolved = await resolveAction({
          actionId, decision: declined ? "declined" : "approved",
          resolvedBy: actor, resolvedVia: "discord",
        });
        if (!resolved) return void await note(`Already ${existing.status} — nothing changed.`);
        const tail = approved
          ? resolved.status === "executed"
            ? "Executed."
            : `Execution failed: ${String(resolved.result?.error ?? "unknown").slice(0, 300)}`
          : "";
        await note(`${declined ? "Declined" : "Approved"} by <@${userId}>. ${tail}`.trim());
      } catch (e) {
        await note(`Failed: ${e instanceof Error ? e.message : "interaction failed"}`);
      }
    });
    return NextResponse.json({ type: 6 }); // DEFERRED_UPDATE_MESSAGE
  }

  if (body.type !== APPLICATION_COMMAND) return NextResponse.json({ type: 6 });
  const text = String(body.data?.options?.[0]?.value ?? "").trim();

  try {
    await ensureSurfaceUser("discord", workspaceId, userId);
  } catch {
    return NextResponse.json({ type: 4, data: { content: "Database unavailable.", flags: 64 } });
  }

  const sub = matchBindingCommand(text);
  if (sub) {
    const reply = await handleBindingCommand({
      surface: "discord", workspaceId, channelId, userId, verb: sub.verb, arg: sub.arg,
    });
    // flags 64 = ephemeral (sender only); a bind/unbind answer is for the channel.
    return NextResponse.json({ type: 4, data: { content: reply.text, flags: reply.broadcast ? 0 : 64 } });
  }

  if (!text) {
    return NextResponse.json({
      type: 4,
      data: { content: "Try `/searchops audit example.com`, `/searchops use example.com`, or `/searchops link you@example.com`.", flags: 64 },
    });
  }

  after(async () => {
    try {
      const identity = await resolveSurfaceUser("discord", workspaceId, userId);
      const createdBy = identity?.user_email || surfaceHandle("discord", workspaceId, userId);
      const thread = await findOrCreateSession({
        surface: "discord", workspaceId, channelId,
        // No native thread per command — the channel itself is the conversation.
        threadId: "channel", createdBy, title: text,
      });
      const events: AgentEvent[] = [];
      await runAgentTurn(thread.sessionId, text, (event) => { events.push(event); });
      await followup(appId, token, renderTurnText(events, publicUrl() ?? internalUrl(), thread.sessionId));
    } catch (e) {
      await followup(appId, token, `*Failed:* ${(e instanceof Error ? e.message : "agent failed").slice(0, 500)}`);
    }
  });
  // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE — "SearchOps is thinking…", followup carries the answer.
  return NextResponse.json({ type: 5 });
}
