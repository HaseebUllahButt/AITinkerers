import { NextRequest, NextResponse, after } from "next/server";
import { startSweep, processChunk, getLinkFixState } from "@/lib/linkfix/run";
import { authorized } from "@/lib/linkfix/auth";

export const maxDuration = 300;

// The daily sweep. DETECTION ONLY — it never writes to the CMS, so it is safe to leave running
// unattended; a person presses Fix on the 404s page (or asks Summer) once they have seen the plan.
async function run(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const state = await getLinkFixState().catch(() => null);
  // Never start a second sweep on top of a live one — including one a person kicked off by hand.
  if (state && !["done", "error", "idle"].includes(state.phase) && Date.now() - state.updatedAt < 60 * 60_000) {
    return NextResponse.json({ skipped: true, reason: `a sweep is already ${state.phase}` });
  }

  const started = await startSweep();
  if ("error" in started) return NextResponse.json({ skipped: true, reason: started.error });
  after(async () => { try { await processChunk(); } catch { /* state persists for resume */ } });
  return NextResponse.json({ started: true, runId: started.runId });
}

export const GET = run;   // Vercel cron issues GET
export const POST = run;
