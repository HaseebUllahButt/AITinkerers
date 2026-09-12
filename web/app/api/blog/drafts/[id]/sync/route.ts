import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import {
  getBlogDraft, markBlogDraftSynced, markBlogDraftSyncFailed,
  createBlogDraftRevision, blogSlugTaken, updateBlogDraft,
} from "@/lib/db/queries";
import {
  createEntry, updateEntry, getEntry, findOneBySlug, blogType, strapiConfigured, adminEntryUrl, strapiLocale,
  collectionForDraft, collectionExists,
} from "@/lib/strapi/client";
import { mapDraftToStrapi, syncReadiness } from "@/lib/strapi/mapDraft";
import { editableSnapshot } from "@/lib/blog/fields";
import { deriveSyncState } from "@/lib/blog/state";
import { checkCollectionFit } from "@/lib/strapi/collectionFit";

export const maxDuration = 60;

// POST — push this draft to Strapi as an UNPUBLISHED entry (publishedAt: null), so a teammate can
// open and edit it in the Strapi admin. Creates the entry the first time, updates it after that.
//
// Deliberately separate from saving. Autosave writes only to our Postgres and can never fail on a
// missing section; this is the explicit "put it in the CMS" step. Strapi relaxes required/minLength
// for drafts, so an incomplete post syncs fine — only slug uniqueness is enforced (it's a `uid`).
//
// On failure the local row is left completely untouched apart from the error bookkeeping. The old
// behaviour returned ok:true with a `warning` string, which let local and remote diverge silently
// with nothing persisted to record it.
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

    const problems = syncReadiness(draft);
    if (problems.length) {
      return NextResponse.json({ ok: false, error: problems.join(" ") }, { status: 400 });
    }
    // uid uniqueness is global and is NOT relaxed for drafts, so catch a local collision here
    // rather than letting Strapi answer with a less obvious 400.
    if (await blogSlugTaken(draft.slug, draft.id)) {
      return NextResponse.json(
        { ok: false, error: `The slug "${draft.slug}" is already used by another draft.` },
        { status: 400 },
      );
    }

    // Snapshot before pushing, so there's always a record of exactly what went to the CMS.
    await createBlogDraftRevision(id, draft.rev, "pre_sync", editableSnapshot(draft), s.user?.email)
      .catch(() => {});

    // The collection this draft belongs to, not "the blog" by assumption. Checked before the first
    // write: creating an entry in a collection that does not exist is not recoverable by retrying,
    // and the failure would surface as a confusing 404 from deep inside the create call.
    const collection = collectionForDraft(draft);
    if (collection !== blogType() && !(await collectionExists(collection))) {
      return NextResponse.json(
        { ok: false, error: `Strapi has no collection "${collection}", or the token cannot read it. Nothing was written.` },
        { status: 400 },
      );
    }

    // Would this collection actually KEEP the draft? collectionExists() above only proves something
    // answers by that name. Measured: syncing into `cluster-pages` preserves 4 of 16 mapped fields and
    // silently discards the title and the whole body, because Strapi ignores attributes a type does not
    // have instead of erroring. See strapi/collectionFit.ts.
    const fit = await checkCollectionFit(collection, draft);
    if (!fit.ok) {
      return NextResponse.json({ ok: false, error: fit.reason, fit }, { status: 400 });
    }

    let strapiId = draft.strapi_id ?? null;
    /** Set when the recorded entry turned out to be gone and this sync had to re-create it. */
    let recovered: string | null = null;
    try {
      if (strapiId) {
        // Never touches publishedAt — re-syncing a draft keeps it a draft, and re-syncing a live
        // post keeps it live (that's the "Push update" case).
        try {
          await updateEntry(collection, strapiId, mapDraftToStrapi(draft, { mode: "draft" }));
        } catch (e: unknown) {
          // ── the recorded entry is GONE ─────────────────────────────────────────────────────────
          //
          // strapi_id is stored forever, and an entry deleted in the Strapi admin leaves the draft
          // pointing at nothing. Every later sync then repeats updateEntry on a dead id and fails
          // identically, so the draft is stuck in sync_failed with no path out of it from the UI —
          // "Retry sync" retries the one call that cannot ever work.
          //
          // Measured on draft 1ccc6708 ("How to Make an AI Comedy Series"): strapi_id 863,
          // synced_rev 5 so it HAD synced, entry 863 answering 404, and ids 861/862/864 present —
          // a hole where a deleted row used to be. Reported by the person as deduplication blocking
          // an edit, which is what it looks like from the outside.
          //
          // The landing path has handled this since sections.ts ("an entry deleted in the Strapi
          // admin leaves the run pointing at nothing while still reporting step 7 of 9"). The blog
          // path never did.
          //
          // Recovery, in order: adopt an entry that already holds this slug, else create a new one.
          // Adopting first matters — creating blindly when the slug is taken is what produces the
          // duplicate the unique-slug rule exists to prevent.
          const msg = e instanceof Error ? e.message : String(e);
          if (!/\b404\b|not found/i.test(msg)) throw e;

          const existing = await findOneBySlug<{ id: number }>(collection, draft.slug).catch(() => null);
          if (existing?.id) {
            strapiId = existing.id;
            await updateEntry(collection, strapiId, mapDraftToStrapi(draft, { mode: "draft" }));
            recovered = `Entry ${draft.strapi_id} no longer exists in Strapi — it was deleted there. Re-pointed this draft at entry ${strapiId}, which already holds the slug "${draft.slug}", and wrote to that.`;
          } else {
            const remade = await createEntry(
              collection,
              mapDraftToStrapi(draft, { mode: "draft", locale: strapiLocale() }),
              { publish: false },
            );
            strapiId = remade.id;
            recovered = `Entry ${draft.strapi_id} no longer exists in Strapi — it was deleted there, and nothing else held the slug "${draft.slug}", so this sync created a fresh entry ${strapiId}. It is a DRAFT; whoever deleted the old one may have meant to.`;
          }
        }
      } else {
        const created = await createEntry(
          collection,
          // locale is only settable at create time in v4.
          mapDraftToStrapi(draft, { mode: "draft", locale: strapiLocale() }),
          { publish: false },
        );
        strapiId = created.id;
      }
    } catch (e: any) {

      const message = e?.message ?? "Strapi sync failed";
      const failed = await markBlogDraftSyncFailed(id, message);
      return NextResponse.json(
        { ok: false, error: message, draft: failed, syncState: deriveSyncState(failed) },
        { status: 502 },
      );
    }

    // ── Verify what actually landed, before calling this synced ───────────────────────────────────
    //
    // A 2xx from Strapi is not proof the fields arrived. Measured on draft
    // 3c200005 / entry 861: SearchOps held thumbnail_media_id 17133 (a real file —
    // deepseek-v4-pro-ga-and-v4-flash-explained-thumbnail.png), the sync returned success, synced_rev
    // was stamped equal to rev so the UI said "In Strapi (draft)" with no staleness — and the entry's
    // thumbnail read back as {"data":null}. The publish gate then passed it, because the gate checks
    // SearchOps's OWN row rather than the CMS. That is how a draft was "ready to go" with an empty
    // required media field in the place it actually has to be filled.
    //
    // Media relations are the fields this happens to: they are set by integer id, and an id Strapi
    // declines to link is dropped silently rather than refused. So they are read back and compared.
    // Prose fields are left alone — they either write or 400, and adding a full-body diff here would
    // cost a large read on every sync to catch a failure that has never been observed.
    const mediaDrift: string[] = [];
    try {
      const after = await getEntry(collection, strapiId!, { populate: "thumbnail,cover" });
      // Three shapes, because `getEntry` runs its result through `flatten()` in strapi/client.ts.
      // Strapi answers `{data:{id,attributes}}`; flatten collapses the relation wrapper and then the
      // id/attributes pair, so what actually arrives here is `{id, name, mime, …}` — no `.data` at all.
      // Reading only `.data.id` therefore found nothing on media that HAD landed, and every sync with a
      // thumbnail was failed with a 502 that named the correct image as missing. Verified against the
      // live entry: thumbnail read back as id=17133 while this reported "Strapi has nothing".
      const landed = (v: unknown): number | null => {
        if (typeof v === "number") return v;
        if (!v || typeof v !== "object") return null;
        const wrapped = (v as { data?: { id?: number } }).data;
        if (typeof wrapped?.id === "number") return wrapped.id;
        const flat = (v as { id?: number }).id;
        return typeof flat === "number" ? flat : null;
      };
      const raw = after as unknown as Record<string, unknown>;
      const checks: Array<[string, number | null | undefined, unknown]> = [
        ["thumbnail", draft.thumbnail_media_id, raw.thumbnail],
        ["cover", draft.cover_media_id, raw.cover],
      ];
      for (const [field, expected, got] of checks) {
        if (!expected) continue;              // nothing to land
        const actual = landed(got);
        if (actual !== expected) {
          mediaDrift.push(`${field}: SearchOps has media ${expected}, Strapi has ${actual ?? "nothing"}`);
        }
      }
    } catch {
      // A failed read-back is not a failed sync. Saying nothing here is right: the write succeeded and
      // the only thing lost is the extra check.
      mediaDrift.push("could not read the entry back, so the media fields were not verified");
    }

    // Drift means NOT synced. Stamping synced_rev would tell the UI everything matches and silence the
    // one prompt that would get somebody to fix it.
    if (mediaDrift.length && !mediaDrift[0].startsWith("could not read")) {
      const message =
        `Strapi accepted the sync but did not store every image: ${mediaDrift.join("; ")}. ` +
        "Re-attach the image in Strapi, or re-sync — this draft is NOT ready to publish.";
      // Record the entry id BEFORE failing the sync. The entry was created; only the verification
      // failed. Returning without stamping it orphans a real Strapi entry that SearchOps has no record
      // of, so the next sync takes the `!strapiId` branch and CREATES A SECOND ONE. Observed: entry
      // 862 existed with both images attached while the draft's strapi_id was still null.
      //
      // Deliberately not markBlogDraftSynced — that stamps synced_rev and tells the UI everything
      // matches, which is the silence this check exists to break. The id is a fact; "synced" is not.
      if (strapiId) await updateBlogDraft(id, { strapi_id: strapiId }).catch(() => {});
      const failed = await markBlogDraftSyncFailed(id, message);
      return NextResponse.json(
        { ok: false, error: message, media_drift: mediaDrift, draft: failed, syncState: deriveSyncState(failed) },
        { status: 502 },
      );
    }

    const updated = await markBlogDraftSynced(id, strapiId!, draft.rev, adminEntryUrl(strapiId!));
    return NextResponse.json({
      ok: true,
      draft: updated,
      syncState: deriveSyncState(updated),
      adminUrl: adminEntryUrl(strapiId!),
      // Said out loud when the entry had to be re-created or re-pointed. A silent recovery would
      // leave somebody believing they are still editing the entry they had open in Strapi.
      ...(recovered ? { recovered, warnings: [recovered] } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "sync failed" }, { status: 500 });
  }
}
