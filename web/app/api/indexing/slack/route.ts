import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getWebhook } from "@/lib/linkaudit/slack";
import { logDispatch } from "@/lib/indexing/persist";

export const maxDuration = 30;

// Posts the indexing digest to link-audit's existing webhook (per user's choice — reuse the
// same channel rather than standing up new severity-routed webhooks yet). Session-only: a
// Slack post is visible to the team and must always be a deliberate human click.
export async function POST(req: NextRequest) {
  const session = await auth().catch(() => null);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const text: string | undefined = body?.text;
  const runId: string | null = body?.runId ?? null;
  if (!text) return NextResponse.json({ ok: false, error: "missing text" }, { status: 400 });

  const webhook = await getWebhook();
  if (!webhook) {
    return NextResponse.json(
      { ok: false, error: "No Slack webhook configured — set it on the Link Audit settings panel." },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      await logDispatch({ runId, kind: "slack", title: "Indexing digest", status: "error", error: `HTTP ${res.status}`, dispatchedBy: session.user.email });
      return NextResponse.json({ ok: false, error: `Slack HTTP ${res.status}` }, { status: 502 });
    }
    await logDispatch({ runId, kind: "slack", title: "Indexing digest", status: "ok", dispatchedBy: session.user.email });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const message = e?.message ?? "post failed";
    await logDispatch({ runId, kind: "slack", title: "Indexing digest", status: "error", error: message, dispatchedBy: session.user.email });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
