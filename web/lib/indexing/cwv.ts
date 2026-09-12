// Core Web Vitals monitor (PRD R7) + diagnosis (R8). Pass/fail is judged on FIELD (CrUX p75)
// data — synthetic lab can't measure INP — while the Lighthouse LAB audits in the same PSI
// response drive the per-metric diagnosis (LCP element, INP long-tasks, CLS sources).
// Ported from imagine-seo-engine's core-web-vitals + pagespeed connector. One PSI call per URL.

export type Rating = "good" | "needs_improvement" | "poor" | "unknown";
export type Device = "mobile" | "desktop";

export interface MetricThresholds {
  good: number;
  poor: number;
}

// INP replaced FID on 2024-03-12. Values in ms except CLS (unitless).
export const THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },
  inp: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
} as const satisfies Record<string, MetricThresholds>;

export interface MetricEval {
  value?: number;
  rating: Rating;
}

export interface VitalsEval {
  lcp: MetricEval;
  inp: MetricEval;
  cls: MetricEval;
  /** All three present AND "good". */
  passesField: boolean;
  /** Any metric lacks field data (CrUX insufficient). */
  hasGaps: boolean;
}

export interface CwvDiagnosis {
  lcp: string[];
  inp: string[];
  cls: string[];
}

/** Where the field p75 came from — CrUX at URL level, CrUX at origin level, or PSI's embedded CrUX. */
export type FieldSource = "crux-url" | "crux-origin" | "psi" | "none";

export interface CwvResult {
  template: string;
  representativeUrl: string;
  device: Device;
  hasField: boolean;
  fieldSource: FieldSource;
  vitals: { lcpMs?: number; inpMs?: number; cls?: number };
  evaluation: VitalsEval;
  diagnosis: CwvDiagnosis;
  error?: string;
  /** Set when the field verdict succeeded but the R8 diagnosis call failed/timed out. */
  diagnosisError?: string;
}

const PSI = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CRUX = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

