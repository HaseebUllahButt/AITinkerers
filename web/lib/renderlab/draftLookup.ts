// Which of these URLs point at an UNPUBLISHED CMS draft?
//
// The distinction the link audit needs (team ask, Aug 31): a broken internal link whose target
// still exists in Strapi as a draft is not a link to hand-fix — it is an editorial decision
// (publish the post, or drop the link), and it belongs in its own queue. Measured need: the
// Aug-26 sitemap halving reverted ~750 blogs to draft and flooded one run with 836 soft-404
// findings, every one of them this case and none of them labeled.
//
// One batched request per fifty slugs per content type (filters[slug][$in]), not one per URL —
// the Strapi instance folds under request storms (see strapiEntry's "gently" rule), and a
// probe that needs only `publishedAt` has no business pulling populated entries.
import { resolvePage } from "./strapiLinks";
import { strapiGet } from "./strapiEntry";

const FIRST_PARTY_HOST = "imagine.art"; // resolvePage already assumes this site's route scheme

interface SlugGroup { pluralApi: string; slugField: string; urlsBySlug: Map<string, string[]> }

/**
 * Returns the subset of `urls` whose CMS entry exists with `publishedAt: null` (a draft).
 *
 * URLs that don't resolve to a CMS content type, live on another host, or whose entry is
 * genuinely missing (deleted, never existed) are NOT in the result — "draft" is a positive
 * identification, never a fallback. Throws only if Strapi is unconfigured or every batch
 * fails; a single failed batch skips those slugs (they stay unlabeled, which is honest).
 */
export async function draftTargetsAmong(urls: string[]): Promise<Set<string>> {
  const groups = new Map<string, SlugGroup>();
  for (const url of urls) {
    try {
      const host = new URL(url).host.replace(/^www\./, "");
      if (host !== FIRST_PARTY_HOST) continue; // another site's path could false-match our routes
    } catch { continue; }
    const r = resolvePage(url);
    if ("error" in r) continue;
    const g = groups.get(r.pluralApi) ?? { pluralApi: r.pluralApi, slugField: r.slugField, urlsBySlug: new Map() };
    const list = g.urlsBySlug.get(r.slugValue) ?? [];
    list.push(url);
    g.urlsBySlug.set(r.slugValue, list);
    groups.set(r.pluralApi, g);
  }

  const drafts = new Set<string>();
  let batches = 0;
  let failures = 0;
  for (const g of groups.values()) {
    const slugs = [...g.urlsBySlug.keys()];
    for (let i = 0; i < slugs.length; i += 50) {
      const batch = slugs.slice(i, i + 50);
      const filter = batch.map((s, j) => `filters[${g.slugField}][$in][${j}]=${encodeURIComponent(s)}`).join("&");
      batches++;
      try {
        const json = await strapiGet(
          `/api/${g.pluralApi}?${filter}&publicationState=preview&fields[0]=${g.slugField}&fields[1]=publishedAt&pagination[pageSize]=${batch.length}`,
        );
        const rows = Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : [];
        for (const row of rows) {
          // Strapi v4 nests under `attributes`; flattened/v5 shapes carry the fields at top level.
          const a = (row.attributes ?? row) as Record<string, unknown>;
          const slug = a[g.slugField];
          if (typeof slug !== "string") continue;
          if (a.publishedAt === null) {
            for (const u of g.urlsBySlug.get(slug) ?? []) drafts.add(u);
          }
        }
      } catch {
        failures++; // this batch's slugs stay unlabeled — honest, and the loop keeps going
      }
    }
  }
  // Unconfigured/unreachable Strapi fails every batch identically — that's an error the caller
  // should log as "check skipped", not a quiet empty result that reads as "no drafts".
  if (batches > 0 && failures === batches) throw new Error("every draft-probe batch failed — Strapi unreachable?");
  return drafts;
}
