import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { syncSitemap, siteUrlCount, lastSitemapSync } from "@/lib/sitemap/store";

export const maxDuration = 120;

async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
    if (req.nextUrl.searchParams.get("key") === secret) return true;
  }
  return !!(await auth().catch(() => null));
}

// GET — inventory status: how many URLs we know about and when they were last refreshed.
export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, count: await siteUrlCount(), last_sync: await lastSitemapSync() });
}

// POST { source_url? } — refresh the inventory from sitemap.xml.
//
// Safe to run repeatedly: the sync upserts and never deletes, so a sitemap that is temporarily broken
// or truncated cannot wipe the URLs the writer validates its internal links against. The response
// reports the count so a suspicious drop is visible rather than silent.
//
// CRON_SECRET is accepted so this can be scheduled. Daily is plenty for a sitemap.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const sourceUrl = typeof (body as any)?.source_url === "string" ? (body as any).source_url : undefined;
  const result = await syncSitemap({ sourceUrl });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
