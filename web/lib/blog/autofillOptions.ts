// The IO half of autofill: read the real author and category options out of Strapi.
//
// Split from @/lib/blog/autofill so that module stays pure and directly assertable from
// /api/blog/selfcheck. Two callers need this and neither should own the STRAPI_DEFAULT_AUTHOR
// matching rules: the editor's "Fill the blanks" button, and the writer's finalize step (which runs
// unattended for every article in a cluster, where there is no one to press a button).
import { listEntries, categoryType, strapiConfigured } from "@/lib/strapi/client";
import type { StrapiOptions } from "./autofill";

export interface LoadedOptions { options: StrapiOptions | null; notes: string[] }

/**
 * Best-effort. An unreachable or unconfigured CMS returns `null`, which the planner reads as
 * "author and category can't be decided" and reports as a skip — never as a silent omission.
 */
export async function loadStrapiOptions(): Promise<LoadedOptions> {
  const notes: string[] = [];
  if (!strapiConfigured()) {
    return { options: null, notes: ["Strapi is not configured, so author and category were skipped."] };
  }
  try {
    const [authors, categories] = await Promise.all([
      listEntries("authors", { pageSize: 100, sort: "username:asc" }),
      listEntries(categoryType(), { pageSize: 100, sort: "title:asc" }),
    ]);
    const list = authors.data.map((a: any) => ({ id: a.id as number, name: String(a.username ?? "") }));

    // STRAPI_DEFAULT_AUTHOR may be an id or a username. It is only honoured if it matches an author
    // that actually exists — a stale env value must not write a dangling relation that fails at sync.
    const want = (process.env.STRAPI_DEFAULT_AUTHOR ?? "").trim();
    const preferred = want
      ? list.find((a) => String(a.id) === want || a.name.toLowerCase() === want.toLowerCase())
      : undefined;
    if (want && !preferred) {
      notes.push(`STRAPI_DEFAULT_AUTHOR is set to "${want}" but no author with that id or name exists in Strapi.`);
    }

    return {
      options: {
        authors: list,
        categories: categories.data.map((c: any) => ({
          id: c.id as number, title: String(c.title ?? ""), slug: String(c.slug ?? ""),
        })),
        default_author_id: preferred?.id ?? null,
      },
      notes,
    };
  } catch (e: any) {
    return { options: null, notes: [`Couldn't read authors and categories from Strapi (${e?.message ?? "request failed"}).`] };
  }
}
