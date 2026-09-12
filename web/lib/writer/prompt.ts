// Assembles what actually gets sent to the model: the cached system prompt, the phase directive
// that steers each turn, and the cache-breakpoint placement across the growing message history.
import type { Anthropic } from "@anthropic-ai/sdk";
import { SKILL_PROMPT } from "./skill";
import { renderVoiceSystem } from "./voice";
import { socialsNote, socialsReminder } from "@/lib/blog/socials";
import { userPromptsNote, userPromptsReminder, promptsRelevant, studioMentioned } from "@/lib/blog/userPrompts";
import { practitionerNote, practitionerReminder } from "@/lib/blog/practitioner";
import { briefVideoNote, youtubeReminder } from "@/lib/blog/youtube";
import { brandNote, brandReminder } from "@/lib/blog/brand";
import { editorialNote, editorialReminder } from "@/lib/blog/editorialRules";
import { productFactsNote } from "@/lib/blog/productFacts";
import type { WriterSession, WriterPhase, WriterVoice } from "@/lib/db/queries";

/**
 * Machine-injected directive blocks. These are written into the USER turn (they have to be: the
 * top-level system prompt is cached and Sonnet 5 has no mid-conversation system role), which means
 * the transcript contains text the human never typed.
 *
 * They must be stripped before anything is displayed. Getting this wrong is not subtle: a
 * `<section_assignment>` block listing every source URL rendered as a giant user chat bubble, and it
 * looked like the user had pasted it. Stripping happens server-side in the display projection so the
 * UI cannot forget to do it.
 */
export const DIRECTIVE_TAGS = ["phase", "section_assignment", "cluster", "repair_request"] as const;

/**
 * Remove every machine directive, leaving only what a human actually wrote.
 *
 * A block that BEGINS with one of these tags is entirely machine-authored: `runTurn` always puts the
 * human's own words in a SEPARATE content block from the directive. So the whole block goes. That
 * also retroactively cleans sessions persisted before the directive was fully wrapped, where the tag
 * held only the phase name and the instructions trailed after it in plain prose.
 *
 * `repair_request` is excluded from the whole-block rule on purpose: a human pressed "Ask it to fix
 * these" to send it, so the transcript should still show that it happened.
 */
const WHOLLY_MACHINE = /^\s*<(phase|section_assignment|cluster)>/;

