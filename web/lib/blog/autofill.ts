// Fill the blanks on a draft, without ever overwriting a human's work.
//
// The ask: "is it possible to also autofill these sections? if the user hasnt specified anything,
// according to best practices and research if applicable?" Two words in that sentence set the rules
// this module follows.
//
//  "if the user hasnt specified anything" — every fill is conditional on the field being EMPTY. A
//  non-empty field is never touched, not even to improve it. That makes the action safe to press at
//  any time, including on a draft someone has been hand-editing for an hour, which is the only way
//  a button like this earns trust.
//
//  "where applicable" — some fields have a defensible answer and some don't. `should_index: true` is
//  a real best practice for an indexable blog post. Picking between two Strapi authors named
//  "Author-01" and "Author-02" is not a best practice, it's a coin flip on an editorial decision, so
//  this module declines and says why. Every outcome is reported either as a fill (with its source)
//  or as a skip (with its reason) — there is no silent third category.
//
// Pure and dependency-free so `/api/blog/selfcheck` can assert it. The caller supplies the
// model-generated metadata, the voice defaults and the real Strapi options; nothing here does IO.
import type { BlogDraft } from "@/lib/db/queries";
import { slugify } from "./fields";

/** Where a filled value came from. Shown to the user, because "the AI wrote it" and "your voice
 *  profile already said so" deserve different levels of scrutiny. */
export type FillSource =
  | "written from the article"   // model-generated from the finished body
  | "voice default"              // configured on the voice profile
  | "copied from the cover"      // thumbnail reuse
  | "derived from the title"     // slug
  | "matched to your topic"      // Strapi category chosen by keyword overlap
  | "only option in Strapi"      // exactly one candidate existed
  | "best practice";             // an editorial default with a real reason

export interface Fill { field: string; value: unknown; source: FillSource; note?: string }
export interface Skip { field: string; why: string }

export interface AutofillPlan {
  patch: Partial<BlogDraft>;
  filled: Fill[];
  skipped: Skip[];
}

/** Model-generated metadata, shaped as `generateMeta` returns it. All optional: autofill has to
 *  work with no Anthropic key at all, filling only what needs no model. */
export interface MetaInput {
  title?: string; slug?: string; description?: string;
  seo_title?: string; seo_description?: string; seo_keywords?: string;
  tags?: string;
  hero_cta_text?: string; hero_cta_url?: string;
}

export interface VoiceDefaults {
  default_cta_text?: string | null;
  default_cta_url?: string | null;
}

export interface StrapiOptions {
  authors: Array<{ id: number; name: string }>;
  categories: Array<{ id: number; title: string; slug: string }>;
  /** STRAPI_DEFAULT_AUTHOR, resolved to an id by the caller if it matched a real author. */
  default_author_id?: number | null;
}

const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === "";

/** Tokens worth matching on. Two characters or fewer carries no signal ("ai" is the exception that
 *  matters most in this product, so keep length 2). */
function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length >= 2 && !STOP.has(t)),
  );
}
const STOP = new Set([
  "the", "and", "for", "with", "your", "you", "are", "how", "what", "why", "best", "top", "guide",
  "using", "use", "from", "into", "that", "this", "our", "can", "does", "vs", "of", "in", "to", "on",
  "a", "an", "is", "it",
]);

/**
 * Plan the fills. Returns a patch for the existing save path plus a full account of what it did.
 *
 * `draft` is the current row; `meta` is optional model output; `topic` is whatever the piece is
 * actually about (the brief's primary keyword, or the title) and is only used for category matching.
 */
