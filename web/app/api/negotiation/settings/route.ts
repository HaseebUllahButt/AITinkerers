import { NextRequest, NextResponse } from "next/server";
import { getNegotiationSettings, saveNegotiationSettings } from "@/lib/negotiation/settings";

// GET — current negotiation handbook / pricing tiers / autonomy toggle.
export async function GET() {
  try {
    return NextResponse.json(await getNegotiationSettings());
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}

// PUT — update any subset of the settings (handbook, tone, thread length, min price,
// anti-highball, pricing_rules, ai_autonomy).
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const saved = await saveNegotiationSettings(body);
    return NextResponse.json(saved);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
