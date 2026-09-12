import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getBlogDraft } from "@/lib/db/queries";
import { checkDraftLinks, describeLinkProblems } from "@/lib/blog/linkCheck";

// Same ceiling as publish. The checker's own budget sits below this so it always returns a partial
// report rather than letting the platform kill the request with no response at all.
export const maxDuration = 60;

// POST — check every link in this draft without publishing anything.
//
// The publish route runs the identical check as a gate, but finding out at the moment you press
// publish is the wrong time: by then the post is finished and the person is trying to ship it. This
// is the same answer on demand, so a broken link is something you fix while editing.
//
// Read-only. It makes outbound HEAD/GET requests to the linked pages and writes nothing.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const draft = await getBlogDraft(id);
    if (!draft) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

    const report = await checkDraftLinks(draft.body ?? "");
    return NextResponse.json({
      ok: true,
      ...report,
      problems: describeLinkProblems(report),
      // The caller should not have to re-derive "is this publishable" from the arrays.
      blocksPublish: report.broken.length > 0,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "link check failed" }, { status: 500 });
  }
}
