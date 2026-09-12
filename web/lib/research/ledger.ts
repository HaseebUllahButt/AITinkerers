// Step 2 of the template-launch process: "have we already built this?", answered from Strapi itself.
//
// WHY STRAPI AND NOT A LOCAL RUN LOG
//
// A log only knows what this app did. Strapi knows what EXISTS — including pages made by hand, by a
// teammate, or by a run whose record was lost. For a board that gets regenerated every morning that
// distinction is the whole point: the failure mode is not "we forgot", it is "we never knew".
//
// The sitemap inventory is checked alongside it, because the two disagree in both directions. Strapi's
// instance holds drafts that are not live; `site_urls` holds 1,500 live URLs including static pages that
// were never cluster-page entries at all.
//
// WHAT COUNTS AS A REPEAT
//
// Not an identical slug — that is the easy case and almost never the one that bites. The repeat that
// matters is the same SUBJECT under a different slug, which is why this compares normalised token sets
// (see ./normalise) rather than strings.
//
// This runs on EVERY candidate BEFORE it is offered, not after one is picked. A board that offers a
// covered subject has already wasted the only judgement the person is there to make.

import { listSiteUrls } from "@/lib/sitemap/store";
import { subjectTokens, tokenOverlap, specialisingTokens } from "./normalise";

// One constant, one module. The API path is already declared in ./configure and a second copy here
// would drift the first time the collection is renamed — with the failure showing up as a ledger that
// silently reports everything as clear.
/** The Strapi collection that holds cluster pages. Still queried by the coverage check: the pages
 *  exist and rank, we simply no longer build them from Summit. */
export const CLUSTER_PAGE_TYPE = "cluster-pages";

export type LedgerKind = "CLEAR" | "NEAR_DUPLICATE" | "DUPLICATE";

export interface LedgerMatch {
  origin: "strapi" | "sitemap";
  slug: string;
  /** Live path, for a sitemap row. Strapi rows have a category instead. */
  path?: string;
  category?: string | null;
  title?: string | null;
  entryId?: number;
  published: boolean;
  /** 0–1 token overlap with the subject. */
  score: number;
}

export interface LedgerVerdict {
  subject: string;
  verdict: LedgerKind;
  /** Full-overlap hits: the same subject, already built. */
  exact: LedgerMatch[];
  /** High-overlap hits that add no distinguishing token — the split-signal case. */
  near: LedgerMatch[];
  /** Adjacent pages worth knowing about. Never blocking. */
  related: LedgerMatch[];
  /** One line, ready to render on a candidate card. */
  note: string;
}

export interface LedgerCorpus {
  strapi: LedgerMatch[];
  sitemap: LedgerMatch[];
  /** Non-null when the corpus is INCOMPLETE. A ledger that silently ran on half the corpus is worse
   *  than one that refused, because CLEAR then means "we did not look". */
  error: string | null;
  readAt: number;
}

function strapiConfig(): { url: string; token: string } | null {
  const url = process.env.STRAPI_URL?.trim().replace(/\/$/, "");
  const token = process.env.STRAPI_API_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

/**
 * Every cluster page Strapi holds, draft and published.
 *
 * Fetched directly rather than through strapi/client.ts's `listEntries` because that helper forces
 * `populate=*`, which on this content type drags the whole `template` dynamiczone — every section of
 * every page — down the wire. The ledger needs four scalar fields. Omitting `populate` entirely is what
 * gets them: Strapi v4 returns scalars only by default.
 */
async function fromStrapi(): Promise<{ rows: LedgerMatch[]; error: string | null }> {
  const cfg = strapiConfig();
  if (!cfg) return { rows: [], error: "STRAPI_URL / STRAPI_API_TOKEN are not set." };

  const rows: LedgerMatch[] = [];
  try {
    for (let page = 1; page <= 25; page++) {
      const qs = new URLSearchParams({
        publicationState: "preview",
        "pagination[page]": String(page),
        "pagination[pageSize]": "100",
        sort: "updatedAt:desc",
      });
      const res = await fetch(`${cfg.url}/api/${CLUSTER_PAGE_TYPE}?${qs}`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = body?.error?.message ?? `HTTP ${res.status}`;
        // Token expiry is the failure this hits in practice and it does not look like one from the
        // status alone, so name it.
        return {
          rows,
          error: /expired/i.test(String(msg))
            ? "The Strapi API token has expired — re-mint it."
            : `Strapi ${res.status}: ${msg}`,
        };
      }
      const json = await res.json();
      for (const row of json?.data ?? []) {
        const a = row.attributes ?? row;
        rows.push({
          origin: "strapi",
          entryId: row.id,
          slug: String(a.slug ?? ""),
          category: a.category ?? null,
          title: a.clusterPageTitle ?? null,
          published: Boolean(a.publishedAt),
          score: 0,
        });
      }
      const pg = json?.meta?.pagination;
      if (!pg || page >= (pg.pageCount ?? 1)) break;
    }
  } catch (e) {
    return { rows, error: e instanceof Error ? e.message : "could not reach Strapi" };
  }
  return { rows, error: null };
}

/**
 * The live URL inventory, minus blogs.
 *
 * `site_urls` is Summit's own synced sitemap (1,500-odd rows). Blog posts are excluded: a post about a
 * model is not a landing page about it, and counting one as coverage would block the page the post
 * exists to support.
 */
async function fromSitemap(): Promise<{ rows: LedgerMatch[]; error: string | null }> {
  try {
    const urls = await listSiteUrls({ limit: 1000 });
    const rows: LedgerMatch[] = [];
    for (const u of urls) {
      const path = String(u.path ?? "");
      const segs = path.split("/").filter(Boolean);
      if (!segs.length) continue;
      if (segs[0] === "blogs") continue;
      rows.push({
        origin: "sitemap",
        slug: segs[segs.length - 1],
        path,
        published: true,
        score: 0,
      });
    }
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : "could not read the URL inventory" };
  }
}

