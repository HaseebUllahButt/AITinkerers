// The three tools that drive the workflow's phase machine: save_brief, propose_outline,
// submit_section. Kept separate from tools.ts (research) because these mutate writer_sessions and
// blog_drafts, while research tools are read-only against external services.
//
// The load-bearing property of this file: propose_outline is the LAST tool call the model can make
// before a human acts. There is no tool named approve_outline, and there never should be — adding
// one would let the model advance past step 3 on its own, which defeats the entire reason step 3
// exists. The approval transition (outline_pending → approved) lives only in
// src/app/api/blog/writer/[id]/approve/route.ts, gated by a real user session.
import type { Anthropic } from "@anthropic-ai/sdk";
import {
  updateWriterSession, updateBlogDraft, getBlogDraft,
  type WriterSession, type WriterBrief, type WriterOutline, type WriterOutlineSection,
} from "@/lib/db/queries";
import { voiceBannedWords, voiceBannedPhrases } from "./voice";
import type { WriterVoice } from "@/lib/db/queries";
import type { ResearchLedger } from "./tools";
import { internalLinkUniverse } from "@/lib/sitemap/store";
import { extractUrls, mergeRequiredSources } from "./userInput";

export const CONTROL_TOOLS: Anthropic.Tool[] = [
  {
    name: "save_brief",
    description:
      "Record the agreed requirements for this piece and move from step 1 to step 2. Call this " +
      "once you have the required fields from the user. Do not call it with guessed values.",
    input_schema: {
      type: "object",
      properties: {
        primary_keyword: { type: "string", description: "The exact phrase to rank for." },
        topic: { type: "string", description: "The topic and the specific angle or argument." },
        page_type: { type: "string", enum: ["blog", "landing"] },
        word_count: { type: "integer", description: "Target word count. Use 2500 if the user did not specify one." },
        negative_keywords: { type: "array", items: { type: "string" }, description: "Phrases to avoid in this specific piece." },
        secondary_keywords: { type: "array", items: { type: "string" } },
        cta_text: { type: "string", description: "The single hero CTA for this piece (Strapi's required blogHeroCTA). Separate from any ```CTA block placed inside the body — this one is not markdown, it fills a dedicated field." },
        cta_url: { type: "string" },
        experiences: { type: "array", items: { type: "string" }, description: "Client stories or product results to consider including, each as one sentence." },
        competitor_urls: {
          type: "array", items: { type: "string" },
          description: "URLs the user supplied as references. These are REQUIRED reading — you cannot propose an outline until you have fetched every one of them.",
        },
        must_follow: {
          type: "string",
          description: "The user's own brief or instructions, captured VERBATIM when they give any. Anything they state about angle, structure, what to include or avoid, tone, or specific points to make. Do not summarise, reword, or filter it — this text is replayed to you on every turn and is not negotiable. Leave empty only if the user gave no instructions of their own.",
        },
      },
      required: ["primary_keyword", "topic", "page_type", "word_count"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_outline",
    description:
      "Submit the step-3 outline for human approval. This ends your turn: the application will not " +
      "call you again until a person approves or sends edits. Put everything the reviewer needs " +
      "into this single call.",
    input_schema: {
      type: "object",
      properties: {
        search_intent: { type: "string", description: "One paragraph: what the reader actually wants." },
        h1: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              level: { type: "string", enum: ["h2", "h3"] },
              heading: { type: "string" },
              target_words: { type: "integer" },
              is_faq: { type: "boolean", description: "True if this heading is phrased as a real question." },
            },
            required: ["level", "heading"],
            additionalProperties: false,
          },
        },
        source_plan: {
          type: "array",
          description: "5 to 10 sources. Every url must have come from web_search or fetch_page this session.",
          items: {
            type: "object",
            properties: {
              url: { type: "string" }, insight: { type: "string" }, anchor_text: { type: "string" },
              section_index: {
                type: "integer",
                description: "Which section this source belongs in, as its 0-based position in the sections array above. Not the heading text.",
              },
            },
            required: ["url", "insight", "anchor_text", "section_index"],
            additionalProperties: false,
          },
        },
        link_plan: {
          type: "array",
          description: "10 to 15 internal links, every url from the voice's internal-link database, spread across the body rather than stacked at the end.",
          items: {
            type: "object",
            properties: {
              url: { type: "string" }, anchor_text: { type: "string" },
              section_index: {
                type: "integer",
                description: "Which section this link belongs in, as its 0-based position in the sections array above.",
              },
            },
            required: ["url", "anchor_text", "section_index"],
            additionalProperties: false,
          },
        },
      },
      required: ["search_intent", "h1", "sections", "source_plan", "link_plan"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_section",
    description:
      "Append one finished section of the approved outline, in order. Call once per section — the " +
      "whole article in one call will be truncated mid-sentence, and once you cross roughly 1500 " +
      "words in a single call risk of truncation rises sharply.",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "integer", description: "0 for the intro, then 1, 2, 3... in outline order." },
        markdown: { type: "string", description: "The complete markdown for this section, including its heading." },
      },
      required: ["index", "markdown"],
      additionalProperties: false,
    },
  },
];

