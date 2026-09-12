// Can this collection actually hold a blog draft?
//
// ── The measured failure ────────────────────────────────────────────────────────────────────────
//
// `strapi_collection` redirects a draft's sync into any collection, and the only validation it ever
// had was collectionExists() — "does a collection by this name respond". That is a much weaker
// question than the one that matters.
//
// Measured on draft a21111ed ("Grok 4.6") after its collection was set to `cluster-pages`.
// mapDraftToStrapi produces 16 keys; cluster-page accepts FOUR of them:
//
//   accepted  slug, shouldIndex, canonicalTag, category
//   dropped   title, body, description, tags, isFeatured, youtubeVideoId, cover, author,
//             thumbnail, blogHeroCTA, blogsMetaData, markupSchema
//
// The article's title and its entire 4,346-character body are in the dropped list. Strapi does not
// error on unknown attributes — it ignores them. So that sync does not fail loudly; it writes an entry
// containing a slug and quietly discards the post. And cluster-page requires four more fields a blog
// draft has no value for at all (`template`, `clusterPageTitle`, `clusterPageDescription`,
// `clusterPageBannerImage`), so what survives cannot be published either.
//
// `category` is worse than dropped, it is mistyped: on the blog it is a RELATION id, on cluster-page
// it is an ENUM of category names. Sending an integer where a string enum is expected is a write that
// looks plausible in a payload and is wrong in the database.
//
// landing/stages.ts already records the damage this class of mistake did once before: "A page taken
// through it published as a blog post and orphaned its own cluster-page entry."
//
// ── Why the check reads the live schema ─────────────────────────────────────────────────────────
//
// Refusing a hardcoded list of bad collections would be wrong the first time somebody added another
// one, and this Strapi has 41 content types. Asking the schema what it can hold is correct for every
// collection including the ones that do not exist yet.
//
// ── Why an unreadable schema REFUSES ────────────────────────────────────────────────────────────
//
// Everywhere else in this app a Strapi outage degrades gracefully. Not here, and deliberately: the
// blog — the destination of every draft that sets nothing — short-circuits before any network call, so
// an outage cannot block normal work. Reaching this check at all means somebody redirected a draft
// somewhere unusual, and an unverifiable unusual write is precisely the one worth stopping.
import { blogType } from "@/lib/strapi/client";
import { mapDraftToStrapi } from "@/lib/strapi/mapDraft";
import type { BlogDraft } from "@/lib/db/queries";

/** Losing any of these means losing the post itself, not a field off it. */
const LOAD_BEARING = new Set(["title", "body"]);

export interface CollectionFit {
  ok: boolean;
  collection: string;
  /** Mapped keys the target has no attribute for. Strapi ignores these SILENTLY. */
  dropped: string[];
  /** Of those, the ones whose loss destroys the content. */
  critical: string[];
  /** Required attributes on the target that a blog draft cannot supply. */
  unsatisfiable: string[];
  /** One sentence naming what is wrong and what to do instead. Null when ok. */
  reason: string | null;
  /** Set when the schema could not be read at all. Also produces ok:false — see the header. */
  error: string | null;
}

interface RawSchema {
  attributes?: Record<string, { type?: string; required?: boolean }>;
  pluralName?: string;
  singularName?: string;
}

let cache: { at: number; value: Map<string, RawSchema> } | null = null;
const TTL_MS = 10 * 60 * 1000;

/**
 * Every collection's schema, keyed by the PLURAL api id — which is what `strapi_collection` holds.
 *
 * Matched on Strapi's own `pluralName` rather than de-pluralising the api id, because that mapping is
 * not derivable: `cluster-pages` → `cluster-page`, but `case-studies` → `case-study`. A naive
 * trailing-s strip produces `case-studie` and a 404 that looks like "the collection is missing".
 */
