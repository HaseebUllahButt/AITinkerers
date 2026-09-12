import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";

import { extractLinks, checkLink, describeOccurrences, fetchRaw, type FingerprintMap } from "@/lib/linkaudit/run";
import { supabaseAdmin } from "@/lib/db/supabase";

// 404 Hunter — paste live page URLs, get every broken link on them with the section it sits in and a
// suggested replacement.
//
// ── Why this is thirty lines and not a subsystem ────────────────────────────────────────────────
//
// SearchOps already owns all of the hard parts, and rebuilding any of them would be a second, worse copy:
//
//   extractLinks         every link with its anchor, its zone and its nearest heading — the "which
//                        section is it in" answer, which is the part that makes a report actionable
//   checkLink            404 / 410 / soft-404 / redirect-to-home / server-error / unreachable, with
//                        per-host soft-404 fingerprinting so a 200 that says "not found" is caught
//   describeOccurrences  the same phrasing the site audit uses, so two surfaces do not describe one
//                        finding two different ways
//
// What is genuinely new here is only the on-demand shape (the site audit sweeps the whole site on a
// schedule; this answers "check these three pages, now") and the replacement suggestion.
export const maxDuration = 300;

async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  const session = await auth().catch(() => null);
  return !!session;
}

/** Stop words that carry no discriminating information when matching one slug against another. */
const STOP = new Set(["the", "a", "an", "of", "for", "to", "in", "and", "your", "best", "top", "free", "online", "ai", "with"]);

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/^https?:\/\/[^/]+/, "").split("?")[0]
    .split(/[/\s\-_.]+/).filter((t) => t && !STOP.has(t) && !/^20\d\d$/.test(t));
}

/**
 * The live page most likely to be what a broken link meant.
 *
 * Token overlap against the real sitemap, and only above a floor — a suggestion that is merely the
 * least-bad match is worse than no suggestion, because somebody will accept it. Returns the top three
 * so a person chooses rather than trusts.
 */
