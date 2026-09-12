import { NextResponse } from "next/server";

import { auth } from "@auth";
import { resolveAction } from "@/lib/agent";
import { query } from "@/lib/db/pg";

// The web approval path — the dashboard's counterpart to the Slack/Discord cards. A proposal can
// be answered from any surface; this is the one the chat surfaces point at when they have no
// buttons of their own.

async function actor(): Promise<string> {
  const session = await auth().catch(() => null);
  return session?.user?.email || "demo-user";
}

function domainFrom(input: string): string {
  return input.trim().replace(/^https?:\/\//i, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
}

export async function GET(req: Request) {
  const domain = domainFrom(new URL(req.url).searchParams.get("domain") ?? "");
  if (!domain) return NextResponse.json({ actions: [] });
  const actions = await query(
    `select a.id, a.kind, a.summary, a.params, a.status, a.proposed_at, a.resolved_at, a.resolved_by, a.result
       from agent_actions a join agent_sessions s on s.id = a.session_id
      join sites si on si.id = s.site_id
      where si.domain = $1
      order by a.proposed_at desc limit 30`,
    [domain],
  ).catch(() => []);
  return NextResponse.json({ actions });
}

export async function POST(req: Request) {
  let body: { actionId?: string; decision?: string };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: "Send a JSON body." }, { status: 400 }); }

  const actionId = String(body.actionId ?? "");
  const decision = body.decision === "approved" ? "approved" : body.decision === "declined" ? "declined" : null;
  if (!actionId || !decision) {
    return NextResponse.json({ error: "actionId and decision (approved|declined) are required." }, { status: 400 });
  }

  const resolved = await resolveAction({
    actionId, decision, resolvedBy: await actor(), resolvedVia: "web",
  });
  if (!resolved) {
    return NextResponse.json({ error: "That proposal no longer exists or was already resolved." }, { status: 409 });
  }
  return NextResponse.json({ action: resolved });
}
