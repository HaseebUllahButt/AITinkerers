import { NextResponse } from "next/server";
import { auth } from "@auth";
import { getUserEmailConfig, getUserAppPasswordEnc } from "@/lib/db/queries";
import { decryptSecret } from "@/lib/crypto";
import { sendEmailAs } from "@/lib/email/smtp";

// POST — send a test email from the current user's Gmail to themselves, to confirm their
// app password actually works before they rely on it for outreach.
export async function POST() {
  const session = await auth().catch(() => null);
  const email = (session?.user?.email as string | undefined) ?? "";
  if (!email) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const enc = await getUserAppPasswordEnc(email);
  const pass = decryptSecret(enc);
  if (!pass) return NextResponse.json({ ok: false, error: "No app password saved yet — add one and save first." });

  const cfg = await getUserEmailConfig(email);
  const res = await sendEmailAs({
    user: email,
    pass,
    fromName: cfg.from_name,
    to: email, // to themselves
    subject: "SearchOps — test email",
    body: `This is a test from SearchOps.\n\nIf you're reading this, your Gmail app password works and outreach will send from ${email}.\n\nYou can change it anytime in Settings.`,
  });

  if (res.ok) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: false, error: res.error ?? "send failed" });
}
