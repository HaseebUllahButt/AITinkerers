import { NextRequest, NextResponse } from "next/server";
import { getDigestConfig, setDigestConfig } from "@/lib/digest/daily";

// GET — daily digest on/off + recipient.
export async function GET() {
  return NextResponse.json(await getDigestConfig());
}

// PUT { enabled?, recipient? } — update the toggle / recipient.
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const patch: any = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.recipient === "string") patch.recipient = body.recipient;
    return NextResponse.json(await setDigestConfig(patch));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
