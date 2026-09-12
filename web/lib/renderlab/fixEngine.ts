// Propose link rewrites in bulk, then apply the ones a person picked.
//
// ── One engine, two jobs ────────────────────────────────────────────────────────────────────────
//
// "Every link whose target is dead" and "every link under /features/" are the same operation over the
// same walk — find link occurrences in Strapi content, decide a replacement, rewrite the exact bytes.
// Only the MATCHER differs. Written once so the two cannot drift into disagreeing about how a CTA fence
// is spliced or which occurrence gets replaced.
//
// ── The apply path re-reads before it writes, always ───────────────────────────────────────────
//
// A queued fix names a byte range in a field that a human may have edited since the scan. So applying
// re-fetches the record and requires the exact `raw` substring to still be present at the recorded
// occurrence — if it is not, the row goes `stale` and nothing is written. The alternative is replacing
// whatever happens to be at that offset now, which is how an automated fixer corrupts a page.
import { supabaseAdmin } from "@/lib/db/supabase";
import { checkLink, fetchSitemapUrls, type FingerprintMap } from "@/lib/linkaudit/run";
import {
  CONTENT_TYPES, extractLinks, resolvePage, toPath, type FoundLink,
} from "./strapiLinks";
import { fetchEntryBySlug, fetchEntryById, fetchRawEntryById, strapiGet, updateEntryFields, writesEnabled } from "./strapiEntry";
import { draftTargetsAmong } from "./draftLookup";

export type Job = "dead" | "prefix";

export interface PrefixRule {
  /** Path segment to move away from, without slashes — e.g. "features". */
  from: string;
  /** Path segment to move to — e.g. "tools". */
  to: string;
}

export interface Match {
  proposedUrl: string;
  reason: string;
  confidence: number | null;
}

// ── matchers ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Rewrite one URL's leading path segment, preserving everything else.
 *
 * Handles absolute and root-relative forms, and the bare `/features` index as well as `/features/x`,
 * because both appear in real content (measured: schema-markup breadcrumbs link the index). Query and
 * hash are preserved — a rewrite that silently drops `?utm_source=` changes what the link does.
 */
export function rewritePrefix(url: string, rule: PrefixRule): string | null {
  const from = rule.from.replace(/^\/|\/$/g, "");
  const to = rule.to.replace(/^\/|\/$/g, "");
  if (!from || !to || from === to) return null;
  const re = new RegExp(`^(https?://[^/]+)?(/${from})(/|$|\\?|#)`);
  const m = url.match(re);
  if (!m) return null;
  return url.replace(re, `${m[1] ?? ""}/${to}${m[3]}`);
}

function isInternal(url: string): boolean {
  return url.startsWith("/") || /^https?:\/\/(www\.)?imagine\.art/i.test(url);
}

/** Root-relative links appear in real content (and past applies WROTE them); checkLink and the
 *  draft probe both need an absolute URL, so internal paths get the canonical host. */
function absolutize(url: string): string {
  return url.startsWith("/") ? `https://www.imagine.art${url}` : url;
}

/**
 * Is this "replacement" the dead link wearing a different spelling? Exported for the E2E suite.
 *
 * A plain string compare missed it: 270 applies since Aug 25 "replaced" a dead absolute URL with
 * its own root-relative path — same dead page, recorded as fixed, confidence 1 because the stale
 * proposer had scored the URL against itself. Internal URLs compare by path; an external URL is
 * only itself when the strings match, since /x on another host is a different page.
 */
export function isSelfReplacement(currentUrl: string, proposedUrl: string): boolean {
  if (currentUrl === proposedUrl) return true;
  return isInternal(currentUrl) && isInternal(proposedUrl) && toPath(currentUrl) === toPath(proposedUrl);
}

/**
 * Refuse a replacement target that does not actually serve — returns the refusal message, or null
 * to proceed. Strapi is the authority, not an HTTP check: a draft's URL can keep serving 200 from
 * a stale ISR cache (measured: /blogs/scale-creative-production-with-ai, publishedAt NULL, live 200).
 *
 * Passes what it cannot verify rather than blocking it: external URLs are a human's explicit
 * choice; paths that don't resolve to a CMS type (or resolve via the single-segment catch-all but
 * have no record) are hardcoded Next routes with nothing to ask Strapi about.
 */
async function replacementRefusal(newUrl: string): Promise<string | null> {
  if (!isInternal(newUrl)) return null;
  const resolved = resolvePage(newUrl);
  if ("error" in resolved) return null;
  try {
    // Default publicationState is live — published entries only, which is the whole point.
    const json = await strapiGet(
      `/api/${resolved.pluralApi}?filters[${resolved.slugField}][$eq]=${encodeURIComponent(resolved.slugValue)}&fields[0]=${resolved.slugField}&pagination[pageSize]=1`,
    );
    if (Array.isArray(json.data) && json.data.length > 0) return null;
  } catch (e: unknown) {
    // Can't verify ≠ verified-dead, but writing an unverifiable target is how drafts got linked.
    return `Could not verify "${newUrl}" is published (${e instanceof Error ? e.message.slice(0, 120) : "Strapi error"}) — try again.`;
  }
  // The catch-all claims every single-segment path as a category-page; no record there usually
  // means a hardcoded route (/ai-image-generator), which serves fine without a CMS entry.
  if (resolved.contentType === "category-page") return null;
  return `"${newUrl}" has no published ${resolved.contentType} behind it — that would be another dead link. Pick a live target.`;
}

