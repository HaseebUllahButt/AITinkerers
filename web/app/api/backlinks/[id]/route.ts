import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth/service";
import { getFunnel } from "@/lib/backlinks/pipeline";

// Auth lives in @/lib/auth/service so a person, a cron and the agent are recognised by one
// rule. The local copy this replaced also returned true when CRON_SECRET was unset.

// GET → the funnel (prospects + stage counts) for one backlink campaign.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const funnel = await getFunnel(id);
    // getFunnel throws on a read error now; null is reserved for "no campaign with this id".
    if (!funnel) return NextResponse.json({ ok: false, error: "No campaign with this id — it may have been deleted." }, { status: 404 });
    return NextResponse.json({ ok: true, ...funnel });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `The database did not answer (${e instanceof Error ? e.message : "read failed"}). The campaign is not gone.` }, { status: 503 });
  }
}
