import { NextRequest, NextResponse } from "next/server";
import { getWorkflowEmails } from "@/lib/db/queries";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const emails = await getWorkflowEmails(id);
    return NextResponse.json(emails);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