const STOP = new Set(["the", "a", "an", "of", "for", "to", "in", "and", "your", "best", "top", "free", "online", "ai", "with"]);
function tokens(s: string): string[] {
  return s.toLowerCase().split("?")[0].split(/[/\s\-_.]+/)
    .filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t));
}

/**
 * Closest most relevant LIVE page for a dead URL. Exported for the E2E suite and the autofix.
 *
 * Relevance = token overlap between the candidate's path and the dead link's path PLUS its
 * anchor text (the anchor often names the topic better than a versioned slug does — "Wan 2.5
 * overview" beats /blogs/wan-2-5-overview at finding /blogs/wan-2-2-overview's successor),
 * with a small same-section nudge (a dead /features page prefers a live /features page).
 * The dead URL itself is never a candidate — the Aug-31 queue audit found ~750 proposals that
 * were the dead link proposing itself, because the stale inventory still listed it.
 * Returns null rather than a least-bad guess.
 */
export function suggestReplacement(url: string, sitemap: Array<{ path: string }>, anchor?: string | null): { path: string; score: number } | null {
  const deadPath = toPath(url);
  const want = new Set([...tokens(deadPath), ...(anchor ? tokens(anchor) : [])]);
  if (want.size < 2) return null;
  const section = deadPath.split("/").filter(Boolean)[0] ?? "";
  let best: { path: string; score: number } | null = null;
  for (const s of sitemap) {
    const candPath = toPath(s.path);
    if (candPath === deadPath) continue; // never propose the dead URL itself
    const have = new Set(tokens(candPath));
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    let score = shared / (want.size + have.size - shared || 1);
    if (section && candPath.split("/").filter(Boolean)[0] === section) score += 0.1;
    score = Math.min(1, Math.round(score * 100) / 100);
    if (!best || score > best.score) best = { path: candPath, score };
  }
  return best && best.score >= 0.4 ? best : null;
}

/**
 * The candidate pool replacements come from: the LIVE sitemap, fetched fresh — never the
 * stored `site_urls` inventory alone. The inventory is upsert-never-delete, so after the
 * Aug-26 mass-unpublish it still listed ~750 draft blogs, and proposals happily pointed dead
 * links at other dead pages (measured: 12 of 15 sampled proposed targets were drafts).
 * The inventory is only a fallback for when the live sitemap itself is unreachable, and the
 * notes say so out loud.
 */
async function livePool(notes: string[]): Promise<Array<{ url: string; path: string }>> {
  try {
    const urls = await fetchSitemapUrls();
    // A near-empty result is a broken fetch wearing a 200, not a 50-page site.
    if (urls.length >= 50) return urls.map((u) => ({ url: u, path: toPath(u) }));
    notes.push(`Live sitemap returned only ${urls.length} URLs — using the stored inventory instead (may include delisted pages).`);
  } catch {
    notes.push("Live sitemap unreachable — using the stored inventory instead (may include delisted pages).");
  }
  const pool: Array<{ url: string; path: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("site_urls").select("url, path").range(from, from + 999);
    pool.push(...(data ?? []) as Array<{ url: string; path: string }>);
    if ((data ?? []).length < 1000) break;
  }
  return pool;
}

// ── the scan ──────────────────────────────────────────────────────────────────────────────────────

export interface ScanOptions {
  job: Job;
  prefix?: PrefixRule;
  /** How many pages to walk. Bounded because each is a throttled Strapi read. */
  batch?: number;
  budgetMs?: number;
  /** Re-walk pages already scanned for this job, oldest first, instead of only new ones. */
  refresh?: boolean;
  /**
   * Link-audit bridge: only queue fixes whose dead target is one of these URLs. The audit
   * already knows exactly which link is broken; without this the scan would re-walk and
   * re-judge everything to find the one target a person just clicked "queue fix" on.
   * Also unlocks external dead targets (proposed as empty → retarget-or-unlink), which the
   * default scan skips — an external 404 is not ours to redirect, but it IS ours to unlink.
   */
  urls?: string[];
  /**
   * Link-audit bridge: walk exactly these pages (the ones the audit saw the link on),
   * ignoring the already-scanned ledger. Deterministic — the button always scans the pages
   * it names, not whatever batch the ledger happens to serve next.
   */
  pages?: string[];
}

export interface ScanResult {
  job: Job;
  pagesScanned: number;
  linksSeen: number;
  queued: number;
  /** Something actually went wrong. */
  errors: number;
  /**
   * Resolved to a content type but no record exists — counted separately from errors, deliberately.
   *
   * The catch-all rule claims every single-segment path as a category-page, so /affiliate-program,
   * /image-studio and /social-media all resolve and then find nothing: they are hardcoded Next.js
   * routes, not CMS content. That is a correct outcome, and five of them in a ten-page scan reported as
   * "errors" made a working scan look half broken. They are still recorded so they are not re-walked.
   */
  noRecord: number;
  seconds: number;
  remaining: number;
  notes: string[];
}

