import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { listMoneyPages } from "@/lib/indexing/discover";
import { allSiteUrlPaths, siteUrlCount } from "@/lib/sitemap/store";

export const maxDuration = 30;

async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
    if (req.nextUrl.searchParams.get("key") === secret) return true;
  }
  return !!(await auth().catch(() => null));
}

// GET — every internal path, for the "pick a page" dropdowns (backlinks, internal links, canonical).
//
// Served from the cached inventory (site_urls) rather than by parsing the live sitemap on every call.
// Two reasons that matters:
//   - Coverage. `listMoneyPages()` filters to MONEY_PAGE_PATTERNS — /ai-image-generator,
//     /ai-video-generator, /apps/*, /features/* — so of ~1,500 real URLs the pickers offered ~460 and
//     every one of the 747 /blogs/* pages was invisible. Those are the pages a blog post most wants to
//     link to.
//   - Speed. This is called from useKnownPages() on mount of every page with a picker, and it was
//     re-fetching and re-parsing a 250KB sitemap each time, behind a 30s route.
//
// Lived at /api/seo-agents/pages until the Growth Agents were removed. It was never an agent — it is
// the site inventory the pickers read — so it moved here rather than going with them.
//
// Money pages sort first so the commercial targets stay at the top of a long list. Falls back to the
// live parse when the inventory has never been synced, so a fresh database still works.
export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    if (await siteUrlCount() === 0) {
      const paths = await listMoneyPages();
      return NextResponse.json({ ok: true, paths, source: "live-sitemap", note: "inventory not synced yet" });
    }
    const paths = await allSiteUrlPaths();
    return NextResponse.json({ ok: true, paths, source: "inventory" });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "failed to list pages" }, { status: 500 });
  }
}
