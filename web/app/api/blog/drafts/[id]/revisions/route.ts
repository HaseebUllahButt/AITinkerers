import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import {
  getBlogDraft, listBlogDraftRevisions, getBlogDraftRevision,
} from "@/lib/db/queries";
import { applyDraftPatch } from "@/lib/blog/save";
import { editableSnapshot } from "@/lib/blog/fields";

export const maxDuration = 30;

async function session(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.get("authorization") === `Bearer ${secret}` || req.nextUrl.searchParams.get("key") === secret)) {
    return { user: { email: "cron" } };
  }
  return auth().catch(() => null);
}

// GET — snapshot history for one draft, newest first. This is the "start off from that point"
// surface: every meaningful save, plus a forced snapshot before any sync, publish, restore, or
// conflict overwrite.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const revisions = await listBlogDraftRevisions(id);
    return NextResponse.json({
      ok: true,
      revisions: revisions.map((r) => ({
        id: r.id,
        rev: r.rev,
        reason: r.reason,
        created_at: r.created_at,
        created_by: r.created_by,
        // Enough for a list row without shipping every body on every open.
        title: (r.snapshot?.title as string) || "",
        word_count: String(r.snapshot?.body ?? "").trim().split(/\s+/).filter(Boolean).length,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "load failed" }, { status: 500 });
  }
}

// POST { revision_id, preview?: true } — read one snapshot in full, or restore it.
//
// Restore is itself just another save (reason: "pre_restore"), so the state being replaced is
// snapshotted first. That makes restoring undoable, which matters because picking the wrong
// revision from a list is easy to do.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const revisionId = Number((body as any)?.revision_id);
  if (!Number.isFinite(revisionId)) {
    return NextResponse.json({ ok: false, error: "revision_id required" }, { status: 400 });
  }
  try {
    const rev = await getBlogDraftRevision(revisionId);
    if (!rev || rev.draft_id !== id) {
      return NextResponse.json({ ok: false, error: "revision not found" }, { status: 404 });
    }
    if ((body as any)?.preview === true) {
      return NextResponse.json({ ok: true, snapshot: rev.snapshot });
    }
    const current = await getBlogDraft(id);
    if (!current) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

    const res = await applyDraftPatch(id, editableSnapshot(rev.snapshot), {
      baseRev: current.rev,
      editedBy: s.user?.email ?? null,
      reason: "pre_restore",
    });
    if (!res) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, conflict: true, draft: res.conflict, error: "This draft was edited elsewhere." },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, draft: res.draft });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "restore failed" }, { status: 500 });
  }
}