export async function scanForFixes(opts: ScanOptions): Promise<ScanResult> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 240_000;
  const batch = opts.batch ?? 40;
  const notes: string[] = [];
  if (opts.job === "prefix" && !opts.prefix) throw new Error("A prefix job needs from/to.");

  // The live sitemap is both the candidate list and the pool replacement suggestions come from.
  const sitemap = await livePool(notes);

  const { data: done } = await supabaseAdmin
    .from("link_scan_pages").select("url, scanned_at").eq("job", opts.job)
    .order("scanned_at", { ascending: true }).limit(5000);
  const seen = new Set((done ?? []).map((r) => r.url as string));

  // Only pages that resolve to a CMS record can be rewritten; the rest have nothing behind them.
  const candidates = sitemap.filter((s) => !("error" in resolvePage(s.url)));
  // Bridge mode: the audit named the pages; walk exactly those, scanned-before or not — built
  // from the request, not filtered from the pool, so a page the live sitemap no longer lists
  // (the audit sees those too) can still be walked and fixed.
  const wantedPages = opts.pages?.length ? new Set(opts.pages.map(toPath)) : null;
  const fresh = candidates.filter((s) => !seen.has(s.url));
  const queue = wantedPages
    ? [...wantedPages].map((p) => ({ url: `https://www.imagine.art${p === "/" ? "" : p}`, path: p }))
    : opts.refresh
      ? [...fresh, ...(done ?? []).map((d) => candidates.find((c) => c.url === d.url)).filter((c): c is { url: string; path: string } => !!c)]
      : fresh;
  const work = queue.slice(0, batch);
  if (wantedPages && work.length === 0) notes.push("None of the requested pages resolve to a CMS record — nothing to rewrite there.");
  // Match by exact URL and by path, because the audit stores absolute URLs while Strapi
  // content links are often root-relative.
  const urlFilter = opts.urls?.length ? new Set(opts.urls.flatMap((u) => [u, toPath(u)])) : null;
  if (!candidates.length) notes.push("No sitemap URL resolved to a CMS content type.");

  let pagesScanned = 0, linksSeen = 0, queued = 0, errors = 0, noRecord = 0;
  const fingerprints: FingerprintMap = {};
  // Per-run cache: the same dead target appears on dozens of pages and checking it once is the
  // difference between a scan that finishes and one that re-requests the same 404 two hundred times.
  const verdicts = new Map<string, string>();
  // Per-run draft cache, same reason. true = the target's CMS entry exists with publishedAt NULL.
  // HTTP alone cannot make this call: a draft's URL keeps serving 200 from a stale ISR cache, so a
  // link that IS broken (the page will 404 on revalidation, and the sitemap has dropped it) looks
  // healthy to checkLink. Strapi is the authority on what is published.
  const draftVerdicts = new Map<string, boolean>();

  // Sequential on purpose. Every iteration is a throttled Strapi read, and concurrency here would
  // defeat the throttle that exists to keep the CMS up.
  for (const page of work) {
    if (Date.now() - started > budgetMs) break;
    const resolved = resolvePage(page.url);
    if ("error" in resolved) continue;

    try {
      const meta = CONTENT_TYPES[resolved.contentType];
      const fetched = await fetchEntryBySlug(meta, resolved.slugValue);
      if (!fetched) {
        // no_record, not error: the surface counts errors, and a clean 35-page scan was reporting
        // "12 unreadable" purely because these carried an error string.
        await recordPage(opts.job, page, resolved.contentType, null, 0, 0, null, true);
        noRecord++; pagesScanned++;
        continue;
      }
      const links = extractLinks(resolved.contentType, fetched.entry);
      linksSeen += links.length;

      // One batched draft probe per page for the internal targets not yet seen this run —
      // draftTargetsAmong groups fifty slugs per request, versus one Strapi call per link.
      if (opts.job === "dead") {
        const unknown = [...new Set(
          links.filter((l) => l.source !== "blog-resource" && isInternal(l.url))
            .map((l) => absolutize(l.url)).filter((u) => !draftVerdicts.has(u)),
        )];
        if (unknown.length) {
          try {
            const drafts = await draftTargetsAmong(unknown);
            for (const u of unknown) draftVerdicts.set(u, drafts.has(u));
          } catch { /* Strapi unreachable — targets stay unlabeled; the HTTP verdict still runs */ }
        }
      }

      let matches = 0;
      for (const link of links) {
        const match = await decide(link, opts, sitemap, fingerprints, verdicts, draftVerdicts, urlFilter);
        if (!match) continue;
        matches++;
        const ok = await queueFix(opts.job, page, resolved, fetched.id, meta.pluralApi, link, match);
        if (ok) queued++;
      }
      await recordPage(opts.job, page, resolved.contentType, fetched.id, links.length, matches, null);
      pagesScanned++;
    } catch (e: unknown) {
      errors++; pagesScanned++;
      await recordPage(opts.job, page, resolved.contentType, null, 0, 0, e instanceof Error ? e.message : "scan failed");
    }
  }

  if (noRecord) {
    notes.push(`${noRecord} path(s) resolved but have no CMS record behind them — hardcoded routes, not content.`);
  }
  return {
    job: opts.job, pagesScanned, linksSeen, queued, errors, noRecord,
    seconds: Math.round((Date.now() - started) / 1000),
    remaining: Math.max(0, fresh.length - pagesScanned),
    notes,
  };
}

