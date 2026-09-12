import { after, NextRequest, NextResponse } from "next/server";

import { runAgentTurn, type AgentEvent } from "@/lib/agent";
import { internalUrl, publicUrl } from "@/lib/appUrl";
import { postMessage, updateMessage } from "@/lib/slack/api";
import { renderTurn } from "@/lib/slack/blocks";
import { verifySlackRequest } from "@/lib/slack/verify";
import {
  ensureSurfaceUser, findOrCreateSession, resolveSurfaceUser, surfaceHandle,
} from "@/lib/surfaces/store";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const verified = verifySlackRequest(raw, req.headers);
  if (!verified.ok) {
    console.warn("[slack] rejected event:", verified.reason);
    return new NextResponse("unauthorized", { status: 401 });
  }

  let body: Record<string, any>;
  try { body = JSON.parse(raw) as Record<string, any>; }
  catch { return NextResponse.json({ ok: true }); }
  if (body.type === "url_verification") return NextResponse.json({ challenge: body.challenge });
  const event = body.event ?? {};
  const isMention = event.type === "app_mention";
  const isDirectMessage = event.type === "message" && event.channel_type === "im";
  if (body.type !== "event_callback" || (!isMention && !isDirectMessage) || event.bot_id || event.subtype) {
    return NextResponse.json({ ok: true });
  }

  const teamId = String(body.team_id ?? "");
  const channelId = String(event.channel ?? "");
  const userId = String(event.user ?? "");
  const threadTs = String(event.thread_ts || event.ts || "");
  // All root-level DMs share one durable session. Channel mentions stay isolated by Slack thread.
  const sessionThreadKey = isDirectMessage && !event.thread_ts ? "dm" : threadTs;
  const replyThreadTs = isDirectMessage && !event.thread_ts ? undefined : threadTs;
  const text = String(event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();

  after(async () => {
    try {
      await ensureSurfaceUser("slack", teamId, userId);
      const identity = await resolveSurfaceUser("slack", teamId, userId);
      const createdBy = identity?.user_email || surfaceHandle("slack", teamId, userId);
      if (!text) return void await postMessage(channelId, "Tell me what to audit or ask for your progress.", undefined, replyThreadTs);
      const placeholder = await postMessage(channelId, `Working on: ${text.slice(0, 150)}`, undefined, replyThreadTs);
      if (!placeholder.ok || !placeholder.ts) return;
      const thread = await findOrCreateSession({
        surface: "slack", workspaceId: teamId, channelId,
        threadId: sessionThreadKey, createdBy, title: text,
      });
      const events: AgentEvent[] = [];
      await runAgentTurn(thread.sessionId, text, (eventItem) => { events.push(eventItem); });
      await updateMessage(
        channelId, placeholder.ts, text.slice(0, 150),
        renderTurn(events, publicUrl() ?? internalUrl(), thread.sessionId),
      );
    } catch (error) {
      console.error("[slack] mention failed:", error);
    }
  });
  return NextResponse.json({ ok: true });
}
