import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { checkUrls, SITEMAP_QA_MAX_URLS } from "@/lib/indexing/checkUrls";

export const maxDuration = 300;

async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  const session = await auth().catch(() => null);
  return !!session;
}

// Pre-publish gate: POST { urls: string[] } → per-URL pass/block/flag with reasons. Report-only,
// no writes. Runs the same indexability battery as the live monitor (checkUrls → evaluateGate).
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  // Accept either a `urls` array or a newline/space-separated `text` blob (paste-friendly).
  let urls: string[] = [];
  if (Array.isArray(body.urls)) urls = (body.urls as unknown[]).filter((u): u is string => typeof u === "string");
  else if (typeof body.text === "string") urls = body.text.split(/[\s,]+/);
  urls = urls.map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) return NextResponse.json({ ok: false, error: "No URLs provided." }, { status: 400 });

  try {
    const report = await checkUrls(urls);
    return NextResponse.json({ ok: true, report, maxPerRun: SITEMAP_QA_MAX_URLS });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Sitemap QA failed" }, { status: 500 });
  }
}
