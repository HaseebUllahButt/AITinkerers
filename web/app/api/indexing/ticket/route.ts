import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { createLinearIssue } from "@/lib/indexing/linear";
import type { ChangeRequestPreview } from "@/lib/indexing/routing";
import { logDispatch } from "@/lib/indexing/persist";

export const maxDuration = 30;

// Creates a real Linear issue for one ticket-routed routing preview. Session-only — a
// deliberate human click, never automated.
export async function POST(req: NextRequest) {
  const session = await auth().catch(() => null);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const preview = body?.preview as ChangeRequestPreview | undefined;
  const runId: string | null = body?.runId ?? null;
  if (!preview || preview.kind !== "ticket") {
    return NextResponse.json({ ok: false, error: "expected a ticket-routed preview" }, { status: 400 });
  }

  try {
    const issue = await createLinearIssue(preview);
    await logDispatch({
      runId,
      kind: "ticket",
      reason: preview.reason,
      title: preview.title,
      targetRef: issue.url,
      status: "ok",
      dispatchedBy: session.user.email,
    });
    return NextResponse.json({ ok: true, issue });
  } catch (e: any) {
    const message = e?.message ?? "ticket creation failed";
    await logDispatch({
      runId,
      kind: "ticket",
      reason: preview.reason,
      title: preview.title,
      status: "error",
      error: message,
      dispatchedBy: session.user.email,
    });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
