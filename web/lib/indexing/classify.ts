// Classify + route (PRD R4, §6.4). Turns each gate failure into an issue record with a root
// cause, owner, priority, exact fix, and a route (mechanical → PR, judgment → ticket). Also
// predicts the GSC coverage state a URL would likely land in — the rendering root-cause join
// (js-gated template + crawled-not-indexed → RENDERING) is the PRD's central diagnostic.
import type { GateResult, UrlChecks } from "./gate";

export type Owner = "webdev" | "seo" | "content";
export type Route = "pr" | "ticket";
export type Priority = "p0" | "p1" | "p2";
export type RootCause =
  | "RENDERING"
  | "THIN_DUPLICATE"
  | "CANONICAL"
  | "CRAWL_BUDGET"
  | "HARD_STATE"
  | "CWV_PERFORMANCE";

export interface Issue {
  reason: string; // stable gate-failure key
  label: string; // human title
  rootCause: RootCause;
  owner: Owner;
  route: Route;
  fix: string;
  priority: Priority;
}

// Per-failure diagnosis + routing. Mechanical fixes (strip noindex, canonical, meta, schema,
// redirect target) route to a PR; rendering + thin/dup are judgment calls → ticket (§6.4).
const FAILURE_MAP: Record<
  string,
  { label: string; rootCause: RootCause; owner: Owner; route: Route; fix: string }
> = {
  is_redirect: {
    label: "Page redirects away",
    rootCause: "HARD_STATE",
    owner: "seo",
    route: "pr",
    fix: "Point internal links at the final destination URL; don't link the redirecting URL.",
  },
  soft_404: {
    label: "Soft 404 (200 but not-found content)",
    rootCause: "HARD_STATE",
    owner: "webdev",
    route: "ticket",
    fix: "Return a real 404 for missing pages, or restore the intended content — Google won't index a 200 that reads as 'not found'.",
  },
  robots_disallowed: {
    label: "Blocked by robots.txt",
    rootCause: "HARD_STATE",
    owner: "webdev",
    route: "pr",
    fix: "Remove the disallow rule for this path in robots.txt if it should be indexable.",
  },
  has_noindex: {
    label: "Excluded by noindex",
    rootCause: "HARD_STATE",
    owner: "webdev",
    route: "pr",
    fix: "Remove the noindex (meta robots or X-Robots-Tag) — often left over from staging.",
  },
  not_self_canonical: {
    label: "Canonical points to another URL",
    rootCause: "CANONICAL",
    owner: "seo",
    route: "pr",
    fix: "Set an explicit self-canonical, or consolidate/differentiate the duplicate.",
  },
  missing_canonical: {
    label: "No canonical tag",
    rootCause: "CANONICAL",
    owner: "seo",
    route: "pr",
    fix: "Add a self-referencing <link rel=\"canonical\"> to the initial HTML.",
  },
  missing_title: {
    label: "Missing <title>",
    rootCause: "HARD_STATE",
    owner: "seo",
    route: "pr",
    fix: "Add a unique, descriptive <title> to the template/page SEO fields.",
  },
  missing_meta_description: {
    label: "Missing meta description",
    rootCause: "HARD_STATE",
    owner: "seo",
    route: "pr",
    fix: "Populate the meta description in the page's SEO component.",
  },
  missing_h1: {
    label: "Missing H1",
    rootCause: "HARD_STATE",
    owner: "seo",
    route: "pr",
    fix: "Add exactly one H1 that states the page's primary topic.",
  },
  multiple_h1: {
    label: "Multiple H1s",
    rootCause: "HARD_STATE",
    owner: "seo",
    route: "pr",
    fix: "Collapse to exactly one H1; demote the others to H2/H3.",
  },
  missing_schema: {
    label: "Missing JSON-LD schema",
    rootCause: "HARD_STATE",
    owner: "seo",
    route: "pr",
    fix: "Add appropriate JSON-LD (e.g. WebPage/SoftwareApplication/Article) to the initial HTML.",
  },
  js_gated: {
    label: "JS-gated rendering",
    rootCause: "RENDERING",
    owner: "webdev",
    route: "ticket",
    fix: "SSR/SSG the primary content, meta, canonical and JSON-LD into the initial HTML — non-rendering crawlers (Google's first pass, GPTBot/ClaudeBot/PerplexityBot) see none of it otherwise.",
  },
  unreachable: {
    label: "Couldn't fetch the page (timeout or bot-block)",
    rootCause: "HARD_STATE",
    owner: "webdev",
    route: "ticket",
    fix: "The crawler couldn't load this page — likely a timeout, rate-limit, or bot protection. Confirm it loads for crawlers; this is a crawl issue, not necessarily a page defect.",
  },
  thin_or_duplicate: {
    label: "Thin / duplicate content",
    rootCause: "THIN_DUPLICATE",
    owner: "content",
    route: "ticket",
    fix: "Raise unique depth vs. template siblings and top competitors; consolidate near-duplicates.",
  },
};

