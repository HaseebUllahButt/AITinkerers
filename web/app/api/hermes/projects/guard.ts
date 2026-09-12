import { NextRequest, NextResponse } from "next/server";

import { MAX_PROJECT_NAME } from "@/components/agent/projects/constants";
import { identifyCaller } from "@/lib/auth/service";

export { MAX_PROJECT_NAME };

/**
 * The gate every project route uses — deliberately narrower than `isAuthorized`.
 *
 * Same argument the /api/hermes/search route spells out, and it applies harder here because these
 * routes WRITE. `isAuthorized` is true for the cron and for Summer herself holding HERMES_TOKEN,
 * and neither has an email to scope by; "scope by nothing" over a shared table is how one person's
 * rail gets rearranged from another's session. So: a `user` caller specifically, and the email
 * comes back as a value that each query takes as a required argument, which means there is no path
 * where a missing identity quietly means "everyone".
 *
 * Returns either the email or the response to send. Callers do:
 *
 *   const who = await requireUserEmail(req);
 *   if ("response" in who) return who.response;
 */
export async function requireUserEmail(
  req: NextRequest,
): Promise<{ email: string } | { response: NextResponse }> {
  const caller = await identifyCaller(req);
  if (!caller) {
    return { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  if (caller.kind !== "user") {
    return {
      response: NextResponse.json(
        { error: "projects are per-person; a machine caller has no rail to organise" },
        { status: 403 },
      ),
    };
  }
  return { email: caller.email };
}

/** Trim, and reject the empty string. A name of spaces would collide with nothing and render as an
 *  invisible group. Returns null when the value is not a usable name. */
export function normaliseProjectName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > MAX_PROJECT_NAME) return null;
  return name;
}
