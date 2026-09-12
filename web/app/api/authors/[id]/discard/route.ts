import { NextRequest, NextResponse } from "next/server";
import { setAuthorDiscarded } from "@/lib/db/queries";

// PATCH { discarded } — discard/undiscard an author. Discarded authors are excluded from
// every workflow (runWorkflowFilters filters them out).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { discarded } = await req.json().catch(() => ({}));
  await setAuthorDiscarded(id, !!discarded);
  return NextResponse.json({ ok: true, discarded: !!discarded });
}
