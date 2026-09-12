import { NextRequest, NextResponse, after } from "next/server";
import { startApply, processChunk } from "@/lib/linkfix/run";
import { authorized } from "@/lib/linkfix/auth";

export const maxDuration = 300;

// POST — write the planned fixes to Strapi. Deliberately a separate call from the sweep: detection
// is safe to run on a schedule, repair edits live pages and is always something a person asks for.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = await startApply();
  if ("error" in started) return NextResponse.json({ error: started.error }, { status: 409 });
  after(async () => { try { await processChunk(); } catch { /* state persists for resume */ } });
  return NextResponse.json({ applying: true, pages: started.pages });
}
