import { NextRequest, NextResponse } from "next/server";
import { getWorkflow, runWorkflowFilters, saveWorkflowProspects, updateWorkflow } from "@/lib/db/queries";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const workflow = await getWorkflow(id);
    if (!workflow) return NextResponse.json({ error: "not found" }, { status: 404 });

    await updateWorkflow(id, { status: "running" });

    const prospects = await runWorkflowFilters(
      workflow.filters ?? {},
      workflow.campaign_id ?? undefined
    );

    const rows = prospects.map((p) => ({ ...p, included: true }));
    await saveWorkflowProspects(id, rows);
    await updateWorkflow(id, { status: "ready", prospect_count: rows.length });

    return NextResponse.json({ count: rows.length });
  } catch (e: any) {
    await updateWorkflow(id, { status: "draft" }).catch(() => {});
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
