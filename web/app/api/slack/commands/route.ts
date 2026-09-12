import { after, NextRequest, NextResponse } from "next/server";

import { runAgentTurn, type AgentEvent } from "@/lib/agent";
import { internalUrl, publicUrl } from "@/lib/appUrl";
import { postMessage, updateMessage } from "@/lib/slack/api";
import { renderTurn } from "@/lib/slack/blocks";
import { verifySlackRequest } from "@/lib/slack/verify";
import { handleBindingCommand, matchBindingCommand } from "@/lib/surfaces/commands";
import {
  ensureSurfaceUser, findOrCreateSession, resolveSurfaceUser, surfaceHandle,
} from "@/lib/surfaces/store";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const verified = verifySlackRequest(raw, req.headers);
  if (!verified.ok) {
    console.warn("[slack] rejected command:", verified.reason);
    return new NextResponse("unauthorized", { status: 401 });
  }

  const form = new URLSearchParams(raw);
  const teamId = form.get("team_id") ?? "";
  const channelId = form.get("channel_id") ?? "";
  const userId = form.get("user_id") ?? "";
  const text = (form.get("text") ?? "").trim();

  try {
    await ensureSurfaceUser("slack", teamId, userId);
  } catch (error) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: error instanceof Error ? error.message : "Database unavailable.",
    });
  }

  const sub = matchBindingCommand(text);
  if (sub) {
    const reply = await handleBindingCommand({
      surface: "slack", workspaceId: teamId, channelId, userId, verb: sub.verb, arg: sub.arg,
    });
    return NextResponse.json({
      response_type: reply.broadcast ? "in_channel" : "ephemeral",
      text: reply.text,
    });
  }

  if (!text) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Try `/searchops audit example.com`, `/searchops use example.com`, or `/searchops link you@example.com`.",
    });
  }

  const identity = await resolveSurfaceUser("slack", teamId, userId);
  const createdBy = identity?.user_email || surfaceHandle("slack", teamId, userId);
  after(async () => {
    const placeholder = await postMessage(channelId, `Working on: ${text.slice(0, 150)}`);
    if (!placeholder.ok || !placeholder.ts) {
      console.error("[slack] could not post placeholder:", placeholder.error);
      return;
    }
    try {
      const thread = await findOrCreateSession({
        surface: "slack", workspaceId: teamId, channelId,
        threadId: placeholder.ts, createdBy, title: text,
      });
      const events: AgentEvent[] = [];
      await runAgentTurn(thread.sessionId, text, (event) => { events.push(event); });
      await updateMessage(
        channelId, placeholder.ts, text.slice(0, 150),
        renderTurn(events, publicUrl() ?? internalUrl(), thread.sessionId),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent failed";
      await updateMessage(channelId, placeholder.ts, "Failed", [
        { type: "section", text: { type: "mrkdwn", text: `*Failed:* ${message.slice(0, 500)}` } },
      ]);
    }
  });
  return NextResponse.json({ response_type: "ephemeral", text: "On it — posting in this channel." });
}
