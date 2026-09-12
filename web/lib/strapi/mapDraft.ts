// Maps a local BlogDraft row (src/lib/db/queries.ts) to the Strapi blog field shape.
// Kept separate from client.ts (which is content-type-agnostic) and queries.ts (which is
// Strapi-agnostic) — this is the one place that knows both schemas.
//
// ── Which collection this targets, and why it changed ──────────────────────────────────────────────
//
// Until now this mapped onto `api::resource.resource`. That was the wrong collection. Measured against
// the live instance (https://imagine-blog.vyro.ai):
//
//     /api/resources       21 entries   ← what Summit was publishing into
//     /api/imagine-webs   759 entries   ← the real blog corpus, "blogs" in the Strapi sidebar
//
// So every draft Summit synced landed in a 21-row collection the content team does not work in. It also
// explains two things that looked like separate problems: `markupSchema` appeared "missing" (it exists on
// imagine-web, not on resources), and the Strapi field arrangement never matched what the team sees,
// because it was mirroring a different content type.
//
// The two schemas are otherwise near-identical, which is why this went unnoticed — the diff is two
// renamed components plus two fields that only exist on the real one:
//
//     resourceHeroCTA   -> blogHeroCTA     (same component: blog-components.blog-hero-cta)
//     resourceMetaData  -> blogsMetaData   (same component: components.metadata)
//     + markupSchema  json         JSON-LD, the field the SEO team asked for
//     + likes         biginteger   not Summit's to write
//
// `category` also retargets: api::resource-category (2 entries) -> api::blog-category (15 real ones).
//
// Field NAMES are read from env rather than hardcoded, so a future collection change is configuration
// instead of a code edit that silently half-lands — the failure mode this comment exists to prevent.
//
// Constraints below come from the live content-type schema
// (GET /api/content-type-builder/content-types/api::imagine-web.imagine-web), not from inference:
//   title        string   REQUIRED  minLength 35
//   description  text     REQUIRED  minLength 120
//   slug         uid      REQUIRED  (targetField title) → globally UNIQUE, incl. across drafts
//   thumbnail    media    REQUIRED
//   cover        media    optional
//   isFeatured   boolean  REQUIRED
//   blogHeroCTA    component REQUIRED (inner text + url both required)
//   blogsMetaData  component optional (but inner title/description/keywords all required)
//   markupSchema   json     optional
//   body richtext (plain markdown) · tags text · author/category manyToOne relations
// draftAndPublish: true, i18n localized.
// No import from ./client on purpose: publishReadiness() is imported by the editor, and this file
// must stay safe to pull into the browser bundle. The caller passes `locale` instead.
import type { BlogDraft } from "@/lib/db/queries";
import { markdownTablesToHtml } from "@/lib/blog/tables";

/** Component field names, overridable so pointing at another collection stays configuration.
 *  NEXT_PUBLIC_ so publishReadiness() resolves the same names in the browser bundle. */
export const HERO_CTA_FIELD = process.env.NEXT_PUBLIC_STRAPI_HERO_CTA_FIELD?.trim() || "blogHeroCTA";
export const META_FIELD = process.env.NEXT_PUBLIC_STRAPI_META_FIELD?.trim() || "blogsMetaData";

export interface MapOptions {
  /** "draft" omits what Strapi relaxes for drafts and allows clearing required media.
   *  "publish" synthesises every required field, because validation is enforced on publish. */
  mode?: "draft" | "publish";
  /** Set to include `locale` in the payload. Only valid on create — v4 has no locale-changing
   *  update. Pass strapiLocale() from ./client at the call site. */
  locale?: string;
}

