import { NextRequest, NextResponse } from "next/server";
import { getSendConfigOrDefault, upsertSendConfig } from "@/lib/db/queries";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await getSendConfigOrDefault(id));
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json();
    // Whitelist updatable fields
    const allowed = ["timezone", "send_hour_start", "send_hour_end", "gap_minutes", "daily_cap", "from_name", "from_email", "provider"] as const;
    const data: Record<string, unknown> = {};
    for (const k of allowed) if (k in body) data[k] = body[k];
    const config = await upsertSendConfig(id, data);
    return NextResponse.json(config);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