async function decide(
  link: FoundLink,
  opts: ScanOptions,
  sitemap: Array<{ path: string }>,
  fingerprints: FingerprintMap,
  verdicts: Map<string, string>,
  draftVerdicts: Map<string, boolean>,
  urlFilter: Set<string> | null = null,
): Promise<Match | null> {
  // Bridge mode: the caller named specific dead targets; everything else is out of scope.
  if (urlFilter && !urlFilter.has(link.url) && !urlFilter.has(toPath(link.url))) return null;
  if (opts.job === "prefix") {
    const next = rewritePrefix(link.url, opts.prefix!);
    if (!next) return null;
    // Not a guess — a mechanical segment swap, so no confidence score to report.
    return { proposedUrl: next, reason: `prefix rename /${opts.prefix!.from} → /${opts.prefix!.to}`, confidence: null };
  }

  // ── A blog-resource card is broken when its blog is not published ─────────────────────────────
  //
  // Decided from the relation, not from an HTTP request. `publishedAt IS NULL` is the cause; a 404 on
  // the slug would merely be the symptom, and on a draft blog the URL often still resolves for a
  // logged-in preview, so the HTTP check would call a broken card healthy.
  if (link.source === "blog-resource") {
    if (link.relation && link.relation.published) return null;
    return {
      // Deliberately empty. There is no sensible automatic replacement for an editorial card, and the
      // instruction was explicit: a person either attaches a new URL or removes it.
      proposedUrl: "",
      reason: link.relation
        ? (link.relation.published ? "ok" : "blog is unpublished")
        : "no blog attached",
      confidence: null,
    };
  }

  // dead: internal links only — unless bridge mode named this external target explicitly.
  // An external 404 is somebody else's page and not ours to redirect, but when the audit
  // flagged it, unlinking or retargeting it IS ours to do.
  if (!isInternal(link.url) && !urlFilter) return null;
  // Absolutized before checking: `new URL("/blogs/x")` throws inside checkLink, so a
  // root-relative link — the exact form past applies wrote — came back "unreach" and was
  // silently skipped forever. Same cache key for both spellings of the same target.
  const target = absolutize(link.url);
  // The draft probe outranks HTTP: publishedAt NULL is broken even while a stale cache serves 200.
  let verdict = draftVerdicts.get(target) ? "draft target" : verdicts.get(target);
  if (!verdict) {
    const r = await checkLink(target, fingerprints);
    verdict = r.verdict;
    verdicts.set(target, verdict);
  }
  if (verdict === "ok" || verdict === "unreach") return null; // unreach is inconclusive, not dead
  if (!isInternal(link.url)) {
    // Same shape as a broken blog-resource card: no automatic replacement makes sense for
    // someone else's dead page — a person attaches a new URL or removes the link.
    return { proposedUrl: "", reason: `dead external link (${verdict}) — pick a replacement or remove`, confidence: null };
  }
  const s = suggestReplacement(link.url, sitemap, link.text);
  return {
    proposedUrl: s ? s.path : "",
    reason: verdict,
    confidence: s?.score ?? null,
  };
}

async function recordPage(
  job: Job, page: { url: string; path: string }, contentType: string | null,
  entryId: number | null, links: number, matches: number, error: string | null,
  noRecord = false,
): Promise<void> {
  await supabaseAdmin.from("link_scan_pages").upsert({
    url: page.url, job, path: page.path, content_type: contentType, entry_id: entryId,
    links_found: links, matches, error, no_record: noRecord, scanned_at: new Date().toISOString(),
  }, { onConflict: "url,job" }).then(() => {}, () => {});
}

async function queueFix(
  job: Job,
  page: { url: string; path: string },
  resolved: { path: string; contentType: string },
  entryId: number,
  pluralApi: string,
  link: FoundLink,
  match: Match,
): Promise<boolean> {
  // The owner redirect: a link behind a relation is owned by that other record, and the field path is
  // relative to IT. Writing the page's own path onto the related record would target a field that does
  // not exist there.
  const targetApi = link.owner?.pluralApi ?? pluralApi;
  const targetId = link.owner?.entryId ?? entryId;
  const fieldPath = (link.owner ? link.ownerFieldPath : link.fieldPath) ?? link.fieldPath;

  const { error } = await supabaseAdmin.from("link_fixes").upsert({
    job, page_url: page.url, page_path: resolved.path, content_type: resolved.contentType,
    plural_api: targetApi, entry_id: targetId, field_path: fieldPath.join("."),
    source: link.source, body_format: link.bodyFormat ?? null,
    // -1 rather than null: both are part of the unique key, which has to be plain columns.
    occurrence: link.bodyOccurrenceIndex ?? -1, array_index: link.arrayIndex ?? -1,
    raw: link.raw ?? null, section: link.section ?? null, anchor: link.text ?? null,
    relation_id: link.relation?.id ?? null,
    relation_published: link.relation ? link.relation.published : null,
    item_id: link.itemId ?? null,
    url: link.url, proposed_url: match.proposedUrl || null,
    reason: match.reason, confidence: match.confidence,
    status: "pending",
  }, {
    onConflict: "plural_api,entry_id,field_path,occurrence,array_index,url,job",
    ignoreDuplicates: false,
  });
  return !error;
}

// ── apply ─────────────────────────────────────────────────────────────────────────────────────────

function setAtPath(root: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = (cursor as Record<string, unknown>)[path[i]];
    if (cursor === null || cursor === undefined) {
      throw new Error(`Field path ${path.join(".")} no longer exists on this record.`);
    }
  }
  (cursor as Record<string, unknown>)[path[path.length - 1]] = value;
}