// One free Google Cloud API key (Chrome UX Report + PageSpeed APIs enabled) powers both CrUX and
// PSI. NO Search Console ownership is needed — CrUX is public per-origin/per-URL field data.
function googleKey(): string | undefined {
  return process.env.GOOGLE_API_KEY || process.env.PAGESPEED_API_KEY || undefined;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Field p75 (LCP/INP/CLS) from the CrUX API. `target` is a full URL or a bare origin. Returns
 * hasField=false when CrUX has insufficient real-user data for that key. Fast (no Lighthouse run),
 * high quota, and works for ANY origin — so it also enables competitor benchmarking.
 */
export async function cruxField(
  target: { url?: string; origin?: string },
  device: Device,
): Promise<{ lcpMs?: number; inpMs?: number; cls?: number; hasField: boolean }> {
  const key = googleKey();
  if (!key) return { hasField: false };
  const body: Record<string, unknown> = { formFactor: device === "desktop" ? "DESKTOP" : "PHONE" };
  if (target.url) body.url = target.url;
  else if (target.origin) body.origin = target.origin;
  else return { hasField: false };
  try {
    const res = await fetch(`${CRUX}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { hasField: false }; // 404 = no data for this key (normal)
    const data: any = await res.json();
    const m = data?.record?.metrics;
    if (!m) return { hasField: false };
    const p75 = (k: string): number | undefined => {
      const v = m?.[k]?.percentiles?.p75;
      return v === undefined ? undefined : Number(v);
    };
    return {
      lcpMs: p75("largest_contentful_paint"),
      inpMs: p75("interaction_to_next_paint"),
      cls: p75("cumulative_layout_shift"),
      hasField: true,
    };
  } catch {
    return { hasField: false };
  }
}

function evalMetric(value: number | undefined, t: MetricThresholds): MetricEval {
  if (value === undefined || Number.isNaN(value)) return { value: undefined, rating: "unknown" };
  const rating: Rating =
    value <= t.good ? "good" : value > t.poor ? "poor" : "needs_improvement";
  return { value, rating };
}

export function evaluateVitals(v: { lcpMs?: number; inpMs?: number; cls?: number }): VitalsEval {
  const lcp = evalMetric(v.lcpMs, THRESHOLDS.lcp);
  const inp = evalMetric(v.inpMs, THRESHOLDS.inp);
  const cls = evalMetric(v.cls, THRESHOLDS.cls);
  const metrics = [lcp, inp, cls];
  return {
    lcp,
    inp,
    cls,
    passesField: metrics.every((m) => m.rating === "good"),
    hasGaps: metrics.some((m) => m.rating === "unknown"),
  };
}

// ── R8 diagnosis: parse the Lighthouse lab audits for each metric's likely cause ──
type Audits = Record<string, any>;

function auditItems(audits: Audits, id: string): any[] {
  return audits?.[id]?.details?.items ?? [];
}
function nodeLabel(item: any): string | undefined {
  const n = item?.node ?? item;
  return (n?.nodeLabel || n?.snippet || n?.selector || "").toString().slice(0, 120) || undefined;
}
function ms(audits: Audits, id: string): number | undefined {
  const v = audits?.[id]?.numericValue;
  return typeof v === "number" ? Math.round(v) : undefined;
}

function diagnose(audits: Audits): CwvDiagnosis {
  const lcp: string[] = [];
  const inp: string[] = [];
  const cls: string[] = [];
  if (!audits) return { lcp, inp, cls };

  // LCP
  const lcpEl = nodeLabel(auditItems(audits, "largest-contentful-paint-element")[0]?.items?.[0]);
  if (lcpEl) lcp.push(`LCP element: ${lcpEl}`);
  const ttfb = ms(audits, "server-response-time");
  if (ttfb && ttfb > 600) lcp.push(`Slow TTFB (~${ttfb}ms)`);
  const rbr = auditItems(audits, "render-blocking-resources");
  if (rbr.length) lcp.push(`${rbr.length} render-blocking resource(s)`);

  // INP (architectural — long main-thread work)
  const longTasks = auditItems(audits, "long-tasks");
  if (longTasks.length) {
    const total = Math.round(longTasks.reduce((s, i) => s + (i.duration ?? 0), 0));
    inp.push(`${longTasks.length} long main-thread task(s) (~${total}ms total)`);
  }
  const bootup = ms(audits, "bootup-time");
  if (bootup && bootup > 2000) inp.push(`Heavy JS execution / bootup (~${bootup}ms)`);
  const mtw = ms(audits, "mainthread-work-breakdown");
  if (mtw && mtw > 3000) inp.push(`High main-thread work (~${mtw}ms)`);

  // CLS
  const shifts = auditItems(audits, "layout-shift-elements").map(nodeLabel).filter(Boolean);
  if (shifts.length) cls.push(`Shifting element(s): ${shifts.slice(0, 3).join("; ")}`);
  const unsized = auditItems(audits, "unsized-images");
  if (unsized.length) cls.push(`${unsized.length} image(s) without explicit dimensions`);

  return { lcp, inp, cls };
}

/**
 * Run PSI once for the Lighthouse lab audits (the R8 "why"); returns diagnosis + PSI field data.
 * A full mobile Lighthouse run routinely takes 30-45s — timed out at 30s this consistently failed
 * silently (the field verdict above still succeeded via the faster CrUX call, so a scan LOOKED
 * complete while quietly never explaining a single failing metric). 55s gives real runs headroom;
 * a genuine failure now returns a reason instead of a silently-empty diagnosis.
 */
async function psiDiagnose(
  url: string,
  device: Device,
): Promise<{ diagnosis: CwvDiagnosis; psiVitals: { lcpMs?: number; inpMs?: number; cls?: number }; error?: string }> {
  const empty = { lcp: [], inp: [], cls: [] };
  const params = new URLSearchParams({ url, strategy: device });
  params.append("category", "performance");
  const key = googleKey();
  if (key) params.set("key", key);
  try {
    const res = await fetch(`${PSI}?${params.toString()}`, { signal: AbortSignal.timeout(55_000) });
    if (!res.ok) return { diagnosis: empty, psiVitals: {}, error: `PageSpeed diagnosis request failed (HTTP ${res.status}).` };
    const data: any = await res.json();
    const m = data?.loadingExperience?.metrics;
    const clsRaw = m?.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile;
    return {
      diagnosis: diagnose(data?.lighthouseResult?.audits),
      psiVitals: {
        lcpMs: m?.LARGEST_CONTENTFUL_PAINT_MS?.percentile,
        inpMs: m?.INTERACTION_TO_NEXT_PAINT?.percentile,
        cls: clsRaw === undefined ? undefined : clsRaw / 100,
      },
    };
  } catch (e: any) {
    const timedOut = e?.name === "TimeoutError";
    return { diagnosis: empty, psiVitals: {}, error: timedOut ? "PageSpeed's full speed test took too long and timed out — the pass/fail numbers above are still real, just no cause breakdown this run." : `PageSpeed diagnosis request failed (${e?.message ?? "unknown error"}).` };
  }
}

/**
 * Field p75 + lab-audit diagnosis for one representative URL. Field verdict comes from the CrUX
 * API (URL level, falling back to origin level so low-traffic pages still get a whole-site read);
 * PSI is called only when a metric isn't "good", to explain WHY. Needs a free Google API key
 * (GOOGLE_API_KEY or PAGESPEED_API_KEY) — never Search Console ownership.
 */
export async function analyzeCwv(
  template: string,
  representativeUrl: string,
  device: Device = "mobile",
): Promise<CwvResult> {
  const base = { template, representativeUrl, device };
  const noData = (error?: string): CwvResult => ({
    ...base, hasField: false, fieldSource: "none", vitals: {}, evaluation: evaluateVitals({}),
    diagnosis: { lcp: [], inp: [], cls: [] }, error,
  });

  if (!googleKey()) return noData("No Google API key (set GOOGLE_API_KEY for CrUX + PageSpeed — free, no Search Console needed).");

  try {
    // 1. Field verdict from CrUX — try the exact URL, then the whole origin.
    let field = await cruxField({ url: representativeUrl }, device);
    let fieldSource: FieldSource = field.hasField ? "crux-url" : "none";
    if (!field.hasField) {
      const origin = await cruxField({ origin: originOf(representativeUrl) }, device);
      if (origin.hasField) { field = origin; fieldSource = "crux-origin"; }
    }

    // 2. Diagnosis via PSI only when something's not good (avoids a slow Lighthouse run on healthy pages).
    let vitals: { lcpMs?: number; inpMs?: number; cls?: number } = { lcpMs: field.lcpMs, inpMs: field.inpMs, cls: field.cls };
    let evaluation = evaluateVitals(vitals);
    let diagnosis: CwvDiagnosis = { lcp: [], inp: [], cls: [] };

    const needDiagnosis = !field.hasField || !evaluation.passesField;
    let diagnosisError: string | undefined;
    if (needDiagnosis) {
      const psi = await psiDiagnose(representativeUrl, device);
      diagnosis = psi.diagnosis;
      diagnosisError = psi.error;
      // If CrUX had no field data, fall back to PSI's embedded CrUX field values.
      if (!field.hasField && (psi.psiVitals.lcpMs !== undefined || psi.psiVitals.cls !== undefined)) {
        vitals = psi.psiVitals;
        evaluation = evaluateVitals(vitals);
        fieldSource = "psi";
      }
    }

    const hasField = fieldSource !== "none";
    return {
      ...base,
      hasField,
      fieldSource,
      vitals,
      evaluation,
      diagnosis,
      error: hasField ? undefined : "No CrUX field data for this URL or origin (not enough real-user traffic yet).",
      diagnosisError: hasField ? diagnosisError : undefined,
    };
  } catch (e: any) {
    return noData(e?.message ?? "CWV request failed");
  }
}
