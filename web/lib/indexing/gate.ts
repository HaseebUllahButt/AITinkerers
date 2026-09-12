// Indexability check battery (PRD §6.3, R2). Pure + deterministic. Produces a per-URL verdict
// of pass / block / flag with the exact failing checks — the shared logic behind both the
// pre-publish gate and the live monitor. "Never a silent pass": any real problem yields block
// or flag. Ported + extended from imagine-seo-engine's sitemap-qa gate (adds RENDERING + THIN/DUP).

export interface UrlChecks {
  url: string;
  path: string;
  httpStatus: number;
  isRedirect: boolean;
  robotsDisallowed: boolean;
  /** meta robots noindex OR X-Robots-Tag: noindex. */
  hasNoindex: boolean;
  /** userCanonical === self (googleCanonical comparison needs GSC; monitor-only). */
  isSelfCanonical: boolean;
  canonical: string | null;
  hasTitle: boolean;
  hasMetaDescription: boolean;
  h1Count: number;
  hasJsonLd: boolean;
  /** RENDERING check: primary content/SEO tags present only after JS. */
  jsGated: boolean;
  /** THIN/DUP check inputs. */
  contentWords: number;
  uniquenessRatio: number; // 0..1 vs template siblings; 1 = fully unique
  /** SOFT-404: returns 200 but the content reads like a not-found page (title/body wording). */
  looksSoft404?: boolean;
}

export type Verdict = "pass" | "block" | "flag";

export interface GateResult {
  url: string;
  verdict: Verdict;
  /** Hard failures — must not enter the sitemap / must not publish. */
  blockFailures: string[];
  /** Soft failures — publish but needs attention (→ PR or ticket). */
  flagFailures: string[];
  failures: string[];
}

export const GATE_THRESHOLDS = {
  /** Minimum primary-content words (below → thin). */
  minContentWords: 120,
  /** Minimum uniqueness ratio vs template siblings (below → duplicate-ish). */
  minUniqueness: 0.5,
} as const;

export function evaluateGate(
  checks: UrlChecks,
  thresholds = GATE_THRESHOLDS,
): GateResult {
  const blockFailures: string[] = [];
  const flagFailures: string[] = [];

  // ── Hard (block) — the page can't index at all in this state ──
  // Status 0 means the crawler couldn't fetch the page at all (timeout / DNS / TLS / bot-block) —
  // that's a crawl problem, not a broken page, so it gets its own reason (not routed as a fix).
  if (checks.httpStatus === 0) blockFailures.push("unreachable");
  else if (checks.httpStatus !== 200) blockFailures.push(`http_status=${checks.httpStatus}`);
  // Soft 404: a 200 that's really a not-found page — Google won't index it and it wastes crawl.
  else if (checks.looksSoft404) blockFailures.push("soft_404");
  if (checks.isRedirect) blockFailures.push("is_redirect");
  if (checks.robotsDisallowed) blockFailures.push("robots_disallowed");
  if (checks.hasNoindex) blockFailures.push("has_noindex");
  // A canonical pointing elsewhere is a hard block; a missing one is a soft flag (Google will
  // self-canonicalize, but an explicit self-canonical is best practice).
  if (checks.canonical !== null && !checks.isSelfCanonical) blockFailures.push("not_self_canonical");

  // ── Soft (flag) — indexable but weak; mechanical fix or judgment call ──
  if (checks.canonical === null) flagFailures.push("missing_canonical");
  if (!checks.hasTitle) flagFailures.push("missing_title");
  if (!checks.hasMetaDescription) flagFailures.push("missing_meta_description");
  if (checks.h1Count === 0) flagFailures.push("missing_h1");
  if (checks.h1Count > 1) flagFailures.push("multiple_h1");
  if (!checks.hasJsonLd) flagFailures.push("missing_schema");
  if (checks.jsGated) flagFailures.push("js_gated");
  if (
    checks.contentWords < thresholds.minContentWords ||
    checks.uniquenessRatio < thresholds.minUniqueness
  ) {
    flagFailures.push("thin_or_duplicate");
  }

  const verdict: Verdict =
    blockFailures.length > 0 ? "block" : flagFailures.length > 0 ? "flag" : "pass";

  return {
    url: checks.url,
    verdict,
    blockFailures,
    flagFailures,
    failures: [...blockFailures, ...flagFailures],
  };
}

export function partitionByVerdict(results: GateResult[]): Record<Verdict, GateResult[]> {
  return {
    pass: results.filter((r) => r.verdict === "pass"),
    block: results.filter((r) => r.verdict === "block"),
    flag: results.filter((r) => r.verdict === "flag"),
  };
}