export function planAutofill(input: {
  draft: Partial<BlogDraft>;
  meta?: MetaInput | null;
  voice?: VoiceDefaults | null;
  strapi?: StrapiOptions | null;
  topic?: string | null;
}): AutofillPlan {
  const { draft, meta, voice, strapi } = input;
  const patch: Record<string, unknown> = {};
  const filled: Fill[] = [];
  const skipped: Skip[] = [];

  const fill = (field: string, value: unknown, source: FillSource, note?: string) => {
    patch[field] = value;
    filled.push({ field, value, source, note });
  };
  const skip = (field: string, why: string) => skipped.push({ field, why });

  /** Fill `field` from model metadata if the draft's value is blank. */
  const fromMeta = (field: keyof MetaInput & string, why: string) => {
    if (!blank((draft as Record<string, unknown>)[field])) return;           // human wrote it
    const v = meta?.[field as keyof MetaInput];
    if (blank(v)) { skip(field, why); return; }
    fill(field, String(v).trim(), "written from the article");
  };

  const noModel = meta ? "the model returned nothing for this" : "needs the AI writer (no metadata generated)";

  fromMeta("title", noModel);
  fromMeta("description", noModel);
  fromMeta("seo_title", noModel);
  fromMeta("seo_description", noModel);
  fromMeta("seo_keywords", noModel);
  fromMeta("tags", noModel);

  // Slug: prefer the model's, else derive from whatever title we now have. A placeholder slug
  // (untitled-<hex>, minted at create time so two blank drafts can't collide) counts as blank —
  // it exists to be replaced.
  const currentSlug = String(draft.slug ?? "");
  const slugIsPlaceholder = /^untitled-[0-9a-f]{8}$/.test(currentSlug);
  if (blank(currentSlug) || slugIsPlaceholder) {
    const proposed = meta?.slug ? slugify(meta.slug) : slugify(String(patch.title ?? draft.title ?? ""));
    if (proposed) {
      fill("slug", proposed, meta?.slug ? "written from the article" : "derived from the title",
        slugIsPlaceholder ? "replaced the placeholder slug" : undefined);
    } else {
      skip("slug", "no title to derive one from");
    }
  }

  // Hero CTA. Strapi requires both halves of the component when publishing, and an invented URL
  // becomes a broken button on a live page — so this comes from the voice profile or the model's
  // (host-validated) override, never from a guess here.
  if (blank(draft.hero_cta_text)) {
    const v = meta?.hero_cta_text ?? voice?.default_cta_text;
    if (blank(v)) skip("hero_cta_text", "no CTA configured on this voice");
    else fill("hero_cta_text", String(v), meta?.hero_cta_text ? "written from the article" : "voice default");
  }
  if (blank(draft.hero_cta_url)) {
    const v = meta?.hero_cta_url ?? voice?.default_cta_url;
    if (blank(v)) skip("hero_cta_url", "no CTA configured on this voice");
    else fill("hero_cta_url", String(v), meta?.hero_cta_url ? "written from the article" : "voice default");
  }

  // Thumbnail: required to publish, and in practice the same asset as the cover. Only when a cover
  // exists — inventing one is not possible and leaving it empty is an honest blocker.
  if (draft.thumbnail_media_id == null && draft.cover_media_id != null) {
    fill("thumbnail_media_id", draft.cover_media_id, "copied from the cover");
    if (draft.cover_media_url) fill("thumbnail_media_url", draft.cover_media_url, "copied from the cover");
  } else if (draft.thumbnail_media_id == null) {
    skip("thumbnail", "no cover image to copy — upload one, this blocks publishing");
  }

  // `is_featured` and `should_index` are deliberately absent from the fills. Both are
  // `boolean NOT NULL DEFAULT` in scripts/035 (false and true respectively), so a real row always
  // holds a boolean and the column defaults already encode the right editorial stance: indexable,
  // not featured. A fill branch here would be unreachable code dressed up as a decision — the
  // selfcheck asserts they stay untouched so nobody adds one back.
  //
  // The one case worth saying out loud: indexing switched off is a deliberate act, so confirm it is
  // being respected rather than leaving the user to wonder whether autofill flipped it back.
  if (draft.should_index === false) {
    skip("should_index", "you turned indexing off, so it was left off");
  }
  // canonical_tag is deliberately never filled: an empty canonical means self-canonical, which is
  // correct for original content. A wrong one silently de-indexes the page in favour of someone else.
  if (blank(draft.canonical_tag)) {
    skip("canonical_tag", "left empty on purpose — that means this page is its own canonical");
  }

  // Author. Two identically-named placeholder authors is not a decision this can make.
  if (draft.author_id == null) {
    const authors = strapi?.authors ?? [];
    if (strapi?.default_author_id != null) {
      fill("author_id", strapi.default_author_id, "best practice", "STRAPI_DEFAULT_AUTHOR");
    } else if (authors.length === 1) {
      fill("author_id", authors[0].id, "only option in Strapi", authors[0].name);
    } else if (authors.length === 0) {
      skip("author", "no authors exist in Strapi yet");
    } else {
      skip("author", `${authors.length} authors to choose from — pick one, or set STRAPI_DEFAULT_AUTHOR`);
    }
  }

  // Category: matched on real overlap with what the piece is about, not assigned at random.
  if (draft.category_id == null) {
    const cats = strapi?.categories ?? [];
    const topic = [input.topic ?? "", patch.title ?? draft.title ?? "", patch.tags ?? draft.tags ?? ""]
      .filter(Boolean).join(" ");
    const topicTokens = tokens(topic);
    const scored = cats
      .map((c) => {
        const ct = tokens(`${c.title} ${c.slug}`);
        let hits = 0;
        for (const t of ct) if (topicTokens.has(t)) hits++;
        return { c, hits };
      })
      .sort((a, b) => b.hits - a.hits);

    if (cats.length === 0) {
      skip("category", "no categories exist in Strapi yet");
    } else if (scored[0].hits > 0 && (scored.length === 1 || scored[0].hits > scored[1].hits)) {
      fill("category_id", scored[0].c.id, "matched to your topic", scored[0].c.title);
    } else if (cats.length === 1) {
      fill("category_id", cats[0].id, "only option in Strapi", cats[0].title);
    } else {
      skip("category", "nothing matched this topic clearly — pick one so it lands in the right place");
    }
  }

  return { patch: patch as Partial<BlogDraft>, filled, skipped };
}
