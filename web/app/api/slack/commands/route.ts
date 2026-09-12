import { after, NextRequest, NextResponse } from "next/server";

import { runAgentTurn, type AgentEvent } from "@/lib/agent";
import { internalUrl, publicUrl } from "@/lib/appUrl";
import { postMessage, updateMessage } from "@/lib/slack/api";
import { renderTurn } from "@/lib/slack/blocks";
import { ensureSlackUser, linkSlackUser, resolveSlackUser } from "@/lib/slack/identity";
import {
  bindChannel, boundSite, findOrCreateSession, findSite, unbindChannel,
} from "@/lib/slack/threads";
import { verifySlackRequest } from "@/lib/slack/verify";

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
    await ensureSlackUser(userId, teamId);
  } catch (error) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: error instanceof Error ? error.message : "Database unavailable.",
    });
  }

  const sub = /^(link|use|where|unuse)(?:\s+(.+))?$/i.exec(text);
  if (sub) return bindingReply(sub[1].toLowerCase(), sub[2] ?? "", teamId, channelId, userId);

  if (!text) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Try `/searchops audit example.com`, `/searchops use example.com`, or `/searchops link you@example.com`.",
    });
  }

  const identity = await resolveSlackUser(userId, teamId);
  const createdBy = identity?.user_email || `slack:${teamId}:${userId}`;
  after(async () => {
    const placeholder = await postMessage(channelId, `Working on: ${text.slice(0, 150)}`);
    if (!placeholder.ok || !placeholder.ts) {
      console.error("[slack] could not post placeholder:", placeholder.error);
      return;
    }
    try {
      const thread = await findOrCreateSession(teamId, channelId, placeholder.ts, createdBy, text);
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

async function bindingReply(
  verb: string, arg: string, teamId: string, channelId: string, userId: string,
) {
  if (verb === "link") {
    const email = arg.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ response_type: "ephemeral", text: "Use `/searchops link you@example.com`." });
    }
    await linkSlackUser(userId, teamId, email, `slack:${teamId}:${userId}`);
    return NextResponse.json({ response_type: "ephemeral", text: `Linked this Slack account to ${email}.` });
  }

  const current = await boundSite(teamId, channelId);
  if (verb === "where") {
    return NextResponse.json({ response_type: "ephemeral", text: current
      ? `This channel follows *${current.brand || current.domain}* (${current.url}).`
      : "This channel is not bound. Use `/searchops use example.com`." });
  }
  if (verb === "unuse") {
    await unbindChannel(teamId, channelId);
    return NextResponse.json({ response_type: "in_channel", text: "This channel no longer follows a site." });
  }

  const site = await findSite(arg.trim());
  if (!site) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: `No saved site matches \`${arg.trim()}\`. Run it once from the audit page, then connect Slack.`,
    });
  }
  await bindChannel(teamId, channelId, site.id, `slack:${teamId}:${userId}`);
  return NextResponse.json({
    response_type: "in_channel", text: `This channel now follows *${site.brand || site.domain}* (${site.url}).`,
  });
}
