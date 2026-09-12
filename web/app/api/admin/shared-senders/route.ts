import { NextRequest, NextResponse } from "next/server";
import { getSharedSenders, upsertUserEmailConfig } from "@/lib/db/queries";
import { encryptSecret } from "@/lib/crypto";

// GET — every configured shared sending identity, enabled or not (Admin management list).
export async function GET() {
  return NextResponse.json(await getSharedSenders());
}

// POST — add a new shared sending identity. Body: { email, label, app_password }
export async function POST(req: NextRequest) {
  try {
    const { email, label, app_password } = await req.json();
    if (!email || !label || !app_password) {
      return NextResponse.json({ error: "email, label, and app_password are required" }, { status: 400 });
    }
    await upsertUserEmailConfig(email, {
      shared_sender_label: label,
      shared_sender_enabled: true,
      app_password_enc: encryptSecret(String(app_password).replace(/\s+/g, "")),
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
