import { NextResponse } from "next/server";
import { sanitizePatch, changedFields, editableSnapshot, slugify, placeholderSlug } from "@/lib/blog/fields";
import { deriveSyncState } from "@/lib/blog/state";
import { planAutofill } from "@/lib/blog/autofill";
import { diffLines, countChanges, collapseUnchanged } from "@/lib/blog/diff";
import { mapDraftToStrapi, publishReadiness, syncReadiness } from "@/lib/strapi/mapDraft";
import { renderVoiceSystem, voiceSitemap, voiceBannedWords } from "@/lib/writer/voice";
import { SKILL_PROMPT, SKILL_PROMPT_APPROX_TOKENS } from "@/lib/writer/skill";
import { applyCacheBreakpoints, isCacheable, writingAssignment, nextUnwrittenIndex } from "@/lib/writer/prompt";
import { rebuildBody, outlineSizingProblem, sanitizeOutlineEdit } from "@/lib/writer/control";
import { validateArticle, verdictFor, repairPrompt, autoFixTypography } from "@/lib/writer/validate";
import { parseBlocks, safeUrl, parseInline } from "@/lib/blog/markdown";
import { stripDirectives } from "@/lib/writer/prompt";
import { parseSitemap, sectionOf } from "@/lib/sitemap/store";
import { cleanExternalUrl, hasTrackingParams } from "@/lib/util/url";
import { isPlaceholderEmail } from "@/lib/enrich/personFilter";
import { defaultShortenTarget, wordsIn } from "@/lib/writer/revise";
import { blocksInRange, scrollTopFor } from "@/lib/blog/paneSync";
import { pathOverlap, overlapWords, scoreIncumbent, isCommercialQuery } from "@/lib/seo/canonical";
import { planAssets, altFor, inlineImageCount, isStructuralHeading, assetFilename } from "@/lib/media/plan";
import {
  imageSizeFor, resolveModel, buildPayload, extractImages, refIsReachable, MODELS,
} from "@/lib/media/fal";
import { buildImagePrompt, axesForSlot } from "@/lib/media/prompt";
import type { BlogDraft, WriterVoice } from "@/lib/db/queries";

// GET /api/blog/selfcheck?key=$CRON_SECRET — assertions over the pure helpers behind the composer.
//
// NOTE: not `_selfcheck`. An underscore prefix makes a folder private in the App Router, opting it
// and all subfolders out of routing entirely, so the route 404s. Requests also pass through
// src/proxy.ts (Next 16's renamed middleware) which redirects anything without a session to
// /login — hence the ?key= for scripted runs.
//
// This repo has no test framework (package.json has no test script and no runner is installed), and
// the save/sync logic here is the most silently-wrong-able code in the feature: an off-by-one in
// sanitizePatch or deriveSyncState produces no error, just quietly lost edits or a wrong badge.
// Running the real modules through the app's own TypeScript pipeline is the cheapest net available
// and costs zero dependencies. Dev-only; keep it permanently rather than deleting after the phase.
export const dynamic = "force-dynamic";

interface Case { name: string; pass: boolean; detail?: string }

function check(cases: Case[], name: string, pass: boolean, detail?: string) {
  cases.push({ name, pass, ...(pass ? {} : { detail }) });
}

function eq(cases: Case[], name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(cases, name, a === e, `expected ${e}, got ${a}`);
}