export function stripDirectives(text: string): string {
  if (WHOLLY_MACHINE.test(text)) return "";
  let out = text;
  for (const tag of DIRECTIVE_TAGS) {
    // Paired form, and the self-contained `<phase>x</phase>` line.
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
    // An unclosed directive (a truncated turn) would otherwise leak the whole tail.
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*$`, "g"), "");
  }
  return out.trim();
}

/**
 * `system[0]` = the frozen workflow (widest-shared, 1h TTL), `system[1]` = this voice (shared by
 * every article on this voice, 1h TTL). Order matters: system[0] alone is ~4.8k tokens, comfortably
 * over the worst-case minimum cacheable prefix; a terse voice profile in that position could fall
 * under it and silently not cache (see selfcheck's cache-minimum assertion for why this is checked
 * mechanically, not just documented).
 */
export function buildSystem(voice: WriterVoice): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: SKILL_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text", text: renderVoiceSystem(voice), cache_control: { type: "ephemeral", ttl: "1h" } },
  ];
}

/**
 * The per-turn instruction. Rides in the trailing USER turn, never in `system` (would invalidate
 * the two breakpoints above on every turn) and never as `{role:"system"}` (Opus 4.8 only —
 * unavailable on Sonnet 5). Wrapped so the model can tell it apart from the human's own words,
 * the same convention this app's own `<system-reminder>` injections use elsewhere.
 */
/**
 * Did the REQUESTER already supply the brief?
 *
 * True for an API request (startBlogRequest writes topic and primary_keyword onto the brief before
 * the first turn) and false for the interactive composer, whose brief is empty until the model calls
 * save_brief. That difference decides what the opening turn is FOR: asking a human, or getting on
 * with it.
 */
export function briefWasSupplied(session: WriterSession): boolean {
  const b = session.brief ?? {};
  return !!String(b.topic ?? "").trim() && !!String(b.primary_keyword ?? "").trim();
}

export function phaseDirective(session: WriterSession, isFirstTurn: boolean): string {
  // EVERYTHING this returns must end up inside the <phase> wrapper at the bottom of the function.
  // An earlier version tagged only the phase NAME and left the instruction prose bare, so
  // stripDirectives removed the word "gathering" and rendered the rest as a message the human
  // appeared to have typed ("Continue gathering step 1 requirements. Call save_brief once you have
  // enough." in a user bubble). If you add a line here, do not add it outside the wrapper.
  const lines: string[] = [`session phase: ${session.phase}`];

  // The operator's own instructions, replayed on EVERY turn rather than only the one they were given
  // on. That repetition is the point: an instruction stated once at the start of a long session is
  // competing with everything written since, and losing. Repeating it verbatim is what turns "the user
  // mentioned this" into a live constraint at the moment each section gets written.
  //
  // Rendered before the phase instructions so it frames them, and marked as outranking the model's own
  // plan — otherwise a conflict resolves toward whatever the model already decided, which is the exact
  // "too deterministic, it ignored what I told it" complaint.
  const mustFollow = (session.must_follow ?? "").trim();
  if (mustFollow) {
    lines.push(
      "The user gave their own instructions for this piece. They are reproduced verbatim below and " +
      "they outrank your own plan, your default structure, and anything in your earlier turns. If one " +
      "conflicts with a convention you would otherwise follow, follow the user. If one is genuinely " +
      "impossible, say so plainly in your next message rather than quietly doing something else:",
      `<user_instructions>\n${mustFollow}\n</user_instructions>`,
    );
  }

  // Supplied URLs that are still unread, restated per turn while any remain outstanding. The hard stop
  // lives in propose_outline; this is what stops the model arriving there having ignored them.
  const required = (session.required_sources ?? []) as string[];
  if (required.length && session.phase === "researching") {
    const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
    const fetched = new Set(Object.keys(session.research?.sources ?? {}).map(norm));
    const unread = required.filter((u) => !fetched.has(norm(u)));
    if (unread.length) {
      lines.push(
        `The user supplied these URLs as required reading and you have not opened ${unread.length} of ` +
        `them yet: ${unread.join(", ")}. Fetch each one before proposing an outline; the outline will ` +
        "be rejected while any remain unread.",
      );
    }
  }

  switch (session.phase) {
    case "gathering":
      // ── Two different opening turns, because there are two different callers ──────────────────
      //
      // The composer's opening turn may only ASK, and tools are structurally disabled for it (see
      // toolChoiceFor). An API request is the opposite case: the requirements arrived WITH the
      // request, there is no human in the loop to answer, and telling the model to greet-and-ask
      // wastes the turn.
      //
      // Observed: a practitioner post requested over the API got the greet-and-ask directive with
      // the supplied brief attached to the same turn. The model replied "I'll save the brief and get
      // straight into research", could not — tools were off — and the run ended at zero sections.
      // The seeded brief and the directive were telling it opposite things.
      if (isFirstTurn && briefWasSupplied(session)) {
        lines.push(
          "The requirements for this piece arrived WITH the request and are already on the brief — they " +
          "are repeated below. There is no human waiting to answer questions. Do not greet and do not " +
          "ask: call save_brief with what you were given and begin the research in this same turn.",
        );
        break;
      }
      lines.push(isFirstTurn
        ? "This is the start of a new piece. Greet briefly and ask for the step 1 requirements in one message, then stop. Tools are disabled on this turn: asking is the whole job."
        : "Continue gathering step 1 requirements. Call save_brief once you have enough.");
      lines.push(
        "If you ask the human anything, that question must be the last thing in your turn and you " +
        "must not call a tool afterwards. Either ask and wait, or proceed without asking. Asking and " +
        "then immediately proceeding gives the human no chance to answer.",
      );
      break;
    case "researching":
      lines.push(
        "The brief is saved. Research now: call serp_analysis on the primary keyword first (it gives " +
        "you who ranks, the real People Also Ask questions and the real related searches), then " +
        "keyword_data, then web_search and fetch_page for the sources you need. Then call propose_outline.",
      );
      lines.push(
        "Also call internal_links for the main topic and for each major subtopic. It searches our own " +
        "site, and the paths it returns are the ONLY URLs on our domain you may link to. Guessing an " +
        "internal path produces a 404 on a published page, so search instead of assuming.",
      );
      // Handed over while the link plan is being made, not after it. A social link decided at writing
      // time is one bolted onto a finished paragraph, which is exactly the "follow us" sentence the
      // rules forbid.
      lines.push(socialsNote());
      lines.push(promptNote(session));
      lines.push(personaNote(session));
      // Handed over with the link plan for the same reason as the socials note: a video chosen while
      // the piece is being planned lands where the prose reaches it, one bolted on at the end lands
      // at the bottom under a "Watch this" heading nobody clicks.
      lines.push(`\n${briefVideoNote(session.brief?.video_embeds)}`);
      // Handed over with the link plan, because "reference the brand strategically" is a decision
      // about WHERE the mention goes, and that is a planning decision. Bolted on at the end it
      // becomes the closing call to action the rules forbid.
      lines.push(`\n${brandNote({ hosted: session.brief?.not_hosted !== true })}`);
      // House style, so unconditional. Unlike the socials or video notes these are not a nudge that
      // depends on the subject — contrastive negation and prose-instead-of-lists showed up in every
      // article reviewed.
      lines.push(`\n${editorialNote()}`);
      // Only where the piece walks an interface, because that is where invented controls happen.
      if (walksAnInterface(session)) lines.push(`\n${productFactsNote()}`);
      break;
    case "outline_pending":
      lines.push("An outline is awaiting human approval. If this message is feedback rather than an approval, revise and call propose_outline again. Do not write any section yet.");
      break;
    case "approved":
      lines.push("The outline was just approved by a human. Begin step 4: call submit_section for section 0 (the intro) now.");
      lines.push(writingAssignment(session, 0));
      lines.push(socialsReminder());
      lines.push(promptReminder(session));
      lines.push(personaReminder(session));
      lines.push(youtubeReminder(session.brief?.video_embeds?.length ?? 0));
      lines.push(brandReminder(session.brief?.not_hosted !== true));
      lines.push(editorialReminder());
      break;
    case "writing": {
      const next = nextUnwrittenIndex(session);
      if (next === null) {
        lines.push("Every section in the approved outline is written. Do not call submit_section again.");
      } else {
        lines.push(`Continue step 4. The next section to submit is index ${next}.`);
        lines.push(writingAssignment(session, next));
        lines.push(socialsReminder());
        lines.push(promptReminder(session));
        lines.push(personaReminder(session));
        lines.push(youtubeReminder(session.brief?.video_embeds?.length ?? 0));
        lines.push(brandReminder(session.brief?.not_hosted !== true));
        lines.push(editorialReminder());
      }
      break;
    }
    case "validating":
      lines.push("The draft is being checked automatically. If you are seeing this, a repair request will follow shortly with specific violations to fix.");
      break;
    default:
      lines.push("");
  }
  // One wrapper around the whole directive, so stripDirectives removes all of it. The nested
  // <section_assignment> goes with it, since the regex runs to the single closing </phase>.
  return `<phase>\n${lines.filter(Boolean).join("\n")}\n</phase>`;
}

/** Content-block types that accept `cache_control`. Anything else (notably `thinking` and
 *  `redacted_thinking`) is rejected with a 400 if marked. */
const CACHEABLE_BLOCK_TYPES = new Set([
  "text", "image", "tool_use", "tool_result", "document", "search_result",
]);

export function isCacheable(block: unknown): boolean {
  const t = (block as { type?: string } | null)?.type;
  return !!t && CACHEABLE_BLOCK_TYPES.has(t);
}

/**
 * The example-prompt guidance, on the pieces where prompts belong.
 *
 * Gated rather than always-on: the block is long, and a post about outreach that carries the Image
 * studio's aspect-ratio habits teaches the model that these blocks can be skipped.
 */
function promptNote(session: WriterSession): string {
  const kw = session.brief?.primary_keyword;
  const topic = session.brief?.topic;
  if (!promptsRelevant(kw, topic)) return "";
  return `\n${userPromptsNote(studioMentioned(kw, topic))}`;
}

/** The same guidance compressed, for the turns where the long note has scrolled out of reach. */
function promptReminder(session: WriterSession): string {
  if (!promptsRelevant(session.brief?.primary_keyword, session.brief?.topic)) return "";
  return userPromptsReminder();
}

/** Is this a practitioner draft? Read off the declared type, never guessed from the title. */
function isPractitioner(session: WriterSession): boolean {
  return session.brief?.blog_page_type === "practitioner";
}

/**
 * The practitioner persona, on practitioner drafts only.
 *
 * This block is the whole type — it carries the role, the friction to open on, the trade vocabulary
 * and the honesty boundary — so unlike the socials and prompt notes it is not a nudge that can be
 * skipped. `persona` names which practitioner; without one the note lists them and asks.
 */
function personaNote(session: WriterSession): string {
  if (!isPractitioner(session)) return "";
  const persona = (session.brief?.persona ?? "").trim();
  return `\n${practitionerNote(persona || undefined)}`;
}

/** The same, compressed, for the section turns. */
function personaReminder(session: WriterSession): string {
  return isPractitioner(session) ? practitionerReminder() : "";
}

/**
 * Does this piece walk the reader through one of our interfaces?
 *
 * Gated because the product-facts block is long and specific, and an article that never opens the app
 * does not need to be told which controls the interior-design video surface lacks. A how-to always
 * qualifies; anything naming a studio or a walkthrough does too.
 */
function walksAnInterface(session: WriterSession): boolean {
  const t = `${session.brief?.topic ?? ""} ${session.brief?.primary_keyword ?? ""}`.toLowerCase();
  if (session.brief?.blog_page_type === "how-to") return true;
  return /\b(step by step|walkthrough|how to|studio|interface|upload|generate|settings?)\b/.test(t);
}

/** The lowest outline index not yet in the section map, or null once all are written. */
export function nextUnwrittenIndex(session: WriterSession): number | null {
  const total = session.outline?.sections.length ?? 0;
  if (!total) return null;
  for (let i = 0; i < total; i++) if (!(String(i) in (session.sections ?? {}))) return i;
  return null;
}

/**
 * Restate the approved plan for the section about to be written.
 *
 * This exists because of an observed failure: the agent wrote a complete 8,600-character article
 * containing ZERO links, despite an approved source plan and internal-link plan. By writing time the
 * outline was dozens of blocks back in the history, competing with several thousand tokens of tool
 * results, and the specific per-section assignments simply stopped being salient. Restating them in
 * the trailing user turn puts them adjacent to the instruction that uses them, and costs nothing in
 * cache terms because this text sits after the last breakpoint anyway.
 */
export function writingAssignment(session: WriterSession, index: number): string {
  const outline = session.outline;
  if (!outline) return "";
  const section = outline.sections[index];
  if (!section) return "";

  // Exact index match. An earlier version matched a free-text section NAME against the heading and
  // silently found nothing, after which this block told the model "no sources were assigned, do not
  // invent any" — which is how a fully-researched article shipped with zero citations. Indices
  // cannot near-miss.
  const sources = outline.source_plan.filter((s) => s.section_index === index);
  const links = outline.link_plan.filter((l) => l.section_index === index);

  // What is still unplaced anywhere, so the fallback below can offer real options instead of
  // suppressing links entirely.
  const written = new Set(Object.keys(session.sections ?? {}).map(Number));
  const unplacedSources = outline.source_plan.filter(
    (s) => !outline.sections[s.section_index] || (!written.has(s.section_index) && s.section_index > index),
  );
  const unplacedLinks = outline.link_plan.filter(
    (l) => !outline.sections[l.section_index] || (!written.has(l.section_index) && l.section_index > index),
  );

  const out: string[] = ["", `<section_assignment index="${index}">`];
  out.push(`Heading (${section.level}): ${section.heading}`);
  if (section.target_words) {
    out.push(`Target length: about ${section.target_words} words. Staying close to this matters, because the whole-article word count is checked against the brief.`);
  }
  if (section.is_faq) {
    out.push("This heading is a question. Answer it completely in the first sentence so the answer stands alone if quoted out of context, then support it.");
  }

  if (sources.length) {
    out.push("", "Sources assigned to this section. Embed each as a contextual markdown link using the given anchor text, and paraphrase the insight rather than quoting it:");
    for (const s of sources) out.push(`  [${s.anchor_text}](${s.url})  for: ${s.insight}`);
  }
  if (links.length) {
    out.push("", "Internal links assigned to this section. Embed each as a markdown link:");
    for (const l of links) out.push(`  [${l.anchor_text}](${l.url})`);
  }

  if (sources.length || links.length) {
    out.push("", "Write these as real inline markdown links in the prose, not as a list at the end. A section that omits its assigned links fails the automated check and comes back to you.");
  } else {
    // Never say "no links assigned, don't add any" — that is what produced zero-citation articles.
    // Offer what is still unplaced instead, and let it decide.
    out.push("", "Nothing was assigned specifically to this section index in the approved plan.");
    if (unplacedSources.length || unplacedLinks.length) {
      out.push("If any of these fit naturally here, use them; otherwise leave them for their own section:");
      for (const s of unplacedSources.slice(0, 4)) out.push(`  [${s.anchor_text}](${s.url})  for: ${s.insight}`);
      for (const l of unplacedLinks.slice(0, 3)) out.push(`  [${l.anchor_text}](${l.url})`);
    }
    out.push("Do not invent a URL that is not in the approved plan.");
  }
  out.push("</section_assignment>");
  return out.join("\n");
}

export function toolChoiceFor(
  phase: WriterPhase,
  isFirstTurn = false,
  briefSupplied = false,
): Anthropic.ToolChoice {
  if (phase === "approved" || phase === "writing") {
    return { type: "tool", name: "submit_section" };
  }
  // The opening turn may only ASK. Without this the model reliably asked its questions and then
  // called save_brief in the same turn, so research started before the human could answer a single
  // one — "the ai asks me questions yet delays letting me answer". Making the first turn incapable of
  // calling a tool is structural; a prompt instruction not to was not obeyed.
  //
  // Cache-safe: tool_choice is not part of the cached prefix. The tools ARRAY must stay identical
  // across turns (a conditional tools array invalidates every breakpoint) — this changes neither.
  // …but only when there is a human to ask. An API request supplied the brief already, so disabling
  // tools on its opening turn just costs a turn and, if the turn budget is tight, the whole run.
  if (phase === "gathering" && isFirstTurn && !briefSupplied) return { type: "none" };
  return { type: "auto" };
}

/**
 * Place cache_control on the message-history side of the request, WITHOUT mutating the blocks the
 * caller will persist (a stored block must never carry request-only fields).
 *
 * Two breakpoints, always the same two positions relative to the end: the last content block
 * (the standard "growing conversation" placement), and — once the history is long enough that a
 * single tool-heavy research turn could exceed it — one 15 blocks back from the end. The plan's
 * finding: each breakpoint walks back at most 20 content blocks to find a prior entry, and the
 * research phase emits tool_use/tool_result pairs in bulk, easily exceeding 20 in one turn. A
 * second, earlier breakpoint keeps the older portion of a long tool-loop within reach of the newer
 * one. Combined with the 2 system breakpoints in buildSystem(), this is 4 total: the hard cap.
 */
/**
 * tool_use ids in a message's blocks that have no answering tool_result — which is every tool_use
 * when the message is the LAST one in history, because a completed round always appends its
 * tool_result user message immediately after.
 *
 * This exists for one failure mode: a turn killed at the Vercel 300s ceiling mid-tool persists the
 * assistant's tool_use blocks but never their results, and the Anthropic API rejects any later
 * request whose history contains an unanswered tool_use — bricking the session permanently rather
 * than merely interrupting it. Both loops call this at turn start and append synthetic interrupted
 * results, so one killed turn costs one tool call, not the conversation. Pure, so the selfcheck can
 * assert it.
 *
 * Lives here rather than in hermes/prompt.ts (where it was first written) because the writer hit the
 * same wall on an unattended API-requested article, and hermes is built on the writer — the shared
 * piece belongs in the base module, not the one layered on top.
 */
export function pendingToolUseIds(blocks: unknown[]): string[] {
  return (blocks as Array<{ type?: string; id?: string }>)
    .filter((b) => b?.type === "tool_use" && typeof b.id === "string")
    .map((b) => b.id as string);
}

export function applyCacheBreakpoints(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  type Flat = { mi: number; bi: number };
  const flat: Flat[] = [];
  messages.forEach((m, mi) => {
    const blocks = Array.isArray(m.content) ? m.content : [];
    blocks.forEach((b, bi) => {
      // Only blocks that ACCEPT cache_control are eligible positions. `thinking` and
      // `redacted_thinking` do not: marking one returns
      //   400 messages.N.content.0.thinking.cache_control: Extra inputs are not permitted
      // and it is invisible until the history happens to end on a thinking block, so the failure
      // shows up several turns in rather than on the first request. Types are not enough to catch
      // this — ContentBlockParam is a union and cache_control is valid on most of its members.
      if (isCacheable(b)) flat.push({ mi, bi });
    });
  });
  if (flat.length === 0) return messages;

  const marks = new Set<string>([`${flat[flat.length - 1].mi}:${flat[flat.length - 1].bi}`]);
  if (flat.length > 15) {
    const back = flat[flat.length - 16];
    marks.add(`${back.mi}:${back.bi}`);
  }

  return messages.map((m, mi) => {
    if (!Array.isArray(m.content)) return m;
    const content = m.content.map((block, bi) => {
      if (!marks.has(`${mi}:${bi}`)) return block;
      // Shallow clone: adds cache_control for THIS request only, leaves the original (which the
      // caller persists to writer_messages) untouched.
      return { ...block, cache_control: { type: "ephemeral" as const } };
    });
    return { ...m, content };
  });
}
