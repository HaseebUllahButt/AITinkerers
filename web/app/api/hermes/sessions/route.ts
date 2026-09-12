import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { createHermesSession, listHermesSessions, listHermesUsers } from "@/lib/db/queries";
import { isSuperUser } from "@/lib/auth/admin";
import { writerEnabled, SELECTABLE_MODELS } from "@/lib/writer/anthropic";

export const maxDuration = 15;

// Session-only on purpose: Hermes acts as (and is attributed to) the person talking to it, so a
// machine credential has no meaningful identity here. Sessions are per-person; the list is yours.
//
// ?as=<email>   read another person's conversations   } superuser only, and only ever a READ
// ?people=1     who has conversations at all          }
//
// Scoped to the superuser list rather than the admin list, and that is deliberate: admin already
// means "can send email as a teammate", and reading someone's half-formed thinking is a different
// kind of access from acting on their behalf. Nobody becomes able to read chats as a side effect of
// being made an admin. There is no write path here at all — POST always creates under the caller's
// own email, so a superuser cannot start or continue a conversation as somebody else.
export async function GET(req: NextRequest) {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const superuser = isSuperUser(email);
  const asUser = req.nextUrl.searchParams.get("as")?.trim().toLowerCase() || "";
  const wantsPeople = req.nextUrl.searchParams.get("people") === "1";

  if ((asUser || wantsPeople) && !superuser) {
    // 403 rather than silently falling back to their own list: a request that was refused should
    // say so, or the caller believes they are reading someone else and are in fact reading themself.
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    if (wantsPeople) {
      return NextResponse.json({ ok: true, people: await listHermesUsers(), superuser: true });
    }
    // Viewing as someone else is reported back, so the UI can say whose chats these are rather than
    // showing another person's history under your own name.
    const target = asUser || email;
    const sessions = await listHermesSessions(target);
    return NextResponse.json({
      ok: true, sessions, configured: writerEnabled(),
      // The allowlist rides along with the list the page already fetches, rather than getting its
      // own endpoint. It is three constants; a second round trip to learn them would cost more than
      // the bytes. The picker renders from THIS rather than a copy in the client, so the menu can
      // never offer a model the PATCH route would reject.
      models: SELECTABLE_MODELS,
      superuser, ...(target !== email ? { viewing_as: target } : {}),
    });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "load failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!writerEnabled()) {
    return NextResponse.json({ ok: false, error: "Hermes is not configured (ANTHROPIC_API_KEY not set)." }, { status: 503 });
  }
  try {
    // A new chat can open on a chosen model, so switching does not mean "start, then switch, then
    // pay a second cache write". Unrecognised ids are dropped to null (the default) rather than
    // rejected: a stale value from a cached page should not stop someone opening a conversation.
    const body = (await req.json().catch(() => ({}))) as { model?: unknown };
    const want = typeof body.model === "string" ? body.model.trim() : "";
    const model = SELECTABLE_MODELS.some((m) => m.id === want) ? want : null;
    const session = await createHermesSession(email, undefined, model);
    return NextResponse.json({ ok: true, session });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "create failed" }, { status: 500 });
  }
}