function fallback(reason: string) {
  return {
    label: reason,
    rootCause: "HARD_STATE" as RootCause,
    owner: "seo" as Owner,
    route: "ticket" as Route,
    fix: "Inspect manually.",
  };
}

// HTTP status failures carry the code (e.g. "http_status=404") — classify by range.
function statusIssue(reason: string): (typeof FAILURE_MAP)[string] {
  const code = Number(reason.split("=")[1]);
  if (code >= 500) {
    return {
      label: `Server error (${code})`,
      rootCause: "HARD_STATE",
      owner: "webdev",
      route: "ticket",
      fix: "Fix the 5xx and confirm a stable 200 for Googlebot.",
    };
  }
  if (code === 404 || code === 410) {
    return {
      label: `Not found (${code})`,
      rootCause: "HARD_STATE",
      owner: "webdev",
      route: "ticket",
      fix: "Restore the page or 301-redirect it to the best equivalent; fix inbound links.",
    };
  }
  return {
    label: `Unexpected status (${code})`,
    rootCause: "HARD_STATE",
    owner: "webdev",
    route: "ticket",
    fix: "Return a 200 for a page that should be indexable.",
  };
}

export function priorityFor(isBlock: boolean, isMoney: boolean): Priority {
  if (isBlock) return isMoney ? "p0" : "p1";
  return isMoney ? "p1" : "p2";
}

/** Build the issue list for a URL from its gate result. */
export function classifyChecks(
  gate: GateResult,
  isMoney: boolean,
): Issue[] {
  const blockSet = new Set(gate.blockFailures);
  return gate.failures.map((reason) => {
    const base = reason.startsWith("http_status=")
      ? statusIssue(reason)
      : FAILURE_MAP[reason] ?? fallback(reason);
    return { reason, ...base, priority: priorityFor(blockSet.has(reason), isMoney) };
  });
}

// ── Predicted GSC coverage state (R3 preview, no live GSC needed) ────────────────
export interface CoveragePrediction {
  state: string;
  rootCause: RootCause | "NONE";
  indexed: boolean;
  note: string;
}

/**
 * Predict the coverage state GSC would most likely assign, from crawl signals alone.
 * This is the pre-publish/offline proxy for the live URL-Inspection monitor (§6.4). The
 * headline case: a js-gated template that otherwise looks fine is the hidden driver of
 * "Crawled – currently not indexed", attributed here to RENDERING.
 */
export function predictCoverage(checks: UrlChecks): CoveragePrediction {
  if (checks.httpStatus >= 500)
    return { state: "Server error (5xx)", rootCause: "HARD_STATE", indexed: false, note: "5xx during crawl" };
  if (checks.httpStatus === 404 || checks.httpStatus === 410)
    return { state: "Not found (404)", rootCause: "HARD_STATE", indexed: false, note: "page not found" };
  if (checks.looksSoft404)
    return { state: "Soft 404", rootCause: "HARD_STATE", indexed: false, note: "returns 200 but content reads as not-found" };
  if (checks.isRedirect)
    return { state: "Page with redirect", rootCause: "HARD_STATE", indexed: false, note: "URL redirects away" };
  if (checks.hasNoindex)
    return { state: "Excluded by 'noindex' tag", rootCause: "HARD_STATE", indexed: false, note: "noindex present" };
  if (checks.robotsDisallowed)
    return { state: "Blocked by robots.txt", rootCause: "HARD_STATE", indexed: false, note: "disallowed" };
  if (checks.canonical !== null && !checks.isSelfCanonical)
    return {
      state: "Duplicate, Google chose different canonical",
      rootCause: "CANONICAL",
      indexed: false,
      note: "canonical points to another URL",
    };
  if (checks.jsGated)
    return {
      state: "Crawled – currently not indexed",
      rootCause: "RENDERING",
      indexed: false,
      note: "primary content/SEO tags only present after JS — invisible to non-rendering crawlers",
    };
  if (
    checks.contentWords < 120 ||
    checks.uniquenessRatio < 0.5
  )
    return {
      state: "Crawled – currently not indexed",
      rootCause: "THIN_DUPLICATE",
      indexed: false,
      note: "thin or near-duplicate vs template siblings",
    };
  return { state: "Submitted and indexed", rootCause: "NONE", indexed: true, note: "healthy" };
}
