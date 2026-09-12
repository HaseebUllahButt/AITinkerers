import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { correctRetiredLinks, MAX_LINKS_PER_RUN } from "@/lib/urlsweep/correct";

// Rewrite retired links in blog bodies. The sweep's other half.
//
// SESSION-ONLY, unlike the sweep itself, and that is the point: the sweep reads, this one edits
// PUBLISHED pages. A CRON_SECRET here would let a scheduled job rewrite live content on a schedule
// with nobody choosing the destination, and choosing the destination is the entire judgement — the
// corrector cannot know that a retired /dashboard link belongs on /ai-video-generator rather than
// /ai-image-generator.
//
// `apply` must be sent explicitly. Without it this is a dry run that writes nothing, which is the
// default because there is no draft state to review afterwards: the edit is live when it lands.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    from?: unknown; to?: unknown; limit?: unknown; apply?: unknown; site_wide?: unknown;
  };

  const r = await correctRetiredLinks({
    from: String(body.from ?? ""),
    to: String(body.to ?? ""),
    limit: Number(body.limit) || MAX_LINKS_PER_RUN,
    apply: body.apply === true,
    siteWide: body.site_wide === true,
  });

  return NextResponse.json({
    ok: !r.refusal,
    from: r.from, to: r.to,
    applied: r.applied,
    // Links, not pages. One post can carry the same retired URL nine times, so a page count would
    // understate what this actually changed.
    links: r.links,
    entries: r.edits.length,
    written: r.written,
    remaining: r.remaining,
    scanned: r.scanned,
    cap: MAX_LINKS_PER_RUN,
    edits: r.edits.map((e) => ({
      entry_id: e.entryId, slug: e.slug, title: e.title, links: e.links,
      urls: e.urls, sample: e.sample, error: e.error ?? null,
    })),
    failed: r.failed.map((e) => ({ entry_id: e.entryId, slug: e.slug, error: e.error ?? null })),
    warnings: r.warnings,
    refusal: r.refusal,
  }, { status: r.refusal ? 409 : 200 });
}
