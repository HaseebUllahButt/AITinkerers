// The single gate every blog-draft write passes through (POST, PATCH, PUT, flush).
//
// Before this existed, the routes did `updateBlogDraft(id, body)` with the raw request body, and
// the editor sent the ENTIRE selected draft back — including id, created_at, status, strapi_id
// and strapi_url. Two consequences: a stale form could silently overwrite `status`/`strapi_id`,
// and any unknown key surfaced as a raw Postgres error inside a 500. Autosave fires constantly,
// so both had to become impossible rather than unlikely.
//
// Rules: unknown keys are DROPPED and reported (never passed to Postgres), values are coerced to
// the column's type, and NOT NULL columns can never be set to null.
import type { BlogDraft } from "@/lib/db/queries";

/** Every field a human (or the writer agent) may edit. Anything absent here is server-owned. */
export const EDITABLE_FIELDS = [
  "title", "slug", "body", "description", "tags",
  "is_featured", "should_index", "canonical_tag", "youtube_video_id",
  "cover_media_id", "cover_media_url",
  "thumbnail_media_id", "thumbnail_media_url",
  "author_id", "category_id",
  "hero_cta_text", "hero_cta_url",
  "seo_title", "seo_description", "seo_keywords",
  "markup_schema",
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Deliberately NOT editable, listed so the reason is discoverable rather than folklore:
 *  id/created_at/updated_at — identity and bookkeeping.
 *  status/strapi_id/strapi_url/strapi_published_at/published_at — owned by the publish path.
 *  sync_state/sync_error/sync_attempted_at/synced_at/synced_rev — owned by the sync path.
 *  rev/last_edited_by — stamped by the guarded update itself.
 *  locale — set once at Strapi create time; v4 has no "change an entry's locale" update.
 *  writer_status/writer_qa/writer_session_id/cluster_id — owned by the writer agent. */

/** Columns declared NOT NULL DEFAULT '' in scripts/035 — a null here is a 500, so coerce to "". */
const NON_NULL_TEXT = new Set<EditableField>(["title", "slug", "body", "description"]);
const NULLABLE_TEXT = new Set<EditableField>([
  "tags", "canonical_tag", "youtube_video_id", "cover_media_url", "thumbnail_media_url",
  "hero_cta_text", "hero_cta_url", "seo_title", "seo_description", "seo_keywords",
  "markup_schema",
]);
const BOOLEANS = new Set<EditableField>(["is_featured", "should_index"]);
/** Strapi ids / media ids. Empty string and NaN both mean "cleared", not 0. */
const NULLABLE_INTS = new Set<EditableField>([
  "cover_media_id", "thumbnail_media_id", "author_id", "category_id",
]);

function coerce(key: EditableField, raw: unknown): unknown {
  if (BOOLEANS.has(key)) return raw === true || raw === "true";
  if (NULLABLE_INTS.has(key)) {
    if (raw === null || raw === undefined || raw === "") return null;
    const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : null;
  }
  if (NON_NULL_TEXT.has(key)) return raw === null || raw === undefined ? "" : String(raw);
  if (NULLABLE_TEXT.has(key)) return raw === null || raw === undefined ? null : String(raw);
  return raw;
}

const EDITABLE_SET = new Set<string>(EDITABLE_FIELDS);

export interface SanitizedPatch {
  patch: Partial<BlogDraft>;
  /** Keys the caller sent that we refused. Surfaced in dev to catch a drifting client. */
  rejected: string[];
}

/**
 * Reduce an arbitrary request body to the subset that may touch `blog_drafts`.
 * Absent keys stay absent (so a PATCH only writes what actually changed); present-but-unknown
 * keys are dropped into `rejected`.
 */
export function sanitizePatch(body: unknown): SanitizedPatch {
  const patch: Record<string, unknown> = {};
  const rejected: string[] = [];
  if (!body || typeof body !== "object") return { patch, rejected };
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    // base_rev rides along on PATCH as a concurrency token, not a column. Not a client bug.
    if (key === "base_rev" || key === "force" || key === "reason") continue;
    if (!EDITABLE_SET.has(key)) { rejected.push(key); continue; }
    patch[key] = coerce(key as EditableField, value);
  }
  return { patch: patch as Partial<BlogDraft>, rejected };
}

/**
 * Only the editable fields whose value actually differs from the last known server row.
 * Autosave calls this so editing the body doesn't resend 20 unrelated columns on every keystroke
 * batch — which also keeps a stale field in the form from clobbering someone else's change to it.
 */
export function changedFields(
  server: Partial<BlogDraft> | null | undefined,
  form: Partial<BlogDraft>,
): Partial<BlogDraft> {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) {
    if (!(key in form)) continue;
    const next = coerce(key, form[key as keyof BlogDraft]);
    const prev = server ? coerce(key, server[key as keyof BlogDraft]) : undefined;
    // Treat null and "" as equal for nullable text: the form uses "" where the DB uses null,
    // and without this every draft would look permanently dirty.
    if (NULLABLE_TEXT.has(key) && (prev ?? "") === (next ?? "")) continue;
    if (prev !== next) out[key] = next;
  }
  return out as Partial<BlogDraft>;
}

/** Just the editable fields, for a revision snapshot or the localStorage journal. */
export function editableSnapshot(row: Partial<BlogDraft>): Partial<BlogDraft> {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) if (key in row) out[key] = row[key as keyof BlogDraft];
  return out as Partial<BlogDraft>;
}

