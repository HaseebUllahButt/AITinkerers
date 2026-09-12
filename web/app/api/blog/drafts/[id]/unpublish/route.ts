import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getBlogDraft, markBlogDraftUnpublished, markBlogDraftSyncFailed } from "@/lib/db/queries";
import { unpublishEntry, blogType, strapiConfigured } from "@/lib/strapi/client";
import { deriveSyncState } from "@/lib/blog/state";

export const maxDuration = 60;

// POST — take a live post back off the site by clearing publishedAt. The Strapi entry survives as
// a draft, so nothing is destroyed and it can be published again.
//
// This is the first caller of unpublishEntry(): it had existed in the Strapi client with zero
// callers because the composer was built believing Draft & Publish was disabled, which made
// "unpublish" look impossible. It isn't — publishedAt is a real field on this content type.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!strapiConfigured()) {
    return NextResponse.json({ ok: false, error: "Strapi not configured" }, { status: 503 });
  }
  const { id } = await params;
  try {
    const draft = await getBlogDraft(id);
    if (!draft) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    if (!draft.strapi_id) {
      return NextResponse.json({ ok: false, error: "This draft isn't in Strapi yet." }, { status: 400 });
    }
    try {
      await unpublishEntry(blogType(), draft.strapi_id);
    } catch (e: any) {
      const message = e?.message ?? "Strapi unpublish failed";
      const failed = await markBlogDraftSyncFailed(id, message);
      return NextResponse.json(
        { ok: false, error: message, draft: failed, syncState: deriveSyncState(failed) },
        { status: 502 },
      );
    }
    const updated = await markBlogDraftUnpublished(id);
    return NextResponse.json({ ok: true, draft: updated, syncState: deriveSyncState(updated) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "unpublish failed" }, { status: 500 });
  }
}
