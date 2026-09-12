// The writer's QA gates, applied to a draft Summer wrote.
//
// ── Why this is advice and not a gate ───────────────────────────────────────────────────────────
//
// /blog/writer runs validateArticle as a GATE: the run stops, repairs, and re-validates, and a
// link_provenance violation fails the whole thing. That works there because the session owns an
// approved outline and a research ledger — it knows which sources the article was allowed to cite.
//
// Summer owns neither. It writes drafts directly, in parts, across turns. Blocking it on the same
// checks would either stop a piece mid-flight or force a rewrite loop against constraints that were
// never agreed, and the 30 gates are mostly craft rules anyway — the kind of thing a good writer
// applies while writing rather than discovers at the end. So the rules go in the PROMPT (see the
// "Writing content that ranks" section in hermes/prompt.ts) and this exists to catch what slipped.
//
// Nothing here rewrites anything or refuses anything. It reports.
//
// ── The checks that are deliberately NOT run ────────────────────────────────────────────────────
//
// Four gates need session state Summer does not have, and running them anyway would produce
// confident nonsense:
//
//   link_provenance      compares every URL against the research ledger. With no ledger the allowlist
//                        is empty, so EVERY link — including correct ones — reads as fabricated. In
//                        the writer this is the harshest verdict there is, never auto-retried, always
//                        needs a human. Firing it on every Summer draft would train people to ignore
//                        the one gate that catches an invented citation.
//   invented_question    needs the People Also Ask / Search Console questions actually retrieved.
//   missing_sources      counts prose links against an APPROVED PLAN's source count.
//   missing_internal_links  same, for internal links.
//
// They are named in the result rather than silently dropped, because "we did not check that" and
// "that passed" are different statements and only one of them is true.

import type { Violation } from "@/lib/writer/validate";
import type { BlogDraft } from "@/lib/db/queries";

/** Gates whose inputs only a writer session has. See the module note. */
const NEEDS_WRITER_SESSION = new Set([
  "link_provenance",
  "invented_question",
  "missing_sources",
  "missing_internal_links",
]);

export interface DraftQualityReport {
  verdict: "clean" | "advisory" | "needs_work";
  /** Counts by severity, so a caller can see at a glance whether anything matters. */
  counts: { auto_fix: number; repair: number; flag: number };
  findings: Array<{ gate: string; severity: string; detail: string }>;
  /** Applied to the body text automatically — typography only, and only if the caller saves it. */
  typography_fixed: string[];
  /** The body with typographic fixes applied. Identical to the input when nothing needed fixing. */
  fixed_body: string | null;
  not_checked: string[];
  keyword: string | null;
  words: number;
}

/**
 * Run the prose gates over a draft's body.
 *
 * `voiceSlug` picks the banned-words/phrases list — those live on the voice, not in the validator,
 * so a draft written in one voice is not judged against another's vocabulary. Falls back to the
 * default voice, which is what Summer uses when nobody chose one.
 */
export async function checkDraftQuality(input: {
  draft: Pick<BlogDraft, "id" | "title" | "body" | "seo_keywords" | "description">;
  voiceSlug?: string | null;
}): Promise<DraftQualityReport> {
  const { validateArticle } = await import("@/lib/writer/validate");
  const { listWriterVoices, getWriterVoiceBySlug } = await import("@/lib/db/queries");
  const { voiceSitemap } = await import("@/lib/writer/voice");
  const { internalLinkUniverse } = await import("@/lib/sitemap/store");
  const { SOCIAL_URLS } = await import("@/lib/blog/socials");

  const body = String(input.draft.body ?? "");
  // The primary keyword is the FIRST of seo_keywords by convention (see update_draft's description),
  // and the keyword gates are worth nothing measured against the wrong phrase.
  const keyword = String(input.draft.seo_keywords ?? "").split(",")[0]?.trim() || null;

  const voice = input.voiceSlug
    ? await getWriterVoiceBySlug(input.voiceSlug).catch(() => null)
    : null;
  const resolved = voice ?? (await listWriterVoices().catch(() => [])).find((v) => v.is_default) ?? null;

  // Internal links still get checked for REACHABILITY even though provenance is off: the sitemap
  // inventory is a fact about our own site, not session state, so it is available here.
  const sitemapUrls = new Set<string>([
    ...(resolved ? voiceSitemap(resolved).map((l) => l.url) : []),
    ...(await internalLinkUniverse().catch(() => new Set<string>())),
    // Same reason as finalize.ts: our own accounts are known-good URLs no sitemap contains.
    ...SOCIAL_URLS,
  ]);

  const result = validateArticle({
    body,
    // A voice is required by the type. Without one the banned-terms gate simply finds nothing, which
    // is the correct degradation — it is the only gate that reads the voice.
    voice: (resolved ?? { banned_words: [], banned_phrases: [], sitemap_links: [] }) as never,
    outline: null,
    brief: { primary_keyword: keyword ?? undefined },
    // Empty on purpose. Every gate that consumes these is filtered out below.
    ledgerUrls: new Set<string>(),
    sitemapUrls,
  });

  const findings = result.violations
    .filter((v: Violation) => !NEEDS_WRITER_SESSION.has(v.gate))
    .map((v: Violation) => ({ gate: v.gate, severity: v.severity, detail: v.detail }));

  const counts = { auto_fix: 0, repair: 0, flag: 0 };
  for (const f of findings) {
    if (f.severity === "auto_fix" || f.severity === "repair" || f.severity === "flag") counts[f.severity]++;
  }
  const typography = findings.filter((f) => f.severity === "auto_fix").map((f) => f.gate);

  return {
    // "needs_work" only for `repair` — a `flag` is a judgement call a person may disagree with, and
    // treating those as failures is how a check stops being read.
    verdict: counts.repair > 0 ? "needs_work" : findings.length ? "advisory" : "clean",
    counts,
    findings,
    typography_fixed: typography,
    fixed_body: result.fixed !== body ? result.fixed : null,
    not_checked: [...NEEDS_WRITER_SESSION],
    keyword,
    words: result.stats.words,
  };
}
