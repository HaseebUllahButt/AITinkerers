import { NextRequest, NextResponse } from "next/server";

import { isAuthorized } from "@/lib/auth/service";
import { runBlogRequest } from "@/lib/blog/request";

// The worker. Writes the article, illustrates it, syncs it to Strapi, announces it in Slack.
//
// Called by QStash after POST /api/blog/request accepts a brief, and by itself when it runs out of
// invocation budget mid-run. NOT reachable with BLOG_REQUEST_TOKEN: the external credential can ask
// for a draft, it cannot drive the machine that makes one. This is the internal side, so it takes
// the internal credentials (CRON_SECRET / HERMES_TOKEN / a logged-in session) via isAuthorized.
//
// 300 is the ceiling this is written against; runBlogRequest checkpoints at 200s and re-enqueues.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const sessionId = String((body as { session_id?: unknown }).session_id ?? "").trim();
  if (!sessionId) return NextResponse.json({ ok: false, error: "session_id is required." }, { status: 400 });

  const result = await runBlogRequest(sessionId);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
