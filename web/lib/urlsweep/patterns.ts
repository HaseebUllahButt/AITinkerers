// What counts as a retired URL, and how to spot one in a page.
//
// The sweep is deliberately GENERIC — "find every internal reference matching these patterns" — and
// the retired dashboard set is only its default. This will happen again: a URL gets retired, links
// to it linger, and somebody has to find them all. A sweep hard-coded to the 2026 dashboard list
// would have to be rewritten next time.

/** The canonical host. Everything else on the domain is, by default, something to look at. */
export const CANONICAL_HOST = "www.northwind.example";
const APEX = "northwind.example";

export interface SweepPattern {
  /** Human label — findings group by this, so it should read as a cause. */
  label: string;
  /** Match any URL on this exact host (www. is normalised away on both sides). */
  host?: string;
  /** Match any URL on the canonical host whose path starts here. */
  pathPrefix?: string;
  /** Match any *.northwind.example host that is not the canonical host or the apex. */
  subdomainCatchAll?: boolean;
  note?: string;
}

/**
 * The default set.
 *
 * The first four are the URLs the team named. The fifth is the one that actually matters: nobody
 * can enumerate every subdomain that has ever been linked, and "plus any other subdomain URLs"
 * is not a list somebody can hand you — it is the output of a crawl. So the catch-all reports
 * EVERY non-canonical northwind.example host it finds, and the team decides which are legitimate.
 * Reporting a live subdomain as a finding is the right failure here: a false positive costs one
 * glance, a missed subdomain is the exact thing this sweep exists to prevent.
 */
export const DEFAULT_PATTERNS: SweepPattern[] = [
  { label: "old dashboard", pathPrefix: "/dashboard", note: "Retired dashboard path on the main site." },
  { label: "ideate subdomain", host: "ideate.northwind.example" },
  { label: "shorts subdomain", host: "shorts.northwind.example" },
  { label: "trust subdomain", host: "trust.northwind.example" },
  {
    label: "other northwind.example subdomain",
    subdomainCatchAll: true,
    note: "Any northwind.example host that is not www — reported so the team can confirm which are still meant to be linked.",
  },
];

function bareHost(h: string): string {
  return h.toLowerCase().replace(/^www\./, "");
}

/**
 * Which pattern does this URL trip, if any?
 *
 * Explicit patterns are tested before the catch-all so a link to ideate.northwind.example is labelled
 * "ideate subdomain" rather than swallowed into the generic bucket — the label is what tells the
 * team whether this is a known retirement or a surprise.
 */
export function matchUrl(rawUrl: string, patterns: SweepPattern[] = DEFAULT_PATTERNS): SweepPattern | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;

  const host = bareHost(u.hostname);
  const path = u.pathname.replace(/\/+$/, "") || "/";

  for (const p of patterns) {
    if (p.host && host === bareHost(p.host)) return p;
    // A path rule is about OUR canonical site. The same path on a partner domain is their business.
    if (p.pathPrefix && (host === APEX)) {
      const pref = p.pathPrefix.replace(/\/+$/, "");
      if (path === pref || path.startsWith(`${pref}/`)) return p;
    }
  }
  for (const p of patterns) {
    if (!p.subdomainCatchAll) continue;
    if (host !== APEX && host.endsWith(`.${APEX}`)) return p;
  }
  return null;
}

/**
 * Strings worth grepping the raw HTML for.
 *
 * The anchor pass misses a CTA whose navigation lives in a click handler, a data attribute or a
 * serialised router payload — and "or on CTA buttons" was named explicitly as part of the ask, so
 * anchors alone would answer the wrong question. These needles drive a second, coarser pass.
 *
 * The catch-all gets no needles: grepping for `.northwind.example` would hit the canonical host on every
 * page and return the whole site. Subdomains are found by the anchor pass and by their own explicit
 * patterns once somebody adds them.
 */
export function needlesFor(p: SweepPattern): string[] {
  if (p.host) return [bareHost(p.host)];
  if (p.pathPrefix) {
    const pref = p.pathPrefix.replace(/\/+$/, "");
    // Quoted-relative catches href="/dashboard" and router.push('/dashboard'); the host-qualified
    // form catches absolute references. Both need a boundary check — see rawHits.
    return [`"${pref}`, `'${pref}`, `${APEX}${pref}`];
  }
  return [];
}

/** A character that legitimately ENDS a path segment. Anything else means we matched a longer word
 *  (`/dashboards-guide` is not `/dashboard`) and the hit is discarded. */
const BOUNDARY = /[/"'?#\\ >)\]},;]/;

/**
 * Count raw (non-anchor) occurrences of a pattern, with one sample of surrounding text.
 *
 * Deliberately conservative: a hit only counts when the character after the needle can actually
 * terminate a path. Over-matching here would flood the report with near-misses and make the whole
 * thing untrustworthy, which is worse than missing an exotic reference.
 */
export function rawHits(html: string, p: SweepPattern): { count: number; sample: string | null } {
  const needles = needlesFor(p);
  if (!needles.length) return { count: 0, sample: null };

  let count = 0;
  let sample: string | null = null;
  const hay = html.toLowerCase();

  for (const needle of needles) {
    const n = needle.toLowerCase();
    let from = 0;
    for (;;) {
      const i = hay.indexOf(n, from);
      if (i === -1) break;
      from = i + n.length;
      const next = html[from];
      if (next !== undefined && !BOUNDARY.test(next)) continue;
      count++;
      if (!sample) {
        sample = html
          .slice(Math.max(0, i - 90), from + 90)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
      }
    }
  }
  return { count, sample };
}
