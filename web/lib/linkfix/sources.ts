// What exists, and where it really lives.
//
// Three sources, each authoritative about something the others are not:
//
//   THE SITEMAP tells us a page's REAL public path. Strapi cannot: `category` reads "feature" for
//   pages served from /features, /apps, /compare AND /music-studio alike, and clusterPageSlug is set
//   on one entry in four hundred. Guessing /features/{slug} is wrong for roughly 40% of them, and a
//   replacement URL that is wrong is worse than the broken link it replaced.
//
//   STRAPI tells us publication state. A link to an unpublished draft is broken with certainty and
//   without a single HTTP request — which is what makes a whole-site sweep affordable.
//
//   THE SITE ITSELF is the last resort, for static routes and external hosts nothing else knows.
import { strapiGetRaw } from "./strapiRaw";
import type { Surface } from "./types";

export const SITE = "https://www.imagine.art";
const SITEMAP_URL = `${SITE}/sitemap.xml`;

export interface EntryState {
  id: number;
  slug: string;
  title: string;
  published: boolean;
}

export interface Inventory {
  fetchedAt: number;
  /** Every published path on the site, normalised, from the sitemap. */
  livePaths: Set<string>;
  /** slug -> real live path, for building replacement URLs. */
  pathBySlug: Map<string, string>;
  blogs: Map<string, EntryState>;      // keyed by lowercase slug
  landings: Map<string, EntryState>;
  blogById: Map<number, EntryState>;
  /** Live entries whose content we scan, per surface. */
  liveIds: Record<Surface, number[]>;
}

export const normPath = (p: string): string => p.replace(/\/+$/, "") || "/";
export const stripHost = (u: string): string => u.replace(/^https?:\/\/(www\.)?imagine\.art/i, "");

async function fetchSitemap(): Promise<string[]> {
  try {
    const res = await fetch(SITEMAP_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Summit-linkfix/1.0)" },
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  } catch {
    return [];
  }
}

/** All entries of one collection, id + slug + title + publish state. Two or three requests. */
async function collectionState(
  type: string,
  titleField: string,
): Promise<EntryState[] | { error: string }> {
  interface Row { id: number; attributes: Record<string, unknown> }
  const out: EntryState[] = [];
  for (let page = 1; page <= 12; page++) {
    const q =
      `publicationState=preview&fields[0]=slug&fields[1]=publishedAt&fields[2]=${titleField}` +
      `&pagination[page]=${page}&pagination[pageSize]=100`;
    const r = await strapiGetRaw<{ data: Row[]; meta: { pagination: { total: number } } }>(`/api/${type}?${q}`);
    if (!r.ok) return { error: `${type}: ${r.error}` };
    for (const row of r.data.data ?? []) {
      const a = row.attributes ?? {};
      out.push({
        id: row.id,
        slug: String(a.slug ?? ""),
        title: String(a[titleField] ?? ""),
        published: Boolean(a.publishedAt),
      });
    }
    const total = r.data.meta?.pagination?.total ?? 0;
    if (page >= Math.ceil(total / 100)) break;
  }
  return out;
}

/**
 * The one-time read every later phase depends on. Cheap: five or six list requests, no page bodies.
 */
export async function buildInventory(): Promise<Inventory | { error: string }> {
  const [sitemapUrls, blogRes, landingRes, annRes] = [
    await fetchSitemap(),
    await collectionState("imagine-webs", "title"),
    await collectionState("cluster-pages", "clusterPageTitle"),
    await collectionState("announcements", "title"),
  ];
  if ("error" in blogRes) return blogRes;
  if ("error" in landingRes) return landingRes;
  // Announcements are a small, occasionally-absent collection; a failure there must not sink the run.
  const announcements = "error" in annRes ? [] : annRes;

  const livePaths = new Set<string>();
  const pathBySlug = new Map<string, string>();
  for (const u of sitemapUrls) {
    const p = normPath(stripHost(u));
    livePaths.add(p);
    const seg = p.split("/").pop();
    // First writer wins: the sitemap lists a page once, so a later collision is a different page
    // that happens to share a last segment.
    if (seg && !pathBySlug.has(seg)) pathBySlug.set(seg, p);
  }

  const blogs = new Map<string, EntryState>();
  const blogById = new Map<number, EntryState>();
  for (const b of blogRes) { blogs.set(b.slug.toLowerCase(), b); blogById.set(b.id, b); }
  const landings = new Map<string, EntryState>();
  for (const c of landingRes) landings.set(c.slug.toLowerCase(), c);

  return {
    fetchedAt: Date.now(),
    livePaths,
    pathBySlug,
    blogs,
    landings,
    blogById,
    liveIds: {
      blog: blogRes.filter((b) => b.published).map((b) => b.id),
      landing: landingRes.filter((c) => c.published).map((c) => c.id),
      announcement: announcements.filter((a) => a.published).map((a) => a.id),
    },
  };
}

/** The public URL of one entry, from the sitemap where it is listed. */
export function publicUrl(inv: Inventory, surface: Surface, slug: string): string {
  if (surface === "blog") return `${SITE}/blogs/${slug}`;
  if (surface === "announcement") return `${SITE}/announcements/${slug}`;
  const p = inv.pathBySlug.get(slug);
  return `${SITE}${p ?? `/features/${slug}`}`;
}

/**
 * One live entry with everything populated deeply enough to see its links.
 *
 * Depth 5 is deliberate. At depth 4 the `populate-deep` plugin truncates the blog relation behind
 * every resource card to a bare `{id}`; at depth 8 the query times out. Callers verify the returned
 * tree with truncatedPaths() before writing it back.
 */
export async function fetchEntry(
  surface: Surface,
  id: number,
): Promise<{ ok: true; attrs: Record<string, unknown> } | { ok: false; error: string }> {
  const path =
    surface === "blog" ? `/api/imagine-webs/${id}?populate=*&publicationState=preview`
    : surface === "announcement" ? `/api/announcements/${id}?populate=*&publicationState=preview`
    : `/api/cluster-pages/${id}?populate=deep,5&publicationState=preview`;
  const r = await strapiGetRaw<{ data: { attributes: Record<string, unknown> } }>(path);
  if (!r.ok) return { ok: false, error: r.error };
  const attrs = r.data?.data?.attributes;
  if (!attrs) return { ok: false, error: "entry has no attributes" };
  return { ok: true, attrs };
}

export const collectionOf = (s: Surface): string =>
  s === "blog" ? "imagine-webs" : s === "announcement" ? "announcements" : "cluster-pages";
