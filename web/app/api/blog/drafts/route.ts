import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { listBlogDraftSummaries, createBlogDraft } from "@/lib/db/queries";
import { sanitizePatch, placeholderSlug } from "@/lib/blog/fields";
import { liveStatuses } from "@/lib/blog/liveStatus";

export const maxDuration = 30;

async function session(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.get("authorization") === `Bearer ${secret}` || req.nextUrl.searchParams.get("key") === secret)) {
    return { user: { email: "cron" } };
  }
  return auth().catch(() => null);
}

// GET ?status=draft|published — list local blog drafts (composer's "My posts" list).
export async function GET(req: NextRequest) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const status = (req.nextUrl.searchParams.get("status") as "draft" | "published") || undefined;
  try {
    // Both in one response. The list and "what is happening to it" are read together on every
    // poll, and two endpoints would let them disagree — a row could show finished while the
    // status said writing, which is the one thing a live indicator must never do.
    const [drafts, live] = await Promise.all([
      listBlogDraftSummaries(status),
      liveStatuses().catch(() => ({})),
    ]);
    return NextResponse.json({ ok: true, drafts, live });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "list failed" }, { status: 500 });
  }
}

// POST { ...fields } — start a new draft. Never touches Strapi; pushing there is an explicit
// action (see /sync). Only allow-listed fields are accepted, so a client that posts a whole stale
// row can't seed server-owned columns like status or strapi_id.
export async function POST(req: NextRequest) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const { patch } = sanitizePatch(body);
  try {
    const draft = await createBlogDraft({
      ...patch,
      // Strapi's slug is a REQUIRED unique `uid`, and uid uniqueness is NOT relaxed for drafts —
      // so two untitled drafts would both be "" and collide on the first sync. Seed a distinct
      // placeholder now rather than discovering it as a 400 later.
      slug: patch.slug?.trim() ? patch.slug : placeholderSlug(),
      created_by: s.user?.email ?? undefined,
    });

    // Kick off the starter images, deliberately WITHOUT awaiting.
    //
    // A draft must exist the instant someone asks for it. An image render is tens of seconds at best and
    // can hang on a provider outage, so awaiting it here would make "new draft" feel broken whenever fal
    // is slow — and would fail the request outright when fal is down, which is a far worse outcome than a
    // draft with no hero yet. The prefill writes the thumbnail onto the draft when it lands; the editor
    // picks it up on its next poll.
    //
    // Skipped for an untitled draft: every prompt derives from the title, so generating from a placeholder
    // spends real money on an image of nothing. Those get their images from the gallery once titled.
    const title = (patch.title as string | undefined)?.trim();
    if (title) {
      void import("@/lib/media/prefill")
        .then(({ prefillAssets }) => prefillAssets({
          draftId: draft.id,
          title,
          keyword: (patch.seo_keywords as string | undefined) ?? title,
          kind: "blog",
          actor: s.user?.email ?? null,
        }))
        .catch(() => { /* best-effort: the draft is already created and usable */ });
    }

    return NextResponse.json({ ok: true, draft, assets_prefilling: !!title });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "create failed" }, { status: 500 });
  }
}
