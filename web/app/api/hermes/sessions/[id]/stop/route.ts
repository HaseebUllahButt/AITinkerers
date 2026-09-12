import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getHermesSession } from "@/lib/db/queries";
import { requestHermesStop } from "@/lib/hermes/stop";

export const maxDuration = 10;

// POST — stop a running turn at its next round boundary. The current model call finishes (a
// mid-stream abort would strand a half-written tool_use pair in the history); the next never starts.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const session = await getHermesSession(id).catch(() => null);
  if (!session) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  if (session.user_email !== email) return NextResponse.json({ ok: false, error: "not yours" }, { status: 403 });
  await requestHermesStop(id);
  return NextResponse.json({ ok: true });
}
