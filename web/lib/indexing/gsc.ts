// Google Search Console URL-Inspection client (PRD R3 — live indexation monitor). When a
// service account is configured, this returns the REAL coverage state Google assigns each URL,
// which the report shows alongside the crawler's prediction. Without credentials it cleanly
// no-ops (isGscConfigured() === false) and the tool keeps working in prediction-only mode.
//
// Credentials (either form) in .env.local:
//   GSC_PROPERTY          e.g. "sc-domain:imagine.art" or "https://www.imagine.art/"
//   GSC_SA_JSON           the service-account JSON, inline (best for Vercel — no file paths)
//   GSC_SA_JSON_BASE64    same JSON, base64-encoded (use if inline quoting is awkward)
import { GoogleAuth } from "google-auth-library";

const SEARCH_CONSOLE = "https://searchconsole.googleapis.com/v1";
const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
// Read and write are separate scopes, and separate clients, on purpose.
//
// Everything that only LOOKS at the property (URL inspection, Search Analytics) runs on readonly, so
// a bug in a reporting path cannot submit or delete anything. The write scope is requested only by
// the sitemap functions at the bottom of this file.
//
// They also cannot share a GoogleAuth instance: scopes are fixed when it is constructed and the
// instance is cached, so handing the readonly client to a write call does not upgrade it — it 403s,
// intermittently, depending on which call happened to construct the singleton first. Two singletons,
// named for their scope, is what makes that impossible rather than merely unlikely.
const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];
const WRITE_SCOPES = ["https://www.googleapis.com/auth/webmasters"];

export interface GscInspection {
  coverageState?: string;
  verdict?: string;
  robotsTxtState?: string;
  indexingState?: string;
  pageFetchState?: string;
  googleCanonical?: string;
  userCanonical?: string;
  lastCrawlTime?: string;
}

