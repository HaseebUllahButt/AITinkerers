import { NextRequest, NextResponse } from "next/server";
import { getWorkflowProspects, addWorkflowProspect, addWorkflowProspects, setWorkflowProspectsIncluded, removeAllWorkflowProspects } from "@/lib/db/queries";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const offset = parseInt(searchParams.get("offset") ?? "0", 10);
  const limit = parseInt(searchParams.get("limit") ?? "50", 10);

  try {
    const result = await getWorkflowProspects(id, { offset, limit });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST — add ONE author to this workflow (search-and-add). Body: { author_id }.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json();
    // Bulk add (AI find → "add all"): { author_ids: [...] }
    if (Array.isArray(body.author_ids)) {
      const added = await addWorkflowProspects(id, body.author_ids.filter(Boolean));
      return NextResponse.json({ ok: true, added });
    }
    if (!body.author_id) return NextResponse.json({ error: "author_id required" }, { status: 400 });
    await addWorkflowProspect(id, body.author_id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PATCH — bulk include/exclude in one request (Select all / Deselect all). Body:
// { included: boolean, author_ids?: string[] } — omit author_ids to affect all in the workflow.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { included, author_ids } = await req.json();
    await setWorkflowProspectsIncluded(id, included === true, Array.isArray(author_ids) ? author_ids : undefined);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE — remove ALL prospects from this workflow.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const removed = await removeAllWorkflowProspects(id);
    return NextResponse.json({ ok: true, removed });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