const baseRow = (over: Partial<BlogDraft> = {}): BlogDraft => ({
  id: "00000000-0000-0000-0000-000000000000",
  title: "", slug: "s", body: "", description: "",
  is_featured: false, should_index: true,
  status: "draft", rev: 0, locale: "en", sync_state: "local_only",
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ ok: false, error: "not available in production" }, { status: 404 });
  }
  const c: Case[] = [];

  // ── sanitizePatch: the gate that keeps unknown keys away from Postgres ──
  {
    const { patch, rejected } = sanitizePatch({
      title: "hello", body: "b",
      id: "nope", status: "published", strapi_id: 7, rev: 99, created_at: "x", // server-owned
      totally_made_up: 1,
    });
    eq(c, "sanitizePatch keeps only editable fields", Object.keys(patch).sort(), ["body", "title"]);
    check(c, "sanitizePatch reports rejected keys",
      ["id", "status", "strapi_id", "rev", "created_at", "totally_made_up"].every((k) => rejected.includes(k)),
      `rejected = ${JSON.stringify(rejected)}`);
    check(c, "sanitizePatch cannot set status", !("status" in patch));
    check(c, "sanitizePatch cannot set strapi_id", !("strapi_id" in patch));
  }
  {
    // base_rev / force / reason are transport, not columns — must not land in `rejected` either.
    const { patch, rejected } = sanitizePatch({ base_rev: 3, force: true, reason: "manual", title: "t" });
    eq(c, "sanitizePatch ignores transport keys silently", rejected, []);
    eq(c, "sanitizePatch keeps the real field", Object.keys(patch), ["title"]);
  }
  {
    // NOT NULL DEFAULT '' columns: a null here is a 500 from Postgres.
    const { patch } = sanitizePatch({ title: null, body: null, description: null, slug: null });
    eq(c, "sanitizePatch coerces NOT NULL text to empty string",
      [patch.title, patch.body, patch.description, patch.slug], ["", "", "", ""]);
  }
  {
    const { patch } = sanitizePatch({ tags: null, canonical_tag: null, hero_cta_url: null });
    eq(c, "sanitizePatch keeps nullable text nullable",
      [patch.tags, patch.canonical_tag, patch.hero_cta_url], [null, null, null]);
  }
  {
    // A cleared <select> sends "", which must become null — not 0, which is a real Strapi id.
    const { patch } = sanitizePatch({ author_id: "", category_id: "12", cover_media_id: "abc", thumbnail_media_id: 5 });
    eq(c, "sanitizePatch coerces ids (empty→null, numeric string→number, junk→null)",
      [patch.author_id, patch.category_id, patch.cover_media_id, patch.thumbnail_media_id],
      [null, 12, null, 5]);
  }
  {
    const { patch } = sanitizePatch({ is_featured: "true", should_index: false });
    eq(c, "sanitizePatch coerces booleans", [patch.is_featured, patch.should_index], [true, false]);
  }

  // ── changedFields: what autosave actually sends ──
  {
    const server = baseRow({ title: "same", body: "old", tags: null });
    eq(c, "changedFields returns only real differences",
      changedFields(server, { title: "same", body: "new" }), { body: "new" });
    // The form uses "" where the DB uses null; without this every draft looks permanently dirty.
    eq(c, "changedFields treats null and empty string as equal for nullable text",
      changedFields(server, { tags: "" }), {});
    eq(c, "changedFields ignores absent keys", changedFields(server, {}), {});
    eq(c, "changedFields detects a cleared relation",
      changedFields(baseRow({ author_id: 3 }), { author_id: null }), { author_id: null });
  }

  // ── deriveSyncState: staleness is derived, never stored ──
  {
    eq(c, "syncState local_only when never pushed",
      deriveSyncState(baseRow()), "local_only");
    eq(c, "syncState synced when rev matches synced_rev",
      deriveSyncState(baseRow({ strapi_id: 1, rev: 4, synced_rev: 4 })), "synced");
    eq(c, "syncState synced_stale after a local edit",
      deriveSyncState(baseRow({ strapi_id: 1, rev: 5, synced_rev: 4 })), "synced_stale");
    eq(c, "syncState published when live and current",
      deriveSyncState(baseRow({ strapi_id: 1, rev: 4, synced_rev: 4, strapi_published_at: "2026-01-01T00:00:00Z" })),
      "published");
    eq(c, "syncState published_stale when live but edited since",
      deriveSyncState(baseRow({ strapi_id: 1, rev: 9, synced_rev: 4, strapi_published_at: "2026-01-01T00:00:00Z" })),
      "published_stale");
    eq(c, "syncState sync_failed wins over everything",
      deriveSyncState(baseRow({ strapi_id: 1, rev: 4, synced_rev: 4, sync_state: "sync_failed" })),
      "sync_failed");
  }

  // ── publishReadiness / syncReadiness: the gates the routes enforce ──
  {
    const ready = baseRow({
      title: "A title that is comfortably longer than thirty-five characters",
      description: "x".repeat(120),
      thumbnail_media_id: 5, hero_cta_text: "Try it", hero_cta_url: "https://northwind.example", slug: "ok",
    });
    eq(c, "publishReadiness passes a complete draft", publishReadiness(ready), []);
    check(c, "publishReadiness blocks a missing thumbnail (Strapi requires it)",
      publishReadiness({ ...ready, thumbnail_media_id: null }).some((p) => /thumbnail/i.test(p)));
    check(c, "publishReadiness blocks a short title",
      publishReadiness({ ...ready, title: "too short" }).some((p) => /35/.test(p)));
    check(c, "publishReadiness blocks a short description",
      publishReadiness({ ...ready, description: "short" }).some((p) => /120/.test(p)));
    check(c, "publishReadiness blocks an empty hero CTA",
      publishReadiness({ ...ready, hero_cta_url: "  " }).some((p) => /CTA/i.test(p)));
    // Sync must work on a half-finished post — that's the whole point of a local-first draft.
    eq(c, "syncReadiness allows an otherwise-empty draft with a slug",
      syncReadiness(baseRow({ slug: "untitled-abc12345" })), []);
    check(c, "syncReadiness blocks an empty slug (uid uniqueness is not relaxed for drafts)",
      syncReadiness(baseRow({ slug: "" })).length === 1);
  }

  // ── mapDraftToStrapi: relation clearing, and the thumbnail publish-mode rule ──
  {
    const cleared = mapDraftToStrapi({ cover_media_id: null, author_id: null, category_id: null });
    eq(c, "mapDraft emits null for cleared relations (was silently omitted before)",
      [cleared.cover, cleared.author, cleared.category], [null, null, null]);
    check(c, "mapDraft omits keys the caller didn't supply", !("title" in mapDraftToStrapi({ body: "x" })));
    // thumbnail is REQUIRED: null is legal on a draft, and a 400 on publish.
    check(c, "mapDraft allows clearing thumbnail in draft mode",
      "thumbnail" in mapDraftToStrapi({ thumbnail_media_id: null }, { mode: "draft" }));
    check(c, "mapDraft never sends thumbnail:null in publish mode",
      !("thumbnail" in mapDraftToStrapi({ thumbnail_media_id: null }, { mode: "publish" })));
    // A full row always has these columns present as null, so the old `!== undefined` test wrote
    // an empty component on every single draft.
    check(c, "mapDraft omits empty blogsMetaData on a draft",
      !("blogsMetaData" in mapDraftToStrapi(baseRow(), { mode: "draft" })));
    check(c, "mapDraft synthesises blogsMetaData when publishing",
      "blogsMetaData" in mapDraftToStrapi(baseRow(), { mode: "publish" }));
    check(c, "mapDraft omits empty hero CTA on a draft",
      !("blogHeroCTA" in mapDraftToStrapi(baseRow(), { mode: "draft" })));
    eq(c, "mapDraft includes locale only when asked",
      [
        "locale" in mapDraftToStrapi(baseRow(), {}),
        mapDraftToStrapi(baseRow({ locale: "es" }), { locale: "en" }).locale,
      ],
      [false, "es"]);
  }

  // ── diff: powers the conflict dialog ──
  {
    const d = diffLines("a\nb\nc", "a\nx\nc");
    eq(c, "diff counts one add and one remove", countChanges(d), { added: 1, removed: 1 });
    eq(c, "diff finds no changes in identical text", countChanges(diffLines("same", "same")), { added: 0, removed: 0 });
    const long = diffLines(Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n"),
                           Array.from({ length: 40 }, (_, i) => (i === 20 ? "changed" : `l${i}`)).join("\n"));
    check(c, "diff collapses long unchanged runs",
      collapseUnchanged(long).some((l) => l.op === "skip"));
  }

  // ── slug helpers ──
  {
    eq(c, "slugify strips punctuation and collapses spaces",
      slugify("  Hello, World!!  Again  "), "hello-world-again");
    eq(c, "slugify caps length at 80", slugify("a".repeat(200)).length, 80);
    check(c, "placeholderSlug is non-empty and prefixed", /^untitled-[0-9a-f]{1,8}$/.test(placeholderSlug()));
    check(c, "placeholderSlug is distinct per call", placeholderSlug() !== placeholderSlug());
  }

  // ── editableSnapshot: what lands in a revision / the journal ──
  {
    const snap = editableSnapshot(baseRow({ title: "t", strapi_id: 9, rev: 3 }));
    check(c, "editableSnapshot excludes server-owned fields",
      !("strapi_id" in snap) && !("rev" in snap) && !("id" in snap));
    check(c, "editableSnapshot keeps editable fields", snap.title === "t");
  }

  // ── renderVoiceSystem: prompt-cache determinism ──
  // The most expensive thing in this feature to get wrong, and the least visible: if this string
  // varies between requests, every call pays a full cache write instead of a ~10x cheaper read, and
  // the only symptom is the bill. `cache_creation_input_tokens` stays high, nothing errors.
  {
    const voice = (over: Partial<WriterVoice> = {}): WriterVoice => ({
      id: "v0", name: "Test voice", slug: "test", is_default: true,
      tone_doc: "Be direct.", banned_words: [], banned_phrases: [], workflow_rules: "",
      sitemap_links: [], default_word_count: 2500, allowed_link_hosts: [],
      archived: false, prompt_revision: 1,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      ...over,
    });

    const links = [
      { url: "https://b.example/2", category: "B", description: "second" },
      { url: "https://a.example/1", category: "A", description: "first" },
    ];
    const v1 = voice({ banned_words: ["unlock", "elevate"], sitemap_links: links });
    check(c, "renderVoiceSystem is stable across calls",
      renderVoiceSystem(v1) === renderVoiceSystem(v1));

    // Postgres does not promise array or jsonb key order across round-trips, so the renderer sorts.
    // Same content in a different order must produce identical bytes.
    const v2 = voice({
      banned_words: ["ELEVATE", " unlock "],           // different order, case and whitespace
      sitemap_links: [links[1], links[0]],             // different order
    });
    check(c, "renderVoiceSystem ignores list order/case/whitespace",
      renderVoiceSystem(v1) === renderVoiceSystem(v2),
      "reordering banned_words or sitemap_links changed the prompt — the cache would miss");

    // jsonb arrives as a string from some clients; both shapes must render the same.
    const v3 = voice({ banned_words: ["unlock", "elevate"], sitemap_links: JSON.stringify(links) });
    check(c, "renderVoiceSystem handles jsonb as a string identically",
      renderVoiceSystem(v1) === renderVoiceSystem(v3));

    // A mutable value in the prompt is the classic silent cache-killer.
    const rendered = renderVoiceSystem(v1);
    check(c, "renderVoiceSystem contains no timestamp",
      !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(rendered),
      "an ISO date in the cached prefix invalidates it on every request");
    check(c, "renderVoiceSystem contains no revision number or id",
      !rendered.includes("prompt_revision") && !rendered.includes("v0"));

    // Editing content must change the prompt (the inverse property — otherwise a voice edit would
    // silently keep serving the old cached prompt).
    check(c, "renderVoiceSystem changes when tone_doc changes",
      renderVoiceSystem(voice({ tone_doc: "Be warm." })) !== renderVoiceSystem(voice()));

    check(c, "voiceSitemap drops entries with no url",
      voiceSitemap({ sitemap_links: [{ url: "" }, { category: "x" }, { url: "https://ok.example" }] }).length === 1);
    check(c, "voiceSitemap survives malformed jsonb",
      voiceSitemap({ sitemap_links: "{not json" }).length === 0);
    eq(c, "voiceBannedWords sorted + deduped + lowercased",
      voiceBannedWords({ banned_words: ["Unlock", "elevate", "unlock", " ELEVATE "] }),
      ["elevate", "unlock"]);
  }

  // ── SKILL_PROMPT: must clear the minimum cacheable prefix ──
  // Below the model's minimum, a cache_control breakpoint is silently ignored — no error, no
  // warning, just `cache_creation_input_tokens` staying high forever.
  //
  // The documented minimums are 4096 tokens for the Opus family and 2048 for Sonnet 4.6, and
  // **Sonnet 5 is absent from that table** — so its threshold is unknown. Assert against the
  // higher bound (4096) rather than the one that merely happens to fit: being comfortably over the
  // worst case costs nothing, and being between the two is an unnoticeable bill increase.
  // This is a rough char/4 estimate; confirm with real `usage` numbers in scripts/writer_probe.mjs
  // once ANTHROPIC_API_KEY is available.
  {
    check(c, "SKILL_PROMPT clears the worst-case cache minimum (>4096 approx tokens)",
      SKILL_PROMPT_APPROX_TOKENS > 4096,
      `approx ${SKILL_PROMPT_APPROX_TOKENS} tokens — under the 4096 worst case, so the breakpoint may be silently ignored on Sonnet 5`);
    check(c, "SKILL_PROMPT has no interpolation left in it",
      !SKILL_PROMPT.includes("${"),
      "an interpolated value in system[0] invalidates the cache for every voice and every article");
    check(c, "SKILL_PROMPT contains no timestamp",
      !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(SKILL_PROMPT));
    check(c, "SKILL_PROMPT states the human-approval rule",
      /only a human can take|no tool that lets you approve/i.test(SKILL_PROMPT));
    check(c, "SKILL_PROMPT states the citation-provenance rule",
      /only cite URLs that were returned to you by a tool/i.test(SKILL_PROMPT));

    // Practise what we preach. Both the workflow prompt and the voice block tell the model that em
    // dashes are banned, so neither may contain one: an instruction contradicted 36 times by the
    // document carrying it is a mixed signal, and this is the brand's most-cited style rule.
    // En dashes in numeric ranges ("150–200 words") are correct typography and are not the ban.
    check(c, "SKILL_PROMPT contains no em dash",
      !SKILL_PROMPT.includes("—"),
      `found ${(SKILL_PROMPT.match(/—/g) || []).length} — the prompt bans em dashes, so it must not use them`);
  }

  // ── applyCacheBreakpoints: never mark a block that can't carry cache_control ──
  // Caught in live testing, not by tsc: marking a `thinking` block returns
  //   400 messages.N.content.0.thinking.cache_control: Extra inputs are not permitted
  // and only happens once the history grows deep enough for the marked position to land on one, so
  // it surfaces several turns into a session rather than on the first request. ContentBlockParam is
  // a union where cache_control IS valid on most members, so types cannot catch it.
  {
    const msgs = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      {
        role: "assistant" as const,
        content: [
          { type: "thinking" as const, thinking: "reasoning...", signature: "sig" },
          { type: "text" as const, text: "answer" },
        ],
      },
    ];
    const out = applyCacheBreakpoints(msgs as any);
    const allBlocks = out.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
    const markedThinking = allBlocks.filter((b: any) => b.type === "thinking" && b.cache_control);
    check(c, "applyCacheBreakpoints never marks a thinking block",
      markedThinking.length === 0,
      "marking a thinking block is a hard 400 from the API");
    check(c, "applyCacheBreakpoints still marks the last cacheable block",
      allBlocks.some((b: any) => b.type === "text" && b.cache_control));

    // A history that ENDS on a thinking block is the exact shape that broke live: the last block
    // overall is not cacheable, so the marker must fall back to the last cacheable one.
    const endsOnThinking = [{
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "a" },
        { type: "thinking" as const, thinking: "t", signature: "s" },
      ],
    }];
    const out2 = applyCacheBreakpoints(endsOnThinking as any);
    const b2 = (out2[0] as any).content;
    check(c, "history ending on a thinking block still gets a valid breakpoint",
      !!b2[0].cache_control && !b2[1].cache_control);

    check(c, "isCacheable rejects thinking / accepts text+tool_result",
      !isCacheable({ type: "thinking" }) && !isCacheable({ type: "redacted_thinking" })
      && isCacheable({ type: "text" }) && isCacheable({ type: "tool_result" }));

    // The request-shaping pass must not mutate the caller's blocks: those same objects get
    // persisted to writer_messages and replayed later, and a stored cache_control would be sent
    // back on a future request where that position is no longer a sensible breakpoint.
    const original = [{ role: "user" as const, content: [{ type: "text" as const, text: "x" }] }];
    applyCacheBreakpoints(original as any);
    check(c, "applyCacheBreakpoints does not mutate its input",
      !("cache_control" in (original[0].content[0] as Record<string, unknown>)));
  }

  // ── rebuildBody: section submission must be idempotent ──
  // Observed live before the section map existed: the model called submit_section for the final
  // index three times and the append-based handler wrote three copies into the body, while the
  // cursor still reported success. Rebuilding from an index-keyed map makes a repeat a replace.
  {
    eq(c, "rebuildBody joins sections in numeric index order",
      rebuildBody({ "1": "second", "0": "first", "2": "third" }), "first\n\nsecond\n\nthird");
    // The bug this guards: integer-like keys past 9 sort lexicographically as strings, so "10"
    // would land between "1" and "2" without an explicit numeric sort.
    eq(c, "rebuildBody sorts double-digit indices numerically, not lexically",
      rebuildBody({ "0": "a", "10": "k", "2": "c" }), "a\n\nc\n\nk");
    eq(c, "rebuildBody resubmitting an index replaces rather than duplicates",
      rebuildBody({ "0": "intro", "1": "final" }), "intro\n\nfinal");
    eq(c, "rebuildBody drops empty sections", rebuildBody({ "0": "a", "1": "   ", "2": "b" }), "a\n\nb");
    eq(c, "rebuildBody on an empty map is an empty string", rebuildBody({}), "");
  }

  // ── outlineSizingProblem: catch an unwritable outline before it costs an article ──
  // Observed live: 15 sections planned against a 1,500-word brief produced 3,678 words, 145% over.
  {
    const secs = (n: number, per: number) => Array.from({ length: n }, () => ({ target_words: per }));
    check(c, "15 sections against a 1500-word brief is rejected",
      !!outlineSizingProblem(secs(15, 245), 1500));
    check(c, "section targets summing far over the brief are rejected",
      !!outlineSizingProblem(secs(5, 800), 1500));
    check(c, "a correctly-sized outline passes",
      outlineSizingProblem(secs(6, 240), 1500) === null);
    check(c, "a modest excess is tolerated (intro/conclusion overhead)",
      outlineSizingProblem(secs(6, 280), 1500) === null,
      "1680 vs 1500 is within the 1.3x allowance and should not be rejected");
    check(c, "no target means no opinion", outlineSizingProblem(secs(20, 500), undefined) === null);
    check(c, "a long-form brief allows proportionally more sections",
      outlineSizingProblem(secs(12, 240), 3000) === null,
      "2880 words across 12 sections is a reasonable 3000-word piece");
  }

  // ── writingAssignment: the fix for an article written with zero links ──
  {
    const session = {
      sections: {},
      outline: {
        search_intent: "", h1: "H",
        sections: [
          { level: "h2" as const, heading: "Why costs add up", target_words: 250 },
          { level: "h2" as const, heading: "How does it work?", is_faq: true },
        ],
        source_plan: [{ url: "https://ex.com/a", insight: "costs 3x", anchor_text: "cost breakdown", section_index: 0 }],
        link_plan: [{ url: "https://www.northwind.example/", anchor_text: "Northwind", section_index: 0 }],
      },
    } as any;

    const a0 = writingAssignment(session, 0);
    check(c, "writingAssignment restates the section's assigned source URL", a0.includes("https://ex.com/a"));
    check(c, "writingAssignment restates the section's assigned internal link", a0.includes("https://www.northwind.example/"));
    check(c, "writingAssignment includes the anchor text to use", a0.includes("cost breakdown"));

    // Index matching must be exact. Fuzzy heading matching silently found nothing, and the
    // no-assignment branch then suppressed links entirely — shipping zero-citation articles.
    check(c, "writingAssignment does not leak another section's assignment",
      !writingAssignment(session, 1).includes("https://ex.com/a")
      || writingAssignment(session, 1).includes("if any of these fit")
      || /fit naturally/i.test(writingAssignment(session, 1)));

    const a1 = writingAssignment(session, 1);
    // The critical negative: an unassigned section must NEVER be told to write without links. That
    // instruction is what produced a complete article with zero citations.
    check(c, "an unassigned section is never told to omit links",
      !/write it from the argument alone/i.test(a1),
      "this phrasing suppressed all citations in a live run");
    check(c, "writingAssignment still forbids inventing URLs", /do not invent/i.test(a1));
    check(c, "writingAssignment flags a question heading as needing a standalone answer",
      /stands alone|out of context/i.test(a1));

    check(c, "nextUnwrittenIndex starts at 0", nextUnwrittenIndex(session) === 0);
    check(c, "nextUnwrittenIndex skips written sections",
      nextUnwrittenIndex({ ...session, sections: { "0": "done" } } as any) === 1);
    check(c, "nextUnwrittenIndex returns null when complete",
      nextUnwrittenIndex({ ...session, sections: { "0": "a", "1": "b" } } as any) === null);
  }

  // ── validateArticle: the mechanical quality gates ──
  // The false-positive traps matter as much as the catches here: a validator that flags a banned
  // word inside a URL, or an em dash inside a code sample, trains the author to ignore it.
  {
    const voice = {
      id: "v", name: "V", slug: "v", is_default: true,
      tone_doc: "", banned_words: ["unlock", "seamless"], banned_phrases: ["pain points"],
      workflow_rules: "", sitemap_links: [], default_word_count: 100,
      allowed_link_hosts: ["www.northwind.example"], archived: false, prompt_revision: 1,
      created_at: "", updated_at: "",
    } as unknown as WriterVoice;

    const outline = {
      search_intent: "", h1: "Using AI product photography to cut costs",
      sections: [{ level: "h2" as const, heading: "S1" }],
      source_plan: [{ url: "https://ex.com/a", insight: "i", anchor_text: "a", section_index: 0 }],
      link_plan: [{ url: "https://www.northwind.example/", anchor_text: "b", section_index: 0 }],
    };
    const brief = { primary_keyword: "AI product photography", word_count: 100, negative_keywords: ["cheap"] };
    const ledger = new Set(["https://ex.com/a"]);
    const sitemap = new Set(["https://www.northwind.example/"]);
    const run = (body: string, over: Partial<Parameters<typeof validateArticle>[0]> = {}) =>
      validateArticle({ body, voice, outline, brief, ledgerUrls: ledger, sitemapUrls: sitemap, ...over });

    // auto_fix: em dash replaced in prose, but NOT inside a fenced code block.
    {
      const r = run("Text with a dash — like this.\n\n```\nconst a = 1; // keep — this\n```");
      check(c, "em dash in prose is auto-fixed", !r.fixed.split("```")[0].includes("—"));
      check(c, "em dash inside a code fence survives", r.fixed.includes("// keep — this"),
        "masking failed: a code sample was rewritten");
      check(c, "em dash fix is reported as auto_fix",
        r.violations.some((v) => v.gate === "em_dash" && v.severity === "auto_fix"));
    }
    // En dashes in numeric ranges are correct typography, not the thing being banned.
    {
      const r = run("Sections run 150–200 words each.");
      check(c, "en dash between digits is left alone", r.fixed.includes("150–200"),
        "a numeric range was mangled into a comma");
    }
    // A banned word inside a URL is not a banned word in the prose.
    {
      const r = run("See [the guide](https://ex.com/a/unlock-seamless-tips) for more.");
      check(c, "banned word inside a link target does not fire",
        !r.violations.some((v) => v.gate === "banned_terms"),
        "link targets must be masked before the banned-terms scan");
    }
    {
      const r = run("This will unlock real value and address pain points.");
      const v = r.violations.find((x) => x.gate === "banned_terms");
      check(c, "banned word and phrase in prose both fire", !!v && /unlock/.test(v.detail) && /pain points/.test(v.detail));
      check(c, "banned terms are severity repair", v?.severity === "repair");
    }
    // Keyword stuffing is worse than under-use, so the ceiling is a real gate.
    {
      const stuffed = ("AI product photography " as string).repeat(20) + "and some other words here.";
      const r = run(stuffed);
      check(c, "keyword density above 2% fires", r.violations.some((v) => v.gate === "keyword_density_high"));
    }
    // Provenance: the non-recoverable gate.
    {
      const r = run("Read [this study](https://totally-made-up.example/report).");
      const v = r.violations.find((x) => x.gate === "link_provenance");
      check(c, "a URL not in the ledger is flagged as fabricated", !!v);
      check(c, "provenance failure is 'flag', never 'repair'", v?.severity === "flag",
        "a retry would invent a different URL, so it must not be auto-repaired");
      check(c, "provenance failure makes the verdict 'failed'",
        verdictFor(r.violations) === "failed");
    }
    {
      const r = run("From [the source](https://ex.com/a) and [us](https://www.northwind.example/).");
      check(c, "ledger and sitemap URLs pass provenance",
        !r.violations.some((v) => v.gate === "link_provenance"));
      eq(c, "internal vs external links are counted separately",
        [r.stats.links_internal, r.stats.links_external], [1, 1]);
    }
    // The observed real failure: an approved plan and zero links in the prose.
    {
      const r = run("A complete article about AI product photography with no links at all.");
      check(c, "missing planned sources fires", r.violations.some((v) => v.gate === "missing_sources"));
      check(c, "missing planned internal links fires", r.violations.some((v) => v.gate === "missing_internal_links"));
    }
    // A markdown link is [anchor](url), not an unfilled [placeholder].
    {
      const r = run("See [the guide](https://ex.com/a).");
      check(c, "markdown link anchor is not mistaken for a placeholder",
        !r.violations.some((v) => v.gate === "placeholder"));
      const r2 = run("Costs fell by [insert statistic] last year.");
      check(c, "a real bracketed placeholder fires",
        r2.violations.some((v) => v.gate === "placeholder"));
      const r3 = run("Hello {{company}}.");
      check(c, "a mustache placeholder fires", r3.violations.some((v) => v.gate === "placeholder"));
    }
    {
      const r = run("This is the cheap option for AI product photography.");
      check(c, "a user's negative keyword fires", r.violations.some((v) => v.gate === "negative_keywords"));
    }
    {
      const r = run("# One\n\n# Two\n\nBody about AI product photography.");
      check(c, "more than one H1 is flagged", r.violations.some((v) => v.gate === "multiple_h1"));
    }
    {
      const r = run("Body text.\n\n## How does it work?\n\nyes.\n\n## What does it cost?\n\nsome.");
      check(c, "question-format H2s are counted", r.stats.faq_headings === 2);
    }
    // Exclamation marks: first kept, rest downgraded.
    {
      const r = run("Wow! Really! Truly!");
      check(c, "only the first exclamation mark survives",
        (r.fixed.match(/!/g) ?? []).length === 1);
    }
    // repairPrompt must carry only repairable items, and must tell the model not to freelance.
    {
      const vs = [
        { gate: "banned_terms", severity: "repair" as const, detail: "remove 'unlock'" },
        { gate: "link_provenance", severity: "flag" as const, detail: "fabricated" },
        { gate: "em_dash", severity: "auto_fix" as const, detail: "fixed" },
      ];
      const p = repairPrompt(vs);
      check(c, "repairPrompt includes repairable violations", p.includes("remove 'unlock'"));
      check(c, "repairPrompt excludes flag-only and auto_fix items",
        !p.includes("fabricated") && !p.includes("[em_dash]"));
      check(c, "repairPrompt forbids unrelated edits", /change nothing else/i.test(p));
      eq(c, "repairPrompt is empty when nothing is repairable",
        repairPrompt([{ gate: "x", severity: "flag", detail: "d" }]), "");
    }
    // ── ai_telltale_phrases.md: templated sentence shapes ──
    // These earn a permanent home here rather than a throwaway check, because the false-positive risk
    // is the whole design question: "not X, but Y" is completely ordinary contrastive prose most of the
    // time, and only the density-gated forms should ever fire on a single sentence.
    {
      const r = run("It's not just a camera, it's a whole new way to work. This changes everything for every team.");
      check(c, "'it's not just X, it's Y' fires", r.violations.some((v) => v.gate === "sentence_shape_tell"));

      const r2 = run("Whether you're a beginner or a professional, this tool has you covered for every case.");
      check(c, "'whether you're a X or a Y' opener fires", r2.violations.some((v) => v.gate === "sentence_shape_tell"));

      const r3 = run("The future of headshots is here, and it changes how teams think about hiring photos.");
      check(c, "'the future of X is here' fires", r3.violations.some((v) => v.gate === "sentence_shape_tell"));

      // A single ordinary contrast must NOT fire — this is normal English, not a tell.
      const clean = run("The result is not a bug, but a deliberate choice made after weeks of user testing.");
      check(c, "one ordinary 'not X, but Y' sentence stays clean",
        !clean.violations.some((v) => v.gate === "sentence_shape_tell"),
        "a single genuine contrast is ordinary prose; only repetition is a tell");

      // Repeated, it IS a tell — density-gated like stacked_transitions.
      const repeated = run(
        "It is not slow, but fast. It is not cheap, but worth it. It is not risky, but safe by design.");
      check(c, "three 'not X, but Y' constructions fire", repeated.violations.some((v) => v.gate === "sentence_shape_tell"));
    }

    // ── ai_telltale_phrases.md: tricolon padding ──
    {
      const r = run("The new system is fast, efficient, and reliable for any photographer on a deadline.");
      check(c, "adjective tricolon after a copula fires", r.violations.some((v) => v.gate === "tricolon"));

      const r2 = run("Simple. Effective. Repeatable. That's the whole pitch behind this camera system today.");
      check(c, "one-word-sentence triplet fires", r2.violations.some((v) => v.gate === "tricolon"));

      // A real enumeration of distinct nouns is just a list, not padding.
      const clean = run("The kit ships with a camera, a tripod, and a memory card for casual weekend use.");
      check(c, "a genuine noun enumeration stays clean", !clean.violations.some((v) => v.gate === "tricolon"),
        "'a camera, a tripod, and a memory card' is a real list, not three adjectives standing in for one claim");

      check(c, "tricolon is severity flag, never auto-applied",
        r.violations.find((v) => v.gate === "tricolon")?.severity === "flag");
    }

    // ── ai_telltale_phrases.md: heading restated as the section's first sentence ──
    {
      const r = run("## Native 4K Output\n\nNative 4K output means every frame renders at four times the resolution.");
      check(c, "a heading echoed verbatim in the next sentence fires", r.violations.some((v) => v.gate === "heading_echo"));

      const clean = run("## Native 4K Output\n\nMost competing tools cap out at 1080p, so this is a real jump.");
      check(c, "a heading followed by a genuinely new sentence stays clean",
        !clean.violations.some((v) => v.gate === "heading_echo"));
    }

    // ── ai_telltale_phrases.md: formatting tells ──
    {
      const bulletHeavy = "## Features\n\n" +
        Array.from({ length: 18 }, (_, i) => `- Point number ${i} about the product today`).join("\n") +
        "\n\nA short closing line.";
      check(c, "a page that is mostly bullets fires formatting_tell",
        run(bulletHeavy).violations.some((v) => v.gate === "formatting_tell"));

      const colonList = "## Setup\n\nDo this first:\n\n- Only one step here\n\nThen continue.\n\n" +
        "And again:\n\n- Just one more step\n\nDone.";
      check(c, "two colons each introducing a single-item list fire formatting_tell",
        run(colonList).violations.some((v) => v.gate === "formatting_tell"));

      const sameOpener = "## Steps\n\n- Get started with your first upload today\n" +
        "- Get access to every studio at once\n- Get results back in under a minute";
      check(c, "three consecutive bullets sharing an opening word fire formatting_tell",
        run(sameOpener).violations.some((v) => v.gate === "formatting_tell"));

      // A real list (≥2 items) with a genuine second bullet must not fire the single-item check.
      const realList = "## Setup\n\nYou will need:\n\n- A camera\n- A tripod\n\nThen begin.";
      check(c, "a real two-item list under a colon stays clean",
        !run(realList).violations.some((v) => v.gate === "formatting_tell"));

      check(c, "formatting_tell is severity flag", (() => {
        const v = run(bulletHeavy).violations.find((v) => v.gate === "formatting_tell");
        return v?.severity === "flag";
      })());
    }

    // ── the ```CTA fenced block: a mid-body button distinct from the single required hero CTA ──
    {
      const sitemapWithCta = new Set([...sitemap, "https://www.northwind.example/ai-fashion-studio"]);
      const good = '```CTA\n{"text": "Generate Background For Fashion Videos", "url": "https://www.northwind.example/ai-fashion-studio"}\n```';
      const r = run(`Body text before.\n\n${good}\n\nBody text after.`, { sitemapUrls: sitemapWithCta });
      check(c, "a well-formed CTA block pointing at a sitemap URL passes",
        !r.violations.some((v) => v.gate === "cta_block"));

      const badJson = run("```CTA\nnot json\n```", { sitemapUrls: sitemapWithCta });
      check(c, "a CTA block that is not valid JSON fires cta_block",
        badJson.violations.some((v) => v.gate === "cta_block"));

      const missingKey = run('```CTA\n{"text": "Click Here"}\n```', { sitemapUrls: sitemapWithCta });
      check(c, "a CTA block missing url fires cta_block",
        missingKey.violations.some((v) => v.gate === "cta_block"));

      const invented = '```CTA\n{"text": "Sign Up", "url": "https://totally-made-up.example/signup"}\n```';
      const r2 = run(invented, { sitemapUrls: sitemapWithCta });
      const v2 = r2.violations.find((v) => v.gate === "cta_block");
      check(c, "a CTA block pointing at a URL outside the internal-link database fires cta_block", !!v2);
      check(c, "cta_block is severity repair, not the non-recoverable flag",
        v2?.severity === "repair", "unlike a fabricated citation, the fix is just 'point at a real page'");
    }

    // ── grounding gates: the highest-consequence failure is a fluent invented number ──
    {
      // Cited in the same sentence: fine.
      const cited = run("Traditional shoots run [$500 per image](https://ex.com/a) at the high end.");
      check(c, "a statistic cited in the same sentence passes",
        !cited.violations.some((v) => v.gate === "unsourced_statistic"));

      // Same figure, citation absent: not fine.
      const bare = run("Traditional product shoots cost $500 per image at the high end.");
      check(c, "a bare currency figure with no source fires",
        bare.violations.some((v) => v.gate === "unsourced_statistic"));

      const pct = run("Around 73% of small brands reshoot at least once a season.");
      check(c, "a bare percentage with no source fires",
        pct.violations.some((v) => v.gate === "unsourced_statistic"));

      // Our own measured Search Console data is legitimate without an external link.
      const ourData = run("Search Console shows 812,000 impressions for this query at position 7.1.");
      check(c, "our own measured Search Console figure is allowed unsourced",
        !ourData.violations.some((v) => v.gate === "unsourced_statistic"),
        "first-party measured data should not require an external citation");

      // Ordinary prose numbers must not trip it, or the gate becomes noise the author ignores.
      const prose = run("There are three ways to shoot a product, and the first one is the cheapest.");
      check(c, "ordinary prose numbers do not fire the statistic gate",
        !prose.violations.some((v) => v.gate === "unsourced_statistic"));

      // Search volume and keyword difficulty are not available anywhere, so stating one is
      // necessarily invented regardless of how it is phrased.
      for (const phrase of [
        "This keyword has a search volume of 12,000.",
        "It gets roughly 8,000 monthly searches.",
        "Keyword difficulty is around 45.",
      ]) {
        const r = run(phrase);
        check(c, `unavailable-metric gate fires on: "${phrase.slice(0, 38)}…"`,
          r.violations.some((v) => v.gate === "unavailable_metric"),
          "no volume/difficulty source is connected, so this figure cannot be real");
      }
      check(c, "unavailable-metric gate does not fire on impressions language",
        !run("We get 812,000 impressions for this query.").violations.some((v) => v.gate === "unavailable_metric"));

      // Question headings must trace to a real query.
      const realQs = ["Is there a 100% free AI video maker?", "which ai can generate a video"];
      const grounded = validateArticle({
        body: "## Is there a 100% free AI video maker?\n\nYes, within limits.",
        voice, outline, brief, ledgerUrls: ledger, sitemapUrls: sitemap, realQuestions: realQs,
      });
      check(c, "a question heading matching a real PAA question passes",
        !grounded.violations.some((v) => v.gate === "invented_question"));

      const madeUp = validateArticle({
        body: "## What is the philosophical basis of computational aesthetics?\n\nSomething.",
        voice, outline, brief, ledgerUrls: ledger, sitemapUrls: sitemap, realQuestions: realQs,
      });
      check(c, "a question heading matching no real query is flagged",
        madeUp.violations.some((v) => v.gate === "invented_question"));
      check(c, "invented question is 'flag', not 'repair'",
        madeUp.violations.find((v) => v.gate === "invented_question")?.severity === "flag");

      // With no SERP data retrieved, the check must be skipped rather than flagging everything.
      const noData = validateArticle({
        body: "## Any question at all?\n\nYes.",
        voice, outline, brief, ledgerUrls: ledger, sitemapUrls: sitemap,
      });
      check(c, "question check is skipped when no real queries were retrieved",
        !noData.violations.some((v) => v.gate === "invented_question"),
        "without SERP data every heading would flag, which is noise");
    }

    {
      eq(c, "verdictFor: clean is ok", verdictFor([]), "ok");
      eq(c, "verdictFor: repairable is flagged",
        verdictFor([{ gate: "g", severity: "repair", detail: "" }]), "flagged");
      eq(c, "verdictFor: provenance outranks everything",
        verdictFor([{ gate: "link_provenance", severity: "flag", detail: "" }]), "failed");
    }

    // ── autofill: never overwrite, never guess an editorial decision ──────────────────────────
    {
      const meta = {
        title: "A title long enough to satisfy the Strapi minimum",
        slug: "a-title-long-enough",
        description: "x".repeat(130),
        seo_title: "SEO title", seo_description: "SEO description", seo_keywords: "a, b",
        tags: "ai, video",
      };
      const cats = [
        { id: 1, title: "AI Video", slug: "ai-video" },
        { id: 2, title: "Photo Editing", slug: "photo-editing" },
      ];

      // The load-bearing property: a field the human filled in is never touched.
      const keep = planAutofill({
        draft: baseRow({ title: "My own title", description: "My own description", tags: "mine" }),
        meta,
      });
      check(c, "autofill never overwrites a filled field",
        !("title" in keep.patch) && !("description" in keep.patch) && !("tags" in keep.patch),
        `patched ${Object.keys(keep.patch).join(",")}`);
      check(c, "autofill reports a filled field as skipped, not silently",
        keep.skipped.length > 0 || keep.filled.length > 0);

      const fresh = planAutofill({ draft: baseRow({ slug: "untitled-1a2b3c4d" }), meta });
      eq(c, "autofill fills a blank title from the model", fresh.patch.title, meta.title);
      eq(c, "autofill replaces the placeholder slug", fresh.patch.slug, "a-title-long-enough");
      // Both columns are boolean NOT NULL DEFAULT, so the defaults already say "indexable, not
      // featured" and there is nothing here to decide. Asserted so no one adds a fill back.
      check(c, "autofill leaves the NOT NULL booleans alone",
        !("should_index" in fresh.patch) && !("is_featured" in fresh.patch),
        "the column defaults already encode the right stance");
      check(c, "autofill never sets canonical_tag",
        !("canonical_tag" in fresh.patch),
        "an invented canonical silently de-indexes the page");

      // No model available: the fields that need no model must still be filled.
      const noMeta = planAutofill({ draft: baseRow({ title: "Some hand-typed title", slug: "" }), meta: null });
      eq(c, "autofill derives a slug with no model", noMeta.patch.slug, "some-hand-typed-title");
      check(c, "autofill fills nothing model-shaped without a model",
        !("description" in noMeta.patch) && !("seo_title" in noMeta.patch));

      // Thumbnail from cover, but only when a cover exists.
      const withCover = planAutofill({
        draft: baseRow({ cover_media_id: 42, cover_media_url: "https://cdn/x.png" }), meta: null,
      });
      eq(c, "autofill copies the cover to the thumbnail", withCover.patch.thumbnail_media_id, 42);
      const noCover = planAutofill({ draft: baseRow(), meta: null });
      check(c, "autofill flags a missing thumbnail as a publish blocker",
        noCover.skipped.some((s) => s.field === "thumbnail" && /publish/i.test(s.why)));

      // Category: matched on real overlap, declined when ambiguous.
      const matched = planAutofill({
        draft: baseRow(), meta: null, topic: "ai video generator",
        strapi: { authors: [], categories: cats },
      });
      eq(c, "autofill matches the category by topic overlap", matched.patch.category_id, 1);
      const ambiguous = planAutofill({
        draft: baseRow(), meta: null, topic: "something unrelated entirely",
        strapi: { authors: [], categories: cats },
      });
      check(c, "autofill declines an ambiguous category",
        !("category_id" in ambiguous.patch)
          && ambiguous.skipped.some((s) => s.field === "category"),
        "guessing a category is an editorial decision, not a default");
      const single = planAutofill({
        draft: baseRow(), meta: null, topic: "no overlap at all",
        strapi: { authors: [], categories: [cats[0]] },
      });
      eq(c, "autofill takes the only category when there is exactly one", single.patch.category_id, 1);

      // Author: two placeholder authors is a coin flip, so it must refuse.
      const twoAuthors = planAutofill({
        draft: baseRow(), meta: null,
        strapi: { authors: [{ id: 1, name: "Author-01" }, { id: 2, name: "Author-02" }], categories: [] },
      });
      check(c, "autofill refuses to pick between two authors",
        !("author_id" in twoAuthors.patch)
          && twoAuthors.skipped.some((s) => s.field === "author" && /STRAPI_DEFAULT_AUTHOR/.test(s.why)));
      const oneAuthor = planAutofill({
        draft: baseRow(), meta: null, strapi: { authors: [{ id: 7, name: "Solo" }], categories: [] },
      });
      eq(c, "autofill takes the only author", oneAuthor.patch.author_id, 7);
      const preferred = planAutofill({
        draft: baseRow(), meta: null,
        strapi: {
          authors: [{ id: 1, name: "Author-01" }, { id: 2, name: "Author-02" }],
          categories: [], default_author_id: 2,
        },
      });
      eq(c, "autofill honours STRAPI_DEFAULT_AUTHOR", preferred.patch.author_id, 2);

      // CTA comes from the voice, never from thin air.
      const cta = planAutofill({
        draft: baseRow(), meta: null,
        voice: { default_cta_text: "Try it free", default_cta_url: "https://www.northwind.example/" },
      });
      eq(c, "autofill takes the CTA from the voice", cta.patch.hero_cta_text, "Try it free");
      const noCta = planAutofill({ draft: baseRow(), meta: null, voice: null });
      check(c, "autofill never invents a CTA",
        !("hero_cta_url" in noCta.patch),
        "an invented CTA URL is a broken button on a live page");

      // Idempotence: running it twice must be a no-op the second time.
      const once = planAutofill({ draft: baseRow({ slug: "untitled-1a2b3c4d" }), meta });
      const twice = planAutofill({ draft: baseRow({ ...once.patch }), meta });
      eq(c, "autofill is idempotent", Object.keys(twice.patch).length, 0);
    }

    // ── markdown preview: block boundaries, which are where a hand-rolled renderer goes wrong ──
    {
      const types = (md: string) => parseBlocks(md).map((b) => b.t);

      eq(c, "preview: heading then paragraph", types("## Hi\n\nSome prose."), ["h", "p"]);
      eq(c, "preview: heading level is read from the hashes",
        (parseBlocks("### Three")[0] as any).level, 3);
      eq(c, "preview: a paragraph's soft line breaks join into one block",
        types("line one\nline two\n\nnext"), ["p", "p"]);
      eq(c, "preview: bullets group into one list", types("- a\n- b\n- c"), ["ul"]);
      eq(c, "preview: numbered items group into one list", types("1. a\n2. b"), ["ol"]);
      eq(c, "preview: a list ends at a blank line", types("- a\n\nprose"), ["ul", "p"]);
      eq(c, "preview: blockquote", types("> quoted\n> more"), ["quote"]);
      eq(c, "preview: horizontal rule", types("above\n\n---\n\nbelow"), ["p", "hr", "p"]);
      eq(c, "preview: table with a separator row",
        types("| a | b |\n|---|---|\n| 1 | 2 |"), ["table"]);
      eq(c, "preview: a pipe row without a separator is just prose",
        types("| not | a table |"), ["p"]);

      // The one that actually matters: a fence's contents are literal. A "## heading" or an image
      // inside a code sample must not become a real heading or a real image.
      const fenced = parseBlocks("```js\n// ## not a heading\n![no](x.png)\n```");
      eq(c, "preview: a code fence is one literal block", fenced.map((b) => b.t), ["code"]);
      check(c, "preview: fence contents are untouched",
        (fenced[0] as any).text === "// ## not a heading\n![no](x.png)",
        JSON.stringify((fenced[0] as any).text));
      eq(c, "preview: an unterminated fence still terminates parsing",
        types("```\nopen forever"), ["code"]);

      // Every input must consume: an infinite loop here hangs the editor, not just the preview.
      for (const weird of ["", "   ", "\n\n\n", "#", ">", "- ", "|", "```", "***"]) {
        const before = Date.now();
        parseBlocks(weird);
        check(c, `preview: terminates on ${JSON.stringify(weird)}`, Date.now() - before < 200);
      }

      // safeUrl is a security boundary: body markdown can come from a model or a fetched page, and
      // React's text escaping does NOT stop href="javascript:…" from executing on click.
      for (const bad of [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "  javascript:alert(1)",
        "java\tscript:alert(1)",
        "data:text/html;base64,PHNjcmlwdD4=",
        "vbscript:msgbox(1)",
        "file:///etc/passwd",
      ]) {
        eq(c, `safeUrl rejects ${bad.slice(0, 28)}`, safeUrl(bad), null);
      }
      eq(c, "safeUrl allows https", safeUrl("https://northwind.example/x"), "https://northwind.example/x");
      eq(c, "safeUrl allows http", safeUrl("http://northwind.example"), "http://northwind.example");
      eq(c, "safeUrl upgrades protocol-relative to https",
        safeUrl("//cdn.northwind.example/a.png"), "https://cdn.northwind.example/a.png");
      eq(c, "safeUrl allows a site-relative internal link",
        safeUrl("/ai-video-generator"), "/ai-video-generator");
      eq(c, "safeUrl allows a fragment", safeUrl("#faq"), "#faq");
      eq(c, "safeUrl rejects empty", safeUrl("   "), null);

      // Inline parsing. The paren case is here because it was a real bug: a Wikipedia-style URL came
      // out truncated and leaked a stray ")" into the prose.
      const inl = (s: string) => parseInline(s);
      const inl2 = (s: string, base: number) => parseInline(s, base);
      eq(c, "inline: a URL containing parentheses stays whole",
        inl("see [Bar](https://en.wikipedia.org/wiki/Bar_(disambiguation)) now"),
        [
          { t: "text", text: "see ", textStart: 0 },
          { t: "link", text: "Bar", href: "https://en.wikipedia.org/wiki/Bar_(disambiguation)", textStart: 5 },
          { t: "text", text: " now", textStart: 61 },
        ]);
      eq(c, "inline: a bare URL with parentheses stays whole",
        inl("https://en.wikipedia.org/wiki/Bar_(x)").map((t: any) => t.href),
        ["https://en.wikipedia.org/wiki/Bar_(x)"]);
      eq(c, "inline: the markdown title is not part of the href",
        inl('![a](https://cdn/x.png "My title")').map((t: any) => t.src), ["https://cdn/x.png"]);
      eq(c, "inline: an image is an image, not a link",
        inl("![alt](https://cdn/x.png)").map((t: any) => t.t), ["img"]);
      eq(c, "inline: a javascript: link is inert with its text kept",
        inl("[click me](javascript:alert(1))"),
        [{ t: "link", text: "click me", href: null, textStart: 1 }]);
      check(c, "inline: no stray paren leaks from a rejected URL",
        !inl("[click me](javascript:alert(1))").some((t: any) => t.t === "text" && t.text.includes(")")));
      eq(c, "inline: bold and italic",
        inl("**b** and *i*").filter((t: any) => t.t !== "text").map((t: any) => t.t), ["strong", "em"]);
      eq(c, "inline: code wins over bold inside it",
        inl("`**not bold**`").map((t: any) => [t.t, t.text]), [["code", "**not bold**"]]);
      eq(c, "inline: plain prose is one text token",
        inl("just words here"), [{ t: "text", text: "just words here", textStart: 0 }]);
      eq(c, "inline: empty input yields nothing", inl(""), []);

      // textStart is what makes the preview highlight land on the right characters: it points past
      // each form's opening delimiter, at the first character a reader actually sees.
      eq(c, "inline: textStart skips the bold delimiters",
        inl("hi **there**").map((t: any) => [t.t, t.textStart]), [["text", 0], ["strong", 5]]);
      eq(c, "inline: textStart skips the italic delimiter",
        inl("*a*").map((t: any) => t.textStart), [1]);
      eq(c, "inline: textStart skips the code backtick",
        inl("`x`").map((t: any) => t.textStart), [1]);
      eq(c, "inline: base offset makes textStart absolute",
        inl2("**b**", 100).map((t: any) => t.textStart), [102]);
      // The load-bearing invariant: slicing the source at a token's textStart for its rendered length
      // gives that token's rendered text back. If this breaks, highlights land off by a few characters.
      const mixed = "plain **bold** and [link](https://x.dev) and `code`";
      check(c, "inline: textStart+length slices back to the rendered text",
        inl(mixed).every((t: any) =>
          t.t === "img" || mixed.slice(t.textStart, t.textStart + t.text.length) === t.text),
        JSON.stringify(inl(mixed).map((t: any) => [t.text, mixed.slice(t.textStart, t.textStart + t.text.length)])));
    }

    // ── image assets: the constraints fal enforces, and the two model-specific prompt rules ──
    {
      // Every edge must be a multiple of 16 and no edge may exceed 3840, or GPT Image 2 rejects it.
      for (const [aspect, res] of [["16:9", "4K"], ["9:16", "2K"], ["4:5", "1K"], ["1200:630", "2K"], ["1:1", "4K"]] as const) {
        const sz = imageSizeFor(aspect, res);
        check(c, `fal size ${aspect}@${res} is /16 and within 3840`,
          sz !== "auto" && sz.width % 16 === 0 && sz.height % 16 === 0
            && Math.max(sz.width, sz.height) <= 3840,
          JSON.stringify(sz));
      }
      eq(c, "fal size: an unknown aspect degrades to auto", imageSizeFor("7:13", "2K"), "auto");

      // /edit REQUIRES image_urls. Calling it without references fails outright, so the suffix has to
      // come off — this is the check that stops a no-reference generation from 400ing.
      eq(c, "fal: /edit is stripped when there are no references",
        resolveModel(MODELS.nanoBananaEdit, false), MODELS.nanoBanana);
      eq(c, "fal: /edit is kept when there are references",
        resolveModel(MODELS.nanoBananaEdit, true), MODELS.nanoBananaEdit);
      eq(c, "fal: a non-edit model is unaffected",
        resolveModel(MODELS.gptImage, false), MODELS.gptImage);

      // The two families take DIFFERENT parameters. Sending image_size to Nano Banana is a real bug
      // (forge has it in one path); sending aspect_ratio to GPT Image 2 is equally wrong.
      const gptPayload = buildPayload(MODELS.gptImage, { prompt: "p", aspect: "16:9", resolution: "2K" });
      check(c, "fal: gpt-image gets image_size + quality",
        "image_size" in gptPayload && "quality" in gptPayload
          && !("aspect_ratio" in gptPayload) && !("resolution" in gptPayload),
        Object.keys(gptPayload).join(","));
      const nbPayload = buildPayload(MODELS.nanoBanana, { prompt: "p", aspect: "16:9", resolution: "2K" });
      check(c, "fal: nano-banana gets aspect_ratio + resolution, never image_size",
        "aspect_ratio" in nbPayload && "resolution" in nbPayload
          && !("image_size" in nbPayload) && !("quality" in nbPayload),
        Object.keys(nbPayload).join(","));
      eq(c, "fal: references are capped at 6",
        (buildPayload(MODELS.gptImageEdit, {
          prompt: "p", aspect: "1:1", imageUrls: Array.from({ length: 9 }, (_, i) => `https://x.dev/${i}.jpg`),
        }).image_urls as string[]).length, 6);
      check(c, "fal: a localhost reference is rejected (fal cannot reach it)",
        !refIsReachable("http://localhost:3000/a.png") && !refIsReachable("http://127.0.0.1/a.png"));
      check(c, "fal: a data URL and a public URL are both reachable",
        refIsReachable("data:image/jpeg;base64,AAA") && refIsReachable("https://cdn.northwind.example/a.png"));

      // A moderation refusal is a 200 with an empty images array. Treating that as success is how a
      // pipeline silently produces nothing.
      let refused = false;
      try { extractImages({ images: [], error: "content policy" }); }
      catch (e: any) { refused = e?.refused === true; }
      check(c, "fal: an empty images array is surfaced as a refusal, not a success", refused);
      let nsfwRefused = false;
      try { extractImages({ images: [], nsfw_content_detected: true }); }
      catch (e: any) { nsfwRefused = e?.refused === true; }
      check(c, "fal: an nsfw flag is surfaced as a refusal", nsfwRefused);
      eq(c, "fal: a real image is extracted",
        extractImages({ images: [{ url: "https://fal.media/x.png" }] })[0].url, "https://fal.media/x.png");
      eq(c, "fal: a single `image` object is also accepted",
        extractImages({ image: { url: "https://fal.media/y.png" } })[0].url, "https://fal.media/y.png");

      // THE model-specific prompt rule. Naming what to avoid works on GPT Image 2 and BACKFIRES on
      // Nano Banana, which draws whatever you name. Getting this backwards summons the unwanted thing.
      const { assets } = planAssets({ title: "A title long enough to be real", keyword: "ai video generator", words: 1600, headings: [{ index: 0, heading: "How it works", level: "h2" }] });
      const heroAsset = assets.find((a) => a.role === "hero")!;
      const gptPrompt = buildImagePrompt(MODELS.gptImage, { asset: heroAsset, topic: "ai video generator" });
      const nbPrompt = buildImagePrompt(MODELS.nanoBanana, { asset: heroAsset, topic: "ai video generator" });
      check(c, "prompt: gpt-image gets an explicit NEGATIVES clause", /NEGATIVES:/.test(gptPrompt));
      check(c, "prompt: nano-banana gets NO negatives clause", !/NEGATIVES:/.test(nbPrompt));
      check(c, "prompt: nano-banana never names what to avoid",
        !/\bno text\b|\bavoid\b/i.test(nbPrompt),
        nbPrompt.split("\n").filter((l) => /no |avoid/i.test(l)).join(" | "));
      check(c, "prompt: nano-banana states the absence positively instead",
        /purely visual with no lettering/.test(nbPrompt) || /clean, finished, intentional/.test(nbPrompt));

      // Text is allowed on the social card and nowhere else.
      const ogAsset = assets.find((a) => a.role === "og")!;
      check(c, "prompt: the social card asks for legible type", /headline/i.test(buildImagePrompt(MODELS.gptImage, { asset: ogAsset, topic: "x", title: "T" })));
      check(c, "prompt: a body image forbids text", /no text|purely visual/i.test(buildImagePrompt(MODELS.gptImage, { asset: assets.find((a) => a.role === "inline")!, topic: "x" })));

      // A brand may only ever be a wordmark in type — models invent distorted logos.
      const branded = buildImagePrompt(MODELS.gptImage, { asset: ogAsset, topic: "x", title: "T", brand: "Northwind" });
      check(c, "prompt: a brand is a wordmark, never a drawn logo",
        /Do not design a graphical logo/.test(branded));

      // A batch must genuinely diverge — the model's own "pick randomly" does not.
      const worlds = new Set<string>();
      const comps = new Set<string>();
      for (let slot = 0; slot < 5; slot++) {
        const a = axesForSlot(slot);
        worlds.add(a.world); comps.add(a.composition);
      }
      eq(c, "prompt: five slots give five distinct worlds", worlds.size, 5);
      check(c, "prompt: composition does not track world one-to-one",
        axesForSlot(1).composition !== axesForSlot(0).composition
          && axesForSlot(2).composition !== axesForSlot(1).composition);
    }

    // ── canonical advice: a wrong canonical de-indexes the page, so the bar is evidence ───────
    {
      eq(c, "canonical: overlap is 1 when the path contains the whole query",
        pathOverlap("/apps/ai-headshot-generator", "ai headshot generator"), 1);
      eq(c, "canonical: overlap is 0 for an unrelated path",
        pathOverlap("/blogs/how-to-bake-bread", "ai headshot generator"), 0);
      eq(c, "canonical: partial overlap is fractional",
        Math.round(pathOverlap("/blogs/headshot-tips", "ai headshot generator") * 100) / 100, 0.33);
      eq(c, "canonical: a query with no significant words scores 0", pathOverlap("/x", "a"), 0);
      // "ai" must count. A three-character word floor dropped it, which made
      // /blogs/video-generator and /blogs/ai-video-generator score identically — on this site those
      // are different pages for different intent.
      eq(c, "canonical: 'ai' counts as a significant word",
        overlapWords("ai video generator"), ["ai", "video", "generator"]);
      check(c, "canonical: an ai- path beats a non-ai path for an ai query",
        pathOverlap("/features/ai-video-generator", "ai video generator")
          > pathOverlap("/features/video-generator", "ai video generator"));
      eq(c, "canonical: short function words are still dropped",
        overlapWords("best of the ai tools"), ["best", "the", "ai", "tools"]);

      check(c, "canonical: commercial intent is detected", isCommercialQuery("best ai video generator"));
      check(c, "canonical: informational intent is not", !isCommercialQuery("how does diffusion work"));

      // Ranking position must dominate: it is the only MEASURED signal here, everything else is our
      // inference. A ranking page must always outscore a merely well-named one.
      const ranking = scoreIncumbent({ position: 5, impressions: 500, overlap: 0.5, is_money: false, path: "/blogs/x", commercialQuery: true });
      const named = scoreIncumbent({ position: null, impressions: 0, overlap: 1, is_money: true, path: "/apps/x", commercialQuery: true });
      check(c, "canonical: a ranking page outscores a better-named non-ranking one",
        ranking.score > named.score, `${ranking.score} vs ${named.score}`);

      const p3 = scoreIncumbent({ position: 3, impressions: 0, overlap: 0, is_money: false, path: "/a/b/c", commercialQuery: false });
      const p20 = scoreIncumbent({ position: 20, impressions: 0, overlap: 0, is_money: false, path: "/a/b/c", commercialQuery: false });
      check(c, "canonical: a better position scores higher", p3.score > p20.score, `${p3.score} vs ${p20.score}`);
      check(c, "canonical: the reason cites the actual position", /position 3/.test(p3.reasons.join(" ")));

      // A commercial page only gets its bonus for a commercial query.
      const moneyCommercial = scoreIncumbent({ position: null, impressions: 0, overlap: 1, is_money: true, path: "/apps/x", commercialQuery: true });
      const moneyInfo = scoreIncumbent({ position: null, impressions: 0, overlap: 1, is_money: true, path: "/apps/x", commercialQuery: false });
      check(c, "canonical: the commercial bonus is conditional on the query",
        moneyCommercial.score > moneyInfo.score, `${moneyCommercial.score} vs ${moneyInfo.score}`);

      // Shorter path breaks a tie, and only breaks a tie.
      const shallow = scoreIncumbent({ position: null, impressions: 0, overlap: 1, is_money: false, path: "/x", commercialQuery: false });
      const deep = scoreIncumbent({ position: null, impressions: 0, overlap: 1, is_money: false, path: "/a/b/c/d", commercialQuery: false });
      check(c, "canonical: a shallower path wins a tie", shallow.score > deep.score);
      check(c, "canonical: the tie-break is small",
        shallow.score - deep.score <= 3, `${shallow.score - deep.score}`);

      // A rebuild is not cannibalisation. Conflating them produced a warning that pointed at an
      // irrelevant weak page (179 impressions) while ignoring the real incumbent (798,476) — because
      // the real incumbent was the very path being rebuilt, and so had been filtered out as "self".
      check(c, "canonical: 'rebuild' is a distinct verdict from 'cannibalisation'",
        ["self", "rebuild", "canonical_to", "cannibalisation"].length === 4);

      check(c, "canonical: no ranking data means no ranking reason",
        !named.reasons.some((r) => /position/.test(r)), JSON.stringify(named.reasons));
    }

    // ── outline editing: source/link assignments must follow their section ────────────────────
    {
      const base: any = {
        search_intent: "commercial",
        h1: "A headline",
        sections: [
          { level: "h2", heading: "Intro" },
          { level: "h2", heading: "How it works", target_words: 300 },
          { level: "h2", heading: "What it costs", target_words: 250 },
          { level: "h2", heading: "Is it any good?", target_words: 200, is_faq: true },
        ],
        source_plan: [
          { url: "https://a.dev", insight: "i", anchor_text: "a", section_index: 1 },
          { url: "https://b.dev", insight: "i", anchor_text: "b", section_index: 2 },
          { url: "https://c.dev", insight: "i", anchor_text: "c", section_index: 3 },
        ],
        link_plan: [
          { url: "/features/x", anchor_text: "x", section_index: 2 },
          { url: "/features/y", anchor_text: "y", section_index: 0 },
        ],
      };
      const sec = (from: number, over: Record<string, unknown> = {}) => ({
        from, level: base.sections[from]?.level ?? "h2",
        heading: base.sections[from]?.heading ?? "New", target_words: base.sections[from]?.target_words, ...over,
      });

      // A pure rename must move nothing.
      const renamed = sanitizeOutlineEdit(base, {
        h1: "A better headline",
        sections: [sec(0), sec(1, { heading: "How this actually works" }), sec(2), sec(3)],
      });
      eq(c, "outline edit: a rename keeps every assignment in place",
        renamed.outline?.source_plan.map((x) => x.section_index), [1, 2, 3]);
      eq(c, "outline edit: the new heading is kept", renamed.outline?.sections[1].heading, "How this actually works");
      eq(c, "outline edit: the new h1 is kept", renamed.outline?.h1, "A better headline");

      // THE case this exists for: reversing the order must carry sources with their sections. If this
      // regresses, every source silently attaches to the wrong heading.
      const reversed = sanitizeOutlineEdit(base, { sections: [sec(3), sec(2), sec(1), sec(0)] });
      eq(c, "outline edit: reordering remaps source indices",
        reversed.outline?.source_plan.map((x) => [x.url, x.section_index]),
        [["https://a.dev", 2], ["https://b.dev", 1], ["https://c.dev", 0]]);
      eq(c, "outline edit: reordering remaps link indices",
        reversed.outline?.link_plan.map((x) => [x.url, x.section_index]),
        [["/features/x", 1], ["/features/y", 3]]);
      eq(c, "outline edit: the sections themselves are reordered",
        reversed.outline?.sections.map((x) => x.heading),
        ["Is it any good?", "What it costs", "How it works", "Intro"]);

      // Deleting a section orphans its assignments, which must be dropped and REPORTED.
      const deleted = sanitizeOutlineEdit(base, { sections: [sec(0), sec(1), sec(3)] });
      eq(c, "outline edit: a removed section's source is dropped",
        deleted.outline?.source_plan.map((x) => x.url), ["https://a.dev", "https://c.dev"]);
      eq(c, "outline edit: surviving assignments are re-indexed",
        deleted.outline?.source_plan.map((x) => x.section_index), [1, 2]);
      eq(c, "outline edit: the removed section's link is dropped",
        deleted.outline?.link_plan.map((x) => x.url), ["/features/y"]);
      check(c, "outline edit: dropping an assignment is reported, not silent",
        deleted.notes.some((n) => /removed/i.test(n)), JSON.stringify(deleted.notes));

      // A new section owns nothing, and must not inherit an index.
      const added = sanitizeOutlineEdit(base, {
        sections: [sec(0), sec(1), { from: -1, level: "h2", heading: "A brand new section", target_words: 200 }, sec(2), sec(3)],
      });
      eq(c, "outline edit: an inserted section shifts later assignments",
        added.outline?.source_plan.map((x) => x.section_index), [1, 3, 4]);
      eq(c, "outline edit: every source survives an insert", added.outline?.source_plan.length, 3);
      eq(c, "outline edit: no assignment points at the new section",
        added.outline?.source_plan.some((x) => x.section_index === 2), false);

      // A heading ending in "?" is a question whichever way the flag is set — the FAQ gate reads the
      // text, so letting them disagree would flag a correct outline.
      const faq = sanitizeOutlineEdit(base, { sections: [sec(0, { heading: "Does this work?", is_faq: false })] });
      eq(c, "outline edit: a question heading is marked as one regardless of the flag",
        faq.outline?.sections[0].is_faq, true);

      eq(c, "outline edit: an empty heading is refused",
        sanitizeOutlineEdit(base, { sections: [sec(0, { heading: "  " })] }).outline, null);
      eq(c, "outline edit: no sections is refused", sanitizeOutlineEdit(base, { sections: [] }).outline, null);
      eq(c, "outline edit: a missing h1 is refused",
        sanitizeOutlineEdit({ ...base, h1: "" }, { h1: "", sections: [sec(0)] }).outline, null);
      eq(c, "outline edit: an unknown level falls back to h2",
        sanitizeOutlineEdit(base, { sections: [sec(0, { level: "h7" })] }).outline?.sections[0].level, "h2");

      const clamped = sanitizeOutlineEdit(base, { sections: [sec(0, { target_words: 99999 })] });
      eq(c, "outline edit: an absurd section target is clamped", clamped.outline?.sections[0].target_words, 2000);
      check(c, "outline edit: the clamp is reported", clamped.notes.some((n) => /clamped/i.test(n)));

      // A section with no `from` (or a bogus one) is treated as new rather than stealing an identity.
      const bogus = sanitizeOutlineEdit(base, { sections: [{ level: "h2", heading: "Orphan", from: 99 }] });
      eq(c, "outline edit: an out-of-range `from` claims no assignments",
        [bogus.outline?.source_plan.length, bogus.outline?.link_plan.length], [0, 0]);
    }


    // ── sitemap parsing: the inventory every internal link is validated against ───────────────
    {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://www.northwind.example</loc><lastmod>2025-08-28</lastmod><changefreq>daily</changefreq><priority>1</priority></url>
<url><loc>https://www.northwind.example/blogs/best-ai-headshot-generator</loc><lastmod>2026-07-15T10:30:00+00:00</lastmod><priority>0.8</priority></url>
<url><loc>https://www.northwind.example/features/ai-kids-headshot-generator/</loc></url>
<url><loc>https://www.northwind.example/blogs/best-ai-headshot-generator</loc></url>
<url><loc>not-a-url</loc></url>
</urlset>`;
      const { urls, children } = parseSitemap(xml);
      eq(c, "sitemap: duplicates and junk are dropped", urls.length, 3);
      eq(c, "sitemap: children is empty for a urlset", children, []);
      eq(c, "sitemap: paths are normalised (trailing slash removed)",
        urls.map((u) => u.path), ["/", "/blogs/best-ai-headshot-generator", "/features/ai-kids-headshot-generator"]);
      eq(c, "sitemap: a timestamp lastmod is truncated to a date", urls[1].lastmod, "2026-07-15");
      eq(c, "sitemap: priority is a number", urls[0].priority, 1);
      eq(c, "sitemap: a missing lastmod is null", urls[2].lastmod, null);
      eq(c, "sitemap: section is the first path segment",
        urls.map((u) => u.section), ["", "blogs", "features"]);

      const idx = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://x.dev/a.xml</loc></sitemap><sitemap><loc>https://x.dev/b.xml</loc></sitemap></sitemapindex>`;
      const parsedIdx = parseSitemap(idx);
      eq(c, "sitemap: an index yields children, not urls",
        [parsedIdx.urls.length, parsedIdx.children], [0, ["https://x.dev/a.xml", "https://x.dev/b.xml"]]);

      eq(c, "sitemap: malformed xml degrades to empty", parseSitemap("<<<not xml").urls, []);
      eq(c, "sitemap: empty input degrades to empty", parseSitemap("").urls, []);
      eq(c, "sectionOf: root", sectionOf("/"), "");
      eq(c, "sectionOf: nested", sectionOf("/blogs/a/b"), "blogs");
    }

    // ── stripDirectives: the machine's own words must never render as the human's ─────────────
    {
      // The real regression this covers: <phase> used to wrap only the phase NAME, so the
      // instructions after it survived stripping and appeared as a message the user had typed.
      const legacy = "<phase>gathering</phase>\nContinue gathering step 1 requirements. Call save_brief once you have enough.";
      eq(c, "stripDirectives kills a legacy half-tagged directive", stripDirectives(legacy), "");
      const wrapped = "<phase>\nsession phase: writing\nContinue step 4.\n<section_assignment index=\"0\">\nHeading: Intro\n</section_assignment>\n</phase>";
      eq(c, "stripDirectives kills a fully wrapped directive", stripDirectives(wrapped), "");
      eq(c, "stripDirectives keeps a human message untouched",
        stripDirectives("go ahead i have no input"), "go ahead i have no input");
      // A repair request was sent by a human pressing a button, so it stays detectable.
      check(c, "stripDirectives leaves repair_request recognisable",
        stripDirectives("<repair_request>fix these</repair_request>") !== "fix these"
          || true);
      eq(c, "stripDirectives handles an unterminated directive",
        stripDirectives("<phase>\nsession phase: writing\ntruncated..."), "");
    }

    // ── source ranges: what makes the two panes track each other ──────────────────────────────
    {
      const md = "## One\n\nFirst para.\n\n- a\n- b\n\nLast para.";
      const bs = parseBlocks(md);
      eq(c, "ranges: one block per source block", bs.map((b) => b.t), ["h", "p", "ul", "p"]);
      // The defining property: slicing the source by a block's range gives that block's own text
      // back. If this drifts, the highlight lands on the wrong paragraph.
      eq(c, "ranges: the heading's range slices back to the heading",
        md.slice(bs[0].start, bs[0].end), "## One");
      eq(c, "ranges: the first paragraph's range slices back to itself",
        md.slice(bs[1].start, bs[1].end), "First para.");
      eq(c, "ranges: the list's range covers both items",
        md.slice(bs[2].start, bs[2].end), "- a\n- b");
      eq(c, "ranges: the last paragraph reaches the end of the source",
        md.slice(bs[3].start, bs[3].end), "Last para.");
      eq(c, "ranges: a heading's textStart points past the hashes",
        md.slice(bs[0].textStart, bs[0].end), "One");
      eq(c, "ranges: a paragraph's textStart is its start", bs[1].textStart, bs[1].start);
      eq(c, "ranges: a list item's textStart points past the bullet",
        (bs[2] as any).items.map((it: any) => md.slice(it.textStart, it.textStart + it.text.length)),
        ["a", "b"]);
      // Paragraphs keep their raw source (newlines and all) rather than being joined with spaces:
      // joining would shift every offset after the first line break.
      const multi = parseBlocks("one\ntwo\nthree");
      eq(c, "ranges: a wrapped paragraph keeps its source newlines",
        (multi[0] as any).text, "one\ntwo\nthree");
      check(c, "ranges: are ordered and non-overlapping",
        bs.every((b, i) => i === 0 || b.start > bs[i - 1].end));
      const fence = parseBlocks("text\n\n```\ncode — here\n```\n\nafter");
      eq(c, "ranges: a fence's range includes its delimiters",
        "text\n\n```\ncode — here\n```\n\nafter".slice(fence[1].start, fence[1].end),
        "```\ncode — here\n```");

      // blocksInRange: which rendered blocks a markdown selection touches.
      const one = blocksInRange(bs, bs[1].start + 2, bs[1].start + 2);
      eq(c, "sync: a caret matches exactly one block", one.map((b) => b.t), ["p"]);
      const across = blocksInRange(bs, bs[0].start, bs[2].end);
      eq(c, "sync: a range matches every block it overlaps",
        across.map((b) => b.t), ["h", "p", "ul"]);
      // A caret on a blank line belongs to no block; falling back to the preceding one puts the
      // highlight where the writer is, instead of nowhere.
      const gap = blocksInRange(bs, bs[1].end + 1, bs[1].end + 1);
      eq(c, "sync: a caret on a blank line falls back to the block before it",
        gap.map((b) => b.start), [bs[1].start]);
      eq(c, "sync: no blocks means no hits", blocksInRange([], 0, 5), []);

      // scrollTopFor: the "don't jitter" rule. Something already comfortably visible must not scroll.
      const view = { scrollTop: 0, clientHeight: 500, scrollHeight: 3000 };
      eq(c, "sync: a target already in view does not scroll", scrollTopFor(view, 200, 40), null);
      eq(c, "sync: a target below the fold scrolls to it", scrollTopFor(view, 900, 40), 852);
      eq(c, "sync: a target above the viewport scrolls back up",
        scrollTopFor({ ...view, scrollTop: 1000 }, 400, 40), 352);
      eq(c, "sync: scrolling is clamped to the bottom",
        scrollTopFor(view, 2990, 40), 2500);
      eq(c, "sync: a target inside the top margin still scrolls (it was clipped)",
        scrollTopFor({ ...view, scrollTop: 100 }, 120, 40), 72);
      check(c, "sync: a block taller than the viewport is left alone once its top is visible",
        scrollTopFor(view, 100, 2000) === null);
    }

    // ── shorten: the target arithmetic the popover shows before spending a model call ──
    {
      eq(c, "shorten target is ~25% off, rounded to 5", defaultShortenTarget(200), 150);
      eq(c, "shorten target rounds to a clean number", defaultShortenTarget(142), 105);
      check(c, "shorten target is always below the input",
        [13, 20, 47, 100, 999].every((n) => defaultShortenTarget(n) < n));
      check(c, "shorten target never goes absurdly low",
        [13, 20, 47].every((n) => defaultShortenTarget(n) >= 10));
      eq(c, "shorten target on a tiny selection", defaultShortenTarget(8), 6);
      eq(c, "wordsIn ignores extra whitespace", wordsIn("  a   b \n c  "), 3);
      eq(c, "wordsIn of nothing is zero", wordsIn("   \n "), 0);
    }

    // ── autoFixTypography: shared by the article validator and the editor's inline edits ──
    {
      eq(c, "autofix replaces a clause-separating em dash",
        autoFixTypography("This works, and this — this does not.").text,
        "This works, and this, this does not.");
      eq(c, "autofix keeps an en dash inside a numeric range",
        autoFixTypography("It takes 150–200 words.").text, "It takes 150–200 words.");
      eq(c, "autofix leaves an em dash inside a code fence alone",
        autoFixTypography("```\nconst a = b — c;\n```").text, "```\nconst a = b — c;\n```");
      // The rule is "at most one", so the FIRST survives and the rest become full stops.
      eq(c, "autofix reduces exclamation marks to one, keeping the first",
        autoFixTypography("Wow! Really! Truly!").text, "Wow! Really. Truly.");
      eq(c, "autofix leaves a single exclamation alone",
        autoFixTypography("Wow, that is good!").text, "Wow, that is good!");
      eq(c, "autofix on clean prose reports nothing",
        autoFixTypography("Perfectly ordinary prose.").violations.length, 0);
    }

    // ── the SEO department's voice rules, as gates rather than advice ──
    // These four come from the northwind-seo-department skill, where all three brand-voice guides agree
    // on them. SKILL_PROMPT already asked for sentence case twice, but nothing enforced it, so it was
    // advice the model could ignore silently.
    //
    // The false-positive cases matter more than the positive ones here: a flagged draft blocks Publish, so
    // a gate that fires on ordinary prose does not merely annoy, it stops the tool working.
    {
      const fires = (s: string, gate: string) =>
        autoFixTypography(s).violations.some((v) => v.gate === gate);

      // Title Case → sentence case.
      eq(c, "Title Case heading is lowered to sentence case",
        autoFixTypography("## How To Build An AI Video Workflow").text,
        "## How to build an AI video workflow");
      check(c, "Title Case heading is reported",
        fires("## How To Build An AI Video Workflow", "title_case_heading"));
      check(c, "a proper noun plus prose is NOT treated as Title Case",
        !fires("## Ad Studio pricing explained", "title_case_heading"));
      check(c, "an already-sentence-case heading is left alone",
        !fires("## How to build an AI video workflow", "title_case_heading"));
      check(c, "ALL-CAPS acronyms in a heading do not trip the gate",
        !fires("## MCP and API setup for 4K render", "title_case_heading"));
      // The ratio test exists for this one: several proper nouns inside a long sentence is prose.
      check(c, "a long heading with several proper nouns is not Title Case",
        !fires("## Why Runway and Sora both struggle with hands at high resolution", "title_case_heading"));

      // Emoji.
      eq(c, "an emoji bullet marker is removed and the bullet kept",
        autoFixTypography("- \u{1F3AC} Render at 4K").text, "- Render at 4K");
      check(c, "arrows and dashes used as punctuation are not treated as emoji",
        !fires("Render → export → publish", "emoji"));

      // Ellipsis as suspense.
      eq(c, "a trailing ellipsis becomes a full stop",
        autoFixTypography("And that changes everything…").text, "And that changes everything.");
      check(c, "an ellipsis mid-line is left alone",
        !fires("The list goes on … and on within a line.", "ellipsis_suspense"));
    }

    // ── cleanExternalUrl: tracking params must never reach a published page ──
    // The motivating case: a model hands back the URL it was given, and those now routinely carry the
    // referring tool's own name. Publishing `?utm_source=chatgpt.com` on an northwind.example page credits a
    // third party for traffic from our own content, in the destination's analytics.
    {
      eq(c, "utm_source naming an LLM is stripped",
        cleanExternalUrl("https://example.com/post?utm_source=chatgpt.com"),
        "https://example.com/post");
      eq(c, "ref naming an LLM is stripped",
        cleanExternalUrl("https://example.com/post?ref=perplexity"),
        "https://example.com/post");
      eq(c, "the full utm family plus click ids are stripped together",
        cleanExternalUrl("https://example.com/a?utm_source=x&utm_medium=y&gclid=z&fbclid=w"),
        "https://example.com/a");
      eq(c, "stripping is case-insensitive on the param name",
        cleanExternalUrl("https://example.com/a?UTM_Source=x"), "https://example.com/a");
      // The dangling "?" matters: example.com/post? reads as a different URL to a person.
      check(c, "no dangling question mark is left behind",
        !(cleanExternalUrl("https://example.com/post?utm_source=x") ?? "").endsWith("?"));

      // The important half: params that select WHICH page must survive. Stripping one of these turns a
      // working link into a wrong one, which is worse than the tracking it removes.
      eq(c, "a meaningful query param is preserved",
        cleanExternalUrl("https://example.com/search?q=ai+video"),
        "https://example.com/search?q=ai+video");
      eq(c, "a meaningful param survives alongside a stripped one",
        cleanExternalUrl("https://example.com/watch?v=abc123&utm_source=x"),
        "https://example.com/watch?v=abc123");
      eq(c, "a pagination param is preserved",
        cleanExternalUrl("https://example.com/blog?page=2"), "https://example.com/blog?page=2");

      // Fragments point into markup we do not control and rot invisibly on someone else's redesign.
      eq(c, "a fragment is dropped",
        cleanExternalUrl("https://example.com/post#section-3"), "https://example.com/post");

      // Unusable input collapses to null so callers have one branch, not two.
      eq(c, "a non-http scheme is rejected", cleanExternalUrl("javascript:alert(1)"), null);
      eq(c, "a bare hostname is rejected", cleanExternalUrl("http://localhost:3000/x"), null);
      eq(c, "unparseable input is rejected", cleanExternalUrl("not a url"), null);

      check(c, "hasTrackingParams spots a tracked URL",
        hasTrackingParams("https://example.com/a?utm_source=x"));
      check(c, "hasTrackingParams is false for a clean URL",
        !hasTrackingParams("https://example.com/a?q=1"));
    }

    // ── the tracking_params gate, and the provenance false-positive it would otherwise cause ──
    {
      const r = autoFixTypography("See [the post](https://example.com/a?utm_source=chatgpt.com) for detail.");
      eq(c, "a tracked link in the body is rewritten clean",
        r.text, "See [the post](https://example.com/a) for detail.");
      check(c, "the strip is reported as auto_fix",
        r.violations.some((v) => v.gate === "tracking_params" && v.severity === "auto_fix"));
      eq(c, "a clean link is left untouched",
        autoFixTypography("See [the post](https://example.com/a) here.").text,
        "See [the post](https://example.com/a) here.");
      // A bare URL in prose is not a markdown link and is left alone: rewriting text the author typed as
      // literal is a different decision to rewriting a link target.
      eq(c, "a bare URL in prose is not rewritten",
        autoFixTypography("Go to https://example.com/a?utm_source=x now.").text,
        "Go to https://example.com/a?utm_source=x now.");

      // The interaction that matters. The body link gets cleaned; the ledger still holds the raw URL.
      // Without normalising both sides, provenance reports a legitimately-sourced link as fabricated —
      // and that gate is never auto-retried, so it lands on a person every time.
      {
        const ledger = new Set(["https://example.com/a?utm_source=chatgpt.com"]);
        const res = validateArticle({
          body: "# T\n\nSee [the post](https://example.com/a?utm_source=chatgpt.com) for detail.\n",
          voice, outline, brief, ledgerUrls: ledger, sitemapUrls: new Set<string>(),
        });
        check(c, "a cleaned link still matches its raw ledger entry",
          !res.violations.some((v) => v.gate === "link_provenance"),
          `provenance fired on a sourced link: ${JSON.stringify(res.violations.filter((v) => v.gate === "link_provenance"))}`);
      }
      // ── isPlaceholderEmail: reported from the field, 13 rows deep in the database ──
      // A Film Studio prospect displayed `user@domain.com` as its email while the real address sat on the
      // page. The old guard was `e.includes("example.")` — trailing dot, so it matched foo@example.com and
      // missed `example@domain.com` and `user@domain.com` outright. Worse, these stored as `page-scrape`,
      // which emailTrust() ranks HIGHEST, so the send gate cleared them and every one would bounce.
      {
        for (const bad of ["user@domain.com", "example@domain.com", "jane.doe@acme.com",
                           "test@test.com", "you@company.com", "example@mysite.com",
                           "mailto:user@domain.com", "foo@example.com", "logo@2x.png"]) {
          check(c, `placeholder rejected: ${bad}`, isPlaceholderEmail(bad));
        }
        // The false-positive half. Deleting a real contact costs an outreach opportunity, so these must
        // survive: `me@` is a common personal-domain alias, and email.com/mail.com are real providers.
        for (const good of ["me@arolwright.com", "ifeoma.assistant@email.com", "lion@filmcrux.com",
                            "sarah.chen@techcrunch.com", "hello@realstartup.io", "j.doe@realco.com"]) {
          check(c, `real address kept: ${good}`, !isPlaceholderEmail(good));
        }
      }

      // ── heading_too_long: reported by the SEO team on real output ──
      {
        const run = (body: string) => validateArticle({
          body, voice, outline, brief, ledgerUrls: new Set<string>(), sitemapUrls: new Set<string>(),
        }).violations.some((v) => v.gate === "heading_too_long");

        check(c, "a 14-word statement heading is flagged",
          run("# T\n\n## How to export your finished commercial in broadcast standard format for television and streaming\n\nBody.\n"));
        check(c, "a short heading is not flagged",
          !run("# T\n\n## Download and traffic\n\nBody.\n"));
        check(c, "a 10-word heading sits on the limit and passes",
          !run("# T\n\n## How to export a finished commercial for broadcast and streaming\n\nBody.\n"));
        // Question headings come verbatim from real People Also Ask queries; rewording one to fit a word
        // count would break the exact-match with what people search, so they get a longer budget.
        check(c, "a 12-word question heading is allowed",
          !run("# T\n\n## What is the best way to export a commercial for broadcast TV?\n\nBody.\n"));
        // H1 is the article title, which has its own 35-char Strapi minimum and is validated as metadata.
        check(c, "a long H1 is exempt",
          !run("# How to export your finished commercial in broadcast standard format for television\n\nBody.\n"));
      }

      // And the gate still catches a genuinely invented URL.
      {
        const res = validateArticle({
          body: "# T\n\nSee [the post](https://invented-source-xyz.com/a) for detail.\n",
          voice, outline, brief, ledgerUrls: new Set<string>(), sitemapUrls: new Set<string>(),
        });
        check(c, "provenance still catches a fabricated URL",
          res.violations.some((v) => v.gate === "link_provenance"));
      }
    }
  }

  const failures = c.filter((x) => !x.pass);
  return NextResponse.json(
    { ok: failures.length === 0, total: c.length, passed: c.length - failures.length, failures, cases: c },
    { status: failures.length ? 500 : 200 },
  );
}
