// Mechanical quality gates. Pure functions, no LLM, no I/O — so they are cheap, deterministic, and
// verifiable from the selfcheck route (this repo has no test framework).
//
// The division of labour that matters: the prompt ASKS for these properties, this file ENFORCES
// them. Asking alone is not enough at 2,500 words, and a model grading its own output is not a
// check. Everything here is something a regex can prove.
//
// The one gate that is deliberately non-recoverable is link provenance. A fabricated citation cannot
// be repaired by asking again, because a retry just invents a different plausible URL — so it fails
// the piece and asks for a human instead of looping.
import type { BlogDraft, WriterVoice, WriterOutline } from "@/lib/db/queries";
import { voiceBannedWords, voiceBannedPhrases } from "./voice";
import { cleanExternalUrl, hasTrackingParams } from "@/lib/util/url";
import { publishReadiness } from "@/lib/strapi/mapDraft";
import { socialLinksIn, isOurSocial, MAX_SOCIAL_LINKS } from "@/lib/blog/socials";
import { embedsIn, isOurEmbeddableUrl, MAX_EMBEDS } from "@/lib/blog/youtube";
import { brandMentionsIn, brandOverused, BRAND_MENTIONS_MIN } from "@/lib/blog/brand";
import { contrastiveNegations, MAX_CONTRASTIVE } from "@/lib/blog/editorialRules";

export type Severity =
  /** Fixed silently in place; the author never sees it. */
  | "auto_fix"
  /** Sent back to the model as a scoped repair request. Bounded (see MAX_REPAIR_ROUNDS). */
  | "repair"
  /** Surfaced to the human. Never auto-retried. */
  | "flag";

export interface Violation {
  gate: string;
  severity: Severity;
  detail: string;
  /** Which outline section it was found in, when the check is section-scoped. */
  section?: number;
}

export interface ValidationResult {
  /** The body after auto_fix substitutions. May be identical to the input. */
  fixed: string;
  violations: Violation[];
  stats: {
    words: number;
    keyword_count: number;
    keyword_density: number;
    links_external: number;
    links_internal: number;
    h1_count: number;
    faq_headings: number;
  };
}

/** Hard cap on scoped repair turns per article. Past this the piece is flagged for a human rather
 *  than looped — an unbounded repair loop is how one stubborn article eats a cluster's budget. */
export const MAX_REPAIR_ROUNDS = 2;

// ── Masking ──────────────────────────────────────────────────────────────────
// Several gates must ignore text that only LOOKS like prose. A banned word inside a URL slug, an em
// dash inside a fenced code sample, or a keyword inside a link target are all false positives, and a
// validator that cries wolf on them trains the author to ignore it.

interface Masked {
  /** Same length as the input, with non-prose spans replaced by spaces so indices still line up. */
  text: string;
}

