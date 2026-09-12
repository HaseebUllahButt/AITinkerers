import { NextRequest, NextResponse } from "next/server";
import { upsertUserEmailConfig } from "@/lib/db/queries";
import { encryptSecret } from "@/lib/crypto";

// PATCH — toggle a shared sender on/off and/or change its Gmail app password.
// Body: { enabled?: boolean; app_password?: string; label?: string }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ email: string }> }) {
  const { email } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};
    if (typeof body.enabled === "boolean") patch.shared_sender_enabled = body.enabled;
    if (typeof body.label === "string" && body.label.trim()) patch.shared_sender_label = body.label.trim();
    if (typeof body.app_password === "string" && body.app_password.trim()) {
      patch.app_password_enc = encryptSecret(body.app_password.replace(/\s+/g, ""));
    }
    await upsertUserEmailConfig(decodeURIComponent(email), patch);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