/** lowercase, strip non-alphanumerics, collapse dashes. Moved out of src/app/blog/page.tsx so
 *  the writer agent and the server-side slug reservation share one implementation. */
/**
 * Words that carry no search value in a URL. Dropped only when a slug is over length — a short
 * title keeps its natural phrasing, because "how-to-make-x" reads better than "make-x" and there
 * is no cost to keeping it.
 */
const SLUG_FILLER = new Set([
  "a", "an", "the", "and", "or", "but", "of", "for", "to", "in", "on", "at", "by", "with",
  "from", "into", "about", "as", "is", "are", "was", "were", "be", "been", "that", "this",
  "it", "its", "you", "your", "we", "our", "what", "which", "when", "why", "how",
]);

const SLUG_MAX = 45;

/**
 * A URL slug: short, readable, and never cut mid-word.
 *
 * The cap was 80 and truncated blindly, which produced slugs ending in half a word — the reader
 * cannot tell what was lost and neither can a search engine. Now the tail is trimmed a WHOLE word
 * at a time, dropping filler first so the words that carry meaning survive:
 *
 *   "how-to-make-an-ai-comedy-series-lessons-from-building-cone-man-live"  (66)
 *     → "how-to-make-ai-comedy-series-lessons-building-cone-man-live"      (58, filler gone)
 *     → "how-to-make-ai-comedy-series-lessons"                             (36, tail trimmed)
 *
 * Uniqueness is NOT this function's job — blogSlugTaken() owns that, and shortening never makes a
 * collision more likely than the caller already handles.
 */
export function slugify(s: string): string {
  const words = s
    .toLowerCase()
    // A dot BETWEEN DIGITS is a version number and becomes a hyphen, not nothing. Stripping it
    // turned "GPT-5.6" into "gpt-56", which reads as fifty-six — the live draft written before
    // this function existed had it right as `gpt-5-6-cyber`.
    .replace(/(\d)\.(\d)/g, "$1-$2")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .split("-")
    .filter(Boolean);

  const join = (w: string[]) => w.join("-");
  if (join(words).length <= SLUG_MAX) return join(words);

  // Drop filler, but keep the first two words whatever they are. Filtering from index 1 turned
  // "how to make…" into "how-make…", which reads as a typo rather than a shortening.
  const trimmed = words.filter((w, i) => i < 2 || !SLUG_FILLER.has(w));
  if (join(trimmed).length <= SLUG_MAX) return join(trimmed);

  // Still long: drop whole words off the end until it fits. Keep at least three so a slug never
  // collapses to one generic word.
  const kept = [...trimmed];
  while (kept.length > 3 && join(kept).length > SLUG_MAX) kept.pop();
  // A single word longer than the cap is the only case a hard cut is right.
  return join(kept).slice(0, SLUG_MAX).replace(/-+$/, "");
}

/**
 * The slug for a TITLE, which is a different job from normalising a string.
 *
 * A title in this house style is "Subject: elaboration" — "GPT-5.6-Cyber: OpenAI's Daybreak Red
 * team model", "Seedance 2.5 reference images: 22 wired live, and what actually broke". The subject
 * is the part worth having in a URL; the elaboration is what makes a slug forty-five characters of
 * noise. So the title is cut at its first separator and only the subject is slugified.
 *
 * The guard matters: a title whose lead is one short word ("Note: how we…") would slug to "note",
 * which is useless, so a too-short lead falls back to the whole title and the normal trimming.
 *
 * NOT applied when somebody types in the slug box — that is `slugify`, which normalises and does
 * not reinterpret. Someone editing a slug by hand has already decided what it should say.
 */
export function slugFromTitle(title: string): string {
  const lead = String(title).split(/\s*[:|–—]\s*/)[0] ?? "";
  const leadSlug = slugify(lead);
  // Two words, or one that is version-shaped ("gpt-5-6-cyber" is one subject, many hyphens).
  const enough = leadSlug.length >= 8 && leadSlug.split("-").filter(Boolean).length >= 2;
  return enough ? leadSlug : slugify(title);
}

/**
 * Make a slug unique without letting it grow past the cap.
 *
 * The suffix is appended INSIDE the limit — the base is shortened to make room — because a slug is
 * capped for a reason and "-2" is not an exemption from it. Callers own the `taken` test, since
 * some check the database and some also check an in-flight batch.
 */
export async function uniqueSlug(
  base: string,
  taken: (candidate: string) => Promise<boolean> | boolean,
): Promise<string> {
  const clean = base || "post";
  if (!(await taken(clean))) return clean;
  for (let n = 2; n <= 50; n++) {
    const suffix = `-${n}`;
    const room = SLUG_MAX - suffix.length;
    const candidate = `${clean.length > room ? clean.slice(0, room).replace(/-+$/, "") : clean}${suffix}`;
    if (!(await taken(candidate))) return candidate;
  }
  // Fifty collisions on one subject is not a naming problem any more; take the random tail.
  const rand = `-${Math.random().toString(16).slice(2, 6)}`;
  const room = SLUG_MAX - rand.length;
  return `${clean.slice(0, room).replace(/-+$/, "")}${rand}`;
}

/** Strapi's `slug` is a REQUIRED unique `uid`, and uid uniqueness is not relaxed for drafts —
 *  so a brand-new draft needs a distinct placeholder, not "". Mirrors the backfill in 043. */
export function placeholderSlug(): string {
  return `untitled-${Math.random().toString(16).slice(2, 10)}`;
}
