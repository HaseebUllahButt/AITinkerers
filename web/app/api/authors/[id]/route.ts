import { NextRequest, NextResponse } from "next/server";
import { getAuthorDetail } from "@/lib/db/queries";

// GET — one author's full detail (profile + contacts + all articles) as a ProspectCard.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const detail = await getAuthorDetail(id);
    if (!detail) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e) {
    return NextResponse.json({ error: `The database did not answer (${e instanceof Error ? e.message : "read failed"}).` }, { status: 503 });
  }
}
