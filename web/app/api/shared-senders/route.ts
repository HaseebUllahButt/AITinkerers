import { NextResponse } from "next/server";
import { getEnabledSharedSenders } from "@/lib/db/queries";

// GET — the currently-enabled shared sending identities (e.g. Zain), for the "Send from"
// picker. Any signed-in user can see the list (just email + label, no password).
export async function GET() {
  return NextResponse.json(await getEnabledSharedSenders());
}