function getAtPath(root: Record<string, unknown>, path: string[]): unknown {
  return path.reduce<unknown>((acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]), root);
}

/** Replace the Nth occurrence, not the first. The whole reason `occurrence` is stored. */
function replaceNth(haystack: string, needle: string, n: number, replacement: string): string {
  let from = 0, seen = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) {
      throw new Error(`Occurrence #${n} of this link is no longer in the field — the content changed since the scan. Re-scan and try again.`);
    }
    if (seen === n) return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
    seen++;
    from = i + needle.length;
  }
}

const CTA_URL = /"url"\s*:\s*"([^"]*)"/g;

/** Swap only the Nth "url" inside a ```CTA fence, leaving the rest of the JSON byte-identical. */
function replaceCtaUrl(fence: string, index: number, newUrl: string): string {
  let seen = 0, done = false;
  const out = fence.replace(CTA_URL, (full, old: string) => {
    if (seen++ !== index) return full;
    done = true;
    return `${full.slice(0, full.length - old.length - 1)}${newUrl}"`;
  });
  if (!done) throw new Error(`Button #${index + 1}'s url is no longer in this CTA block. Re-scan and try again.`);
  return out;
}

/**
 * Remove one BUTTON from a ```CTA fence — the whole `{text, url}` object, never just its url,
 * because a button with an empty url still renders and goes nowhere. A fence left with zero
 * buttons is no fence at all: the caller substitutes an empty string and the block disappears
 * from the body. Exported for the E2E suite.
 */
export function removeCtaButton(fence: string, index: number): string {
  const m = /^(```[ \t]*CTA[ \t]*\r?\n)([\s\S]*?)(```)\s*$/i.exec(fence);
  if (!m) throw new Error("This CTA block no longer parses. Re-scan and try again.");
  let parsed: unknown;
  try { parsed = JSON.parse(m[2].trim()); } catch {
    throw new Error("This CTA block's JSON no longer parses. Re-scan and try again.");
  }
  if (!Array.isArray(parsed)) return ""; // a single-button fence minus its button is no fence
  if (index < 0 || index >= parsed.length) {
    throw new Error(`Button #${index + 1} is no longer in this CTA block. Re-scan and try again.`);
  }
  parsed.splice(index, 1);
  if (parsed.length === 0) return "";
  return `${m[1]}${JSON.stringify(parsed, null, 2)}\n${m[3]}`;
}

export interface FixRow {
  id: string; job: Job; plural_api: string; entry_id: number; field_path: string;
  source: "cta" | "body" | "blog-resource"; body_format: string | null; occurrence: number;
  array_index: number; raw: string | null; url: string; proposed_url: string | null;
  content_type: string; page_path: string; anchor: string | null;
  /** "replace" swaps the target. "remove" drops the link and keeps the anchor text. */
  action: "replace" | "remove";
  /** blog-resource only. */
  relation_id: number | null;
  item_id: number | null;
}

export interface ApplyOutcome { id: string; ok: boolean; message: string }

/**
 * Apply one queued fix.
 *
 * Refuses rather than guesses at every point where reality has moved: a missing field, a changed
 * value, an occurrence that is no longer there. Those all mean somebody edited the page since the scan,
 * and the correct response is to say so, not to write.
 */
