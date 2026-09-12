import { NextRequest, NextResponse } from "next/server";
import { getWorkflow, updateWorkflow } from "@/lib/db/queries";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const workflow = await getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(workflow);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json();
    await updateWorkflow(id, body);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
