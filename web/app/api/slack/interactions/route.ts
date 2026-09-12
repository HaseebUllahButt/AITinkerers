import { after, NextRequest, NextResponse } from "next/server";

import { getAgentAction, resolveAction } from "@/lib/agent";
import { updateMessage } from "@/lib/slack/api";
import { ensureSlackUser, resolveSlackUser } from "@/lib/slack/identity";
import { verifySlackRequest } from "@/lib/slack/verify";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const verified = verifySlackRequest(raw, req.headers);
  if (!verified.ok) {
    console.warn("[slack] rejected interaction:", verified.reason);
    return new NextResponse("unauthorized", { status: 401 });
  }
  const encoded = new URLSearchParams(raw).get("payload");
  if (!encoded) return NextResponse.json({ ok: true });

  let payload: Record<string, any>;
  try { payload = JSON.parse(encoded) as Record<string, any>; }
  catch { return NextResponse.json({ ok: true }); }
  const action = payload.actions?.[0] ?? {};
  const actionId = String(action.action_id ?? "");
  const target = String(action.value ?? "");
  const approved = actionId.startsWith("agent_approve:");
  const declined = actionId.startsWith("agent_decline:");
  if ((!approved && !declined) || !target) return NextResponse.json({ ok: true });

  after(async () => {
    const teamId = String(payload.team?.id ?? "");
    const userId = String(payload.user?.id ?? "");
    const channelId = String(payload.channel?.id ?? "");
    const messageTs = String(payload.message?.ts ?? "");
    const note = async (text: string) => updateMessage(channelId, messageTs, text, [
      { type: "section", text: { type: "mrkdwn", text } },
    ]);
    try {
      await ensureSlackUser(userId, teamId);
      const identity = await resolveSlackUser(userId, teamId);
      const actor = identity?.user_email || `slack:${teamId}:${userId}`;
      const existing = await getAgentAction(target);
      if (!existing) return void await note("That proposal no longer exists.");
      const resolved = await resolveAction({
        actionId: target,
        decision: declined ? "declined" : "approved",
        resolvedBy: actor,
        resolvedVia: "slack",
        result: approved
          ? { approved: true, note: "Approved for human execution; the agent made no external change." }
          : { approved: false },
      });
      await note(resolved
        ? `${declined ? "Declined" : "Approved"} by <@${userId}>. No external change was run by the agent.`
        : `Already ${existing.status} — nothing changed.`);
    } catch (error) {
      await note(`Failed: ${error instanceof Error ? error.message : "interaction failed"}`);
    }
  });
  return NextResponse.json({ ok: true });
}
