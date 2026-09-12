import { NextRequest, NextResponse } from "next/server";
import { setFollowupArmed } from "@/lib/db/queries";

// Arm / disarm a single scheduled follow-up. POST { armed: boolean }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { armed } = await req.json();
    const res = await setFollowupArmed(id, !!armed);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
