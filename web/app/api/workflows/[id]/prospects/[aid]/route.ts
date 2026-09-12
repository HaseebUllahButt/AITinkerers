import { NextRequest, NextResponse } from "next/server";
import { toggleWorkflowProspect, removeWorkflowProspect } from "@/lib/db/queries";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; aid: string }> }
) {
  const { id, aid } = await params;
  try {
    const { included } = await req.json();
    await toggleWorkflowProspect(id, aid, Boolean(included));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE — remove this prospect from the workflow entirely.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; aid: string }> }
) {
  const { id, aid } = await params;
  try {
    await removeWorkflowProspect(id, aid);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
