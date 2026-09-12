import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { applyDraftPatch } from "@/lib/blog/save";

export const maxDuration = 30;

// POST — last-gasp save fired from `pagehide` via navigator.sendBeacon().
//
// Why this exists as its own route rather than reusing PATCH: sendBeacon can only issue a POST,
// and it's the only send mechanism the browser guarantees to complete after the page starts
// unloading (a normal fetch is cancelled, and `keepalive` is best-effort). The NextAuth session
// cookie rides along with the beacon, so it authenticates like any other request.
//
// It answers 204 with no body: nothing is listening by the time this resolves, and returning JSON
// to a dead page just wastes bytes. Conflicts are also ignored here on purpose — the tab is going
// away, so `force` semantics (save what the user typed) beat a conflict dialog nobody can see.
// The client's localStorage journal is the backstop if this never lands at all.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return new NextResponse(null, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return new NextResponse(null, { status: 204 });
  try {
    await applyDraftPatch(id, body, {
      baseRev: null, // force: the page is unloading, keep the user's text
      editedBy: s.user?.email ?? null,
      reason: "autosave",
    });
  } catch {
    // Swallow: there is no UI left to show an error to, and the journal already holds the text.
  }
  return new NextResponse(null, { status: 204 });
}