function maskNonProse(body: string): Masked {
  let out = body;
  const blank = (m: string) => " ".repeat(m.length);
  out = out.replace(/```[\s\S]*?```/g, blank);   // fenced code
  out = out.replace(/`[^`\n]*`/g, blank);        // inline code
  out = out.replace(/\]\([^)]*\)/g, blank);      // link TARGETS (keeps the anchor text visible)
  out = out.replace(/^\s{4,}\S.*$/gm, blank);    // indented code blocks
  out = out.replace(/<!--[\s\S]*?-->/g, blank);  // html comments
  return { text: out };
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── The gates ────────────────────────────────────────────────────────────────

export interface ValidateInput {
  body: string;
  voice: WriterVoice;
  outline: WriterOutline | null;
  brief: { primary_keyword?: string; word_count?: number; negative_keywords?: string[] };
  /** URLs a research tool actually returned this session. The provenance allowlist. */
  ledgerUrls: Set<string>;
  /** URLs from the voice's internal-link database. Also allowed. */
  sitemapUrls: Set<string>;
  /** Real queries we retrieved: People Also Ask questions plus Search Console queries. Question
   *  headings are checked against this so an invented question is at least surfaced. Omit to skip
   *  that check (e.g. when no SERP data was available for the topic). */
  realQuestions?: string[];
  /**
   * Terms a feature, app or tool page already owns (lib/blog/cannibalization.ts → ownedHeadTerms).
   *
   * Passed IN rather than read here because this function is pure and synchronous, and the selfcheck
   * route calls it seventeen times over fixture bodies — giving it a database dependency would make
   * every one of those a network call. The caller already does async work and has the list.
   *
   * Omit to skip the check.
   */
  ownedTerms?: string[];
}

/**
 * The two purely typographic fixes, on any piece of prose.
 *
 * Extracted from validateArticle because they are needed on fragments too: a shortened or rewritten
 * section comes back from the model as a snippet, and it must go through the same em-dash and
 * exclamation rules as a full article. One implementation, or the editor's inline edits quietly
 * become the one place em dashes get in.
 */
export function autoFixTypography(input: string): { text: string; violations: Violation[] } {
  const violations: Violation[] = [];
  let body = input;

  // ── em dashes ──
  // Not a style preference: it is the single most-cited "this was machine-written" tell, and every
  // voice bans it. Replaced outside code/URLs only.
  {
    const masked = maskNonProse(body).text;
    const positions: number[] = [];
    for (let i = 0; i < masked.length; i++) if (masked[i] === "—" || masked[i] === "–") positions.push(i);
    // En dashes inside numeric ranges ("150–200 words") are correct typography; only flag a dash
    // that is acting as a clause separator, i.e. not sitting between two digits.
    const toFix = positions.filter((i) => !(/\d/.test(body[i - 1] ?? "") && /\d/.test(body[i + 1] ?? "")));
    if (toFix.length) {
      const chars = [...body];
      for (const i of toFix) chars[i] = ",";
      // "word , word" would be wrong; collapse the space the dash left behind.
      body = chars.join("").replace(/\s+,/g, ",");
      violations.push({
        gate: "em_dash", severity: "auto_fix",
        detail: `Replaced ${toFix.length} em/en dash(es) used as clause separators.`,
      });
    }
  }

  // ── exclamation marks beyond the first ──
  //
  // Counted on the masked text and, until this was fixed, REPLACED on the raw one — so every `!`
  // the mask had deliberately excluded was rewritten anyway. And a markdown image begins `![`, where
  // the bang is SYNTAX, not punctuation.
  //
  // Together those turned the second inline image of every article into a plain link:
  //
  //     ![Why I stopped opening the stock tab first](https://blogs-cdn...)   first ! survives
  //     .[What is AI generated B-roll](https://blogs-cdn...)                 second ! becomes .
  //
  // The image then stops rendering, and link_provenance correctly reports the URL as a fabricated
  // link — because by that point it IS one. Two real articles failed on exactly that. It could not
  // happen before body images existed on the unattended path; there was no non-prose `!` to hit.
  //
  // Indices are shared: maskNonProse is index-preserving, which is what the em-dash pass above
  // relies on too.
  {
    const masked = maskNonProse(body).text;
    const positions: number[] = [];
    for (let i = 0; i < masked.length; i++) {
      if (masked[i] !== "!") continue;          // prose only, same as the count
      if (body[i + 1] === "[") continue;        // `![` opens an image: syntax, leave it alone
      positions.push(i);
    }
    if (positions.length > 1) {
      const chars = [...body];
      // Keep the first, flatten the rest.
      for (const i of positions.slice(1)) chars[i] = ".";
      body = chars.join("");
      violations.push({
        gate: "exclamation", severity: "auto_fix",
        detail: `Reduced ${positions.length} exclamation marks to 1.`,
      });
    }
  }

  // ── Title Case headings ──
  // Every voice guide says sentence case, and SKILL_PROMPT says it twice — but nothing enforced it, so it
  // was advice the model could quietly ignore. Auto-fixable because lowercasing a word mid-heading is a
  // mechanical edit with no judgement in it.
  //
  // The heuristic is "three or more capitalised words in one heading", which is what Title Case actually
  // looks like. Two is left alone because "Ad Studio pricing" is a proper noun plus prose, not Title Case.
  // ALL-CAPS tokens (API, CTA, 4K) and anything after a colon are never touched.
  {
    body = body.replace(/^(#{1,6})[ \t]+(.+)$/gm, (line, hashes: string, text: string) => {
      // A heading that is one long sentence is not Title Case even if it has several proper nouns in it.
      const words = text.trim().split(/\s+/);
      if (words.length < 3) return line;

      // One-or-more lowercase letters, not two: Title Case capitalises the short function words too
      // ("How To Build An X"), and requiring two would miss "To"/"An"/"Of" — the very words that make a
      // heading Title Case — which drags the ratio below the threshold and lets the heading through.
      // Still excludes ALL-CAPS tokens (AI, MCP, API, 4K), which is what the trailing `$` on [a-z]+ buys.
      const isCapWord = (w: string) => /^[A-Z][a-z]+$/.test(w.replace(/[^\w]/g, ""));
      const capped = words.filter(isCapWord);
      // Ratio as well as count: 3 capitalised words out of 15 is prose, 5 out of 6 is Title Case.
      if (capped.length < 3 || capped.length / words.length < 0.6) return line;

      const fixed = words
        .map((w, i) => {
          if (i === 0) return w; // the first word stays capitalised in sentence case
          if (!isCapWord(w)) return w;
          return w[0].toLowerCase() + w.slice(1);
        })
        .join(" ");
      if (fixed === text) return line;
      violations.push({
        gate: "title_case_heading", severity: "auto_fix",
        detail: `Converted a Title Case heading to sentence case: "${text.trim()}".`,
      });
      return `${hashes} ${fixed}`;
    });
  }

  // ── emoji ──
  // The guides ban emoji as bullets or section markers, and the app itself had every emoji stripped out
  // on purpose. A model that emits one into an article body would put it on a published page, so this is
  // a removal rather than a flag.
  {
    // Pictographic ranges only. Deliberately does NOT include U+2000–U+2BFF wholesale, which would eat
    // arrows, bullets and quotation marks that are legitimate punctuation.
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;
    const masked = maskNonProse(body).text;
    const count = (masked.match(EMOJI) ?? []).length;
    if (count > 0) {
      // Collapse the whitespace the emoji leaves behind, including a leading "- 🎬 " bullet marker.
      body = body.replace(EMOJI, "").replace(/[ \t]{2,}/g, " ").replace(/^([-*]) +/gm, "$1 ");
      violations.push({
        gate: "emoji", severity: "auto_fix",
        detail: `Removed ${count} emoji.`,
      });
    }
  }

  // ── tracking parameters on links ──
  // A model asked to cite a source hands back the URL it was given, and those increasingly carry the
  // referring tool's own name: `utm_source=chatgpt.com`, `ref=perplexity`. Published on an imagine.art
  // page that credits a third party for traffic from our own content, in the destination's analytics.
  //
  // Auto-fix rather than flag: there is exactly one correct answer (remove them), no judgement involved,
  // and it lives here so the editor's inline edits get the same treatment as generated sections.
  //
  // NOTE for whoever touches the provenance gate: it compares body links against the tool ledger, and the
  // ledger stores RAW tool URLs which may still carry these params. Both sides are normalised through
  // cleanExternalUrl() there for exactly this reason — strip here without normalising there and every
  // cleaned link gets reported as fabricated.
  {
    const seen: string[] = [];
    body = body.replace(/\]\((https?:\/\/[^)\s]+)\)/g, (whole, url: string) => {
      if (!hasTrackingParams(url)) return whole;
      const clean = cleanExternalUrl(url);
      if (!clean) return whole;
      seen.push(url);
      return `](${clean})`;
    });
    if (seen.length) {
      violations.push({
        gate: "tracking_params", severity: "auto_fix",
        detail: `Stripped tracking parameters from ${seen.length} link(s). These credit a third party for ` +
          `traffic from our own page: ${seen.slice(0, 2).join(", ")}`,
      });
    }
  }

  // ── ellipsis used as a suspense device ──
  // "And that changes everything…" is called out by name in the guides. An ellipsis mid-sentence can be a
  // legitimate elision, so only one at the end of a line is treated as the suspense pattern.
  {
    const before = body;
    body = body.replace(/[ \t]*(?:…|\.\.\.)[ \t]*$/gm, ".");
    if (body !== before) {
      violations.push({
        gate: "ellipsis_suspense", severity: "auto_fix",
        detail: "Replaced trailing ellipsis used for suspense with a full stop.",
      });
    }
  }

  return { text: body, violations };
}

export function validateArticle(input: ValidateInput): ValidationResult {
  const { voice, outline, brief, ledgerUrls, sitemapUrls } = input;

  const typo = autoFixTypography(input.body);
  const violations: Violation[] = [...typo.violations];
  let body = typo.text;

  const masked = maskNonProse(body).text;
  const words = wordCount(masked);

  // ── repair: banned words and phrases ──
  {
    const hits: string[] = [];
    const lower = masked.toLowerCase();
    for (const p of voiceBannedPhrases(voice)) if (lower.includes(p)) hits.push(`"${p}"`);
    for (const w of voiceBannedWords(voice)) {
      if (new RegExp(`\\b${escapeRe(w)}\\b`, "i").test(lower)) hits.push(`"${w}"`);
    }
    if (hits.length) {
      violations.push({
        gate: "banned_terms", severity: "repair",
        detail: `Remove and rephrase: ${hits.join(", ")}. Say the specific thing each was standing in for rather than swapping in a near-synonym.`,
      });
    }
  }

  // ── repair: bold used for mid-sentence emphasis ──
  // Called out in all three voice guides as a giveaway of AI drafting. Not auto-fixed: stripping the
  // markers can leave a sentence that was leaning on the emphasis to carry its meaning, so the model
  // should rewrite it to put the weight on the words instead.
  //
  // The deliberate exception is a bold run at the START of a line or bullet, which is a structural label
  // (the Image T7 template's bulleted sections are built that way) rather than emphasis.
  {
    const emphasis: string[] = [];
    for (const line of masked.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      // Strip an opening bullet/number marker, then a leading bold run — those are labels, not emphasis.
      const afterMarker = trimmed.replace(/^(?:[-*+]|\d+\.)\s+/, "");
      const afterLabel = afterMarker.replace(/^\*\*[^*]+\*\*:?\s*/, "");
      for (const m of afterLabel.matchAll(/\*\*([^*\n]{1,60})\*\*/g)) emphasis.push(m[1]);
    }
    if (emphasis.length) {
      violations.push({
        gate: "mid_sentence_bold", severity: "repair",
        detail:
          `Remove mid-sentence bolding (${emphasis.slice(0, 4).map((e) => `"${e}"`).join(", ")}` +
          `${emphasis.length > 4 ? `, +${emphasis.length - 4} more` : ""}). ` +
          "Rewrite so the sentence carries the emphasis. Bold is for headings and structural labels only.",
      });
    }
  }

  // ── repair: headings that run long ──
  // Reported by the SEO team on real output. A heading is a label, not a sentence: it has to be scannable
  // in a table of contents, it becomes the anchor text of any jump link, and Google truncates it in a
  // featured snippet. Long headings are also a symptom worth surfacing rather than just trimming — a
  // heading that needs 14 words is usually covering two sections that should be split.
  //
  // 10 words / 70 characters is the threshold, applied to H2 and H3 only. H1 is exempt because the article
  // title has its own Strapi minimum of 35 characters and is validated as metadata, so trimming it here
  // would fight that rule.
  //
  // Question headings get a slightly longer budget: they come verbatim from real People Also Ask queries
  // (the no-invented-questions gate enforces that), and rewording one to fit a word count would break the
  // exact-match with what people actually search.
  {
    const long: string[] = [];
    for (const m of body.matchAll(/^(#{2,3})[ \t]+(.+)$/gm)) {
      const text = m[2].trim();
      const isQuestion = text.endsWith("?");
      const words = text.split(/\s+/).filter(Boolean).length;
      const maxWords = isQuestion ? 14 : 10;
      const maxChars = isQuestion ? 95 : 70;
      if (words > maxWords || text.length > maxChars) {
        long.push(`"${text}" (${words} words, ${text.length} chars)`);
      }
    }
    if (long.length) {
      violations.push({
        gate: "heading_too_long", severity: "repair",
        detail:
          `${long.length} heading(s) run long: ${long.slice(0, 3).join("; ")}` +
          `${long.length > 3 ? `, +${long.length - 3} more` : ""}. ` +
          "Cut each to at most 10 words (14 for a question heading). A heading is a label, not a sentence — " +
          "it becomes anchor text and gets truncated in search results. If one cannot be shortened without " +
          "losing meaning, the section is probably covering two things and should be split.",
      });
    }
  }

  // ── flag: stacked transition words ──
  // The guides are explicit that these are "individually harmless and collectively a tell", which is why
  // they are counted here rather than banned outright — a flat ban would fire on ordinary English, and
  // since a flagged draft blocks Publish, that would turn a style note into a broken publish path.
  //
  // `flag`, not `repair`: at this density it is a symptom of a paragraph that has not decided what it is
  // arguing, and a scoped rewrite turn tends to swap the words rather than fix the structure. Better to
  // surface it for a person.
  {
    const TRANSITIONS = /\b(?:moreover|furthermore|additionally|in addition|what's more)\b/gi;
    const hits = (masked.match(TRANSITIONS) ?? []).length;
    const words = wordCount(masked);
    // Roughly one per 500 words reads as normal connective prose; three in a 700-word piece does not.
    const budget = Math.max(2, Math.round(words / 500));
    if (hits > budget) {
      violations.push({
        gate: "stacked_transitions", severity: "flag",
        detail:
          `${hits} stacked transition words ("moreover", "furthermore", "additionally") in ${words} words ` +
          `(about ${budget} would read as normal). Usually a sign a section is listing points rather than ` +
          "making an argument.",
      });
    }
  }

  // ── repair: templated AI sentence shapes ──
  // From ai_telltale_phrases.md's "Structural Habits to Avoid" — patterns that are a dead giveaway
  // regardless of the specific words filled in, so a flat banned-phrase match can't catch them. Bundled
  // into one gate rather than one block each, mirroring how banned_terms batches multiple word hits into
  // a single violation: these are all instances of the same underlying problem (a templated shape doing
  // the thinking instead of the specific sentence), so one repair turn should fix all of them at once.
  //
  // "Not X, but Y" is deliberately excluded from the single-hit templates below and counted instead
  // (budget, not a flat match) for the same reason stacked_transitions counts rather than bans: "not a
  // bug, but a feature" is completely ordinary contrastive prose, and only becomes a tell at density.
  {
    const shapeHits: string[] = [];

    // "It's not just X, it's Y" / "Not only X but also Y" — specific enough that one hit already reads
    // as the cliché rather than a sentence that happens to use "not" and "but".
    if (/\bit'?s\s+not\s+just\s+[^.,;\n]{2,60},?\s+it'?s\s+/i.test(masked)) {
      shapeHits.push('the "it\'s not just X, it\'s Y" construction');
    }
    if (/\bnot\s+only\s+[^.,;\n]{2,60}\s+but\s+(?:also\s+)?/i.test(masked)) {
      shapeHits.push('a "not only X but also Y" construction');
    }
    // "Whether you're a beginner or a professional" — the shape only shows up as this cliché; real
    // prose describing two genuinely different audiences reads differently.
    if (/\bwhether\s+you'?re\s+a(?:n)?\s+[^,.;\n]{2,30}\s+or\s+(?:an?\s+)?[^,.;\n]{2,30}\b/i.test(masked)) {
      shapeHits.push('a "whether you\'re a X or a Y" opener');
    }
    // Participial throat-clearing: "Designed to empower creators everywhere, ImagineArt is built to..."
    if (/^(?:Designed|Built|Aimed|Created|Engineered)\s+to\s+\w[^.\n]{0,70},\s+\w+\s+(?:is|are)\b/im.test(masked)) {
      shapeHits.push("a participial throat-clearing opener (\"Designed to X, Y is Z\")");
    }
    // Hedge stacking: two hedges in one clause carry no more meaning than one.
    if (/\b(?:this|it)\s+could\s+potentially\b/i.test(masked) || /\bmight\s+possibly\b/i.test(masked) || /\bmay\s+potentially\b/i.test(masked)) {
      shapeHits.push('a doubled hedge ("could potentially", "might possibly")');
    }
    // "Now that we've covered X, let's look at Y" — a transition that names the transition instead of
    // just making it.
    if (/\bnow that we'?(?:ve|have)\s+(?:covered|discussed|looked at|explored)\s+[^,.\n]{2,60},?\s+let'?s\s+(?:look at|explore|dive into|move on to|turn to)\b/i.test(masked)) {
      shapeHits.push('a "now that we\'ve covered X, let\'s look at Y" transition');
    }
    // "The future of X is here" — the variable middle is why this needs a regex, not a phrase-list entry.
    if (/\bthe\s+future\s+of\s+[^.\n]{1,40}\s+is\s+here\b/i.test(masked)) {
      shapeHits.push('a "the future of X is here" closer');
    }
    // Forced rhetorical question immediately answered by a short stock sentence. Counted, not matched
    // on first sight, for the same reason as stacked_transitions: one rhetorical question is a normal
    // device, and only repetition reads as a tic.
    {
      const paras = masked.split(/\n{2,}/);
      let qaCount = 0;
      for (const p of paras) {
        const t = p.trim();
        if (!t || t.startsWith("#")) continue;
        if (/^[A-Z][^.!?\n]{3,60}\?\s+[A-Z][^.!?\n]{1,40}[.!]$/.test(t)) qaCount++;
      }
      if (qaCount >= 2) shapeHits.push(`${qaCount} rhetorical-question-then-stock-answer paragraphs`);
    }
    // "Not X, but Y" — density-gated, see comment above.
    {
      const notButCount = (masked.match(/\bnot\s+[^,.;\n]{2,40},\s*but\s+/gi) ?? []).length;
      if (notButCount >= 3) shapeHits.push(`${notButCount} "not X, but Y" constructions`);
    }

    if (shapeHits.length) {
      violations.push({
        gate: "sentence_shape_tell", severity: "repair",
        detail: `Found ${shapeHits.join("; ")}. These are templated shapes that read as AI-generated ` +
          "regardless of the words filling them in. Rewrite the sentence to make the specific point " +
          "directly instead of pouring it into the template.",
      });
    }
  }

  // ── flag: tricolon padding ──
  // "Fast, efficient, and reliable." Three adjectives standing in for one specific claim. Narrowed to
  // fire after a copula (is/are/looks/feels/sounds) so it doesn't catch a genuine enumeration of distinct
  // nouns ("cats, dogs, and birds"), which is ordinary prose, not padding.
  {
    const tricolonHits: string[] = [];
    for (const m of masked.matchAll(/\b(?:is|are|was|were|looks?|feels?|sounds?|reads?)\s+(\w+),\s*(\w+),?\s+and\s+(\w+)\b/gi)) {
      tricolonHits.push(m[0].trim());
    }
    // The other shape from the guide: three consecutive one-word sentences ("Simple. Effective.
    // Repeatable."). Sentence-split rather than regex, because a regex anchored on periods can't tell a
    // sentence boundary from a decimal or an abbreviation.
    const sentences = masked.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i + 2 < sentences.length; i++) {
      const three = sentences.slice(i, i + 3);
      if (three.every((s) => /^[A-Za-z][\w'-]*[.!]$/.test(s))) {
        tricolonHits.push(three.join(" "));
      }
    }
    if (tricolonHits.length) {
      violations.push({
        gate: "tricolon", severity: "flag",
        detail: `${tricolonHits.length} tricolon pattern(s): ${tricolonHits.slice(0, 3).map((h) => `"${h}"`).join(", ")}` +
          `${tricolonHits.length > 3 ? `, +${tricolonHits.length - 3} more` : ""}. Three adjectives or ` +
          "three one-word sentences standing in for one specific claim. Name the actual thing instead.",
      });
    }
  }

  // ── flag: a heading restated as the first sentence after it ──
  // "## Native 4K Output\n\nNative 4K output means..." The heading already said it; the section should
  // add to it, not repeat it. Compared on significant words only (short stopwords stripped) so a heading
  // and its opening sentence sharing "the" and "a" doesn't count as an echo.
  {
    const STOPWORDS = new Set(["a", "an", "the", "of", "for", "and", "or", "to", "in", "on", "is", "are", "with", "your", "you", "how"]);
    const sig = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
    const echoes: string[] = [];
    const headingRe = /^(#{2,3})[ \t]+(.+)$/gm;
    let hm: RegExpExecArray | null;
    while ((hm = headingRe.exec(body))) {
      const rest = body.slice(hm.index + hm[0].length);
      const nextPara = rest.match(/\n{2,}([^\n#][^\n]*)/);
      if (!nextPara) continue;
      const firstSentence = nextPara[1].split(/(?<=[.!?])\s/)[0];
      const headWords = sig(hm[2]);
      if (headWords.size < 2) continue;
      const sentWords = sig(firstSentence);
      const overlap = [...headWords].filter((w) => sentWords.has(w)).length;
      if (overlap / headWords.size >= 0.7) {
        echoes.push(`"${hm[2].trim()}"`);
      }
    }
    if (echoes.length) {
      violations.push({
        gate: "heading_echo", severity: "flag",
        detail: `${echoes.length} heading(s) restated almost verbatim in the sentence right after: ${echoes.slice(0, 3).join(", ")}. Open the section by adding to the heading, not repeating it.`,
      });
    }
  }

  // ── flag: formatting tells ──
  // ai_telltale_phrases.md's "Formatting Tells" — none of these are about WHAT the prose says, only how
  // it's shaped on the page, which is why they're detected on structure (paragraph lengths, bullet
  // ratios, blank-line positions) rather than on any word list.
  {
    const fmtHits: string[] = [];

    // Every paragraph the same length. Body paragraphs only (skip headings, bullets, code, blockquotes),
    // and only counted once there are enough of them for "uniform" to mean anything.
    const paraWordCounts = masked
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p && !/^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)/.test(p))
      .map((p) => p.split(/\s+/).filter(Boolean).length)
      .filter((n) => n >= 25); // short paragraphs (a one-liner, a lead-in) are naturally uniform-ish
    if (paraWordCounts.length >= 4) {
      const mean = paraWordCounts.reduce((a, b) => a + b, 0) / paraWordCounts.length;
      const variance = paraWordCounts.reduce((a, n) => a + (n - mean) ** 2, 0) / paraWordCounts.length;
      const cv = Math.sqrt(variance) / mean;
      if (cv < 0.12) {
        fmtHits.push(`${paraWordCounts.length} paragraphs all within ${Math.round(cv * 100)}% of the same length (${Math.round(mean)} words each)`);
      }
    }

    // Bullet lists for everything. A high ratio of bullet lines to prose lines on a long enough piece.
    const bodyLines = body.split("\n").filter((l) => l.trim() && !/^#{1,6}\s/.test(l) && !/^```/.test(l));
    const bulletLines = bodyLines.filter((l) => /^\s*(?:[-*+]|\d+\.)\s+/.test(l));
    if (bodyLines.length >= 20 && bulletLines.length / bodyLines.length > 0.45) {
      fmtHits.push(`${bulletLines.length} of ${bodyLines.length} body lines are bullets (${Math.round((bulletLines.length / bodyLines.length) * 100)}%) — some of this should be prose`);
    }

    // Colon introducing a single-item "list" — a colon-terminated line followed by exactly one bullet,
    // then something other than a second bullet. A real list has ≥2 items; one item is just a sentence
    // wearing a bullet as a costume. Blank lines are skipped when looking for "the next line" — markdown
    // conventionally puts one between a lead-in and its list, so lines[i+1] would just be "" and this
    // would never fire on the exact shape it exists to catch.
    let singleItemLists = 0;
    const lines = body.split("\n");
    const nextNonBlank = (from: number) => {
      let j = from;
      while (j < lines.length && lines[j].trim() === "") j++;
      return j;
    };
    for (let i = 0; i < lines.length; i++) {
      if (!/:\s*$/.test(lines[i].trim())) continue;
      const bulletAt = nextNonBlank(i + 1);
      if (!/^\s*[-*+]\s+/.test(lines[bulletAt] ?? "")) continue;
      const secondAt = nextNonBlank(bulletAt + 1);
      if (/^\s*[-*+]\s+/.test(lines[secondAt] ?? "")) continue; // a second bullet follows — it's a real list
      singleItemLists++;
    }
    if (singleItemLists >= 2) {
      fmtHits.push(`${singleItemLists} colons introducing a "list" of exactly one bullet — just finish the sentence`);
    }

    // Every bullet in a list opening with the same word — the list reads as a template being filled in
    // rather than distinct points.
    const bulletGroups: string[][] = [];
    let current: string[] = [];
    for (const l of lines) {
      const m = l.match(/^\s*(?:[-*+]|\d+\.)\s+(\S+)/);
      if (m) current.push(m[1].toLowerCase().replace(/[^a-z]/g, ""));
      else if (current.length) { bulletGroups.push(current); current = []; }
    }
    if (current.length) bulletGroups.push(current);
    for (const g of bulletGroups) {
      for (let i = 0; i + 2 < g.length; i++) {
        if (g[i] && g[i] === g[i + 1] && g[i] === g[i + 2]) {
          fmtHits.push(`a bulleted list where 3+ consecutive items all start with "${g[i]}"`);
          break;
        }
      }
    }

    if (fmtHits.length) {
      violations.push({
        gate: "formatting_tell", severity: "flag",
        detail: `${fmtHits.join("; ")}.`,
      });
    }
  }

  // ── repair: negative keywords the user explicitly excluded ──
  {
    const lower = masked.toLowerCase();
    const hits = (brief.negative_keywords ?? []).filter((n) => n.trim() && lower.includes(n.toLowerCase()));
    if (hits.length) {
      violations.push({
        gate: "negative_keywords", severity: "repair",
        detail: `The user asked to avoid these in this piece: ${hits.map((h) => `"${h}"`).join(", ")}.`,
      });
    }
  }

  // ── repair: placeholders ──
  // Reuses the same shapes as the outreach generators (src/lib/email/followup.ts) — a bracketed or
  // mustache token means the model punted on a real value.
  {
    const bracket = masked.match(/\[[^\]\n]{1,40}\]/g) ?? [];
    // A markdown link is `[anchor](url)`, which is not a placeholder — exclude those.
    const realPlaceholders = bracket.filter((b) => {
      const at = masked.indexOf(b);
      return masked[at + b.length] !== "(";
    });
    const mustache = masked.match(/\{\{[^}\n]+\}\}/g) ?? [];
    if (realPlaceholders.length || mustache.length) {
      violations.push({
        gate: "placeholder", severity: "repair",
        detail: `Unfilled placeholder(s): ${[...realPlaceholders, ...mustache].slice(0, 5).join(", ")}. Write the sentence so it does not need one.`,
      });
    }
  }

  // ── keyword placement and density ──
  const keyword = (brief.primary_keyword ?? "").trim();
  let keywordCount = 0;
  let density = 0;
  if (keyword) {
    const re = new RegExp(escapeRe(keyword), "gi");
    keywordCount = (masked.match(re) ?? []).length;
    density = words ? (keywordCount * wordCount(keyword)) / words : 0;

    const h1 = body.match(/^#\s+(.+)$/m)?.[1] ?? outline?.h1 ?? "";
    if (h1 && !new RegExp(escapeRe(keyword), "i").test(h1)) {
      violations.push({ gate: "keyword_in_h1", severity: "repair", detail: `The H1 does not contain "${keyword}".` });
    }
    const firstHundred = masked.trim().split(/\s+/).slice(0, 100).join(" ");
    if (!new RegExp(escapeRe(keyword), "i").test(firstHundred)) {
      violations.push({
        gate: "keyword_early", severity: "repair",
        detail: `"${keyword}" does not appear in the first 100 words.`,
      });
    }
    const h2s = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]);
    const h2Hits = h2s.filter((h) => new RegExp(escapeRe(keyword), "i").test(h)).length;
    if (h2Hits < 2) {
      violations.push({
        gate: "keyword_in_h2", severity: "repair",
        detail: `"${keyword}" appears in ${h2Hits} H2 heading(s); the target is 2 to 3. Add it where a heading naturally wants that exact phrase.`,
      });
    }
    // Over-stuffing is worse than under-using: it reads as spam to a reader and to a ranking system.
    if (density > 0.02) {
      violations.push({
        gate: "keyword_density_high", severity: "repair",
        detail: `Keyword density is ${(density * 100).toFixed(1)}%, above the 2% ceiling. Remove the mentions that a human would not have written.`,
      });
    } else if (density < 0.01 && words > 300) {
      violations.push({
        gate: "keyword_density_low", severity: "repair",
        detail: `Keyword density is ${(density * 100).toFixed(1)}%, below the 1% floor. Add the exact phrase only where a sentence genuinely wants it.`,
      });
    }
  }

  // ── the head term another page owns ──
  //
  // The pre-draft gate is what stops this article being aimed at a feature page's term in the first
  // place (lib/blog/cannibalization.ts), and it is the better place to catch it: by the time a body
  // exists, the keyword has already shaped every heading. This is the backstop for the two cases that
  // reach here anyway — a request that came through the ADVISORY path and kept its keyword, and a
  // writer that drifted back to the term it was told to avoid.
  //
  // Opening position only. The standard forbids leading with a term another page owns, not mentioning
  // it: the sentence that links up to the owner has to name it, and that link is the whole mechanism by
  // which a supporting article supports rather than competes.
  const ownedTerms = input.ownedTerms ?? [];
  if (ownedTerms.length) {
    const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? outline?.h1?.trim() ?? "";
    const lower = h1.toLowerCase();
    // Longest first: "ai avatar video generator" and "ai avatar generator" can both match, and naming
    // the longer one tells the writer which page it is actually colliding with.
    const hit = [...ownedTerms].sort((a, b) => b.length - a.length)
      .find((t) => t.length > 6 && lower.startsWith(t.toLowerCase()));
    if (hit) {
      // ── Why the severity splits on whether it IS the primary keyword ────────────────────────────
      //
      // `keyword_in_h1` above REQUIRES the primary keyword in the H1. If the owned term and the primary
      // keyword are the same string, a `repair` here would ask the writer to satisfy two rules that
      // constrain one phrase from opposite sides, and the repair loop would spend its rounds oscillating
      // — the same shape as the thumbnail violation the writer could not satisfy and kept being asked to.
      //
      // So: when they differ, the writer can simply move the phrase, and `repair` is honest. When they
      // are the same, the target itself is wrong and no amount of rewriting fixes it — that is a
      // decision for a person, which is what `flag` means.
      const isTheKeyword = keyword && hit.toLowerCase() === keyword.toLowerCase();
      violations.push({
        gate: "owned_head_term_in_h1",
        severity: isTheKeyword ? "flag" : "repair",
        detail: isTheKeyword
          ? `The H1 opens with "${hit}", which is also this article's primary keyword — and that term is `
            + "already owned by a feature, app or tool page. This cannot be fixed by rewriting the H1: the "
            + "article is aimed at a query another page should win. Retarget it or accept that the two will "
            + "compete."
          : `The H1 opens with "${hit}", a term a feature, app or tool page already owns. Lead with what `
            + `this article uniquely does. "${hit}" can appear later, in the sentence that links to the `
            + "page that owns it.",
      });
    }
  }

  // ── our own social links ──
  //
  // The writer is told it may link one or two of our accounts where a sentence genuinely earns it. Two
  // ways that degrades, and both are repairable by rewriting rather than by a human decision:
  //
  //   the link count creeps up until the body carries a footer the template already provides
  //   the links get collected under a heading, which is the same footer wearing a hat
  //
  // A social URL that is not one of ours needs no gate here: link_provenance already calls it
  // fabricated, which is the right verdict for an invented handle or a deep link to a specific post.
  // ── contrastive negation ──────────────────────────────────────────────────────────────────────
  //
  // "The demand is measured, not theoretical" was flagged in review as reading machine-written, and a
  // sweep of thirty days of drafts found the construction almost everywhere: "decoration, not
  // communication", "faster, not cheaper", "generated, not recovered", "the sound bed is timing, not
  // decoration". It says the same thing twice, once positively and once negatively.
  //
  // `repair` rather than `flag` because the fix needs no human judgement — keep the positive half and
  // delete the rest. Threshold is 1 rather than 0 deliberately: one can be the right sentence, and a
  // gate that fires on every article is a gate people learn to ignore.
  {
    const hits = contrastiveNegations(body);
    if (hits.length > MAX_CONTRASTIVE) {
      const shown = hits.slice(0, 4).map((h) => `"${h.text}"`).join(", ");
      violations.push({
        gate: "contrastive_negation", severity: "repair",
        detail: `${hits.length} contrastive-negation constructions; at most ${MAX_CONTRASTIVE} belongs in `
          + `an article. ${shown}${hits.length > 4 ? ", …" : ""}. Keep the positive half and stop — `
          + "\"The demand is measured.\" If the excluded thing matters, give it its own sentence and its "
          + "own reason.",
      });
    }
  }

  // ── The brand reference, in both directions ───────────────────────────────────────────────────
  //
  // We publish about models we do not host on purpose, for user value and domain authority. The cost
  // of that decision is that such an article has no natural reason to mention us, and the two ways it
  // goes wrong are opposite: zero mentions (a well-ranked page that sends the reader to a competitor
  // and converts nothing) or a closing "Ready to create? Try ImagineArt free!" (which tells the
  // reader the preceding 1,500 words were an advert).
  //
  // Both gates are `repair` rather than `flag`: each has an obvious fix that does not need a human to
  // adjudicate — add the sentence where the reader is deciding, or delete the CTA paragraph.
  {
    const mentions = brandMentionsIn(body);
    if (mentions < BRAND_MENTIONS_MIN) {
      violations.push({
        gate: "brand_absent", severity: "repair",
        detail: "The article never references ImagineArt. Add it once where it does work for the reader — "
          + "the studio they would use for this job, the setting that fixes the problem, or the provenance "
          + "of a generation shown here. Mid-article, where they are deciding. NOT a closing call to action.",
      });
    } else {
      // A rate, and exempt when the brand is in the title — see the note in brand.ts. A flat count
      // would have fired on both real drafts measured, neither of which was padded.
      // The H1 as written, falling back to the approved outline's — same resolution the head-term
      // gates above use, so "is the brand in the title" means the same thing everywhere.
      const h1 = body.match(/^#\s+(.+)$/m)?.[1] ?? outline?.h1 ?? "";
      const dense = brandOverused(body, h1);
      if (dense.over) {
        violations.push({
          gate: "brand_excess", severity: "repair",
          detail: `ImagineArt is named ${dense.mentions} times — ${dense.per1k} per 1,000 characters, which `
            + "reads as padding rather than as the subject. Keep the mentions whose sentence would be worse "
            + "without them and cut the rest.",
        });
      }
    }

    // The closing CTA, matched on the shapes it actually takes rather than on the word "try".
    const tail = body.slice(-700);
    const cta = tail.match(
      /\b(ready to (get started|create|try|begin)|start (creating|generating|your free)|sign up (today|now|free)|try (it )?(imagineart )?(free|now|today)|get started (today|now|free)|create your (first|own)[^.\n]{0,40}(today|now|free))\b/i,
    );
    if (cta) {
      violations.push({
        gate: "brand_closing_cta", severity: "repair",
        detail: `The piece ends on a call to action ("${cta[0]}"). Cut it. An article ends on the reader's `
          + "problem being solved; a sign-up push at the end is the clearest signal that everything above it "
          + "was an advert, and it costs more trust than the link earns.",
      });
    }
  }

  // ── Video embeds that will render as an empty box ─────────────────────────────────────────────
  //
  // This gate exists because the failure is SILENT. imagine-web's blog renderer converts an iframe
  // src to an embed URL only when the src contains "youtube.com/watch" — anything else is passed
  // through untouched, and YouTube refuses to be framed from a youtu.be, /shorts or bare watch URL.
  // So a wrong link does not error anywhere: it publishes, and the reader gets a blank 16:9 hole
  // that nobody notices until someone scrolls the live page.
  {
    const embeds = embedsIn(body);
    const broken = embeds.filter((u) => /youtu\.be\/|\/shorts\/|youtube\.com\/embed\//.test(u));
    if (broken.length) {
      violations.push({
        gate: "video_embed_form", severity: "repair",
        detail: `${broken.length} video embed${broken.length === 1 ? " uses" : "s use"} a URL the blog `
          + `renderer cannot convert (${broken[0]}). It only rewrites a src containing "youtube.com/watch"; `
          + "a youtu.be, /shorts or /embed/ link is passed straight through and renders as an empty player. "
          + "Use the long form: <iframe src=\"https://www.youtube.com/watch?v=ID\"></iframe>.",
      });
    }
    const foreign = embeds.filter((u) => !isOurEmbeddableUrl(u) && !/youtu\.be\/|\/shorts\/|youtube\.com\/embed\//.test(u));
    if (foreign.length) {
      violations.push({
        gate: "video_embed_foreign", severity: "flag",
        detail: `An embed points somewhere that is not an ImagineArt YouTube video (${foreign[0]}). `
          + "We embed our own channel only.",
      });
    }
    if (embeds.length > MAX_EMBEDS) {
      violations.push({
        gate: "video_embed_excess", severity: "repair",
        detail: `${embeds.length} video embeds; the cap is ${MAX_EMBEDS}. Keep the ones the prose actually `
          + "reaches and cut the rest — a page of players reads as padding.",
      });
    }
  }

  {
    const socials = socialLinksIn(body);
    if (socials.length > MAX_SOCIAL_LINKS) {
      violations.push({
        gate: "social_links_excess", severity: "repair",
        detail: `${socials.length} links to our own social accounts; the cap is ${MAX_SOCIAL_LINKS}. `
          + "Keep the one or two where the sentence around the link does real work for the reader and cut "
          + "the rest — the published page already has the site footer.",
      });
    }
    // A heading about our socials, or a "follow us" line. Matched on the heading and on the imperative
    // because the block arrives in both shapes.
    const followBlock = body.match(/^#{2,4}\s*.*\b(follow us|find us|connect with us|our socials?|stay in touch|join our community)\b.*$/im)
      ?? body.match(/^\s*(?:follow|find|connect with) us\b.*$/im);
    if (followBlock && socials.length) {
      violations.push({
        gate: "social_follow_block", severity: "repair",
        detail: `"${followBlock[0].trim().slice(0, 70)}" is a follow-us block. Our accounts belong inline, `
          + "in a sentence that gives the reader a reason to click — a troubleshooting note, a place to see "
          + "more output. A block of platform names is boilerplate a reader skips.",
      });
    }
    const notOurs = socials.filter((u) => !isOurSocial(u));
    if (notOurs.length) {
      violations.push({
        gate: "social_link_not_canonical", severity: "repair",
        detail: `${notOurs.slice(0, 3).join(", ")} is on one of our platforms but is not our canonical `
          + "account URL. A deep link to a specific post or video rots; link the account itself.",
      });
    }
  }

  // ── structure ──
  const h1Count = (body.match(/^#\s+/gm) ?? []).length;
  if (h1Count > 1) {
    violations.push({ gate: "multiple_h1", severity: "flag", detail: `Found ${h1Count} H1 headings; a page must have exactly one.` });
  }
  const faqHeadings = [...body.matchAll(/^##\s+.*\?\s*$/gm)].length;
  if (outline && faqHeadings < 2) {
    violations.push({
      gate: "faq_headings", severity: "flag",
      detail: `Only ${faqHeadings} question-format H2(s); the target is 2 to 4. These are what earn featured snippets and answer-engine citations.`,
    });
  }

  // ── GEO: the answer-first opening ───────────────────────────────────────────
  //
  // The single highest-value GEO technique, and the one thing a page cannot be quoted without: the
  // first paragraph has to answer the title in its own first sentence, carrying a specific — a
  // number, a named model, a price — rather than warming up to the topic.
  //
  // An answer engine lifts ONE passage. If the opening is "AI video has advanced rapidly and
  // choosing a tool depends on your needs", there is nothing in it to quote, and the engine quotes
  // whoever did write a checkable sentence. Measured on our own reviews site: every page that gets
  // cited opens with the claim, the figure and the date in one sentence.
  //
  // Checked on the OPENING only, deliberately. A body-wide "be specific" rule would fire constantly
  // and get ignored; one scoped rule about one paragraph is followable.
  {
    const afterH1 = body.replace(/^#\s+.*$/m, "");
    const firstPara = afterH1
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      // Skip headings, images, blockquote furniture and list openers to find real prose.
      .find((b) => b.length > 0 && !/^[#>!|\-*\d]/.test(b));

    if (firstPara) {
      const openWords = firstPara.split(/\s+/).length;
      // A specific is a digit, or a capitalised product name that is NOT just the opening word of
      // the sentence — "An AI video generator…" is not a specific, "…uses Seedance 2.0" is.
      const withoutFirstWord = firstPara.replace(/^\S+\s+/, "");
      const hasSpecific = /\d/.test(firstPara) || /\b[A-Z][a-zA-Z]{2,}\s+[A-Z0-9]/.test(withoutFirstWord);
      // The shapes that mean "I have not answered anything yet".
      // Apostrophes are part of the phrase — "In today's world" is the canonical offender, and a
      // character class of [a-z ] silently excluded it.
      const preamble = /^(in (today|the)[a-z' ]+|as (ai|the)[a-z' ]+|(ai|technology) (has|is) (become|becoming|transformed|transforming)|with the rise of|in recent years|in the (world|era|age) of|when it comes to|whether you|there are many|choosing the right|gone are the days)/i.test(firstPara);

      if (preamble) {
        violations.push({
          gate: "answer_first_preamble", severity: "repair",
          detail: `The opening paragraph warms up instead of answering: "${firstPara.slice(0, 90)}…". `
            + "Replace it with one sentence that answers the title directly and carries the number, the "
            + "name or the date. An answer engine quotes one passage, and a preamble gives it nothing to lift.",
        });
      } else if (!hasSpecific) {
        violations.push({
          gate: "answer_first_vague", severity: "flag",
          detail: "The opening paragraph carries no specific — no figure, no named model, no price. "
            + "Put the concrete claim in the first sentence so it survives being quoted on its own.",
        });
      }
      if (openWords > 90) {
        violations.push({
          gate: "answer_first_long", severity: "flag",
          detail: `The opening paragraph is ${openWords} words. Answer the title in the first 40 to 60, `
            + "then continue; an extractor takes the opening block whole.",
        });
      }
    }
  }

  // ── GEO: never head a section with a doubt about us ──────────────────────────
  //
  // A question heading is text on the page, and an engine can quote the QUESTION rather than the
  // answer. "Is ImagineArt legit" on our own page poses the doubt it then answers. Both that and
  // "most common complaints" were deliberately removed from the reviews site's FAQ for exactly this
  // reason — the first invites a negative extraction, the second plants the doubt itself.
  {
    const brandWords = ["imagineart", "imagine art", "imagine.art", "vyro"];
    const doubt = /\b(scam|legit|safe to use|a rip.?off|shut(ting)? down|lawsuit|dangerous|steal(ing)? (your )?data|complaints?|problems? with|worse than)\b/i;
    const offenders = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)]
      .map((mm) => mm[1].trim())
      .filter((h) => doubt.test(h) && brandWords.some((b) => h.toLowerCase().includes(b)));
    if (offenders.length) {
      violations.push({
        gate: "doubt_heading", severity: "repair",
        detail: `These headings plant a doubt about us that an engine can quote on its own: `
          + `${offenders.slice(0, 3).map((h) => `"${h}"`).join(", ")}. Answer the concern inside a `
          + "neutral heading instead — the question is extractable text, not a container.",
      });
    }
  }

  // ── GEO: comparison content needs a table ───────────────────────────────────
  //
  // Comparison queries are where answer engines pull hardest, and a table is the most extractable
  // structure on a page. A "best N" or "X vs Y" piece written as prose paragraphs loses to a
  // competitor's table even when the prose is better.
  {
    // The H1 is the subject line here — `brief` carries the keyword but not a title.
    const h1 = /^#\s+(.+)$/m.exec(body)?.[1] ?? "";
    const subject = `${h1} ${keyword ?? ""}`.toLowerCase();
    const isComparison = /\bvs\.?\b|\bversus\b|\bbest\s+\d|\btop\s+\d|\balternatives?\b|\bcompar/.test(subject);
    // A markdown table needs a delimiter row; a lone pipe in prose is not one.
    const hasTable = /^\s*\|?[\s:-]*\|[\s:|-]*$/m.test(body);
    if (isComparison && !hasTable) {
      violations.push({
        gate: "comparison_table", severity: "repair",
        detail: "This is comparison content with no table. Comparison queries are where answer engines "
          + "extract hardest, and a table is the cleanest thing to lift. Add one row per option with "
          + "the columns a buyer actually weighs.",
      });
    }
  }

  // ── word count ──
  const target = brief.word_count ?? voice.default_word_count;
  if (target && words) {
    const drift = Math.abs(words - target) / target;
    if (drift > 0.1) {
      violations.push({
        gate: "word_count", severity: "repair",
        detail: `${words} words against a ${target} target (${(drift * 100).toFixed(0)}% off, tolerance is 10%).`,
      });
    }
  }

  // ── link provenance: the non-recoverable gate ──
  // IMAGES ARE NOT CITATIONS.
  //
  // This matched on `](` alone, which is also what an image `![alt](url)` contains — so every
  // generated image in the body was checked as though it were a source the article was citing, and
  // reported as fabricated because no research tool returned it. It never surfaced while body images
  // did not exist on the unattended path; enabling them made it fire immediately, and on the one gate
  // that is deliberately never auto-retried and always needs a human.
  //
  // Observed on "Best AI logo generators for graphic designers": link_provenance called
  // blogs-cdn.imagine.art/...best_ai_logo_generators... fabricated. That is our own CDN, holding an
  // image this pipeline rendered and re-hosted a minute earlier.
  //
  // Provenance governs CLAIMS — a URL offered to the reader as a source. An asset the pipeline
  // produced is neither a claim nor something a reader follows for evidence.
  const allLinks = [...body.matchAll(/(!?)\[[^\]]*?\]\((https?:\/\/[^)\s]+)\)/g)]
    .filter((m) => m[1] !== "!")
    .map((m) => m[2]);
  const internalHosts = new Set(voice.allowed_link_hosts.map((h) => h.toLowerCase()));
  const isInternal = (u: string) => {
    try { return internalHosts.has(new URL(u).host.toLowerCase()); } catch { return false; }
  };
  const linksInternal = allLinks.filter(isInternal);
  const linksExternal = allLinks.filter((u) => !isInternal(u));

  {
    // Compare on the CLEANED form of both sides. autoFixTypography has already stripped tracking params
    // from the body, while the ledger holds raw tool URLs that may still carry them — so a link that came
    // through legitimately with `?utm_source=...` would no longer string-match its own ledger entry and
    // would be reported as fabricated. That failure mode is especially nasty because link_provenance is
    // deliberately never auto-retried and always needs a human.
    const norm = (u: string) => cleanExternalUrl(u) ?? u;
    const allowed = new Set<string>();
    for (const u of ledgerUrls) allowed.add(norm(u));
    for (const u of sitemapUrls) allowed.add(norm(u));
    const fabricated = allLinks.filter((u) => !allowed.has(norm(u)));
    if (fabricated.length) {
      violations.push({
        gate: "link_provenance", severity: "flag",
        detail: `These URLs were never returned by a research tool and are not in the internal-link ` +
          `database, so they are fabricated: ${fabricated.slice(0, 5).join(", ")}. This is not sent ` +
          `back for a retry — a retry would invent different URLs. Needs a human.`,
      });
    }

    // ── repair: inline CTA blocks ──
    // A ```CTA fence is the frontend's convention for a mid-body CTA button (see renderVoiceSystem's
    // "Inserting a CTA inside the body" section) — separate from the single required Strapi hero CTA.
    // Two ways this ships broken: the fence isn't valid {text, url} JSON, so the frontend's parser
    // renders nothing or throws; or the url isn't a real page, so the rendered button 404s. Both are
    // repairable — unlike a fabricated citation, the correct fix is simply "point at a real page from
    // the list you were given" — so this is `repair`, not the non-recoverable `flag` link_provenance
    // uses for invented sources.
    const ctaHits: string[] = [];
    for (const m of body.matchAll(/```CTA\s*\n([\s\S]*?)```/gi)) {
      const raw = m[1].trim();
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { ctaHits.push(`block is not valid JSON: ${raw.slice(0, 80)}`); continue; }
      const text = (parsed as any)?.text;
      const url = (parsed as any)?.url;
      if (typeof text !== "string" || !text.trim() || typeof url !== "string" || !url.trim()) {
        ctaHits.push(`block is missing "text" or "url": ${raw.slice(0, 80)}`);
        continue;
      }
      if (!allowed.has(norm(url))) {
        ctaHits.push(`"${text}" points at ${url}, which is not in the internal link database`);
      }
    }
    if (ctaHits.length) {
      violations.push({
        gate: "cta_block", severity: "repair",
        detail: `${ctaHits.length} CTA block(s) need fixing: ${ctaHits.slice(0, 4).join("; ")}` +
          `${ctaHits.length > 4 ? `, +${ctaHits.length - 4} more` : ""}. A CTA block is a fenced ` +
          '```CTA code block containing only {"text": "...", "url": "..."}. The url must be one of ' +
          "the pages in the internal link database — never invent one.",
      });
    }
  }

  // ── repair: statistics with no source attached ──
  // The highest-consequence failure mode in SEO content: a fluent, specific, invented number. This
  // checks the sentence that STATES a figure for a link, because a citation three paragraphs away is
  // not a citation. Deliberately narrow so it doesn't fire on ordinary prose numbers: it wants a
  // percentage, a currency amount, or a magnitude word ("2.5 million users").
  {
    const STAT = /(\b\d[\d,.]*\s?%|\bp\.?p\.?\b|[$£€]\s?\d[\d,.]*(\s?(k|m|bn|billion|million|trillion))?|\b\d[\d,.]*\s?(million|billion|trillion)\b|\b\d[\d,.]*x\s+(more|faster|higher|cheaper|better)\b)/i;
    // Split on sentence ends, but keep markdown links intact (they contain dots in URLs). Masking
    // already blanked link TARGETS, so re-scan the raw body here and test each sentence for a link.
    const sentences = body.split(/(?<=[.!?])\s+(?=[A-Z"'“])/);
    const offenders: string[] = [];
    for (const s of sentences) {
      if (!STAT.test(s)) continue;
      if (/\]\(https?:\/\//.test(s)) continue;                    // cites something inline
      // Our own measured Search Console figures are legitimate to state without an external link,
      // as long as the sentence makes clear it is our own data.
      if (/search console|impressions|our own data|we rank|we are shown/i.test(s)) continue;
      // Round rhetorical numbers and time references are not statistics.
      if (/\b(one|two|three|first|second|third)\b/i.test(s) && !/%|[$£€]/.test(s)) continue;
      offenders.push(s.trim().slice(0, 120));
    }
    if (offenders.length) {
      violations.push({
        gate: "unsourced_statistic", severity: "repair",
        detail: `These sentences state a figure with no source linked in the same sentence. Either link the source you got it from, or rewrite without the number: ${offenders.slice(0, 4).map((o) => `"${o}"`).join(" | ")}`,
      });
    }
  }

  // ── repair: a stated search volume or keyword difficulty ──
  // Neither is available anywhere in this system, so any such claim is necessarily invented.
  {
    const m = masked.match(/\b(search volume|monthly searches|searches per month|keyword difficulty|difficulty score|KD\s*[:=]?\s*\d+)\b/i);
    if (m) {
      violations.push({
        gate: "unavailable_metric", severity: "repair",
        detail: `The article refers to "${m[0]}". No search-volume or keyword-difficulty data source is connected to this system, so that figure cannot be real. Use our measured Search Console impressions instead, or remove the claim.`,
      });
    }
  }

  // ── flag: question headings that match no real query ──
  // A question H2 only earns a featured snippet or an answer-engine citation if it matches something
  // people actually type. An invented one matches nothing, so it is worth surfacing even though the
  // model may have had a good reason.
  if (input.realQuestions && input.realQuestions.length) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    const real = input.realQuestions.map(norm);
    const invented = [...body.matchAll(/^##\s+(.+\?)\s*$/gm)]
      .map((mm) => mm[1].trim())
      .filter((h) => {
        const n = norm(h);
        // Count it as grounded if it shares most of its words with a real query.
        return !real.some((r) => {
          if (r.includes(n) || n.includes(r)) return true;
          const rw = new Set(r.split(" "));
          const hits = n.split(" ").filter((w) => w.length > 3 && rw.has(w)).length;
          return hits >= 3;
        });
      });
    if (invented.length) {
      violations.push({
        gate: "invented_question", severity: "flag",
        detail: `These question headings do not match any People Also Ask question or Search Console query we retrieved: ${invented.slice(0, 4).map((q) => `"${q}"`).join(", ")}. A question heading is only worth having if it matches a real query.`,
      });
    }
  }

  // ── links actually present ──
  // The observed failure this catches: a complete article with an approved source plan and zero
  // links in the prose.
  if (outline) {
    const plannedExternal = outline.source_plan.length;
    const plannedInternal = outline.link_plan.length;
    if (plannedExternal > 0 && linksExternal.length === 0) {
      violations.push({
        gate: "missing_sources", severity: "repair",
        detail: `The approved plan had ${plannedExternal} sources but the prose contains no external links. Embed them as contextual markdown links on their planned anchor text.`,
      });
    }
    if (plannedInternal > 0 && linksInternal.length === 0) {
      violations.push({
        gate: "missing_internal_links", severity: "repair",
        detail: `The approved plan had ${plannedInternal} internal links but none appear in the prose.`,
      });
    }
  }

  return {
    fixed: body,
    violations,
    stats: {
      words,
      keyword_count: keywordCount,
      keyword_density: density,
      links_external: linksExternal.length,
      links_internal: linksInternal.length,
      h1_count: h1Count,
      faq_headings: faqHeadings,
    },
  };
}

/**
 * Publish-blocking field checks, on top of the prose gates. Reuses publishReadiness() rather than
 * restating the same rules — that function is the single source of truth for what Strapi (and our own
 * thumbnail policy) require.
 *
 * ── Why the severity is split ───────────────────────────────────────────────────────────────────
 *
 * Every one of these used to be `repair`, which means every one of them went into repair_prompt and
 * was handed to the WRITER with "fix exactly these and change nothing else". The writer's only tools
 * are submit_section and update_draft — it can rewrite prose and set text fields. It cannot produce
 * an image.
 *
 * So "Thumbnail image is required (social/preview card)" was an instruction the model could never
 * satisfy. Measured on the rescued 09:00 run of 2026-08-22: the repair loop was handed
 *
 *     - [word_count] 2760 words against a 2500 target (10% off, tolerance is 10%).
 *     - [publish_readiness] Thumbnail image is required (social/preview card).
 *
 * and spent round after round resubmitting sections — index 10, 0, 6, 8, 7 — trimming words (which it
 * could fix) while the thumbnail line stayed. The loop's own "no improvement, stop" guard did not
 * catch it, because the word count WAS improving each round, so the pair always looked like progress.
 * The thumbnail is generated later by ensureThumbnails/generateAssets; it was never the writer's job.
 *
 * MEDIA blockers are therefore reported as `flag` — visible in the verdict and on the draft, not sent
 * to the model. Text-field blockers stay `repair`, because those it genuinely can fix.
 */
const MEDIA_BLOCKER = /thumbnail|cover image|hero image/i;

export function draftReadinessViolations(draft: Partial<BlogDraft>): Violation[] {
  return publishReadiness(draft).map((detail) => ({
    gate: "publish_readiness",
    severity: MEDIA_BLOCKER.test(detail) ? ("flag" as const) : ("repair" as const),
    detail,
  }));
}

/** Overall verdict for blog_drafts.writer_status. */
export function verdictFor(violations: Violation[]): "ok" | "flagged" | "failed" {
  if (violations.some((v) => v.gate === "link_provenance")) return "failed";
  if (violations.some((v) => v.severity === "flag" || v.severity === "repair")) return "flagged";
  return "ok";
}

/** The scoped repair instruction sent back to the model. Deliberately narrow: fix these, change
 *  nothing else, because an unrelated edit smuggled into a fix is how an approved outline quietly
 *  stops matching the article. */
export function repairPrompt(violations: Violation[]): string {
  const repairable = violations.filter((v) => v.severity === "repair");
  if (!repairable.length) return "";
  const lines = [
    "<repair_request>",
    "The automated check found these problems. Fix exactly these and change nothing else.",
    "Resubmit only the sections that need to change, using submit_section with the same index.",
    "",
  ];
  for (const v of repairable) lines.push(`- [${v.gate}] ${v.detail}`);
  lines.push("", "Do not rewrite anything that was not listed. Do not add or remove sections.", "</repair_request>");
  return lines.join("\n");
}
