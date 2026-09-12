import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import {
  getBlogDraft, markBlogDraftPublished, markBlogDraftSyncFailed,
  createBlogDraftRevision, blogSlugTaken,
} from "@/lib/db/queries";
import {
  createEntry, updateEntry, publishEntry, getEntry, blogType, strapiConfigured, adminEntryUrl, strapiLocale,
} from "@/lib/strapi/client";
import { mapDraftToStrapi, publishReadiness } from "@/lib/strapi/mapDraft";
import { editableSnapshot } from "@/lib/blog/fields";
import { deriveSyncState } from "@/lib/blog/state";
import { checkDraftLinks, describeLinkProblems } from "@/lib/blog/linkCheck";
import { collectionForDraft } from "@/lib/strapi/client";
import { checkCollectionFit } from "@/lib/strapi/collectionFit";

export const maxDuration = 60;

/** Publishing writes to whatever host STRAPI_URL points at. That is currently a sandbox, but a
 *  config change is all that stands between here and a live site, so the host is echoed back to the
 *  caller on every publish and can be gated outright with STRAPI_ALLOW_PUBLISH. */
function publishGate(): { ok: true; host: string } | { ok: false; error: string } {
  const host = (process.env.STRAPI_URL ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const allow = process.env.STRAPI_ALLOW_PUBLISH?.trim();
  if (allow && allow !== "1" && allow !== "true" && allow !== host) {
    return { ok: false, error: `Publishing is disabled for ${host} (STRAPI_ALLOW_PUBLISH=${allow}).` };
  }
  return { ok: true, host };
}

// POST — make this post LIVE in Strapi. The one action that publishes; never a side effect of a
// save or a sync.
//
// Two calls in a fixed order: push the current fields, THEN set publishedAt. That way we can never
// publish stale content, and a failure at step 2 leaves a correct, still-unpublished draft rather
// than a half-updated live post. If the draft has never been synced, this syncs it first so the
// user doesn't have to sequence two buttons.
//
// ⚠️ The publishReadiness() call below is not a nicety — it is the only validation that runs.
// Probed on the live instance: a PUT setting publishedAt does NOT re-validate, so Strapi will
// happily publish an entry with a one-character title and no description (HTTP 200, no errors).
// Strapi validates on create only, and our two-step deliberately avoids create-with-publishedAt.
// If this guard is ever moved after the Strapi calls, or downgraded to a warning, invalid content
// goes live silently. See scripts/blog_strapi_draft_probe.mjs.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Session-only: publishing is a deliberate human act, so no CRON_SECRET path here. That's also
  // what stops the unattended cluster writer from ever reaching it.
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!strapiConfigured()) {
    return NextResponse.json({ ok: false, error: "Strapi not configured" }, { status: 503 });
  }
  const gate = publishGate();
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: 403 });

  const { id } = await params;
  // Opt-out for a link the checker is wrong about (a bot-hostile host, a page going live in the
  // same release). Absent or false means the gate applies.
  const force = await req.json().then((b) => b?.force === true).catch(() => false);
  try {
    const draft = await getBlogDraft(id);
    if (!draft) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

    const problems = publishReadiness(draft);
    if (problems.length) {
      return NextResponse.json(
        { ok: false, error: problems.join(" "), problems, host: gate.host },
        { status: 400 },
      );
    }
    if (await blogSlugTaken(draft.slug, draft.id)) {
      return NextResponse.json(
        { ok: false, error: `The slug "${draft.slug}" is already used by another draft.` },
        { status: 400 },
      );
    }

    // Do the links actually resolve? publishReadiness() above cannot answer this — it is synchronous
    // field validation, and the writer's own validator only checks that a URL was tool-sourced and
    // on the approved internal list, never that the page is still there. An approved internal page
    // that was unpublished last week passes every existing check and 404s the moment this goes live.
    //
    // Only DEFINITE breakage blocks (404, gone, soft-404, silent redirect to home, first-party 5xx).
    // Unreachable is reported and allowed through: X and other bot-hostile hosts land there, and a
    // gate that cries wolf is a gate people learn to skip.
    //
    // `force: true` from the client publishes anyway, and the response always carries the findings
    // either way, so overriding is a visible decision rather than a silent one.
    if (!force) {
      const report = await checkDraftLinks(draft.body ?? "").catch(() => null);
      if (report?.broken.length) {
        return NextResponse.json({
          ok: false,
          error: `${report.broken.length} link${report.broken.length === 1 ? "" : "s"} in this post ${report.broken.length === 1 ? "does" : "do"} not resolve.`,
          problems: describeLinkProblems(report),
          linkCheck: report,
          host: gate.host,
        }, { status: 400 });
      }
    }

    await createBlogDraftRevision(id, draft.rev, "pre_publish", editableSnapshot(draft), s.user?.email)
      .catch(() => {});

    // The draft's OWN collection, not blogType(). This route used blogType() in all three calls while
    // the sync route honoured strapi_collection, and that asymmetry was a live data-loss path: a draft
    // synced into another collection stores THAT entry's numeric id, so publishing it ran
    // updateEntry(blog, <other collection's id>) — overwriting and then publishing whichever unrelated
    // blog post happened to hold that id. Strapi ids are per-collection and the blog has 759 entries,
    // so a low id from a smaller collection lands on a real, live post.
    const collection = collectionForDraft(draft);
    const fit = await checkCollectionFit(collection, draft);
    if (!fit.ok) {
      return NextResponse.json({ ok: false, error: fit.reason, fit, host: gate.host }, { status: 400 });
    }

    let strapiId = draft.strapi_id ?? null;
    try {
      const fields = mapDraftToStrapi(draft, { mode: "publish" });
      if (strapiId) {
        await updateEntry(collection, strapiId, fields);
      } else {
        // Created as a draft, then published below — same two-step, so the ordering guarantee
        // holds even for a never-synced post.
        const created = await createEntry(
          collection,
          mapDraftToStrapi(draft, { mode: "publish", locale: strapiLocale() }),
          { publish: false },
        );
        strapiId = created.id;
      }

      // ── Verify the ENTRY, not our own row, before going live ────────────────────────────────
      //
      // publishReadiness() above reads the SearchOps draft. That is the right check for "has a person
      // finished writing this", and the wrong one for "is the thing about to go live complete",
      // because the two can disagree: media relations are set by integer id and an id Strapi
      // declines to link is dropped SILENTLY rather than refused. Measured on entry 861 — SearchOps
      // held thumbnail 17133 and the entry's thumbnail read back empty, with blogHeroCTA empty too,
      // while every gate passed.
      //
      // This is the last moment it can be caught. Per the note on publishReadiness, a PUT that sets
      // publishedAt does NOT re-run Strapi's validation — an entry with a one-character title and no
      // description publishes with a 200 — so nothing downstream will object.
      //
      // Reads back the fields just written. `flatten()` in strapi/client.ts collapses
      // {data:{id,attributes}} to {id,…}, so a media field arrives as an object with an id and no
      // `.data`; both shapes are accepted here (the mistake #111 fixed in the sync route).
      const after = await getEntry(collection, strapiId!, { populate: "thumbnail,cover,blogHeroCTA" })
        .catch(() => null);
      if (after) {
        const raw = after as unknown as Record<string, unknown>;
        const mediaId = (v: unknown): number | null => {
          if (typeof v === "number") return v;
          if (!v || typeof v !== "object") return null;
          const wrapped = (v as { data?: { id?: number } }).data;
          if (typeof wrapped?.id === "number") return wrapped.id;
          const flat = (v as { id?: number }).id;
          return typeof flat === "number" ? flat : null;
        };
        const cta = raw.blogHeroCTA as { text?: string; url?: string; data?: { attributes?: { text?: string; url?: string } } } | null;
        const ctaInner = cta?.data?.attributes ?? cta ?? null;
        const inStrapi: string[] = [];
        if (!String((raw.title as string) ?? "").trim()) inStrapi.push("title is empty in Strapi");
        if (!String((raw.description as string) ?? "").trim()) inStrapi.push("description is empty in Strapi");
        if (!String((raw.body as string) ?? "").trim()) inStrapi.push("body is empty in Strapi");
        if (draft.thumbnail_media_id && mediaId(raw.thumbnail) !== draft.thumbnail_media_id) {
          inStrapi.push(`thumbnail did not attach (SearchOps has ${draft.thumbnail_media_id}, Strapi has ${mediaId(raw.thumbnail) ?? "nothing"})`);
        }
        if (draft.cover_media_id && mediaId(raw.cover) !== draft.cover_media_id) {
          inStrapi.push(`cover did not attach (SearchOps has ${draft.cover_media_id}, Strapi has ${mediaId(raw.cover) ?? "nothing"})`);
        }
        if (!ctaInner?.text?.trim() || !ctaInner?.url?.trim()) inStrapi.push("hero CTA is empty in Strapi");
        if (inStrapi.length) {
          // NOT published, and the entry is left as a draft so the state is recoverable: fix the
          // field (or re-sync) and press publish again.
          const message =
            `Strapi accepted the write but the entry is not complete, so this was NOT published: ${inStrapi.join("; ")}. `
            + "The entry is still a draft — fix it in Strapi or re-sync, then publish again.";
          const failed = await markBlogDraftSyncFailed(id, message);
          return NextResponse.json(
            { ok: false, error: message, problems: inStrapi, strapi_drift: inStrapi, draft: failed, syncState: deriveSyncState(failed), host: gate.host },
            { status: 502 },
          );
        }
      }

      await publishEntry(collection, strapiId!);
    } catch (e: any) {
      const message = e?.message ?? "Strapi publish failed";
      const failed = await markBlogDraftSyncFailed(id, message);
      return NextResponse.json(
        { ok: false, error: message, draft: failed, syncState: deriveSyncState(failed), host: gate.host },
        { status: 502 },
      );
    }

    const updated = await markBlogDraftPublished(id, strapiId!, draft.rev, adminEntryUrl(strapiId!));
    return NextResponse.json({
      ok: true,
      draft: updated,
      syncState: deriveSyncState(updated),
      adminUrl: adminEntryUrl(strapiId!),
      host: gate.host,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "publish failed" }, { status: 500 });
  }
}
