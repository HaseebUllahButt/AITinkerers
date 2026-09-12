import { NextRequest, NextResponse } from "next/server";

import {
  blogRequestAuthorised, parseBlogRequest, startBlogRequest, blogRequestStatus,
} from "@/lib/blog/request";

// The public entry point: someone outside SearchOps asks for a blog draft.
//
// POST /api/blog/request      { topic, ... }  → 202 { request_id, draft_id, status_url }
// GET  /api/blog/request?id=… → progress for that request
//
// 202, not 200: the article does not exist yet when this answers. Writing it takes minutes and
// Vercel kills a function at 300s, so the work runs in /api/blog/request/run and this returns
// something to poll. Answering 200 with a draft id would imply a finished article that isn't.
//
// Auth is BLOG_REQUEST_TOKEN and nothing else — see the note in src/lib/blog/request.ts for why
// this deliberately does not go through identifyCaller.
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!blogRequestAuthorised(req.headers.get("authorization"))) {
    // Same answer for a bad token and an unset one. Distinguishing them would tell an untrusted
    // caller whether the feature is switched on, which is not information they need.
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const parsed = parseBlogRequest(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  const started = await startBlogRequest(parsed.input);
  if (!started.ok) {
    return NextResponse.json({ ok: false, error: started.error }, { status: started.status });
  }
  return NextResponse.json({ ok: true, ...started.accepted }, { status: 202 });
}

export async function GET(req: NextRequest) {
  if (!blogRequestAuthorised(req.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id is required." }, { status: 400 });

  const status = await blogRequestStatus(id);
  if (!status) return NextResponse.json({ ok: false, error: "No such request." }, { status: 404 });
  return NextResponse.json({ ok: true, ...status });
}
