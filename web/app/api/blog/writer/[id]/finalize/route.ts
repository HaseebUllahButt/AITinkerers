import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { finalizeSession } from "@/lib/writer/finalize";

export const maxDuration = 120;

// POST — run the quality gates and generate the Strapi metadata, once all sections are written.
// A thin auth wrapper: the logic lives in src/lib/writer/finalize.ts so the integration probe can
// exercise it without a browser session.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const res = await finalizeSession(id);
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "finalize failed" }, { status: 500 });
  }
}
