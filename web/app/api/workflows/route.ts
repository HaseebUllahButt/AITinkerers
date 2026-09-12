import { NextRequest, NextResponse } from "next/server";
import { getWorkflows, createWorkflow } from "@/lib/db/queries";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const campaignId = searchParams.get("campaign_id") ?? undefined;
    const workflows = await getWorkflows(campaignId);
    return NextResponse.json(workflows);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, campaign_id, filters } = body;
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    const workflow = await createWorkflow({ name, campaign_id, filters });
    return NextResponse.json(workflow, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
