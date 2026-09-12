// Google Search Console URL-Inspection client (PRD R3 — live indexation monitor). When a
// service account is configured, this returns the REAL coverage state Google assigns each URL,
// which the report shows alongside the crawler's prediction. Without credentials it cleanly
// no-ops (isGscConfigured() === false) and the tool keeps working in prediction-only mode.
//
// Credentials (either form) in .env.local:
//   GSC_PROPERTY          e.g. "sc-domain:northwind.example" or "https://www.northwind.example/"
//   GSC_SA_JSON           the service-account JSON, inline (best for Vercel — no file paths)
//   GSC_SA_JSON_BASE64    same JSON, base64-encoded (use if inline quoting is awkward)
import { GoogleAuth } from "google-auth-library";

const SEARCH_CONSOLE = "https://searchconsole.googleapis.com/v1";
const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];
// Sitemap submission is a WRITE — the readonly scope that inspects URLs cannot submit one.
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
 * Submit (or resubmit) a sitemap for a property. Returns the feedpath Google accepted.
 * Throws on failure — this runs behind an approved action, so an honest error beats a quiet no-op.
 */
export async function submitSitemap(
  property: string, sitemapUrl: string,
): Promise<{ property: string; sitemap: string }> {
  const creds = loadCredentials();
  if (!creds) throw new Error("No Search Console service-account credentials configured.");
  const client = await getWriteAuth(creds).getClient();
  await client.request({
    url: `${WEBMASTERS}/sites/${encodeURIComponent(property)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
    method: "PUT",
  });
  return { property, sitemap: sitemapUrl };
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
