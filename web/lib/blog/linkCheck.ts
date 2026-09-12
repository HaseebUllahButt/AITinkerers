// Does every link in this draft actually resolve? Run before publishing.
//
// ── Why this did not already exist ─────────────────────────────────────────────────────────────────
//
// The writer's validator (lib/writer/validate.ts) already gates links hard, but on two questions that
// are not this one:
//
//   provenance  did a research tool actually return this URL, or did the model invent it
//   membership  is this internal URL in the voice's approved internal-link database
//
// Both are string comparisons against sets we already hold, and neither makes a network request. A URL
// can pass both and still be dead: an approved internal page that has since been unpublished, a source
// that 404'd after the research call, a real domain whose path was retired. The validator was never
// wrong about what it checked, it just never asked whether the page is there.
//
// ── Why the audit's checker, and not a new one ─────────────────────────────────────────────────────
//
// `linkaudit/run.ts` already answers exactly this, and its version is meaningfully stronger than a
// plain status-code probe. Alongside 404/410 it catches:
//
//   soft   HTTP 200 whose title or h1 says "not found" — the common SPA failure mode
//   home   a deep link that quietly redirects to the site root, which reads as 200 and is still broken
//   fingerprint match against the site root, which catches catch-all routes serving 200 for any path
//
// It also carries a social-domain skip list, because X and t.co block non-browser requests and would
// otherwise report as broken on every scan. Reusing it means the pre-publish gate and the nightly
// audit can never disagree about whether a link is dead, which they would drift into immediately if
// this file grew its own probe.
//
// ── Suggestions ────────────────────────────────────────────────────────────────────────────────────
//
// Borrowed from muhammadarsalan100/page-links-validator, which does one thing we had no equivalent of:
// when an internal link is broken, it proposes a live replacement by slug similarity. Our
// seo-agents/internalLinks.ts suggests where to ADD links, which is a different question. Dice's
// coefficient over character bigrams is their choice and it is the right one here: dependency-free,
// and slugs are exactly the short hyphenated strings it handles well.
import { checkLink, type FingerprintMap, type LinkVerdict } from "@/lib/linkaudit/run";
import { internalLinkUniverse } from "@/lib/sitemap/store";
import type { BlogDraft } from "@/lib/db/queries";

export interface DraftLink {
  url: string;
  /** Anchor text, or the CTA's button label. Empty for a bare autolink. */
  anchor: string;
  /** Where it sits, so a report can point at it: "body" or "CTA button". */
  zone: "body" | "cta";
}

export interface LinkFinding extends DraftLink {
  verdict: LinkVerdict["verdict"];
  status?: number;
  /** Live internal URLs ranked by slug similarity. Only computed for broken internal links. */
  suggestions: string[];
}

export interface LinkCheckReport {
  checked: number;
  /** Definitely dead. These block a publish. */
  broken: LinkFinding[];
  /** Could not be reached. Reported, never blocking — see the note on `unreach` below. */
  unreachable: LinkFinding[];
  /** True when the time budget cut the pass short, so "no problems" is not a complete answer. */
  truncated: boolean;
}

/** Verdicts that mean the page is genuinely not there. `unreach` is deliberately excluded: a blocked
 *  bot, a WAF challenge or a flaky moment all land there, and blocking a publish on one would train
 *  people to bypass the gate, which is worse than the occasional dead outbound link. */
const BROKEN: ReadonlySet<string> = new Set(["404", "410", "soft", "home", "server-error"]);

/**
 * A first-party 404 that the audit downgraded to `unreach` still counts as broken here.
 *
 * checkLink() only trusts a 404 whose BODY also reads like an error page, because an SPA can answer
 * 404 while rendering a perfectly working screen, and the nightly audit's own comment is explicit
 * that falsely pinging writers is the worse failure there. Correct for a crawl over the whole live
 * site; wrong for this gate.
 *
 * On northwind.example the reasoning inverts. There is no bot-block to be fooled by on our own domain, so
 * a genuine 404 status is our page being missing, and the cost of ignoring it is shipping a post
 * that links to it. Measured while building this: a nonexistent /features/ path returns 404 with a
 * full app shell, so the audit reports `unreach` and this gate would have waved it through.
 *
 * Third-party stays untouched. A 404 from someone else's WAF is exactly the false positive the
 * audit is guarding against, and blocking a publish on it would teach people to force past the gate.
 */
function isDefinitelyBroken(v: LinkVerdict, url: string): boolean {
  if (BROKEN.has(v.verdict)) return true;
  return isInternal(url) && (v.status === 404 || v.status === 410);
}

