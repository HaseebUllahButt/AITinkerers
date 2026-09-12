import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { supabaseAdmin } from "@/lib/db/supabase";

export const maxDuration = 10;

/** Surfaces we accept. An allow-list, not free text: this is written from the browser, and an
 *  unvalidated string field would let anyone stuff the adoption report with whatever they liked. */
const SURFACES = new Set([
  "/", "/campaigns", "/workflows", "/email-finder", "/emails", "/sending", "/inbox", "/whatsapp", "/negotiation",
  "/payments", "/drafts", "/blog/writer", "/blog/voices", "/media",
  "/site-audit", "/backlinks", "/handbook", "/notifications", "/admin", "/settings",
  "/hermes",
]);

const ACTIONS = new Set(["view", "run", "create", "publish"]);

/**
 * Record that someone opened a surface.
 *
 * Deliberately cheap and deliberately lossy. A unique index on (user, action, surface, hour) means a
 * repeat visit inside the same hour conflicts and is dropped, so a left-open polling tab writes one row
 * an hour rather than thousands — and the "most used surface" figure measures people rather than
 * refresh rates. A conflict is the expected case, not an error, so it returns 200.
 */
export async function POST(req: NextRequest) {
  const session = await auth().catch(() => null);
  const email = session?.user?.email;
  // Not an error: unauthenticated page loads (the login screen) are not adoption signal.
  if (!email) return new NextResponse(null, { status: 204 });

  let body: { action?: string; surface?: string; entityId?: string } = {};
  try { body = await req.json(); } catch { /* an empty body is a no-op, not a failure */ }

  const action = body.action ?? "view";
  const surface = body.surface ?? "";
  if (!ACTIONS.has(action) || !SURFACES.has(surface)) {
    return NextResponse.json({ ok: false, reason: "unrecognised action or surface" }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("usage_events")
    .insert({ user_email: email, action, surface, entity_id: body.entityId ?? null });

  // 23505 is the unique-violation from the per-hour dedupe index — the intended outcome on a revisit.
  if (error && error.code !== "23505") {
    // Tracking must never break the page that reports it, so this is swallowed with a signal rather
    // than surfaced as a 500 to a user who was only navigating.
    return NextResponse.json({ ok: false, reason: error.message }, { status: 200 });
  }
  return NextResponse.json({ ok: true, deduped: error?.code === "23505" });
}
