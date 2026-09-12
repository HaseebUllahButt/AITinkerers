// The other half of the retired-URL sweep: actually fix the links.
//
// The sweep finds every place the site points at something decommissioned and groups it into a work
// list. Nothing acted on that list, so a run ended with a person opening Strapi and editing bodies by
// hand — 106 published posts reference imagine.art/dashboard, which is not a by-hand job.
//
// ── What this will and will not touch ───────────────────────────────────────────────────────────
//
// ONLY the `body` of blog entries in Strapi, because that is the only content SearchOps owns. The sweep's
// most useful output is `site_wide`, which means the reference lives in a shared React template in
// imagine-web — one code change, in another repo, via a PR. A content corrector cannot fix those, and
// the dangerous version of this module is the one that reports success after changing nothing. So a
// site-wide group is refused by name, with the reason.
//
// ── Why it is capped, and why the cap counts links rather than pages ────────────────────────────
//
// 100 links per run, by instruction, and the cap is enforced on OCCURRENCES: one post can carry the
// same retired URL nine times, so a page-based cap would quietly rewrite several hundred links while
// claiming a hundred. Partial by design — the report says exactly how many are left, and the next run
// picks them up.
//
// ── The rule that makes this safe to run at all ─────────────────────────────────────────────────
//
// These are PUBLISHED pages. Every edit is live the moment it is written, with no draft to review. So:
//
//   1. Dry run is the default. `apply` has to be asked for.
//   2. The destination is verified against `site_urls` — the real sitemap — BEFORE anything is written.
//      Replacing a dead link with a dead link is the one outcome worse than leaving it alone, and it is
//      exactly what a plausible-looking replacement path produces.
//   3. Whole URLs are replaced, never substrings. A literal replace of "imagine.art/dashboard" also
//      rewrites "imagine.art/dashboard/billing" into a path nobody chose.
//   4. publishedAt is never sent, so a live page stays live and a draft stays a draft.
import { supabaseAdmin } from "@/lib/db/supabase";
import { updateEntry, blogType } from "@/lib/strapi/client";
import { matchUrl, type SweepPattern } from "./patterns";

/** By instruction. Also the ceiling: a caller asking for more gets 100. */
export const MAX_LINKS_PER_RUN = 100;

export interface CorrectionEdit {
  entryId: number;
  slug: string;
  title: string;
  /** Every distinct retired URL in this entry, with how many times it appears. */
  urls: Array<{ from: string; to: string; count: number }>;
  /** Occurrences rewritten in this entry. */
  links: number;
  /** A short before/after around the first change, so a person can see the shape of the edit. */
  sample: { before: string; after: string } | null;
  /** Set when the write was attempted and failed. */
  error?: string;
}

export interface CorrectionPlan {
  from: string;
  to: string;
  /** Entries that would change, already capped. */
  edits: CorrectionEdit[];
  /** Links this run covers. */
  links: number;
  /** Links matching `from` that this run leaves for the next one. */
  remaining: number;
  /** Entries scanned. */
  scanned: number;
  /** Why the run refused, when it did. */
  refusal: string | null;
  warnings: string[];
}

export interface CorrectionResult extends CorrectionPlan {
  applied: boolean;
  /** Entries actually written. */
  written: number;
  failed: CorrectionEdit[];
}

function strapiConfig(): { url: string; token: string } | null {
  const url = process.env.STRAPI_URL?.trim().replace(/\/$/, "");
  const token = process.env.STRAPI_API_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

/**
 * Every URL-looking token in a body, with its exact text.
 *
 * Deliberately greedy about what counts as a URL and deliberately careful about where it stops:
 * markdown puts a closing paren right after the href, and HTML puts a quote there, so both terminate
 * the match. Trailing punctuation is trimmed because "see https://x.imagine.art/foo." is a sentence,
 * not a path ending in a full stop.
 */
export function urlsIn(body: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s)"'<>\]]+/gi;
  for (const m of body.matchAll(re)) {
    out.push(m[0].replace(/[.,;:!?]+$/, ""));
  }
  return out;
}

/** Is this replacement somewhere that actually exists? */
async function destinationLive(to: string): Promise<{ ok: boolean; why: string }> {
  let path: string;
  try {
    const u = new URL(to, "https://www.imagine.art");
    if (!/(^|\.)imagine\.art$/i.test(u.hostname)) {
      // An external destination cannot be checked against our sitemap. Allowed, but said out loud.
      return { ok: true, why: `${u.hostname} is external, so it was not checked against the sitemap.` };
    }
    path = u.pathname.replace(/\/$/, "") || "/";
  } catch {
    return { ok: false, why: `"${to}" is not a URL or a path.` };
  }
  if (path === "/") return { ok: true, why: "" };
  const { data, error } = await supabaseAdmin.from("site_urls").select("path").eq("path", path).maybeSingle();
  if (error) return { ok: true, why: `Could not reach site_urls to confirm ${path} is live.` };
  return data
    ? { ok: true, why: "" }
    : { ok: false, why: `${path} is not in site_urls, so it is not a live page. Replacing a retired link with a dead one is worse than leaving it.` };
}

