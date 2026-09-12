import { NextRequest, NextResponse, after } from "next/server";
import { startSweep, processChunk, getLinkFixState } from "@/lib/linkfix/run";
import { authorized } from "@/lib/linkfix/auth";

export const maxDuration = 300;

// POST — start a 404 sweep, or continue an in-flight one when QStash hands the next chunk back.
// Detection only: this never writes to the CMS. Repair is /api/link-fix/apply.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}) as Record<string, unknown>);

  if (body.continue) {
    const state = await getLinkFixState();
    if (!state) return NextResponse.json({ continued: false, reason: "nothing to continue" });
    after(async () => { try { await processChunk(); } catch { /* state persists; the next chunk resumes */ } });
    return NextResponse.json({ continued: true, phase: state.phase });
  }

  const started = await startSweep();
  if ("error" in started) return NextResponse.json({ error: started.error }, { status: 409 });
  after(async () => { try { await processChunk(); } catch { /* as above */ } });
  return NextResponse.json({ started: true, runId: started.runId });
}