export async function applyFix(row: FixRow, actor: string): Promise<ApplyOutcome> {
  if (!writesEnabled()) return { id: row.id, ok: false, message: "Writes are disabled (RENDER_LAB_WRITES=1)." };
  const remove = row.action === "remove";
  const newUrl = (row.proposed_url ?? "").trim();
  if (!remove) {
    if (!newUrl) return { id: row.id, ok: false, message: "No replacement URL set for this row." };
    if (isSelfReplacement(row.url, newUrl)) {
      return { id: row.id, ok: false, message: "The replacement is the dead link itself (only the spelling differs) — that fixes nothing. Pick a different target." };
    }
  }

  // A blog-resource card is a relation inside a repeatable component, not a string in a field, so it
  // takes a completely different write. Handled before the text paths below — the card path proves
  // its target published via findBlogIdBySlug, so the check below would be a second Strapi round-trip.
  if (row.source === "blog-resource") return applyBlogResourceFix(row, actor, remove, newUrl);

  // Verified BEFORE the write, and a refusal leaves the row pending (no status change) — the row is
  // fine, its proposal is not, and a person retargets it. Skipped for removals: nothing to point at.
  if (!remove) {
    const refusal = await replacementRefusal(newUrl);
    if (refusal) return { id: row.id, ok: false, message: refusal };
  }

  // ── Removing a button means removing the BUTTON, never emptying its url ───────────────────────
  //
  // A CTA field IS the url, so blanking it would leave a button on the live page that goes
  // nowhere — worse than one that goes somewhere dead. "Remove" on a CTA therefore takes the
  // whole button out: the `{text, url}` object spliced from a fence, the component nulled (or
  // spliced from its list) for a structured field. Both handled in their branches below.

  const path = row.field_path.split(".");
  try {
    const meta = CONTENT_TYPES[row.content_type];
    // A relation-owned row's plural_api is not one of the page-level types, so it is fetched raw.
    const fresh = meta && meta.pluralApi === row.plural_api
      ? await fetchEntryById(row.plural_api, meta.apiUid, row.entry_id)
      : await fetchRawEntryById(row.plural_api, row.entry_id);
    if (!fresh) throw new Error("The record could not be read back.");

    const top = path[0];
    if (fresh[top] === undefined) throw new Error(`Field "${top}" no longer exists on this record.`);

    // Mutate inside a wrapper and read the result back out of it. structuredClone of a top-level
    // SCALAR (field_path === ["href"]) yields a primitive, and mutating a throwaway object would lose
    // the change, because a primitive is not aliased the way a nested object is.
    const wrapper: Record<string, unknown> = { [top]: structuredClone(fresh[top]) };
    const existing = getAtPath(wrapper, path);

    let oldValue: string;
    if (row.source === "body") {
      if (typeof existing !== "string") throw new Error(`Field "${row.field_path}" is no longer text.`);
      if (row.raw === null || row.occurrence < 0) throw new Error("Missing body-link metadata; re-scan.");
      oldValue = row.raw;
      const replacement = remove
        // Remove per format: a fence loses the whole button (or the whole block, if it was the
        // last one); a markdown link keeps its anchor text, unwrapped; a bare autolink has no
        // separate text — the URL itself is what the sentence said — so it just goes.
        ? (row.body_format === "cta-fence" ? removeCtaButton(row.raw, Math.max(0, row.array_index))
          : row.body_format === "markdown-link" ? (row.anchor ?? "")
          : "")
        : row.body_format === "cta-fence" ? replaceCtaUrl(row.raw, Math.max(0, row.array_index), newUrl)
        : row.body_format === "markdown-link" ? `[${row.anchor ?? ""}](${newUrl})`
        : newUrl;
      setAtPath(wrapper, path, replaceNth(existing, row.raw, row.occurrence, replacement));
    } else {
      if (existing !== row.url) {
        throw new Error("This link's value has changed since the scan — re-scan and try again.");
      }
      oldValue = String(existing);
      if (remove) {
        // Take out the button component that OWNS this url, not the url alone. Inside a
        // repeatable list the item is spliced (the list stays dense); a standalone component
        // is nulled. A url with no component around it has nothing to remove — replace it.
        if (path.length < 2) throw new Error("This url is a top-level field with no button component around it — replace it with a working URL instead.");
        const parentPath = path.slice(0, -1);
        const last = parentPath[parentPath.length - 1];
        if (/^\d+$/.test(last)) {
          const list = getAtPath(wrapper, parentPath.slice(0, -1));
          if (!Array.isArray(list)) throw new Error("The button list has changed shape since the scan — re-scan and try again.");
          list.splice(Number(last), 1);
        } else {
          setAtPath(wrapper, parentPath, null);
        }
      } else {
        setAtPath(wrapper, path, newUrl);
      }
    }

    await updateEntryFields(row.plural_api, row.entry_id, { [top]: wrapper[top] });

    const isButton = row.source === "cta" || row.body_format === "cta-fence";
    await supabaseAdmin.from("link_fixes").update({
      status: "applied", old_value: oldValue,
      new_value: remove
        ? (isButton ? `(button removed${row.anchor ? `: "${row.anchor}"` : ""})` : `(link removed, text kept: "${row.anchor ?? ""}")`)
        : newUrl,
      applied_at: new Date().toISOString(), applied_by: actor, error: null,
    }).eq("id", row.id);
    return { id: row.id, ok: true, message: remove ? (isButton ? "Button removed." : "Link removed, text kept.") : "Applied." };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "apply failed";
    // "changed since the scan" is not a failure of the tool, it is the tool declining to overwrite
    // somebody's edit. Recorded as stale so a re-scan picks it up cleanly rather than as a red error.
    const stale = /changed since|no longer|re-scan/i.test(msg);
    await supabaseAdmin.from("link_fixes")
      .update({ status: stale ? "stale" : "failed", error: msg }).eq("id", row.id);
    return { id: row.id, ok: false, message: msg };
  }
}

/**
 * Repoint or remove one blogResourceItems card.
 *
 * ── The rule the probes taught, and it is not optional ──────────────────────────────────────────
 *
 * A removed item's component row is DELETED. Re-sending that id in a later write fails with
 * "Some of the provided components in blogResourceItems are not related to the entity". The surviving
 * siblings, by contrast, still exist and MUST keep their ids — send them without and Strapi recreates
 * them, losing their order. So: keep ids for what stays, omit the removed one entirely, and never
 * reuse an id that has already gone.
 *
 * Learned the hard way: an earlier probe emptied the array and then tried to restore it using the old
 * ids, which failed for exactly this reason and left a page with no cards until it was rebuilt with
 * fresh ones.
 *
 * ── Why the whole dynamic zone is re-sent ───────────────────────────────────────────────────────
 *
 * `template` is a dynamic zone. Strapi replaces it wholesale on write, so a PUT carrying only the one
 * component would delete every other section on the page. The zone is read, one item is changed, and
 * the whole thing goes back.
 */