async function collectionSchemas(): Promise<Map<string, RawSchema>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const url = process.env.STRAPI_URL?.trim().replace(/\/$/, "");
  const token = process.env.STRAPI_API_TOKEN?.trim();
  if (!url || !token) throw new Error("STRAPI_URL / STRAPI_API_TOKEN are not set.");

  const res = await fetch(`${url}/api/content-type-builder/content-types`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`content-type-builder returned ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ uid?: string; schema?: RawSchema }> };

  const byPlural = new Map<string, RawSchema>();
  for (const ct of json?.data ?? []) {
    // Only `api::*` types. The plugin and admin types (users-permissions, upload) are not somewhere a
    // draft can be synced and listing them would only make a mistyped name match something.
    if (!ct?.uid?.startsWith("api::")) continue;
    const plural = ct.schema?.pluralName;
    if (plural) byPlural.set(plural, ct.schema!);
  }
  if (byPlural.size === 0) throw new Error("Strapi returned no API content types.");
  cache = { at: Date.now(), value: byPlural };
  return byPlural;
}

/**
 * Would syncing this draft into this collection preserve it?
 *
 * Takes the real draft rather than a synthetic sample so the refusal can name what would actually be
 * lost from THIS post. A draft with no youtube id does not need to hear that youtubeVideoId has
 * nowhere to go.
 */
export async function checkCollectionFit(
  collection: string,
  draft: Partial<BlogDraft>,
): Promise<CollectionFit> {
  const base: CollectionFit = {
    ok: true, collection, dropped: [], critical: [], unsatisfiable: [], reason: null, error: null,
  };

  // The blog is the default and the known-good case. Short-circuited before any network call so a
  // Strapi outage can never block an ordinary sync.
  if (!collection || collection === blogType()) return base;

  let schemas: Map<string, RawSchema>;
  try {
    schemas = await collectionSchemas();
  } catch (e) {
    return {
      ...base,
      ok: false,
      error: e instanceof Error ? e.message : "could not read the Strapi schema",
      reason:
        `This draft is set to sync into "${collection}" rather than the blog, and SearchOps could not read ` +
        "that collection's schema to check the fields would survive. Refusing rather than guessing — " +
        "clear the draft's Strapi collection to publish it to the blog, or retry when Strapi answers.",
    };
  }

  const schema = schemas.get(collection);
  if (!schema) {
    return {
      ...base,
      ok: false,
      reason:
        `There is no Strapi collection called "${collection}". Known collections are matched on their ` +
        `plural api id — clear the field to use the blog (${blogType()}).`,
    };
  }

  const attrs = schema.attributes ?? {};
  const mapped = Object.keys(mapDraftToStrapi(draft, { mode: "draft" }));
  const dropped = mapped.filter((k) => !(k in attrs));
  const critical = dropped.filter((k) => LOAD_BEARING.has(k));
  const unsatisfiable = Object.entries(attrs)
    .filter(([name, a]) => a?.required && !mapped.includes(name))
    .map(([name]) => name);

  if (critical.length === 0 && unsatisfiable.length === 0) {
    return { ...base, dropped };
  }

  // Named in the order a person would want them: what gets destroyed, then what cannot be filled.
  const parts: string[] = [];
  if (critical.length) {
    parts.push(
      `"${collection}" has no ${critical.join(" or ")} field, so the draft's ${
        critical.includes("body") ? "entire body" : critical.join(" and ")
      } would be silently discarded — Strapi ignores attributes a type does not have rather than erroring`,
    );
  }
  if (unsatisfiable.length) {
    parts.push(
      `it requires ${unsatisfiable.join(", ")}, which a blog draft has no value for, so the entry could not be published either`,
    );
  }

  return {
    ...base,
    ok: false,
    dropped,
    critical,
    unsatisfiable,
    reason:
      `This draft cannot sync into "${collection}": ${parts.join("; ")}. ` +
      (collection === "cluster-pages"
        ? "A landing page is a different kind of thing, not a blog draft with a different collection — build it through the landing tools (or /landing), which write a real cluster-page entry with a template."
        : "Clear the draft's Strapi collection to publish it to the blog."),
  };
}
