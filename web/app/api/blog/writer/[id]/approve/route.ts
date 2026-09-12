import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getWriterSession, updateWriterSession, getBlogDraft, updateBlogDraft, blogSlugTaken } from "@/lib/db/queries";
import { slugify } from "@/lib/blog/fields";

export const maxDuration = 30;

// POST — the human approval gate. Session-only, deliberately with NO CRON_SECRET branch: unlike
// every scan/cron route in this app, there is no automated caller for this one. That absence is
// the actual enforcement mechanism for "a human must approve step 3" — there is no tool the model
// can call to reach this effect, and there is no service credential that can either.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const session = await getWriterSession(id);
    if (!session) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    if (session.phase !== "outline_pending") {
      return NextResponse.json({ ok: false, error: `Nothing to approve — session is in phase "${session.phase}".` }, { status: 400 });
    }
    if (!session.outline) {
      return NextResponse.json({ ok: false, error: "No outline recorded on this session." }, { status: 400 });
    }

    // Stamp the draft's title/slug from the approved H1 now that it's committed, but only while
    // they're still empty/placeholder — never overwrite something the user already typed.
    if (session.draft_id) {
      const draft = await getBlogDraft(session.draft_id);
      if (draft) {
        const patch: Record<string, string> = {};
        if (!draft.title.trim()) patch.title = session.outline.h1;
        if (/^untitled-[0-9a-f]{8}$/.test(draft.slug)) {
          const proposed = slugify(session.outline.h1);
          patch.slug = (proposed && !(await blogSlugTaken(proposed, draft.id))) ? proposed : draft.slug;
        }
        if (Object.keys(patch).length) await updateBlogDraft(draft.id, patch);
      }
    }

    const updated = await updateWriterSession(id, {
      phase: "approved",
      outline_approved_at: new Date().toISOString(),
      outline_approved_by: s.user?.email ?? null,
    });
    return NextResponse.json({ ok: true, session: updated });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "approve failed" }, { status: 500 });
  }
}