async function applyBlogResourceFix(
  row: FixRow, actor: string, remove: boolean, newUrl: string,
): Promise<ApplyOutcome> {
  const path = row.field_path.split(".");
  // template.<i>.blogResources.blogResourceItems.<n>
  const itemIndex = Number(path[path.length - 1]);
  if (!Number.isInteger(itemIndex)) {
    return { id: row.id, ok: false, message: `Field path does not end in an item index: ${row.field_path}` };
  }
  const containerPath = path.slice(0, -1);

  try {
    const meta = CONTENT_TYPES[row.content_type];
    if (!meta) throw new Error(`Unknown content type ${row.content_type}.`);

    // Resolve the replacement to a blog ENTRY. A card points at a record, not a slug, so a URL that
    // does not resolve to one is not a usable replacement.
    let newBlogId: number | null = null;
    if (!remove) {
      const slug = toPath(newUrl).replace(/^\/blogs\//, "").replace(/^\/+|\/+$/g, "");
      if (!slug || toPath(newUrl).indexOf("/blogs/") !== 0) {
        throw new Error(`"${newUrl}" is not a /blogs/<slug> URL. A resource card can only point at a blog.`);
      }
      // Resolved against STRAPI, not against SearchOps's own blog_drafts.strapi_id.
      //
      // The first version preferred blog_drafts as a cheap shortcut and it produced a 400:
      // "1 relation(s) of type api::imagine-web.imagine-web associated with this entity do not exist".
      // That column is SearchOps's record of a sync that happened once; the entry can since have been
      // deleted or replaced, and a stale id is indistinguishable from a good one until Strapi rejects
      // it. Strapi is the only authority on which entries exist, so ask it.
      newBlogId = await findBlogIdBySlug(slug);
      if (!newBlogId) throw new Error(`No published blog entry in Strapi with slug "${slug}".`);
    }

    const fresh = await fetchEntryById(row.plural_api, meta.apiUid, row.entry_id);
    if (!fresh) throw new Error("The page could not be read back.");

    const zone = fresh[containerPath[0]];
    if (!Array.isArray(zone)) throw new Error(`"${containerPath[0]}" is not a dynamic zone on this page.`);

    const wrapper: Record<string, unknown> = { [containerPath[0]]: structuredClone(zone) };
    const items = getAtPath(wrapper, containerPath);
    if (!Array.isArray(items)) throw new Error(`No blogResourceItems at ${containerPath.join(".")}.`);
    const current = items[itemIndex] as { id?: number; blog?: { id?: number } | number | null } | undefined;
    if (!current) throw new Error(`Item #${itemIndex} is no longer there — re-scan and try again.`);

    // Drift check: the card must still point where the scan said it did. `?? null` matters:
    // a caller that never selected relation_id hands us undefined, which slips past a plain
    // !== null check and turns EVERY apply into a phantom "changed since the scan" refusal
    // (that exact bug shipped — the route's select was missing the column).
    const recordedBlogId = row.relation_id ?? null;
    const currentBlogId = typeof current.blog === "number" ? current.blog : current.blog?.id ?? null;
    if (recordedBlogId !== null && currentBlogId !== null && currentBlogId !== recordedBlogId) {
      throw new Error(`This card now points at blog ${currentBlogId}, not ${recordedBlogId} — somebody changed it since the scan. Re-scan and try again.`);
    }

    // Rebuild the item list: surviving siblings keep their ids, the target is repointed or dropped.
    const rebuilt = (items as Array<{ id?: number; blog?: { id?: number } | number | null }>)
      .map((it, i) => {
        const bid = typeof it.blog === "number" ? it.blog : it.blog?.id ?? null;
        if (i !== itemIndex) return { ...(it.id ? { id: it.id } : {}), blog: bid };
        return remove ? null : { ...(it.id ? { id: it.id } : {}), blog: newBlogId };
      })
      .filter((x): x is { id?: number; blog: number | null } => x !== null);

    setAtPath(wrapper, containerPath, rebuilt);
    await updateEntryFields(row.plural_api, row.entry_id, { [containerPath[0]]: wrapper[containerPath[0]] });

    const oldValue = `blog ${row.relation_id ?? "?"} (${row.url || "no slug"})`;
    await supabaseAdmin.from("link_fixes").update({
      status: "applied", old_value: oldValue,
      new_value: remove ? `(card removed; ${rebuilt.length} card(s) left in the section)` : `blog ${newBlogId} (${newUrl})`,
      applied_at: new Date().toISOString(), applied_by: actor, error: null,
    }).eq("id", row.id);

    return {
      id: row.id, ok: true,
      message: remove
        ? `Card removed. ${rebuilt.length} card(s) still in that section.`
        : `Card repointed to blog ${newBlogId}; its own title and asset will render.`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "apply failed";
    const stale = /re-scan|no longer|changed it since/i.test(msg);
    await supabaseAdmin.from("link_fixes").update({ status: stale ? "stale" : "failed", error: msg }).eq("id", row.id);
    return { id: row.id, ok: false, message: msg };
  }
}

/**
 * Look a blog entry up by slug straight from Strapi — PUBLISHED entries only.
 *
 * Not fetchEntryBySlug: that fetcher queries `publicationState=preview` (the scan needs to read
 * entries behind delisted pages), which resolves drafts too — so the "No published blog entry"
 * refusal below it never actually refused a draft. Default publicationState is live, and a light
 * fields-only query skips the two-pass populate a mere existence check has no use for.
 */
async function findBlogIdBySlug(slug: string): Promise<number | null> {
  const meta = CONTENT_TYPES["imagine-web"];
  const json = await strapiGet(
    `/api/${meta.pluralApi}?filters[${meta.slugField}][$eq]=${encodeURIComponent(slug)}&fields[0]=${meta.slugField}&pagination[pageSize]=1`,
  ).catch(() => null);
  const row = (json?.data as Array<{ id?: unknown }> | undefined)?.[0];
  return typeof row?.id === "number" ? row.id : null;
}

// ── autofix: the directed section-wide repair ──────────────────────────────────────────────────────

export interface AutoFixResult {
  section: string;
  considered: number;
  applied: number;
  failed: number;
  /** No live candidate scored above the bar — left pending for a human. */
  skippedNoMatch: number;
  /** External dead targets — not ours to repoint automatically. */
  skippedExternal: number;
  /** Budget ran out with rows left; run it again. */
  remaining: number;
  notes: string[];
  samples: Array<{ page: string; dead: string; to: string; score: number }>;
}

/**
 * Auto-fix a section's dead links, when directed (team ask, Aug 31: "/features — find the
 * closest most relevant live link and replace it").
 *
 * One click does, for every pending replace-row on pages under /<section>: re-propose against
 * the LIVE sitemap (never the stale inventory — the whole reason the old queue proposed drafts),
 * and apply the proposal when its relevance clears the bar. Everything below the bar stays
 * pending for a person — auto means "confident matches only", not "something for everything".
 * Rows a person marked "remove" keep that intent; external dead links stay a human call.
 */
export async function autoFixSection(
  section: string,
  actor: string,
  opts: { minScore?: number; budgetMs?: number } = {},
): Promise<AutoFixResult> {
  const minScore = opts.minScore ?? 0.5;
  const budgetMs = opts.budgetMs ?? 240_000;
  const started = Date.now();
  const seg = section.replace(/^\/+|\/+$/g, "");
  if (!seg || /[^a-z0-9-]/i.test(seg)) throw new Error("autofix needs a plain section segment, e.g. features");
  if (!writesEnabled()) throw new Error("Writes are disabled (RENDER_LAB_WRITES=1).");

  const notes: string[] = [];
  const pool = await livePool(notes);
  // A resource card can only point at a blog, so a card's search space IS the live blogs. Filtering
  // the global best afterwards was strictly worse: /blogs/gpt-4o-image-generation-capabilities lost
  // its usable blog match because /features/gpt-4o-image-generation outscored it and was then
  // discarded — the card got nothing instead of the best blog.
  const blogPool = pool.filter((p) => p.path.startsWith("/blogs/"));
  const livePaths = new Set(pool.map((p) => p.path));
  const { data: rows, error } = await supabaseAdmin
    .from("link_fixes")
    .select("id, job, plural_api, entry_id, field_path, source, body_format, occurrence, array_index, raw, url, proposed_url, content_type, page_path, anchor, action, relation_id, item_id")
    .eq("job", "dead").eq("status", "pending").eq("action", "replace")
    // The section's own index page counts as part of the section — breadcrumbs link it.
    .or(`page_path.eq./${seg},page_path.like./${seg}/%`)
    .order("page_path").limit(1000);
  if (error) throw new Error(error.message);

  const out: AutoFixResult = {
    section: `/${seg}`, considered: (rows ?? []).length,
    applied: 0, failed: 0, skippedNoMatch: 0, skippedExternal: 0, remaining: 0,
    notes, samples: [],
  };

  // Sequential on purpose — every apply is a throttled Strapi read+write.
  for (const raw of (rows ?? []) as unknown as FixRow[]) {
    if (Date.now() - started > budgetMs) { out.remaining++; continue; }
    if (!isInternal(raw.url)) { out.skippedExternal++; continue; }
    const s = suggestReplacement(raw.url, raw.source === "blog-resource" ? blogPool : pool, raw.anchor);
    if (!s || s.score < minScore) {
      out.skippedNoMatch++;
      // Queue hygiene for the row left pending: a stored proposal that is the dead URL itself or a
      // page the live sitemap doesn't list (both pre-live-pool leftovers — 1,123 and 44 measured
      // today) reads as a confident match in the UI and gets hand-applied. Replace it with the
      // fresh below-bar suggestion, or nothing. A proposal that IS live stays — that's a human's
      // retarget, not poison.
      const poisoned = raw.proposed_url
        && (isSelfReplacement(raw.url, raw.proposed_url) || !livePaths.has(toPath(raw.proposed_url)));
      if (poisoned) {
        await supabaseAdmin.from("link_fixes")
          .update({ proposed_url: s?.path ?? null, confidence: s?.score ?? null }).eq("id", raw.id);
      }
      continue;
    }
    // Persist the fresh live-pool proposal first, so the row's history shows what the autofix
    // decided even when the apply then refuses (stale content, unpublished target, …).
    await supabaseAdmin.from("link_fixes")
      .update({ proposed_url: s.path, confidence: s.score }).eq("id", raw.id);
    const res = await applyFix({ ...raw, proposed_url: s.path }, actor);
    if (res.ok) {
      out.applied++;
      if (out.samples.length < 10) out.samples.push({ page: raw.page_path, dead: raw.url, to: s.path, score: s.score });
    } else {
      out.failed++;
    }
  }
  if (out.remaining > 0) notes.push(`Time budget reached — ${out.remaining} row(s) untouched; run Auto-fix again to continue.`);
  return out;
}
