import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getHermesAction, getHermesSession } from "@/lib/db/queries";
import { executeAction, declineAction } from "@/lib/hermes/confirm";

// Execution self-calls the target route (up to 240s for a workflow send) — see confirm.ts.
export const maxDuration = 300;

// POST { decision: "confirm" | "decline" } — resolve a proposed action. This is THE human click the
// whole confirm-in-chat design exists for: the model proposed, this route executes, and resolved_by
// records who clicked. Owner-only: the session's user is the one the card was shown to.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const decision = (body as { decision?: unknown }).decision;
  if (decision !== "confirm" && decision !== "decline") {
    return NextResponse.json({ ok: false, error: 'decision must be "confirm" or "decline"' }, { status: 400 });
  }

  try {
    const action = await getHermesAction(id);
    if (!action) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    const session = await getHermesSession(action.session_id);
    if (!session || session.user_email !== email) {
      return NextResponse.json({ ok: false, error: "not yours" }, { status: 403 });
    }

    if (decision === "decline") {
      const declined = await declineAction(id, email);
      if (!declined) {
        const current = await getHermesAction(id);
        return NextResponse.json({ ok: false, error: `Already ${current?.status ?? "resolved"}.`, action: current }, { status: 409 });
      }
      return NextResponse.json({ ok: true, action: declined });
    }

    // Forward the clicker's own cookie and origin: the target route sees their real session, so
    // every existing guard and attribution applies exactly as if they pressed the page button.
    const result = await executeAction(id, {
      resolvedBy: email,
      cookie: req.headers.get("cookie"),
      origin: new URL(req.url).origin,
    });
    if (!result) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    if (result.outcome === "conflict") {
      return NextResponse.json({ ok: false, error: `Already ${result.action.status}.`, action: result.action }, { status: 409 });
    }
    return NextResponse.json({ ok: result.outcome === "executed", outcome: result.outcome, action: result.action });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "action failed" }, { status: 500 });
  }
}
