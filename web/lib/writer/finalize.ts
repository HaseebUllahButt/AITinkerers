// Validation + metadata as a callable function rather than logic buried in a route handler, so the
// integration probe (scripts/writer_e2e_probe.mjs) can exercise the real thing without a browser
// session. The route is a thin auth wrapper over this.
import {
  getWriterSession, updateWriterSession, getWriterVoice, getBlogDraft, updateBlogDraft,
  blogSlugTaken, accumulateWriterUsage,
  type BlogDraft,
} from "@/lib/db/queries";
import { validateArticle, draftReadinessViolations, verdictFor, repairPrompt, type Violation } from "./validate";
import { ownedHeadTerms } from "@/lib/blog/cannibalization";
import { SOCIAL_URLS } from "@/lib/blog/socials";
import { isOurEmbeddableUrl } from "@/lib/blog/youtube";
import { generateMeta } from "./meta";
import { voiceSitemap } from "./voice";
import { slugify, slugFromTitle, uniqueSlug } from "@/lib/blog/fields";
import { planAutofill } from "@/lib/blog/autofill";
import { loadStrapiOptions } from "@/lib/blog/autofillOptions";
import { internalLinkUniverse } from "@/lib/sitemap/store";

export interface FinalizeResult {
  ok: boolean;
  error?: string;
  verdict?: "ok" | "flagged" | "failed";
  violations?: Violation[];
  stats?: ReturnType<typeof validateArticle>["stats"];
  draft?: BlogDraft | null;
  repair_prompt?: string | null;
}

