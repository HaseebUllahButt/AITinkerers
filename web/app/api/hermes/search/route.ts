import { NextRequest, NextResponse } from "next/server";

import { identifyCaller } from "@/lib/auth/service";
import { isSuperUser } from "@/lib/auth/admin";
import { searchHermesSessions } from "@/lib/db/queries";

// GET /api/hermes/search?q=… — search this user's conversations by title and message content.
//
// Deliberately narrower than `isAuthorized`. That predicate is true for the cron and the agent as
// well as a person, and neither of those has an inbox to search — a machine caller here would have
// no email to scope by, and "scope by nothing" over a shared table is how one user's chats end up
// in another's results. So this requires a `user` caller specifically, and the search function
// takes the email as a REQUIRED argument rather than inferring it, which means there is no code
// path where a missing identity quietly searches everyone.
export async function GET(req: NextRequest) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (caller.kind !== "user") {
    return NextResponse.json(
      { error: "search is per-person; a machine caller has no conversations to search" },
      { status: 403 },
    );
  }

  const q = req.nextUrl.searchParams.get("q") ?? "";
  // Search follows the same rule as the rail: the superuser may search another person's
  // conversations, everyone else only their own. Refused explicitly rather than quietly searching
  // your own inbox instead, which would look like the other person simply had no matches.
  const asUser = req.nextUrl.searchParams.get("as")?.trim().toLowerCase() || "";
  if (asUser && !isSuperUser(caller.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const hits = await searchHermesSessions(asUser || caller.email, q);
    return NextResponse.json({ ok: true, query: q, hits, ...(asUser ? { viewing_as: asUser } : {}) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "search failed" },
      { status: 500 },
    );
  }
}
