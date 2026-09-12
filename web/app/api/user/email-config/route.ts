import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getUserEmailConfig, upsertUserEmailConfig, respaceSenderQueue } from "@/lib/db/queries";
import { encryptSecret } from "@/lib/crypto";

async function currentEmail(): Promise<string | null> {
  const session = await auth().catch(() => null);
  return (session?.user?.email as string | undefined) ?? null;
}

// GET — the current user's sending config (never returns the password itself).
export async function GET() {
  const email = await currentEmail();
  if (!email) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  return NextResponse.json(await getUserEmailConfig(email));
}

// PATCH — save the current user's app password (encrypted) and/or schedule settings.
export async function PATCH(req: NextRequest) {
  const email = await currentEmail();
  if (!email) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};
    if (typeof body.app_password === "string" && body.app_password.trim()) {
      // Gmail shows app passwords with spaces; strip them before storing.
      patch.app_password_enc = encryptSecret(body.app_password.replace(/\s+/g, ""));
    }
    for (const k of ["from_name", "timezone"]) if (typeof body[k] === "string") patch[k] = body[k];
    const pacingKeys = ["send_hour_start", "send_hour_end", "gap_minutes", "daily_cap"];
    for (const k of pacingKeys) if (body[k] != null) patch[k] = Number(body[k]);
    await upsertUserEmailConfig(email, patch);

    // New pacing settings apply to what is ALREADY queued, not only to the next batch. Without
    // this, changing the gap or the window left today's queue on the times it was given, and the
    // change looked like it had done nothing. Best-effort: a failed re-space must not lose the
    // saved settings, so it is reported alongside them rather than thrown.
    let respaced: number | null = null;
    let respaceError: string | undefined;
    if (pacingKeys.some((k) => body[k] != null) || typeof body.timezone === "string") {
      try { respaced = await respaceSenderQueue(email); }
      catch (e) { respaceError = e instanceof Error ? e.message : "could not re-space the queue"; }
    }
    return NextResponse.json({ ...(await getUserEmailConfig(email)), respaced, respaceError });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