export interface ControlToolContext {
  session: WriterSession;
  voice: WriterVoice;
  ledger: ResearchLedger;
  /** Everything the person has typed this session, directive-stripped. The fallback for save_brief
   *  when the model paraphrases the brief instead of capturing it. */
  humanText?: string;
}

export interface ControlToolResult {
  content: string;
  is_error?: boolean;
  /** True only for propose_outline — signals the agent loop to stop after this turn rather than
   *  looping for another assistant response. */
  endTurn?: boolean;
}

function bannedHit(text: string, voice: WriterVoice): string | null {
  const words = voiceBannedWords(voice);
  const phrases = voiceBannedPhrases(voice);
  const lower = text.toLowerCase();
  for (const p of phrases) if (lower.includes(p)) return p;
  for (const w of words) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)) return w;
  return null;
}

export async function runControlTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ControlToolContext,
): Promise<ControlToolResult> {
  const { session, voice } = ctx;

  if (name === "save_brief") {
    if (session.phase !== "gathering") {
      return { is_error: true, content: `The brief is already saved (current phase: ${session.phase}). Proceed with research; do not call save_brief again.` };
    }
    // ── Merge, do not replace ─────────────────────────────────────────────────────────────────
    //
    // This built a fresh object, which silently discarded everything the REQUESTER put on the brief
    // and the model has no way to know about: blog_page_type, persona, video_embeds, source_material,
    // hero_image_url. The model-owned fields below all overwrite explicitly, so spreading the stored
    // brief first cannot resurrect a stale value — it only keeps the fields save_brief never had an
    // opinion about.
    //
    // Observed: an API request with page_type "comparison" reached `researching` with
    // blog_page_type null, so the persona block, the video list and the page-type-aware image plan
    // were all inert from the second turn onwards.
    const brief: Partial<WriterBrief> = {
      ...(session.brief ?? {}),
      primary_keyword: String(input.primary_keyword ?? "").trim(),
      topic: String(input.topic ?? "").trim(),
      page_type: input.page_type === "landing" ? "landing" : "blog",
      word_count: Number(input.word_count) || voice.default_word_count,
      negative_keywords: Array.isArray(input.negative_keywords) ? input.negative_keywords.map(String) : [],
      secondary_keywords: Array.isArray(input.secondary_keywords) ? input.secondary_keywords.map(String) : [],
      cta_text: input.cta_text ? String(input.cta_text) : voice.default_cta_text ?? null,
      cta_url: input.cta_url ? String(input.cta_url) : voice.default_cta_url ?? null,
      experiences: Array.isArray(input.experiences) ? input.experiences.map(String) : [],
      competitor_urls: Array.isArray(input.competitor_urls) ? input.competitor_urls.map(String) : [],
    };
    if (!brief.primary_keyword || !brief.topic) {
      return { is_error: true, content: "primary_keyword and topic are both required and cannot be empty." };
    }

    // A brief whose own keyword collides with the voice's banned list poisons every gate 2 check
    // downstream — every mention of the keyword becomes an unfixable violation. Catch it now.
    const hit = bannedHit(brief.primary_keyword, voice) ?? bannedHit(brief.topic, voice);
    const warning = hit
      ? ` Note: "${hit}" from this voice's banned list appears in the keyword or topic. If it must ` +
        `appear verbatim (e.g. it is the actual product name), say so in the outline; otherwise avoid it.`
      : "";

    // The operator's own instructions and links, promoted out of the brief blob into first-class
    // columns. `competitor_urls` used to stop here: it was written into `brief` and then read back by
    // nothing — not research, not the outline gate, not the validator. An operator who pasted three
    // reference URLs could not tell "read and judged unhelpful" from "never opened", because it was
    // always the second. Copying them to required_sources is what makes the gate below possible.
    // Two fallbacks, both for the same failure: the model deciding on the operator's behalf that
    // their instructions did not need recording.
    //
    // must_follow: if it arrives empty but the person clearly wrote a brief of their own, keep their
    // words rather than nothing. The bar is deliberately crude (some prose beyond the one-line answers
    // a keyword prompt elicits) because the cost of over-capturing is a slightly long directive, while
    // the cost of under-capturing is the complaint this whole path exists to fix. A model that DID
    // capture properly always wins, since its version is the operator's text minus the chit-chat.
    const humanText = (ctx.humanText ?? "").trim();
    const modelMustFollow = typeof input.must_follow === "string" ? input.must_follow.trim() : "";
    const mustFollow = modelMustFollow || (humanText.length >= 80 ? humanText : "");

    // required_sources: union of the links the model forwarded and every link the person actually
    // pasted. agent.ts already sweeps each turn as it arrives, so this mainly catches URLs the model
    // invented into competitor_urls having never been typed, and keeps the two paths consistent.
    // ── Only a HUMAN can create required reading ──────────────────────────────────────────────
    //
    // competitor_urls used to be promoted wholesale. That is right when a person pasted links, and
    // wrong when the "brief" is machine-authored — and for an unattended autopilot run it always is.
    //
    // Measured, one run: the brief said "answer engines cite facy.ai, visionstory.ai, swapface.org,
    // heygen.com instead" as EVIDENCE of a citation gap. The skill says "when in doubt, capture" every
    // URL into competitor_urls, so the model dutifully captured four competitor homepages, and they
    // became mandatory reading. Those sites block bots, and fetch_page separately refuses any URL that
    // was not a search result — so the model had no legal move. It spent 19 minutes and 54,540 output
    // tokens, produced no outline, and the run died with "no sections were written".
    //
    // So a competitor URL is only REQUIRED when it appears in text a person actually typed. Anything
    // the model volunteered on its own stays in brief.competitor_urls as a suggestion it may read.
    const typed = new Set(extractUrls(humanText).map((u) => u.trim().replace(/\/+$/, "").toLowerCase()));
    const fromBrief = (brief.competitor_urls ?? [])
      .filter((u) => /^https?:\/\//i.test(u))
      .filter((u) => typed.has(u.trim().replace(/\/+$/, "").toLowerCase()));
    const required =
      mergeRequiredSources(session.required_sources, [...fromBrief, ...extractUrls(humanText)]) ??
      (session.required_sources ?? []);

    await updateWriterSession(session.id, {
      phase: "researching",
      brief,
      ...(mustFollow ? { must_follow: mustFollow } : {}),
      ...(required.length ? { required_sources: required } : {}),
    } as Parameters<typeof updateWriterSession>[1]);

    const mustNote = mustFollow
      ? " Your must-follow instructions are attached to every turn and are not negotiable."
      : "";
    const srcNote = required.length
      ? ` You MUST read all ${required.length} supplied URL(s) with fetch_page or competitor_page ` +
        `before proposing an outline: ${required.join(", ")}.`
      : "";
    return { content: `Brief saved. Move to step 2: research.${warning}${mustNote}${srcNote}` };
  }

  if (name === "propose_outline") {
    if (session.phase !== "researching") {
      return { is_error: true, content: `Cannot propose an outline from phase "${session.phase}". Save the brief first if you haven't.` };
    }
    const sections = Array.isArray(input.sections) ? (input.sections as WriterOutlineSection[]) : [];
    const sourcePlan = Array.isArray(input.source_plan) ? (input.source_plan as any[]) : [];
    const linkPlan = Array.isArray(input.link_plan) ? (input.link_plan as any[]) : [];

    if (sections.length === 0) return { is_error: true, content: "sections cannot be empty." };

    const sizing = outlineSizingProblem(sections, session.brief?.word_count ?? voice.default_word_count);
    if (sizing) return { is_error: true, content: sizing };

    // The gate that makes supplied links non-optional.
    //
    // A prompt asking the model to read them is not enforcement — it is the thing that already failed.
    // The ledger records what research tools actually returned, so "did it open this URL" is a set
    // membership test with a real answer, and the outline is the right place to check: late enough that
    // the model has had its whole research phase, early enough that nothing has been written yet.
    //
    // Matching ignores a trailing slash. A user who pastes `example.com/post/` and a fetch that
    // normalises to `example.com/post` are the same page, and failing that would be the gate crying wolf
    // on its own bookkeeping.
    {
      const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
      const fetched = new Set(Object.keys(ctx.ledger.sources).map(norm));
      const required = (session.required_sources ?? []) as string[];
      const failures = ctx.ledger.fetchFailures ?? {};

      // ── Tried-and-impossible is not the same as not-tried ──────────────────────────────────
      //
      // A page that 403s a crawler will 403 on every retry. Blocking forever on it turns one
      // unreachable URL into a dead run: the old version of this gate produced exactly that, and its
      // own advice ("say so explicitly rather than skipping it") did nothing, because saying so did
      // not unblock anything. There was no legal move.
      //
      // Two genuine failures is enough evidence. The URL is dropped from the requirement and the
      // failure is stated in the directive, so the piece is written without it rather than not at all.
      const GIVE_UP_AFTER = 2;
      const unread = required.filter((u) => !fetched.has(norm(u)));
      const impossible = unread.filter((u) => (failures[norm(u)] ?? 0) >= GIVE_UP_AFTER);
      const stillWorthTrying = unread.filter((u) => (failures[norm(u)] ?? 0) < GIVE_UP_AFTER);

      if (impossible.length) {
        // Persist the drop so later turns and the audit trail agree on why.
        const keep = required.filter((u) => !impossible.some((i) => norm(i) === norm(u)));
        // Persisted only — `session` is const here, and the next turn re-reads the row anyway. The
        // in-memory copy is not used again after this gate.
        await updateWriterSession(session.id, {
          required_sources: keep,
        } as Parameters<typeof updateWriterSession>[1]);
      }

      if (stillWorthTrying.length) {
        return {
          is_error: true,
          content:
            `You have not read ${stillWorthTrying.length} of the URL(s) the user supplied, and they are ` +
            `required reading for this piece: ${stillWorthTrying.join(", ")}. Fetch each one with ` +
            `competitor_page (which accepts any URL) or fetch_page, then propose the outline again. ` +
            `If a fetch fails twice the requirement is dropped automatically and you may proceed ` +
            `without it — do not keep retrying past that.`,
        };
      }
    }

    // Provenance check on the plan itself: fail fast here rather than let the model discover after
    // writing that a planned source was never real. Same ledger the validator uses later.
    const badSources = sourcePlan.filter((s) => !(s.url in ctx.ledger.sources));
    if (badSources.length) {
      return {
        is_error: true,
        content: `These source_plan URLs were not returned by web_search or fetch_page this ` +
          `session and cannot be used: ${badSources.map((s) => s.url).join(", ")}. Search for real ` +
          `sources or remove them from the plan.`,
      };
    }
    // Cluster siblings are valid internal targets even though they are not in the voice's sitemap:
    // their slugs were minted and collision-checked at cluster-approval time, so those pages will
    // exist. Leaving them out here was a real bug. The model was told to link to its siblings, put
    // them in the link_plan, had the whole plan rejected as "not in the internal-link database", and
    // gave up — so no article in a cluster linked to any other, which is the entire point of one.
    const siblings = (session.brief?.cluster_siblings ?? []) as string[];
    // The voice's curated list, the cluster siblings, AND every real page in the sitemap inventory.
    // Before the inventory existed this was the 36 curated links only, so a link to any of the 747
    // real blog posts was rejected as "not in this voice's internal-link database" — which is why
    // cluster articles could only ever link to their own siblings.
    const inventory = await internalLinkUniverse().catch(() => new Set<string>());
    const validPaths = new Set([...voiceHostPaths(voice), ...siblings, ...inventory]);
    const badLinks = linkPlan.filter((l) => !validPaths.has(String(l.url)));
    if (badLinks.length) {
      return {
        is_error: true,
        content: `These link_plan URLs are not real pages on our site and cannot be used: ` +
          `${badLinks.map((l) => l.url).join(", ")}. Call internal_links to find pages that do exist ` +
          `rather than guessing a path.`,
      };
    }

    const outline: WriterOutline = {
      search_intent: String(input.search_intent ?? ""),
      h1: String(input.h1 ?? ""),
      sections,
      source_plan: sourcePlan as WriterOutline["source_plan"],
      link_plan: linkPlan as WriterOutline["link_plan"],
    };

    await updateWriterSession(session.id, { phase: "outline_pending", outline });
    return {
      content: "Outline recorded and sent for approval. Stop here and wait; do not write any " +
        "section until you see an approval.",
      endTurn: true,
    };
  }

  if (name === "submit_section") {
    if (session.phase !== "approved" && session.phase !== "writing") {
      return { is_error: true, content: `Cannot write yet. Phase is "${session.phase}", and the outline must be approved by a human before any section is written.` };
    }
    if (!session.draft_id) {
      return { is_error: true, content: "No draft is attached to this session. This is a configuration error, not something you can fix." };
    }
    const markdown = String(input.markdown ?? "").trim();
    if (!markdown) return { is_error: true, content: "markdown cannot be empty." };
    const index = Number(input.index);
    if (!Number.isInteger(index) || index < 0) return { is_error: true, content: "index must be a non-negative integer." };

    const total = session.outline?.sections.length ?? 0;
    if (total && index >= total) {
      return { is_error: true, content: `index ${index} is past the end of the approved outline (${total} sections, so the last index is ${total - 1}).` };
    }

    const draft = await getBlogDraft(session.draft_id);
    if (!draft) return { is_error: true, content: "The attached draft no longer exists." };

    // Keyed by index and REBUILT, never appended: a resubmitted index replaces its section instead
    // of duplicating it. Observed live before this changed — the model submitted the final section
    // three times and the body carried three copies, with the cursor still reporting success.
    const wasAlreadyWritten = typeof session.sections?.[String(index)] === "string";
    const sections: Record<string, string> = { ...(session.sections ?? {}), [String(index)]: markdown };
    const body = rebuildBody(sections);

    await updateBlogDraft(session.draft_id, { body });
    const updated = await updateWriterSession(session.id, {
      phase: "writing",
      sections,
      section_cursor: Math.max(session.section_cursor, index + 1),
    });
    // Keep the caller's view current so the next tool call in this same batch sees this section.
    Object.assign(session, updated);

    const written = Object.keys(sections).length;
    const missing = total ? [...Array(total).keys()].filter((i) => !(String(i) in sections)) : [];

    if (wasAlreadyWritten) {
      return { content: `Section ${index} REPLACED (it had already been written). ${written}/${total || "?"} sections done.${missing.length ? ` Still missing: ${missing.join(", ")}.` : " All sections are now written, so stop calling submit_section."}` };
    }
    return {
      content: missing.length
        ? `Section ${index} saved. ${written}/${total} sections done. Next write index ${missing[0]}.`
        : `Section ${index} saved. All ${total} sections are written. Do not call submit_section again; the piece goes to validation next.`,
    };
  }

  return { is_error: true, content: `Unknown control tool "${name}".` };
}

/**
 * Why an outline cannot hit its brief's word count, or null if it can.
 *
 * Rejecting a badly-sized outline costs one cheap turn; discovering the same problem after writing
 * costs the whole article and a repair round. Observed live: 15 sections planned against a 1,500-word
 * brief, which arrived 3,678 words, 145% over.
 *
 * Pure and exported so it can be asserted without a database (this repo has no test framework).
 */
export function outlineSizingProblem(
  sections: Array<{ target_words?: number }>,
  target: number | undefined,
): string | null {
  if (!target || !sections.length) return null;

  const declared = sections.reduce((n, s) => n + (Number(s.target_words) || 0), 0);
  // Sections carry the body; intro and conclusion overhead means a modest excess is fine.
  if (declared > target * 1.3) {
    return `This outline's section targets add up to ${declared} words against a ${target}-word brief, ` +
      `so the finished piece would come in far over and fail the word-count check. Cut or merge ` +
      `sections until the total is close to ${target}, then call propose_outline again.`;
  }
  // Too many sections overshoots even when the per-section numbers look fine, because each one
  // carries a heading and a minimum viable amount of prose underneath it.
  const maxSections = Math.max(4, Math.round(target / 180));
  if (sections.length > maxSections) {
    return `${sections.length} sections is too many for a ${target}-word piece (roughly ${maxSections} ` +
      `is the ceiling, since each one needs a heading and real prose under it). Merge the overlapping ` +
      `ones and call propose_outline again.`;
  }
  return null;
}

/**
 * Assemble the draft body from the per-index section map, in numeric outline order.
 *
 * Numeric sort, not the object's key order: JS orders integer-like string keys ascending, which
 * happens to be right, but relying on that is a footgun the moment an index goes past 9 and someone
 * stores "10" alongside "2". Sort explicitly.
 */
export function rebuildBody(sections: Record<string, string>): string {
  return Object.keys(sections)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
    .map((n) => sections[String(n)].trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Every URL in the voice's sitemap, for the link_plan provenance check. Exported so the agent
 *  loop can compute the same set once per turn rather than recomputing per tool call. */
export function voiceHostPaths(voice: WriterVoice): string[] {
  const raw = voice.sitemap_links;
  let parsed: unknown = raw;
  if (typeof raw === "string") { try { parsed = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((l: any) => String(l?.url ?? "")).filter(Boolean);
}


/* ─────────────────────────────────────────────────────────────────────────────────────────────────
   Editing an outline that is awaiting approval.

   Replying "move section 4 up and drop section 6" works, but it costs a full model round-trip to
   restate something the reviewer could have done directly, and the model sometimes rewrites more than
   was asked. So the outline is directly editable in the approval panel.

   The hazard is `section_index`. Both source_plan and link_plan point at sections BY INDEX, and that
   is deliberate — matching on heading text once failed silently and shipped articles with zero
   citations. Which means any reorder, insert or delete has to remap those indices, or every source and
   link silently attaches to the wrong section, or to none.

   So the client sends each section with `from`: the index it occupied in the original outline, or -1
   for a section the reviewer added. That is the only reliable identity — heading text is exactly what
   the reviewer is editing.
   ───────────────────────────────────────────────────────────────────────────────────────────────── */

export interface OutlineEditSection {
  level?: string;
  heading?: string;
  target_words?: unknown;
  is_faq?: unknown;
  /** Index in the ORIGINAL outline, or -1 (or absent) for a newly added section. */
  from?: unknown;
}

export interface OutlineEditResult {
  outline: WriterOutline | null;
  error?: string;
  /** Assignments that had nowhere to land, and clamps applied. Surfaced, never silent. */
  notes: string[];
}

/**
 * Validate and remap an edited outline. Pure, so the selfcheck can pin the index arithmetic.
 */
export function sanitizeOutlineEdit(
  original: WriterOutline,
  edit: { h1?: unknown; search_intent?: unknown; sections?: unknown },
): OutlineEditResult {
  const notes: string[] = [];
  if (!edit || typeof edit !== "object") return { outline: null, error: "No outline supplied.", notes };
  if (!Array.isArray(edit.sections)) return { outline: null, error: "The outline needs a list of sections.", notes };
  if (!edit.sections.length) return { outline: null, error: "An outline needs at least one section.", notes };
  if (edit.sections.length > 40) return { outline: null, error: "That is too many sections.", notes };

  const h1 = String(edit.h1 ?? original.h1 ?? "").trim();
  if (!h1) return { outline: null, error: "The outline needs an H1.", notes };

  /** old index → new index. Built as we walk the edited list, so it reflects the final order. */
  const remap = new Map<number, number>();
  const sections: WriterOutlineSection[] = [];

  for (let newIndex = 0; newIndex < edit.sections.length; newIndex++) {
    const raw = (edit.sections[newIndex] ?? {}) as OutlineEditSection;
    const heading = String(raw.heading ?? "").trim();
    if (!heading) return { outline: null, error: `Section ${newIndex + 1} has no heading.`, notes };

    const level = raw.level === "h3" ? "h3" : "h2";
    let target_words: number | undefined = Math.round(Number(raw.target_words));
    if (!Number.isFinite(target_words) || target_words <= 0) target_words = undefined;
    else if (target_words < 40 || target_words > 2000) {
      const clamped = Math.max(40, Math.min(2000, target_words));
      notes.push(`"${heading}": target ${target_words} words clamped to ${clamped}.`);
      target_words = clamped;
    }

    sections.push({
      level,
      heading,
      ...(target_words ? { target_words } : {}),
      // A heading ending in "?" IS a question, whatever the flag says — the FAQ gate keys off the
      // text, so letting the two disagree would flag a correct outline.
      is_faq: raw.is_faq === true || /\?\s*$/.test(heading),
    });

    const from = Number(raw.from);
    if (Number.isInteger(from) && from >= 0 && from < original.sections.length) {
      // Last writer wins if the client duplicated a `from`; a duplicated identity is a client bug and
      // attaching the sources twice would be worse than attaching them once.
      remap.set(from, newIndex);
    }
  }

  /** Re-point an assignment at its section's new index, or report it as orphaned. */
  const move = <T extends { section_index: number }>(list: T[], what: string): T[] => {
    const out: T[] = [];
    for (const a of list) {
      const to = remap.get(a.section_index);
      if (to === undefined) {
        notes.push(`Dropped a ${what} that was assigned to a section you removed.`);
        continue;
      }
      out.push({ ...a, section_index: to });
    }
    return out;
  };

  return {
    outline: {
      search_intent: String(edit.search_intent ?? original.search_intent ?? "").trim(),
      h1,
      sections,
      source_plan: move(original.source_plan ?? [], "source"),
      link_plan: move(original.link_plan ?? [], "link"),
    },
    notes,
  };
}