export function mapDraftToStrapi(d: Partial<BlogDraft>, opts: MapOptions = {}): Record<string, unknown> {
  const mode = opts.mode ?? "draft";
  const out: Record<string, unknown> = {};

  // Uniform rule for every field: emit the key iff the caller supplied it, and pass `null`
  // through as `null`. Relations and media used to be gated on truthiness (`if (d.cover_media_id)`)
  // while scalars used `!== undefined`, which meant clearing an author or a cover locally simply
  // omitted the key — so the live entry kept the old relation forever with no way to unset it.
  const has = (k: keyof BlogDraft) => k in d;

  if (has("title")) out.title = d.title;
  if (has("slug")) out.slug = d.slug;
  // Pipe tables become HTML on the way out. Measured on 40 live posts: 18 use an HTML <table>, 0 use a
  // markdown pipe table — the renderer does not support GFM tables, so a pipe table ships as literal
  // pipes on a live page. Converting here rather than in the editor keeps the author's own source as
  // markdown (which the live preview renders) instead of mutating it under their cursor.
  if (has("body")) out.body = d.body ? markdownTablesToHtml(d.body) : d.body;
  if (has("description")) out.description = d.description;
  if (has("tags")) out.tags = d.tags;
  if (has("is_featured")) out.isFeatured = d.is_featured ?? false;
  if (has("should_index")) out.shouldIndex = d.should_index ?? true;
  if (has("canonical_tag")) out.canonicalTag = d.canonical_tag ?? null;
  if (has("youtube_video_id")) out.youtubeVideoId = d.youtube_video_id ?? null;

  if (has("cover_media_id")) out.cover = d.cover_media_id ?? null;
  if (has("author_id")) out.author = d.author_id ?? null;
  if (has("category_id")) out.category = d.category_id ?? null;

  // thumbnail is REQUIRED, so `null` is only ever legal while the entry is a draft. Sending
  // thumbnail:null in publish mode would turn a passing publish into a 400.
  if (has("thumbnail_media_id")) {
    const t = d.thumbnail_media_id ?? null;
    if (t !== null || mode === "draft") out.thumbnail = t;
  }

  // Required component. Only synthesise the empty shape when publishing (where its absence is a
  // hard failure); on a draft, omit it entirely rather than writing {text:"",url:""} — Strapi's
  // required check is notNil(), so empty strings would satisfy it and mask a missing CTA.
  const hasCta = !!d.hero_cta_text?.trim() || !!d.hero_cta_url?.trim();
  if (hasCta || mode === "publish") {
    out[HERO_CTA_FIELD] = { text: d.hero_cta_text ?? "", url: d.hero_cta_url ?? "" };
  }

  // Optional component whose inner fields are all required. A full Supabase row always contains
  // these keys (as null), so the old `!== undefined` test fired on every single draft and wrote an
  // empty component. Only emit when there's real content, or when publishing.
  const hasSeo = !!d.seo_title?.trim() || !!d.seo_description?.trim() || !!d.seo_keywords?.trim();
  if (hasSeo || mode === "publish") {
    out[META_FIELD] = {
      title: d.seo_title || d.title || "",
      description: d.seo_description || d.description || "",
      keywords: d.seo_keywords || "",
    };
  }

  // JSON-LD. Only on the real blog collection, which is part of why the collection switch mattered:
  // `resources` has no such field, so schema markup had nowhere to go at all.
  //
  // Sent as a parsed object, not a string — the field is Strapi `json`, and posting a JSON *string*
  // stores a quoted blob that renders as escaped text in the admin's code editor rather than a tree.
  // Unparseable content is dropped rather than passed through: a malformed graph on a live page is
  // worse than none, and this is the last place that can tell the difference.
  if (has("markup_schema")) {
    const raw = (d as Record<string, unknown>).markup_schema;
    if (raw == null || raw === "") {
      if (mode === "draft") out.markupSchema = null;
    } else if (typeof raw === "string") {
      try { out.markupSchema = JSON.parse(raw); } catch { /* malformed — omit rather than corrupt */ }
    } else {
      out.markupSchema = raw;
    }
  }

  if (opts.locale) out.locale = d.locale || opts.locale;

  return out;
}

/** Blocks a *sync* (push as an unpublished Strapi draft). Strapi relaxes `required` and
 *  `minLength` for drafts, but NOT uid uniqueness — so slug is the only hard gate here. */
export function syncReadiness(d: Partial<BlogDraft>): string[] {
  const problems: string[] = [];
  if (!d.slug?.trim()) problems.push("Slug is required (Strapi uses it as a unique id).");
  return problems;
}

/**
 * Blocks a *publish*.
 *
 * ⚠️ This is not a convenience mirror of Strapi's validation — it is the ONLY gate. Probed against
 * the live instance (scripts/blog_strapi_draft_probe.mjs): a `PUT` that sets `publishedAt` does
 * **not** re-run validation. An entry with title "x", no description and no hero CTA published with
 * HTTP 200 and zero errors. Strapi only validates on *create*, so our two-step publish
 * (updateEntry → publishEntry) bypasses its validation entirely.
 *
 * Consequences, both load-bearing:
 *   - The publish route must call this BEFORE touching Strapi (it does). Never make it advisory.
 *   - Never "simplify" publishing into a single create-with-publishedAt call to get Strapi's
 *     validation back: that loses the ordering guarantee that stops stale content going live.
 */
export function publishReadiness(d: Partial<BlogDraft>): string[] {
  const problems: string[] = [];
  if (!d.title || d.title.length < 35) problems.push(`Title needs ≥35 characters (currently ${d.title?.length ?? 0}).`);
  if (!d.description || d.description.length < 120) problems.push(`Description needs ≥120 characters (currently ${d.description?.length ?? 0}).`);
  // Declared `required: true` on the content type, but the REST API does NOT enforce it — a publish
  // with every other field present and no thumbnail returns 200 (probed). We block on it anyway,
  // deliberately: it's the social/preview card image for an SEO page, the Strapi admin does enforce
  // it, and "Use cover" makes satisfying it one click. This is our rule, not Strapi's.
  if (!d.thumbnail_media_id) problems.push("Thumbnail image is required (social/preview card).");
  if (!d.hero_cta_text?.trim() || !d.hero_cta_url?.trim()) problems.push("Hero CTA (text + URL) is required.");
  if (!d.slug?.trim()) problems.push("Slug is required.");
  return problems;
}