const SKIP_SCHEME = /^(mailto:|tel:|#|javascript:|data:)/i;

/**
 * Every link in a draft body: markdown links, bare autolinks, and the URLs inside ```CTA fences.
 *
 * The CTA fence is the frontend's own convention for a mid-body button and is parsed by
 * writer/validate.ts the same way. It holds either one object or an array of them, and its url is a
 * real link on the rendered page, so it has to be checked like any other. A malformed fence is left
 * alone here: validate.ts already reports that, and reporting it twice in different words helps
 * no one.
 */
export function extractDraftLinks(body: string): DraftLink[] {
  const out: DraftLink[] = [];
  const seen = new Set<string>();
  const push = (url: string, anchor: string, zone: DraftLink["zone"]) => {
    const u = url.trim().replace(/[.,;:]+$/, "");
    if (!u || SKIP_SCHEME.test(u)) return;
    const key = `${zone}|${u.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: u, anchor: anchor.trim(), zone });
  };

  // CTA fences first, and remove them from what the markdown pass sees. Their JSON contains quoted
  // URLs that the markdown/autolink patterns would otherwise pick up a second time under the wrong
  // zone, and a report that lists one button twice reads as two problems.
  let rest = body;
  for (const m of body.matchAll(/```CTA\s*\n([\s\S]*?)```/gi)) {
    rest = rest.replace(m[0], "");
    try {
      const parsed = JSON.parse(m[1]);
      for (const c of Array.isArray(parsed) ? parsed : [parsed]) {
        if (c && typeof c.url === "string") push(c.url, typeof c.text === "string" ? c.text : "", "cta");
      }
    } catch { /* malformed fence — validate.ts owns that error */ }
  }

  // Fenced code and inline code can contain example URLs that are illustrative, not navigable.
  rest = rest.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

  // The `(!?)` group is what keeps IMAGES out. `![alt](url)` contains `](url)`, so without it every
  // generated body image was collected as a link the article offers the reader — which is what it is
  // not. Body images only started existing on the unattended path recently, so this had never fired;
  // the same omission in validate.ts's provenance gate reported our own CDN as a fabricated source.
  const MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const m of rest.matchAll(MD_LINK)) { if (m[1] !== "!") push(m[3], m[2], "body"); }

  // Bare autolinks. Markdown links are REMOVED first rather than excluded with a `(?<!\()`
  // lookbehind: that lookbehind also rejected a URL wrapped in ordinary prose parentheses, which is
  // a normal way to cite one, so "(https://example.com/two)" was silently never checked.
  // `)` stays out of the character class so the wrapping paren is not swallowed. The cost is a URL
  // that genuinely contains one, like a Wikipedia "_(disambiguation)" path, gets clipped — rarer in
  // our copy than a parenthesised citation, and it fails loudly as a 404 rather than silently.
  const bare = rest.replace(MD_LINK, " ");
  for (const m of bare.matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/gi)) push(m[0], "", "body");
  return out;
}

/** Dice's coefficient over character bigrams. 1 is identical, 0 shares no adjacent pair. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a), B = bigrams(b);
  let hits = 0;
  for (const [g, n] of A) hits += Math.min(n, B.get(g) ?? 0);
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

const slugOf = (url: string) => {
  try { return new URL(url, "https://www.northwind.example").pathname.replace(/\/+$/, "").split("/").pop() ?? ""; }
  catch { return ""; }
};

function suggestFor(brokenUrl: string, universe: string[]): string[] {
  const slug = slugOf(brokenUrl);
  if (!slug) return [];
  return universe
    .map((u) => ({ u, score: similarity(slug, slugOf(u)) }))
    // Below roughly half the bigrams in common the "suggestion" is noise, and a wrong suggestion is
    // worse than none — someone will accept it without looking.
    .filter((x) => x.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.u);
}

function isInternal(url: string): boolean {
  try { return /(^|\.)imagine\.art$/i.test(new URL(url).hostname); } catch { return url.startsWith("/"); }
}

/**
 * Check every link in a draft.
 *
 * Bounded twice over, because this runs inside a request: `concurrency` at a time, and the whole pass
 * abandons at `budgetMs`. A long guide can carry a hundred links, and a publish that hangs past the
 * platform's own function timeout returns nothing at all — strictly worse than a partial answer that
 * says it is partial, which is what `truncated` is for.
 */
export async function checkDraftLinks(
  body: string,
  opts: { budgetMs?: number; concurrency?: number } = {},
): Promise<LinkCheckReport> {
  const budgetMs = opts.budgetMs ?? 25_000;
  const concurrency = opts.concurrency ?? 8;
  const links = extractDraftLinks(body);
  const deadline = Date.now() + budgetMs;
  const fp: FingerprintMap = {};

  const broken: LinkFinding[] = [];
  const unreachable: LinkFinding[] = [];
  let checked = 0;
  let truncated = false;

  let cursor = 0;
  async function worker() {
    while (cursor < links.length) {
      if (Date.now() >= deadline) { truncated = true; return; }
      const link = links[cursor++];
      const v = await checkLink(link.url, fp).catch(
        () => ({ verdict: "unreach" as const, status: undefined }),
      );
      checked++;
      if (v.verdict === "ok") continue;
      const finding: LinkFinding = { ...link, verdict: v.verdict, status: v.status, suggestions: [] };
      if (isDefinitelyBroken(v, link.url)) broken.push(finding);
      else unreachable.push(finding);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, links.length) }, worker));

  // Suggestions only for broken INTERNAL links, and only once the checking is done — the universe
  // fetch is wasted work on a draft whose links are all fine, which is the common case.
  const internalBroken = broken.filter((b) => isInternal(b.url));
  if (internalBroken.length) {
    const universe = [...(await internalLinkUniverse().catch(() => new Set<string>()))];
    for (const b of internalBroken) b.suggestions = suggestFor(b.url, universe);
  }

  return { checked, broken, unreachable, truncated };
}

/** One-line-per-problem summary for an API error body or a toast. */
export function describeLinkProblems(r: LinkCheckReport): string[] {
  const label: Record<string, string> = {
    "404": "404", "410": "gone", soft: "renders a not-found page",
    home: "redirects to the homepage", "server-error": "server error",
    // Only reachable here for a first-party 404/410 the audit downgraded — see isDefinitelyBroken.
    unreach: "404 on our own site",
  };
  return r.broken.map((b) => {
    const what = label[b.verdict] ?? b.verdict;
    const where = b.zone === "cta" ? "CTA button" : b.anchor ? `"${b.anchor}"` : "link";
    const fix = b.suggestions.length ? ` Did you mean ${b.suggestions[0]}?` : "";
    return `${where} → ${b.url} (${what}).${fix}`;
  });
}