function loadCredentials(): Record<string, unknown> | null {
  const raw = process.env.GSC_SA_JSON;
  const b64 = process.env.GSC_SA_JSON_BASE64;
  try {
    if (raw && raw.trim()) return JSON.parse(raw);
    if (b64 && b64.trim()) return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
  return null;
}

export function gscProperty(): string | null {
  return process.env.GSC_PROPERTY?.trim() || null;
}

/**
 * The service account's email, for the "we do it for you" connection: the user adds this address as a
 * Full user on their property in Search Console. Null when no credentials are configured, so the UI
 * can say "unavailable" rather than showing a form that leads nowhere.
 */
export function serviceAccountEmail(): string | null {
  const creds = loadCredentials();
  const email = creds?.client_email;
  return typeof email === "string" && email.includes("@") ? email : null;
}

export function isGscConfigured(): boolean {
  return !!gscProperty() && !!loadCredentials();
}

let auth: GoogleAuth | undefined;
function getAuth(creds: Record<string, unknown>): GoogleAuth {
  auth ??= new GoogleAuth({ credentials: creds, scopes: SCOPES });
  return auth;
}

let writeAuth: GoogleAuth | undefined;
function getWriteAuth(creds: Record<string, unknown>): GoogleAuth {
  writeAuth ??= new GoogleAuth({ credentials: creds, scopes: WRITE_SCOPES });
  return writeAuth;
}

/**
 * Inspect one URL's live index state. Returns null on any failure (quota, auth, transient) so
 * a single bad call never breaks the surrounding scan. Quota is ~2,000/day & 600/min, one URL
 * per call — callers must bound how many URLs they inspect.
 */
export async function inspectUrl(url: string): Promise<GscInspection | null> {
  const property = gscProperty();
  const creds = loadCredentials();
  if (!property || !creds) return null;
  try {
    const client = await getAuth(creds).getClient();
    const res = await client.request<{
      inspectionResult?: { indexStatusResult?: Record<string, string> };
    }>({
      url: `${SEARCH_CONSOLE}/urlInspection/index:inspect`,
      method: "POST",
      data: { inspectionUrl: url, siteUrl: property },
    });
    const s = res.data.inspectionResult?.indexStatusResult ?? {};
    return {
      coverageState: s.coverageState,
      verdict: s.verdict,
      robotsTxtState: s.robotsTxtState,
      indexingState: s.indexingState,
      pageFetchState: s.pageFetchState,
      googleCanonical: s.googleCanonical,
      userCanonical: s.userCanonical,
      lastCrawlTime: s.lastCrawlTime,
    };
  } catch {
    return null;
  }
}

export interface SearchAnalyticsRow {
  /** Values in the order of the requested dimensions (e.g. [page] or [page, query]). */
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Query the GSC Search Analytics table (clicks/impressions/CTR/position). Returns [] on any
 * failure. Powers the Rank Watcher (position 4–10) and Content Refresh (clicks over time).
 */
export async function searchAnalytics(params: {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  dimensions?: string[];
  rowLimit?: number;
  /**
   * Offset into the result set, for properties with more pages than one request can return.
   *
   * rowLimit caps at 25,000 and this property has more than that over a long window — measured, a
   * 480-day page query returns exactly 25,000 rows, which is the cap rather than the total. Without
   * paging, everything past the cap is invisible, and "invisible" looked identical to "does not exist".
   * Optional and defaulting to 0, so every existing caller behaves exactly as before.
   */
  startRow?: number;
  /**
   * Restrict to pages whose URL contains this substring — e.g. "/blogs/". Pushed into the GSC query
   * itself (a `dimensionFilterGroups` filter on the "page" dimension) rather than fetched-then-filtered,
   * because the cost that matters here is Google's own pagination: an unfiltered page-dimension query
   * over a wide date range hits GSC's 25,000-row page cap, which means several sequential round trips
   * to Google on every call. A substring filter shrinks the result set Google returns in the first
   * place, which is the only thing that shrinks the number of round trips.
   *
   * GSC currently allows one filter group per request, so this covers one substring — a caller wanting
   * "either A or B" (as the dead-page sweep does for /blogs/ + /features/) issues two filtered calls
   * and merges them, not one call with an OR the API cannot express.
   */
  pageContains?: string;
}): Promise<SearchAnalyticsRow[]> {
  const property = gscProperty();
  const creds = loadCredentials();
  if (!property || !creds) return [];
  try {
    const client = await getAuth(creds).getClient();
    const res = await client.request<{ rows?: SearchAnalyticsRow[] }>({
      url: `${WEBMASTERS}/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
      method: "POST",
      data: {
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: params.dimensions ?? ["page"],
        rowLimit: params.rowLimit ?? 1000,
        startRow: params.startRow ?? 0,
        ...(params.pageContains ? {
          dimensionFilterGroups: [{
            filters: [{ dimension: "page", operator: "contains", expression: params.pageContains }],
          }],
        } : {}),
      },
    });
    return res.data.rows ?? [];
  } catch {
    return [];
  }
}

/** YYYY-MM-DD for `n` days before today (UTC). */
export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}


// ── Publishing ──────────────────────────────────────────────────────────────────────────────────
//
// What this can and cannot do, stated once so no caller promises the wrong thing:
//
//   CAN     submit a sitemap, re-submit it, list what Google has, delete one.
//   CANNOT  force a reindex. The URL Inspection API is read-only, and the Indexing API is
//           officially only for JobPosting and BroadcastEvent. There is no supported call that
//           makes Google recrawl an arbitrary page.
//
// So the honest publish loop is: change the page, bump <lastmod>, resubmit the sitemap, then poll
// inspectUrl() until the index state flips. We report what Google did. We never claim to have
// caused it.
//
// ── Permission ──────────────────────────────────────────────────────────────────────────────────
//
// The write scope is necessary and not sufficient. The service account must also be a Full user or
// an Owner on the property in Search Console; a Restricted user is refused. That is a step a human
// takes in Search Console's UI and nothing here can do it for them — so a 403 from these functions
// usually means "the account was never added", not "the credentials are wrong". listAccessibleSites
// exists to tell those two apart before a user is told something is broken.

export interface SitemapStatus {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  warnings?: number;
  errors?: number;
}

export interface PublishResult {
  ok: boolean;
  /** Present on failure, already phrased for a person rather than passed through raw. */
  error?: string;
}

/** Shared shape for the write calls: null credentials/property is a configuration answer, not a throw. */
function writeTarget(property?: string): { property: string; creds: Record<string, unknown> } | null {
  const p = property || gscProperty();
  const creds = loadCredentials();
  if (!p || !creds) return null;
  return { property: p, creds };
}

function explain(e: unknown): string {
  const status = (e as { response?: { status?: number } })?.response?.status;
  if (status === 403) {
    return "Google refused (403). The service account is almost certainly not a Full user or Owner on this property in Search Console — add it there, then retry.";
  }
  if (status === 404) return "Google returned 404 — the property or sitemap path is not one this account can see.";
  const msg = e instanceof Error ? e.message : "request failed";
  return msg.slice(0, 300);
}

/**
 * Which properties can this account actually reach?
 *
 * Worth calling before reporting a failure: connecting credentials does NOT grant property access,
 * and an account with no properties looks exactly like a broken integration from the outside. This
 * turns that into a sentence a user can act on.
 */
export async function listAccessibleSites(): Promise<string[] | null> {
  const creds = loadCredentials();
  if (!creds) return null;
  try {
    const client = await getAuth(creds).getClient();
    const res = await client.request<{ siteEntry?: Array<{ siteUrl: string; permissionLevel: string }> }>({
      url: `${WEBMASTERS}/sites`,
      method: "GET",
    });
    return (res.data.siteEntry ?? []).map((s) => s.siteUrl);
  } catch {
    return null;
  }
}

/**
 * Submit (or re-submit) a sitemap. Re-submitting an existing one is how a content change is
 * announced — it is the same call, and it is not an error.
 *
 * `feedpath` must be the sitemap's full URL, not a path relative to the property.
 */
export async function submitSitemap(feedpath: string, property?: string): Promise<PublishResult> {
  const t = writeTarget(property);
  if (!t) return { ok: false, error: "Search Console is not configured (property or credentials missing)." };
  try {
    const client = await getWriteAuth(t.creds).getClient();
    await client.request({
      url: `${WEBMASTERS}/sites/${encodeURIComponent(t.property)}/sitemaps/${encodeURIComponent(feedpath)}`,
      method: "PUT",
    });
    // A successful submit is 204 with no body: Google has accepted the URL for processing, which is
    // not the same as having fetched or indexed it. listSitemaps() is where that becomes visible.
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: explain(e) };
  }
}

/** What Google currently holds for this property — the only way to verify a submit landed. */
export async function listSitemaps(property?: string): Promise<SitemapStatus[] | null> {
  const t = writeTarget(property);
  if (!t) return null;
  try {
    const client = await getAuth(t.creds).getClient();
    const res = await client.request<{
      sitemap?: Array<{
        path: string; lastSubmitted?: string; lastDownloaded?: string;
        isPending?: boolean; warnings?: string; errors?: string;
      }>;
    }>({
      url: `${WEBMASTERS}/sites/${encodeURIComponent(t.property)}/sitemaps`,
      method: "GET",
    });
    return (res.data.sitemap ?? []).map((s) => ({
      path: s.path,
      lastSubmitted: s.lastSubmitted,
      lastDownloaded: s.lastDownloaded,
      isPending: s.isPending,
      warnings: Number(s.warnings ?? 0),
      errors: Number(s.errors ?? 0),
    }));
  } catch {
    return null;
  }
}

/**
 * Remove a sitemap from the property.
 *
 * Destructive and rarely correct — Google stops using a sitemap it no longer knows about, which can
 * quietly reduce discovery of everything it listed. Never call this as cleanup; only when a person
 * has explicitly asked for that sitemap to be withdrawn.
 */
export async function deleteSitemap(feedpath: string, property?: string): Promise<PublishResult> {
  const t = writeTarget(property);
  if (!t) return { ok: false, error: "Search Console is not configured (property or credentials missing)." };
  try {
    const client = await getWriteAuth(t.creds).getClient();
    await client.request({
      url: `${WEBMASTERS}/sites/${encodeURIComponent(t.property)}/sitemaps/${encodeURIComponent(feedpath)}`,
      method: "DELETE",
    });
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: explain(e) };
  }
}
