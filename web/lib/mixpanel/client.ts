// Mixpanel Query API client — the read side only.
//
// Summit needs product analytics for one question the rest of the app cannot answer: did the SEO work
// earn anything. Rankings, impressions and clicks all stop at the door; signups, generations and
// revenue happen on the other side of it, and they live in Mixpanel.
//
// Credentials (a service account, .env.local):
//   MIXPANEL_PROJECT_ID        e.g. 3287199
//   MIXPANEL_SA_USERNAME       service account username (…​.mp-service-account)
//   MIXPANEL_SA_SECRET         its secret
//   MIXPANEL_REGION            optional — "eu" or "in" for those residencies, default US
//
// Without them `isMixpanelConfigured()` is false and every call returns empty, exactly as gsc.ts does:
// the page then says the ROI view is unconfigured rather than rendering zeros that look like a bad
// quarter.

const REGION_HOST: Record<string, string> = {
  eu: "https://eu.mixpanel.com",
  in: "https://in.mixpanel.com",
};

function host(): string {
  const r = (process.env.MIXPANEL_REGION ?? "").trim().toLowerCase();
  return REGION_HOST[r] ?? "https://mixpanel.com";
}

export function projectId(): string | null {
  return process.env.MIXPANEL_PROJECT_ID?.trim() || null;
}

export function isMixpanelConfigured(): boolean {
  return !!(projectId() && process.env.MIXPANEL_SA_USERNAME?.trim() && process.env.MIXPANEL_SA_SECRET?.trim());
}

function authHeader(): string {
  const u = process.env.MIXPANEL_SA_USERNAME?.trim() ?? "";
  const s = process.env.MIXPANEL_SA_SECRET?.trim() ?? "";
  return `Basic ${Buffer.from(`${u}:${s}`).toString("base64")}`;
}

/** YYYY-MM-DD, n days before today (UTC). Mixpanel dates are inclusive on both ends. */
export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

export class MixpanelError extends Error {}

async function query(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const pid = projectId();
  if (!pid) throw new MixpanelError("Mixpanel is not configured (MIXPANEL_PROJECT_ID).");
  const qs = new URLSearchParams({ ...params, project_id: pid });
  const res = await fetch(`${host()}${path}?${qs}`, {
    headers: { Authorization: authHeader(), Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // Mixpanel puts the useful part in the body — a bare "400" tells nobody which expression was
    // rejected, and these `where` expressions are exactly the thing that gets a character wrong.
    throw new MixpanelError(`Mixpanel ${res.status} on ${path}${text ? `: ${text.slice(0, 400)}` : ""}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new MixpanelError(`Mixpanel returned non-JSON on ${path}: ${text.slice(0, 200)}`);
  }
}

/** `{ segment: total }`, summed across the window. */
export type Segments = Record<string, number>;

function collapse(results: Record<string, Record<string, number>>): Segments {
  const out: Segments = {};
  for (const [segment, byDate] of Object.entries(results ?? {})) {
    out[segment] = Object.values(byDate ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
  }
  return out;
}

export interface SegmentationArgs {
  event: string;
  from: string;
  to: string;
  /** Breakdown expression, e.g. `properties["first_page_view"]`. Omit for a single total. */
  on?: string;
  /** Filter expression in Mixpanel's segmentation syntax. */
  where?: string;
  /** unique = distinct users (what a "conversion" means here), general = raw event count. */
  type?: "general" | "unique" | "average";
  limit?: number;
}

/** Count events (or uniques) per segment. */
export async function segmentation(a: SegmentationArgs): Promise<Segments> {
  const params: Record<string, string> = {
    event: a.event, from_date: a.from, to_date: a.to,
    unit: "day", type: a.type ?? "unique",
  };
  if (a.on) params.on = a.on;
  if (a.where) params.where = a.where;
  if (a.limit) params.limit = String(a.limit);
  const j = await query("/api/2.0/segmentation", params);
  return collapse((j.data as { values?: Record<string, Record<string, number>> })?.values ?? {});
}

/** Sum a numeric property per segment — this is how revenue is counted. */
export async function segmentationSum(a: SegmentationArgs & { expression: string }): Promise<Segments> {
  const params: Record<string, string> = {
    event: a.event, from_date: a.from, to_date: a.to,
    unit: "day", expression: a.expression,
  };
  if (a.on) params.on = a.on;
  if (a.where) params.where = a.where;
  const j = await query("/api/2.0/segmentation/sum", params);
  // /sum returns { results: { segment: { date: n } } } when segmented, and { results: { date: n } }
  // when not — the unsegmented shape would otherwise collapse into one bogus segment per date.
  const results = (j.results ?? {}) as Record<string, unknown>;
  if (!a.on) {
    const total = Object.values(results).reduce<number>((s, v) => s + (Number(v) || 0), 0);
    return { $overall: total };
  }
  return collapse(results as Record<string, Record<string, number>>);
}
