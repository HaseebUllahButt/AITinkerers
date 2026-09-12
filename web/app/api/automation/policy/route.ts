import { NextRequest, NextResponse } from "next/server";
import { identifyCaller, actorFor } from "@/lib/auth/service";
import { upsertPolicy, listPolicies, getDefaultPolicy } from "@/lib/automation/policy";

// The standing-policy surface. GET lists every policy row (default first); POST applies a
// validated patch to one workflow's policy — or the global default when workflow_id is null.
//
// POST is what a set_policy confirm card executes: Hermes PROPOSES a policy change, a person
// clicks, and executeAction self-calls here with the clicker's cookie, so attribution lands on
// the human who authorized the standing behaviour. Direct calls from the page or a script work
// identically. Validation is the same pure validatePolicyPatch the proposal already passed, so
// a click cannot fail on values the card was allowed to carry.
export async function GET(req: NextRequest) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [def, all] = await Promise.all([getDefaultPolicy(), listPolicies()]);
  return NextResponse.json({ ok: true, default: def, policies: all });
}

export async function POST(req: NextRequest) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const workflowId = typeof body.workflow_id === "string" && body.workflow_id ? body.workflow_id : null;
    if (!body.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) {
      return NextResponse.json({ ok: false, error: "patch must be an object of policy fields" }, { status: 400 });
    }
    const policy = await upsertPolicy(workflowId, body.patch as Record<string, unknown>, actorFor(caller) ?? "unknown");
    return NextResponse.json({ ok: true, policy });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 400 });
  }
}