/**
 * Work out the run, and optionally perform it.
 *
 * `from` is matched as a whole URL against the sweep's own pattern logic when it looks like a host or a
 * path prefix, so "shorts.imagine.art" catches every URL on that host rather than only the exact
 * string. That is the shape the sweep reports in, so it is the shape a caller has in hand.
 */
export async function correctRetiredLinks(input: {
  from: string;
  to: string;
  limit?: number;
  apply?: boolean;
  /** Refuse rather than write when the sweep called this reference site-wide. */
  siteWide?: boolean;
}): Promise<CorrectionResult> {
  const cap = Math.max(1, Math.min(input.limit ?? MAX_LINKS_PER_RUN, MAX_LINKS_PER_RUN));
  const base: CorrectionResult = {
    from: input.from, to: input.to, edits: [], links: 0, remaining: 0, scanned: 0,
    refusal: null, warnings: [], applied: false, written: 0, failed: [],
  };

  const cfg = strapiConfig();
  if (!cfg) return { ...base, refusal: "STRAPI_URL / STRAPI_API_TOKEN are not set." };
  const from = input.from.trim();
  const to = input.to.trim();
  if (!from) return { ...base, refusal: "No retired URL was given." };
  if (!to) return { ...base, refusal: "No replacement was given." };

  if (input.siteWide) {
    return {
      ...base,
      refusal:
        "The sweep marked this reference site-wide, which means it lives in a shared template in " +
        "imagine-web, not in page content. Editing blog bodies would change nothing and report success. " +
        "This one needs a PR against that repo.",
    };
  }

  const dest = await destinationLive(to);
  if (!dest.ok) return { ...base, refusal: dest.why };
  if (dest.why) base.warnings.push(dest.why);

  // The matcher. A bare host or path becomes a sweep pattern so whole-URL matching does the work; a
  // full URL is compared literally, which is what a caller pasting one link expects.
  const bare = from.replace(/^https?:\/\//, "");
  const looksLikeHost = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(bare);
  const looksLikePath = bare.startsWith("/");
  const pattern: SweepPattern | null =
    looksLikeHost ? { label: from, host: bare }
    : looksLikePath ? { label: from, pathPrefix: bare }
    : null;
  const hits = (url: string): boolean =>
    pattern ? matchUrl(url, [pattern]) !== null : url === from || url.replace(/\/$/, "") === from.replace(/\/$/, "");

  // One search, on the substring Strapi can filter by. The per-URL test above is what actually decides.
  // Keep the leading slash. Stripping it turned a search for "/dashboard" into a search for the word
  // "dashboard", which matched 269 entries instead of the 106 that carry the path.
  const needle = bare.split("?")[0];
  const q = new URLSearchParams({
    "filters[body][$contains]": needle,
    "fields[0]": "slug", "fields[1]": "title", "fields[2]": "body",
    "pagination[pageSize]": "100",
    publicationState: "preview",
  });
  const res = await fetch(`${cfg.url}/api/${blogType()}?${q}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) return { ...base, refusal: `Strapi answered ${res.status} to the search.` };
  const json = await res.json();
  const rows = (json?.data ?? []) as Array<{ id: number; attributes?: Record<string, unknown> }>;
  base.scanned = rows.length;
  const reportedTotal = Number(json?.meta?.pagination?.total ?? rows.length);
  if (reportedTotal > rows.length) {
    base.warnings.push(`${reportedTotal} entries match; this run read the first ${rows.length}.`);
  }

  // ── every replacement this run would write, checked against the sitemap ───
  //
  // The prefix check earlier is not enough, and assuming it was is how this module first behaved: a
  // path swap carries the tail over, so /dashboard/video/tool/imagine-shorts became
  // /ai-video-generator/video/tool/imagine-shorts — a URL nobody has ever served. Verifying the base
  // and then writing a constructed deep path is the same dead-link-for-dead-link trade the guard
  // exists to prevent, one level down.
  //
  // So every distinct destination is resolved first, in one query, and anything not live is skipped and
  // named. A retired deep path often has no 1:1 replacement at all, and that is a decision for a
  // person, not a string operation.
  const wanted = new Map<string, string>(); // retired url -> replacement
  for (const row of rows) {
    for (const u of urlsIn(String(row.attributes?.body ?? ""))) {
      if (hits(u) && !wanted.has(u)) wanted.set(u, replacementFor(u, from, to));
    }
  }
  const destPaths = new Set<string>();
  for (const r of wanted.values()) {
    try {
      const u = new URL(r);
      if (/(^|\.)imagine\.art$/i.test(u.hostname)) destPaths.add(u.pathname.replace(/\/$/, "") || "/");
    } catch { /* unparseable destinations are refused below */ }
  }
  const liveDest = new Set<string>(["/"]);
  if (destPaths.size) {
    const { data } = await supabaseAdmin.from("site_urls").select("path").in("path", [...destPaths]);
    for (const r of data ?? []) liveDest.add(r.path as string);
  }
  /** Would this replacement land on a real page? External destinations are trusted, as above. */
  const destOk = (replacement: string): boolean => {
    try {
      const u = new URL(replacement);
      if (!/(^|\.)imagine\.art$/i.test(u.hostname)) return true;
      return liveDest.has(u.pathname.replace(/\/$/, "") || "/");
    } catch { return false; }
  };
  const skipped = new Map<string, string>(); // retired url -> the dead replacement it would have got
  for (const [u, r] of wanted) if (!destOk(r)) skipped.set(u, r);
  if (skipped.size) {
    base.warnings.push(
      `${skipped.size} retired URL(s) were left alone because the replacement they would get is not a live page — `
      + `e.g. ${[...skipped.entries()].slice(0, 2).map(([u, r]) => `${u} -> ${r}`).join("; ")}. `
      + "These need a destination chosen by a person.",
    );
  }

  let budget = cap;
  let leftover = 0;

  for (const row of rows) {
    const body = String(row.attributes?.body ?? "");
    if (!body) continue;
    const slug = String(row.attributes?.slug ?? "");
    const title = String(row.attributes?.title ?? "");

    // Distinct retired URLs in this body, and how often each appears.
    const counts = new Map<string, number>();
    for (const u of urlsIn(body)) {
      if (!hits(u)) continue;
      if (skipped.has(u)) continue; // no live destination — left exactly as it is
      counts.set(u, (counts.get(u) ?? 0) + 1);
    }
    if (!counts.size) continue;

    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (budget <= 0) { leftover += total; continue; }

    // An entry is rewritten whole or not at all. Half-fixing one post leaves it in a state nobody
    // asked for and makes the next run's counts meaningless.
    if (total > budget) { leftover += total; continue; }

    let next = body;
    const urls: CorrectionEdit["urls"] = [];
    let sample: CorrectionEdit["sample"] = null;
    for (const [url, count] of counts) {
      const replacement = wanted.get(url) ?? replacementFor(url, from, to);
      if (sample === null) {
        const at = next.indexOf(url);
        if (at >= 0) {
          sample = {
            before: next.slice(Math.max(0, at - 40), at + url.length + 25),
            after: next.slice(Math.max(0, at - 40), at).concat(replacement, next.slice(at + url.length, at + url.length + 25)),
          };
        }
      }
      next = next.split(url).join(replacement);
      urls.push({ from: url, to: replacement, count });
    }
    if (next === body) continue;

    budget -= total;
    base.links += total;
    base.edits.push({ entryId: row.id, slug, title, urls, links: total, sample });
  }

  base.remaining = leftover;

  if (!input.apply) return base;

  // ── the writes ────────────────────────────────────────────────────────────
  base.applied = true;
  for (const edit of base.edits) {
    const row = rows.find((r) => r.id === edit.entryId);
    if (!row) { edit.error = "the entry vanished between the search and the write"; base.failed.push(edit); continue; }
    let next = String(row.attributes?.body ?? "");
    for (const u of edit.urls) next = next.split(u.from).join(u.to);
    try {
      // `body` only. Sending anything else — least of all publishedAt — would risk changing the state
      // of a live page while fixing a link on it.
      await updateEntry(blogType(), edit.entryId, { body: next });
      base.written += 1;
    } catch (e) {
      edit.error = e instanceof Error ? e.message : "the write failed";
      base.failed.push(edit);
    }
  }
  return base;
}

/**
 * What one retired URL becomes.
 *
 * When `from` is a path prefix the tail is carried over, so /dashboard/billing → /new/billing rather
 * than collapsing every deep link onto one page. When `from` is a host, only the host is swapped and
 * the path is kept — a retired subdomain almost always has the same paths on the canonical host, and
 * throwing the path away would turn 106 distinct links into 106 copies of the homepage.
 */
export function replacementFor(url: string, from: string, to: string): string {
  const bare = from.replace(/^https?:\/\//, "");
  try {
    const u = new URL(url);
    // host swap
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(bare)) {
      const dest = new URL(to.includes("://") ? to : `https://${to}`);
      // A replacement that names a specific page replaces the whole URL; one that names only a host
      // keeps the path.
      const destPath = dest.pathname.replace(/\/$/, "");
      return destPath ? dest.toString() : `${dest.origin}${u.pathname}${u.search}${u.hash}`;
    }
    // path-prefix swap
    if (bare.startsWith("/")) {
      const prefix = bare.replace(/\/$/, "");
      const tail = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : "";
      const dest = new URL(to.includes("://") ? to : `https://www.imagine.art${to.startsWith("/") ? to : `/${to}`}`);
      return `${dest.origin}${dest.pathname.replace(/\/$/, "")}${tail}${u.search}${u.hash}`;
    }
  } catch { /* fall through */ }
  return to;
}