export async function finalizeSession(id: string): Promise<FinalizeResult> {
  const session = await getWriterSession(id);
  if (!session) return { ok: false, error: "not found" };
  if (!session.draft_id) return { ok: false, error: "No draft attached." };
  if (!session.voice_id) return { ok: false, error: "No voice attached." };

  const [voice, draft] = await Promise.all([getWriterVoice(session.voice_id), getBlogDraft(session.draft_id)]);
  if (!voice) return { ok: false, error: "Voice no longer exists." };
  if (!draft) return { ok: false, error: "Draft no longer exists." };
  if (!draft.body?.trim()) return { ok: false, error: "Nothing written yet." };

  await updateWriterSession(id, { phase: "validating" });

  const research = (session.research ?? {}) as Record<string, unknown>;
  const ledgerUrls = new Set(Object.keys((research.sources ?? {}) as Record<string, unknown>));
  // Cluster siblings are legitimate internal links even though they aren't in the voice's sitemap:
  // their slugs were minted and collision-checked at cluster-approval time, so they will exist.
  // Everything that counts as a legitimate internal link: the voice's curated list, the cluster
  // siblings, and the full sitemap inventory. Without the inventory the link_provenance gate flagged
  // links to real pages as fabricated, which is a `failed` verdict — the harshest one there is.
  const [inventory, ownedTerms] = await Promise.all([
    internalLinkUniverse().catch(() => new Set<string>()),
    // The terms a feature, app or tool page already owns. Fetched here rather than inside the validator
    // because validateArticle is pure and synchronous, and it is called on fixtures seventeen times by
    // the selfcheck route. An empty list on failure means the check is skipped, not that it passed —
    // which is the right way round: this is a backstop behind the pre-draft gate, not the only guard.
    ownedHeadTerms().catch(() => [] as string[]),
  ]);
  const sitemapUrls = new Set([
    ...voiceSitemap(voice).map((l) => l.url),
    ...((session.brief?.cluster_siblings ?? []) as string[]),
    ...inventory,
    // Our own social accounts. They are not in the sitemap because they are not our pages, but they
    // are every bit as much a known-good URL — and without them here, link_provenance calls every
    // social link fabricated. That gate is a `flag` and is deliberately never auto-retried, so a
    // writer doing exactly what it was told would land the article in front of a human every time.
    ...SOCIAL_URLS,
    // Our own YouTube videos, for exactly the reason the socials are here: they are known-good URLs
    // that are not our pages, and without them link_provenance calls every embed fabricated. The ids
    // were resolved from the channel feed at request time, so they are as verified as a sitemap path.
    ...((session.brief?.video_embeds ?? []) as Array<{ url: string }>).map((v) => v.url),
  ]);

  // Real questions we actually retrieved. People Also Ask entries are questions by definition;
  // Search Console rows are mostly NOT ("ai video generator" is a keyword, not a question), so only
  // the question-shaped ones count. Including every GSC keyword made this fire on every article,
  // since no real question heading resembles a bare keyword — a false positive that would have
  // trained the team to ignore the gate.
  const isQuestionShaped = (s: string) =>
    /\?\s*$/.test(s) || /^(how|what|why|when|where|which|who|can|do|does|is|are|should|will)\b/i.test(s.trim());
  const realQuestions = [
    ...((research.paa as string[]) ?? []),
    ...(((research.keyword_rows as Array<{ keyword: string }>) ?? [])
      .map((k) => k.keyword)
      .filter(isQuestionShaped)),
  ];

  // Prose gates first: local, free, and they decide whether a metadata call is even worth making.
  const result = validateArticle({
    body: draft.body, voice, outline: session.outline, brief: session.brief,
    ledgerUrls, sitemapUrls, ownedTerms,
    // Only check invented questions when we actually have real ones to compare against; with no
    // SERP data every heading would be "invented" and the flag would be noise.
    realQuestions: realQuestions.length ? realQuestions : undefined,
  });

  if (result.fixed !== draft.body) {
    await updateBlogDraft(session.draft_id, { body: result.fixed });
  }

  // A provenance failure is going to a human regardless, so don't spend a metadata call on it.
  const terminal = result.violations.some((v) => v.gate === "link_provenance");
  let metaProblems: string[] = [];
  if (!terminal) {
    const { meta, problems, usage } = await generateMeta(result.fixed, voice, session.brief);
    metaProblems = problems;
    if (usage) await accumulateWriterUsage(id, usage);
    if (meta) {
      // The server owns the final slug. The model proposes; uniqueness is ours to guarantee, because
      // Strapi's slug is a unique uid and a collision is a 400 at sync time.
      // The model's proposed slug is taken as-is when it gave one; otherwise the TITLE'S SUBJECT
      // rather than the whole title, so a post about GPT-5.6-Cyber is `gpt-5-6-cyber` and not
      // `gpt-5-6-cyber-openais-daybreak-red-team-model`.
      const base = meta.slug ? slugify(meta.slug) : slugFromTitle(meta.title);
      // uniqueSlug appends inside the length cap rather than past it.
      const slug = await uniqueSlug(base, (c) => blogSlugTaken(c, draft.id));
      await updateBlogDraft(session.draft_id, {
        title: meta.title, slug, description: meta.description,
        seo_title: meta.seo_title, seo_description: meta.seo_description,
        seo_keywords: meta.seo_keywords, tags: meta.tags,
        hero_cta_text: meta.hero_cta_text ?? null, hero_cta_url: meta.hero_cta_url ?? null,
      });
    }
  }

  // Fill what the model doesn't produce: author, category, and the thumbnail when a cover exists.
  // This matters most for clusters, where a dozen articles finish unattended and nobody is going to
  // press "Fill the blanks" on each one. Best-effort by design — the planner reports an unreachable
  // Strapi as a skip, and readiness below still names anything genuinely missing.
  {
    const current = await getBlogDraft(session.draft_id);
    if (current) {
      const { options } = await loadStrapiOptions();
      const plan = planAutofill({
        draft: current,
        meta: null,                                  // already written above; never overwrite it
        voice: { default_cta_text: voice.default_cta_text, default_cta_url: voice.default_cta_url },
        strapi: options,
        topic: session.brief?.primary_keyword ?? null,
      });
      if (Object.keys(plan.patch).length) await updateBlogDraft(session.draft_id, plan.patch);
    }
  }

  // Re-read so the publish-readiness check sees the metadata just written.
  const withMeta = await getBlogDraft(session.draft_id);
  const allViolations: Violation[] = [
    ...result.violations,
    ...draftReadinessViolations(withMeta ?? draft),
    ...metaProblems.map((detail) => ({ gate: "metadata", severity: "repair" as const, detail })),
  ];
  const verdict = verdictFor(allViolations);

  await updateBlogDraft(session.draft_id, {
    writer_status: verdict,
    writer_qa: { violations: allViolations, stats: result.stats, checked_at: new Date().toISOString() },
    writer_session_id: id,
  });

  const repairable = allViolations.filter((v) => v.severity === "repair");
  await updateWriterSession(id, {
    phase: verdict === "failed" ? "failed" : repairable.length ? "writing" : "done",
    ...(verdict === "failed" ? { error: "link provenance failure" } : {}),
  });

  return {
    ok: true,
    verdict,
    violations: allViolations,
    stats: result.stats,
    draft: await getBlogDraft(session.draft_id),
    repair_prompt: repairable.length ? repairPrompt(allViolations) : null,
  };
}
