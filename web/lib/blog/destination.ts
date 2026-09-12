// Where a draft will actually publish, and when its canonical tag contradicts that.
//
// ── Why this module exists ──────────────────────────────────────────────────────────────────────
//
// The live URL of a synced draft comes from the Strapi collection it lands in and from NOTHING else —
// not the slug, not the canonical tag. `strapi_collection` decides it (see collectionForDraft in
// strapi/client.ts), and until this module it appeared in no UI anywhere: not the drafts list, not the
// editor. A draft bound for /features looked identical to one bound for /blogs.
//
// Measured, on draft a21111ed: Summer was asked for a landing page, wrote a blog draft, and set
// `canonical_tag = https://www.northwind.example/features/grok-4-6` while leaving `strapi_collection` null.
// That draft would publish at /blogs/grok-4-6 carrying a canonical pointing at a /features/ URL that
// does not exist — a self-inflicted de-index, since a canonical tag tells Google to index the OTHER
// page instead of this one. The prompt already forbade it in words. Words are not a guard.
//
// ── The one thing this module refuses to do ─────────────────────────────────────────────────────
//
// Guess a URL prefix for a collection it does not know. We know the blog's: /blogs/<slug>. We do NOT
// know a cluster page's, and it is not derivable from the collection — the dedicated route folders in
// imagine-web gate on the entry's `category` enum, which is frequently not the template's own name
// (see the warning in landing/configure.ts). So a cluster page's path depends on data this module
// cannot see.
//
// Inventing a prefix would produce confident wrong warnings on legitimate pages, which is how a
// warning system gets ignored. So the check fires only in the two directions that are knowable:
// a blog draft whose canonical is not under /blogs/, and a non-blog draft whose canonical IS. Both
// are unambiguously wrong. Everything else is silent rather than guessed.
//
// ── Client-safe LEAF: no imports ────────────────────────────────────────────────────────────────
//
// The drafts list is a client component, so this deliberately does NOT import blogType() from
// strapi/client — same reason landing/stages.ts is split out of landing/store.ts. That would pull the
// whole Strapi REST client into the browser bundle to read one string.
//
// The default is duplicated from strapi/client.ts's blogType() instead. That duplication is safe for
// the reason that matters: the case this has to get right is `strapi_collection` being EMPTY, which
// means the blog by definition and needs no env at all. The env read only refines the LABEL when a
// draft explicitly stores the blog's own api id, and in the browser (where STRAPI_BLOG_TYPE is not a
// NEXT_PUBLIC_ var and so is undefined) a non-default override would mislabel that one case as its
// raw api id rather than "Blog" — cosmetic, never a wrong destination.

/** Must stay in step with blogType() in strapi/client.ts. See the note above on why it is copied. */
const BLOG_TYPE_DEFAULT = "imagine-webs";

function blogCollection(): string {
  return process.env.STRAPI_BLOG_TYPE?.trim() || BLOG_TYPE_DEFAULT;
}

/** What to call a destination in the UI, and whether it is the ordinary blog path. */
export interface Destination {
  /** The Strapi collection api id this draft syncs into. */
  collection: string;
  /** Short label for a badge, e.g. "Blog" or "Cluster pages". */
  label: string;
  /** True for the default blog collection — the destination of every draft that sets nothing. */
  isBlog: boolean;
  /** The live URL path prefix, ONLY when we actually know it. Null means unknown, never guessed. */
  pathPrefix: string | null;
}

/** Collection api id → human label. Anything unlisted is labelled from its own api id. */
const LABELS: Record<string, string> = {
  "cluster-pages": "Cluster page",
  "case-studies": "Case study",
  "category-pages": "Category page",
};

/** Turn a collection api id into something readable: "cluster-pages" → "Cluster pages". */
function labelFor(collection: string): string {
  const known = LABELS[collection];
  if (known) return known;
  const words = collection.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Where this draft publishes.
 *
 * Mirrors collectionForDraft's fallback deliberately: an empty collection IS the blog, and that is the
 * case this has to be exactly right about because it is the default for every draft ever made.
 */
export function destinationOf(d: { strapi_collection?: string | null }): Destination {
  const explicit = d.strapi_collection?.trim();
  const blog = blogCollection();
  const collection = explicit || blog;
  // Empty is the blog without consulting anything — see the client-safety note above.
  const isBlog = !explicit || collection === blog;
  return {
    collection,
    label: isBlog ? "Blog" : labelFor(collection),
    isBlog,
    pathPrefix: isBlog ? "/blogs/" : null,
  };
}

/** The path of a canonical URL, or null when it is empty or unparseable. */
function canonicalPath(canonical: string | null | undefined): string | null {
  const v = (canonical ?? "").trim();
  if (!v) return null;
  try {
    return new URL(v).pathname || null;
  } catch {
    // A relative canonical is unusual but not nonsense; treat a leading slash as the path.
    return v.startsWith("/") ? v : null;
  }
}

/**
 * Does this draft's canonical tag contradict where it will publish?
 *
 * Returns the warning to show, or null when there is nothing knowable to say. A WARNING and never a
 * block: a deliberate cross-canonical is a real, correct SEO move (see seo/canonical.ts — an existing
 * page that already ranks should own the query), and blocking it would break the legitimate case to
 * catch the accidental one.
 */
export function canonicalConflict(d: {
  strapi_collection?: string | null;
  canonical_tag?: string | null;
}): string | null {
  const path = canonicalPath(d.canonical_tag);
  if (!path) return null;
  const dest = destinationOf(d);

  if (dest.isBlog && !path.startsWith("/blogs/")) {
    return (
      `This draft publishes to the blog, at /blogs/<slug> — but its canonical points at ${path}. ` +
      "A canonical tells Google to index that other URL instead of this one, so publishing as-is " +
      "de-indexes the post. Either clear the canonical, or set the draft's Strapi collection to the " +
      "one that actually serves that path."
    );
  }

  if (!dest.isBlog && path.startsWith("/blogs/")) {
    return (
      `This draft publishes to ${dest.collection}, not the blog — but its canonical points at ${path}. ` +
      "Clear it or point it at the real live URL for this collection."
    );
  }

  return null;
}
