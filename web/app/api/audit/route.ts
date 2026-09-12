import { NextResponse } from "next/server";

import { runAudit } from "@/lib/audit/run";

// The render pass drives a real browser and the market read makes five sequential model calls,
// so this is nowhere near a default serverless budget.
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let url = "";
  let competitors: string[] = [];
  try {
    const body = (await req.json()) as { url?: string; competitors?: unknown };
    url = String(body?.url ?? "");
    if (Array.isArray(body?.competitors)) {
      competitors = body.competitors.filter((c): c is string => typeof c === "string").slice(0, 6);
    }
  } catch {
    return NextResponse.json({ error: "Send a JSON body with a url." }, { status: 400 });
  }
  if (!url.trim()) return NextResponse.json({ error: "Enter a URL to audit." }, { status: 400 });

  try {
    return NextResponse.json(await runAudit(url, { competitors }));
  } catch (err) {
    // Name what failed. "Something went wrong" is not a finding.
    const message = err instanceof Error ? err.message : "The audit failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