function suggest(brokenUrl: string, sitemap: Array<{ path: string; url: string }>): Array<{ url: string; path: string; score: number }> {
  const want = new Set(tokens(brokenUrl));
  if (!want.size) return [];
  const scored = sitemap.map((s) => {
    const have = new Set(tokens(s.path));
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    return { ...s, score: shared / (want.size + have.size - shared || 1) };
  });
  return scored.filter((s) => s.score >= 0.35).sort((a, b) => b.score - a.score).slice(0, 3)
    .map((s) => ({ url: s.url, path: s.path, score: Math.round(s.score * 100) / 100 }));
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { urls?: string[] | string };
  const raw = Array.isArray(body.urls) ? body.urls : String(body.urls ?? "").split(/[\n,]+/);
  // Ten: each page can carry a hundred links and each link is a network round trip, so this bound is
  // what keeps the request inside its budget rather than timing out having reported nothing.
  const urls = raw.map((u) => u.trim()).filter(Boolean).slice(0, 10);
  if (!urls.length) return NextResponse.json({ error: "Give at least one page URL." }, { status: 400 });

  // The sitemap, for replacement suggestions. Paged: the client caps at 1,000 rows and there are 1,501.
  const sitemap: Array<{ path: string; url: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("site_urls").select("path, url").range(from, from + 999);
    sitemap.push(...(data ?? []) as Array<{ path: string; url: string }>);
    if ((data ?? []).length < 1000) break;
  }

  // Shared across every page in the batch, so ten pages linking to the same host fingerprint it once.
  const fingerprints: FingerprintMap = {};

  // ── One verdict per URL, across the whole batch ────────────────────────────────────────────────
  //
  // Every page on this site carries the same footer and nav — measured, 80 links on one blog post, and
  // most of them are the shared chrome. Checking ten pages without this would re-request the same
  // sixty URLs ten times, which is both the bulk of the wait and sixty times the load on our own host
  // for one answer. A single page still costs 80 live requests (~35s); that part is inherent, because
  // the whole point is checking them rather than trusting a cache.
  const verdicts = new Map<string, Awaited<ReturnType<typeof checkLink>>>();
  async function checkOnce(url: string) {
    const hit = verdicts.get(url);
    if (hit) return hit;
    const v = await checkLink(url, fingerprints);
    verdicts.set(url, v);
    return v;
  }

  const pages = [];

  for (const pageUrl of urls) {
    const fetched = await fetchRaw(pageUrl);
    if ("error" in fetched) {
      pages.push({ url: pageUrl, error: fetched.error, links: [], checked: 0 });
      continue;
    }
    if (fetched.status >= 400) {
      pages.push({ url: pageUrl, error: `The page itself answers HTTP ${fetched.status}.`, links: [], checked: 0 });
      continue;
    }

    const links = extractLinks(fetched.html, pageUrl);

    // ── Bounded concurrency, which is faster AND more accurate ─────────────────────────────────
    //
    // This was an unbounded Promise.all over every link on the page. Measured, that was the worst of
    // both worlds: 80 simultaneous requests to one host got throttled, so a single page took ~35s AND
    // the throttled requests came back as false "unreachable" verdicts. Running the same scan twice
    // gave 1 broken link and then 2, with the extra one being a page of ours that exists.
    //
    // Eight at a time finishes sooner, because the wall was the host's rate limiting rather than our
    // own round trips, and the verdicts stop depending on how busy the batch is. The serial re-check
    // below stays as the backstop; it should now rarely have anything to do.
    const results: Array<Awaited<ReturnType<typeof one>> | null> = new Array(links.length).fill(null);
    async function one(l: (typeof links)[number]) {
      const verdict = await checkOnce(l.url);
      if (verdict.verdict === "ok") return null;
      return {
        url: l.url,
        anchor: l.anchor,
        verdict: verdict.verdict,
        status: verdict.status ?? null,
        // Where on the page it sits — the thing that turns "something is broken" into "fix this".
        where: describeOccurrences(l.occurrences) ?? l.context ?? null,
        occurrences: l.occurrences,
        suggestions: suggest(l.url, sitemap),
      };
    }
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (;;) {
        const i = next++;
        if (i >= links.length) return;
        results[i] = await one(links[i]);
      }
    }));

    // ── Re-check every "unreachable", one at a time ────────────────────────────────────────────
    //
    // Measured on the first real run: a page with 80 links reported /apps/nano-banana-2 and
    // /apps/kling-3.0 as unreachable, and the suggester matched each one's own path in the live
    // sitemap at 100% — which is the tell. Eighty concurrent requests to one host gets throttled, and
    // a throttled request is indistinguishable from a dead link if you only ask once.
    //
    // `unreach` is the only verdict re-checked, because it is the only one that means "no answer". A
    // 404 or a soft-404 came back with an answer and does not become truer on a second ask.
    //
    // This matters more than it looks: a tool that reports working links as broken gets ignored inside
    // a week, and then the real 404 it finds next month is in a list nobody opens.
    const confirmed = [];
    for (const r of results) {
      if (r === null) continue;
      if (r.verdict !== "unreach") { confirmed.push(r); continue; }
      await new Promise((res) => setTimeout(res, 250));
      const second = await checkLink(r.url, fingerprints);
      // Overwrite the cached verdict either way, so a later page in the batch inherits the CONFIRMED
      // answer rather than repeating the whole re-check for the same footer link.
      verdicts.set(r.url, second);
      if (second.verdict === "ok") continue; // it was throttling, not a broken link
      confirmed.push({ ...r, verdict: second.verdict, status: second.status ?? r.status });
    }

    pages.push({
      url: pageUrl,
      finalUrl: fetched.finalUrl,
      error: null,
      checked: links.length,
      links: confirmed,
    });
  }

  return NextResponse.json({
    ok: true,
    // Note what this does NOT do: it never writes to Strapi. Detection and a suggestion are safe to
    // automate; editing published copy is not, and a one-click write-back from a tool nobody has
    // reviewed yet is how a bad suggestion becomes a live page.
    pages,
    totalBroken: pages.reduce((n, p) => n + p.links.length, 0),
  });
}