// Cached per process. The corpus changes when someone ships a page, which is a several-times-a-week
// event, and a radar sweep checks a dozen candidates against it in one pass — re-reading 1,600 rows per
// candidate would turn one board into a minute of Strapi traffic.
let cache: LedgerCorpus | null = null;
const TTL_MS = 10 * 60 * 1000;

export async function getLedgerCorpus(opts: { fresh?: boolean } = {}): Promise<LedgerCorpus> {
  if (!opts.fresh && cache && Date.now() - cache.readAt < TTL_MS) return cache;
  const [strapi, sitemap] = await Promise.all([fromStrapi(), fromSitemap()]);
  const corpus: LedgerCorpus = {
    strapi: strapi.rows,
    sitemap: sitemap.rows,
    error: strapi.error ?? sitemap.error,
    readAt: Date.now(),
  };
  // Never cache a partial read — a transient Strapi blip must not make the next ten minutes of
  // candidates look clear.
  if (!corpus.error) cache = corpus;
  return corpus;
}

/** Anything at or above this overlap, with nothing distinguishing added, is the same page. */
const NEAR = 0.6;
/** Below this a match is context, not a warning. */
const RELATED = 0.34;

/**
 * Score one subject against a corpus already in hand.
 *
 * Slug and title are scored SEPARATELY and the better one kept. Pooling them into a single token set
 * hides exact matches: an entry whose slug is literally the subject but whose title adds four more
 * words scores 43% pooled and sails through as clear.
 */
export function scoreSubject(subject: string, corpus: LedgerCorpus): LedgerVerdict {
  const want = subjectTokens(subject);
  const scored: Array<LedgerMatch & { adds: string[] }> = [];

  for (const row of [...corpus.strapi, ...corpus.sitemap]) {
    const slugT = subjectTokens(row.slug);
    const titleT = row.title ? subjectTokens(row.title) : new Set<string>();
    const slugScore = tokenOverlap(want, slugT);
    const titleScore = tokenOverlap(want, titleT);
    const score = Math.max(slugScore, titleScore);
    if (score < RELATED) continue;
    const best = slugScore >= titleScore ? slugT : titleT;
    scored.push({ ...row, score, adds: specialisingTokens(want, best) });
  }
  scored.sort((a, b) => b.score - a.score);

  const exact = scored.filter((r) => r.score >= 0.999);
  const near = scored.filter((r) => r.score >= NEAR && r.score < 0.999 && r.adds.length === 0);
  const taken = new Set([...exact, ...near]);
  const related = scored.filter((r) => !taken.has(r)).slice(0, 5);

  const verdict: LedgerKind = exact.length ? "DUPLICATE" : near.length ? "NEAR_DUPLICATE" : "CLEAR";
  const first = exact[0] ?? near[0] ?? null;
  const note =
    verdict === "DUPLICATE"
      ? `Already built: ${first?.path ?? `/${first?.slug}`}${first?.origin === "strapi" && !first.published ? " (draft)" : ""}.`
      : verdict === "NEAR_DUPLICATE"
        ? `Same subject under a different slug: ${first?.path ?? `/${first?.slug}`}. Building it splits the ranking signal between two pages.`
        : corpus.error
          ? "Could not read the whole corpus — treat this as unchecked, not clear."
          : "Nothing close enough to be a repeat.";

  return {
    subject,
    // An incomplete corpus cannot produce a CLEAR. Downgrading it to NEAR_DUPLICATE would be a lie in
    // the other direction, so the kind stays CLEAR and the note says the check did not complete —
    // callers surface `corpus.error` alongside it.
    verdict,
    exact: exact.map(strip),
    near: near.map(strip),
    related: related.map(strip),
    note,
  };
}

/** Drop the internal `adds` scratch field before a match crosses an API boundary. */
function strip(r: LedgerMatch & { adds: string[] }): LedgerMatch {
  return {
    origin: r.origin, slug: r.slug, path: r.path, category: r.category,
    title: r.title, entryId: r.entryId, published: r.published, score: r.score,
  };
}

/** One-shot check for a single subject. Reads (or reuses) the corpus, then scores. */
export async function ledgerCheck(subject: string, opts: { fresh?: boolean } = {}): Promise<{
  verdict: LedgerVerdict;
  corpusError: string | null;
  corpusSize: number;
}> {
  const corpus = await getLedgerCorpus(opts);
  return {
    verdict: scoreSubject(subject, corpus),
    corpusError: corpus.error,
    corpusSize: corpus.strapi.length + corpus.sitemap.length,
  };
}
