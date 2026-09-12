import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth/service";
import { listSiteUrls } from "@/lib/sitemap/store";
import { checkUrlLive, cleanExternalUrl, hasTrackingParams, isBlockedUrl } from "@/lib/util/url";

// Liveness probes are network calls to third parties, so give a batch room to finish. Well under the
// 300s ceiling because the UI is waiting on this synchronously.
export const maxDuration = 60;

/**
 * The link picker's backend: search internal pages, and validate external URLs before they can be
 * inserted into a draft.
 *
 * GET  ?q=video            → internal candidates from the sitemap inventory
 * POST { urls: [...] }     → clean + liveness-check external URLs
 *
 * Why external links are validated at INSERT time rather than only at publish time: by publish the author
 * has moved on, and a flagged link at that point is someone else's problem to research. At insert the
 * person still has the tab open and knows what they meant to cite. The validator gates stay as the
 * backstop for links that arrive some other way (a model pasting one mid-draft), but this is where a bad
 * link should actually get stopped.
 */
export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const rows = await listSiteUrls({ q: q || undefined, limit: 40 });

  return NextResponse.json({
    ok: true,
    // Money pages first: those are the pages a post is usually trying to funnel toward, so they should
    // not be buried under blog archives in the picker.
    candidates: rows
      .slice()
      .sort((a, b) => Number(b.is_money) - Number(a.is_money) || a.path.localeCompare(b.path))
      .map((r) => ({ url: r.url, path: r.path, section: r.section, isMoney: r.is_money })),
  });
}

export interface ExternalLinkVerdict {
  input: string;
  /** The URL to actually insert. Null when it must not be inserted at all. */
  url: string | null;
  ok: boolean;
  /** True when tracking parameters were removed. Surfaced so the UI can say so rather than silently differ from what was pasted. */
  cleaned: boolean;
  status: number | null;
  /** Present when ok is false: why, in words a person can act on. */
  reason?: string;
  /** Set when the URL redirected — the author should usually cite the destination, not the redirector. */
  redirectedTo?: string;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const raw: unknown = body.urls ?? body.url;
  const inputs = (Array.isArray(raw) ? raw : [raw]).filter((u): u is string => typeof u === "string" && !!u.trim());

  if (!inputs.length) {
    return NextResponse.json({ ok: false, error: "url or urls is required" }, { status: 400 });
  }
  // A generous cap that still stops one paste from turning into a hundred outbound requests.
  if (inputs.length > 20) {
    return NextResponse.json({ ok: false, error: "at most 20 URLs per request" }, { status: 400 });
  }

  const verdicts = await Promise.all(inputs.map(async (input): Promise<ExternalLinkVerdict> => {
    const clean = cleanExternalUrl(input);
    if (!clean) {
      return { input, url: null, ok: false, cleaned: false, status: null,
        reason: "Not a usable http(s) URL." };
    }

    // The same block list the discovery pipeline uses. A YouTube or X link is not a citation for an SEO
    // article, and news.google.com is an opaque redirect wrapper rather than a fetchable source.
    if (isBlockedUrl(clean)) {
      return { input, url: null, ok: false, cleaned: false, status: null,
        reason: "Social, video and aggregator links are not citable sources." };
    }

    const cleaned = hasTrackingParams(input);
    const live = await checkUrlLive(clean, 12_000);

    if (!live.ok) {
      return { input, url: null, ok: false, cleaned, status: live.status,
        reason: `Link is not reachable (${live.reason}). Nothing gets inserted — a dead link on a published page is worse than no link.` };
    }

    // Follow the redirect in the inserted URL. Citing the redirector means the reader takes an extra hop
    // and the link breaks entirely if that hop is ever retired.
    const finalDiffers = live.finalUrl !== clean;
    return {
      input,
      url: live.finalUrl,
      ok: true,
      cleaned,
      status: live.status,
      ...(finalDiffers ? { redirectedTo: live.finalUrl } : {}),
    };
  }));

  return NextResponse.json({ ok: true, verdicts });
}
