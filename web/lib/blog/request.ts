// Externally-triggered blog drafts: brief in over HTTP, a draft in Summit out, Slack when it lands.
//
// Someone outside Summit sends a topic and whatever context they have. A full article gets written
// through the normal research → outline → sections → validate flow, its images get generated and
// attached, and Slack says so. Nobody has to be logged in and nobody has to be watching.
//
// The draft STOPS IN SUMMIT. It used to push straight to Strapi as an unpublished entry, which put
// unreviewed machine output into the CMS on every external call and left someone to clear it out
// when the article was poor. A person reads it here and presses Sync themselves — see the note at
// the sync call for the whole reasoning, and BLOG_REQUEST_AUTOSYNC=1 to restore the old behaviour.
//
// ── Why this is accept-then-work, not do-then-respond ───────────────────────────────────────────
//
// Writing one article is minutes of model time: research, an outline, a turn per section, a
// validation pass, then up to two repair rounds. Images are another 30-60s each. Vercel kills a
// function at 300s. So the POST creates rows, hands off, and answers 202 with an id. Everything
// real happens in a worker that checkpoints and re-enqueues itself, exactly the pattern
// clusterRun.ts already uses for unattended cluster generation, because that pattern is the only
// one that survives the ceiling.
//
// A synchronous version of this endpoint would appear to work in dev (no ceiling) and time out in
// production on every article long enough to be worth writing. That failure mode is worth naming
// because it is the obvious way to build this.
//
// ── Why its credential is NOT part of identifyCaller ────────────────────────────────────────────
//
// isAuthorized() is `identifyCaller(req) !== null`, and ~26 routes use it — including ones that
// send email and publish to the live site. Adding a fourth arm to that union would hand every one
// of those routes to whoever holds this token. This token goes to someone outside the team, so it
// gets its own check and unlocks exactly one verb: request a draft. It reuses safeEqual so the
// comparison stays constant-time, but shares nothing else.
import {
  createBlogDraft, createWriterSession, getBlogDraft, getWriterSession,
  getDefaultWriterVoice, getWriterVoiceBySlug, updateWriterSession,
  blogSlugTaken, markBlogDraftSynced, markBlogDraftSyncFailed, createBlogDraftRevision,
  type BlogDraft, type WriterVoice,
} from "@/lib/db/queries";
import { supabaseAdmin } from "@/lib/db/supabase";
import { safeEqual } from "@/lib/auth/service";
import { placeholderSlug, editableSnapshot } from "@/lib/blog/fields";
import { deriveSyncState } from "@/lib/blog/state";
import { writerEnabled } from "@/lib/writer/anthropic";
import { writeOneArticle } from "@/lib/writer/writeArticle";
import { runTurn } from "@/lib/writer/agent";
import { extractUrls } from "@/lib/writer/userInput";
import { isServerless, qstashPublish } from "@/lib/qstash";
import {
  createEntry, updateEntry, blogType, strapiConfigured, adminEntryUrl, strapiLocale,
  collectionForDraft, collectionExists,
} from "@/lib/strapi/client";
import { mapDraftToStrapi, syncReadiness, publishReadiness } from "@/lib/strapi/mapDraft";
import { getWebhook } from "@/lib/linkaudit/slack";
import { slackPost } from "@/lib/slack/post";
import { tagFor, namesFor, type Audience } from "@/lib/slack/tags";
import { checkCannibalization, summarise } from "./cannibalization";
import { inferPageType, pageType, PAGE_TYPE_KEYS } from "./pageTypes";
import { composeReadyMessage } from "@/lib/blog/notifyReady";
import { linkOr, internalUrl } from "@/lib/appUrl";
import { checkCollectionFit } from "@/lib/strapi/collectionFit";

/**
 * Which audience a draft's notifications belong to, decided by WHO ASKED for it.
 *
 * This used to be tagFor("atlas") at the one call site, which was right while Atlas was the only
 * caller. The autopilot then started using the same startBlogRequest path and inherited Atlas's
 * audience — so Ahmed, who is in that list because he owns the Atlas integration and can act on ITS
 * failures, got pinged about a post Summit chose and wrote by itself.
 *
 * `created_by` is `api:autopilot:<slot>` for the autopilot and `api:<whoever>` for Atlas.
 */
function audienceFor(createdBy: string | null | undefined): Audience {
  const who = (createdBy ?? "").toLowerCase();
  if (/^(api:)?autopilot\b/.test(who)) return "blog";
  // Atlas has to NAME itself now. This used to be the else-branch, so every caller that was not the
  // autopilot was assumed to be Atlas and pinged Ahmed — who is on that list because he owns the
  // Atlas integration and can act on ITS failures. A test request ("test-astra") and any future
  // third caller both landed there, ringing the wrong phone about a draft he cannot do anything
  // with. Observed on 2026-09-08 with two test runs.
  if (/\batlas\b/.test(who)) return "atlas";
  // Anything else is a blog draft, so it goes to whoever reviews blog drafts.
  return "blog";
}

/**
 * Does must_follow already tell the model what to write?
 *
 * The autopilot packs "The article to write: <angle>" into must_follow, which phaseDirective renders
 * verbatim every turn — so the topic is already in front of the model and seeding it again is a
 * wasted turn. Matched on the autopilot's own phrasing plus the generic shapes an operator writes,
 * rather than on mere non-emptiness: a must_follow that only says "keep it under 1200 words" does
 * NOT convey a subject, and a run with that and no seed is the failure this whole thing fixes.
 */
function carriesTheBrief(mustFollow: string | null | undefined): boolean {
  const m = (mustFollow ?? "").trim();
  if (m.length < 20) return false;
  // No trailing \b on the colon forms: "Topic: best ai …" has a space after the colon, and \b cannot
  // match there, so `topic:\b` never fired. Erring toward false is safe — a false negative only
  // costs one redundant seeding turn, while a false positive means the topic never reaches the model
  // at all, which is the failure this guards.
  return /\b(the article to write|write about|the piece to write)\b/i.test(m)
    || /\b(topic|subject|primary keyword)\s*:/i.test(m);
}

/** A probe or smoke run. Announced, but it must not ring anybody's phone. */
function isProbeRequest(requestedBy: string | null | undefined): boolean {
  return /(^|[:\-_])(test|tests|probe|smoke|dryrun|dry-run)([:\-_]|$)/i.test(requestedBy ?? "");
}

/** Every notification says this is a test until the flow has proven itself on real briefs. Flip
 *  BLOG_REQUEST_ANNOUNCE_LIVE=1 to drop the banner; nothing else changes. */
function isTestMode(): boolean {
  return process.env.BLOG_REQUEST_ANNOUNCE_LIVE !== "1";
}

/** Leave room to hand off before the 300s ceiling. Same budget as clusterRun/enrich. */
const CHUNK_BUDGET_MS = isServerless() ? 200_000 : Infinity;

/**
 * Attempts before a run is declared dead.
 *
 * One transient throw used to end a run permanently. Measured on the 09:00 autopilot run of
 * 2026-08-22: the session did 21 messages of real research — brief saved, the target page fetched,
 * SERP and keyword data pulled, thirteen internal-link lookups, two competitor pages, four web
 * searches — then something threw at 114 seconds and the whole thing was marked `failed` with a
 * blank draft and the slug `untitled-f3d7151e`. Three of eight write turns had been used. Nothing
 * was wrong with the work; nothing retried it; and every one of those research calls was billed.
 */
const MAX_RUN_ATTEMPTS = 3;

/**
 * What was actually thrown, as text.
 *
 * `e instanceof Error ? e.message : "writing failed"` threw away everything about a non-Error throw,
 * and "writing failed" is the literal fallback — so the one field meant to explain the failure said
 * nothing at all, and the real cause was unrecoverable after the fact. A rejected promise carrying
 * undefined, a plain object, or a string all landed here identically.
 */
function describeThrow(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || "Error with no message";
  if (e === undefined) return "threw undefined (a promise rejected with no reason)";
  if (e === null) return "threw null";
  if (typeof e === "string") return `threw a string: ${e.slice(0, 300)}`;
  try {
    return `threw a non-Error ${typeof e}: ${JSON.stringify(e).slice(0, 300)}`;
  } catch {
    return `threw a non-Error ${typeof e} that could not be serialised`;
  }
}

export interface BlogRequestInput {
  /** What the article is about. The only genuinely required field. */
  topic: string;
  /**
   * The raw material to write FROM: a transcript, notes, pasted markdown, an existing draft.
   *
   * Deliberately uncapped where `topic` is capped at 2000. A YouTube transcript is tens of
   * thousands of characters and is the actual substance of the piece, not a description of it.
   * It is sent as the session's opening message so it enters the conversation once and is cached
   * thereafter, rather than through `must_follow`, which is re-rendered verbatim on every single
   * turn and would re-bill the whole transcript eight times over.
   */
  source_material?: string;
  /**
   * The article's hero image, supplied by the caller rather than generated.
   *
   * Atlas sends the source video's poster frame here. Taking it is strictly better than rendering
   * one: it is the actual video the piece is about, it costs nothing, and it is the image a reader
   * would recognise. A generated hero for a post about a specific video is a worse picture of it.
   */
  hero_image_url?: string;
  primary_keyword?: string;
  secondary_keywords?: string[];
  word_count?: number;
  /**
   * A key from pageTypes — the shape the piece has to take.
   *
   * The autopilot's judge already picks one, and it used to reach the writer only as a sentence
   * inside `must_follow`. That is enough for a how-to, whose instructions are all prose, and not
   * enough for a practitioner post, whose persona, trade vocabulary and honesty boundary are a whole
   * block the prompt has to look up. Carried as a field so the writer can branch on it.
   */
  blog_page_type?: string;
  /** For a practitioner post: which role from src/lib/blog/practitioner.ts writes it. */
  persona?: string;
  /** The subject is a model we do not run, so the piece owes the reader that boundary. */
  not_hosted?: boolean;
  /** Rendered verbatim into every turn's directive, so it cannot decay out of context the way a
   *  first-message instruction does. This is where "must mention X", "avoid Y" belong. */
  must_follow?: string;
  /** URLs the writer is required to actually read before drafting. */
  required_sources?: string[];
  cta_text?: string;
  cta_url?: string;
  /** Which brand voice to write in. Omitted means the default voice, and the response says which
   *  one was used so an external caller is never guessing. */
  voice_slug?: string;
  /** Free-text attribution for the audit trail — who asked for this. */
  requested_by?: string;
  /** Top-level payload keys the parser ignored. Diagnostics only — never read by the writer. */
  unknown_keys?: string[];
}

export interface BlogRequestAccepted {
  request_id: string;
  draft_id: string;
  voice: string;
  status_url: string;
  /**
   * What the cannibalization check found, when it found anything.
   *
   * On the response rather than only in the logs so an integration can surface it: Atlas posts back to
   * a channel, and "this will compete with /features/x unless it is retargeted" is worth seeing at
   * request time rather than discovering from a rankings report in six weeks.
   */
  seo_warning?: string;
}

/** Authorise a blog request. Deliberately narrow: see the module note. */
export function blogRequestAuthorised(authHeader: string | null): boolean {
  const token = process.env.BLOG_REQUEST_TOKEN?.trim();
  if (!token) return false; // unset means the endpoint is closed, never open
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return !!bearer && safeEqual(bearer, token);
}

/** Union of several URL lists, order-preserving, deduped on the same trailing-slash-insensitive form
 *  the outline gate and the provenance check both normalise with. */
function mergeUrls(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const u = raw.trim();
      if (!u) continue;
      const key = u.replace(/\/+$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u);
    }
  }
  return out;
}

/**
 * The first URL in a supplied list that is plainly an image.
 *
 * A video poster frame is the case this exists for, so a YouTube thumbnail host wins outright even
 * when it carries no file extension. Otherwise an image extension is required — guessing that any
 * unfamiliar URL might be a picture would hand the article a hero that is really a docs page, and
 * rehostToStrapi would then fail on it after the run had already decided not to render one.
 */
function firstImageUrl(urls: string[]): string | undefined {
  const isYtThumb = (u: string) => /^https?:\/\/i\d?\.ytimg\.com\//i.test(u);
  const isImageFile = (u: string) => /\.(jpe?g|png|webp|avif)(\?|#|$)/i.test(u);
  return urls.find(isYtThumb) ?? urls.find(isImageFile);
}

/**
 * A YouTube video id from anywhere in the payload.
 *
 * ── Why this exists rather than reading a field ─────────────────────────────────────────────────
 *
 * Four consecutive live requests carried the poster frame in `required_sources` and nothing in
 * `hero_image_url`, and a fifth could put it somewhere else again. Depending on WHICH key a caller
 * chose is a promise about their payload shape that nobody made — and every time it changes, posts
 * silently render a generated hero instead of the video they are about.
 *
 * A video id is derivable from any YouTube link, and the thumbnail URL is derivable from the id. So
 * Summit stops asking and works it out: if the request mentions a video anywhere, the article gets
 * that video's poster frame.
 */
export function youtubeIdFrom(text: string): string | null {
  if (!text) return null;
  const m = text.match(
    /(?:youtube\.com\/(?:watch\?(?:[^\s"']*&)?v=|embed\/|v\/|shorts\/)|youtu\.be\/|i\d?\.ytimg\.com\/vi\/)([A-Za-z0-9_-]{11})/,
  );
  return m ? m[1] : null;
}

/**
 * The best thumbnail that actually exists for a video.
 *
 * YouTube 404s a missing `maxresdefault` rather than falling back, so it is probed before being
 * used — handing the pipeline a dead URL would fail the re-host after the run had already decided
 * not to render a hero, leaving the post with no image at all. `hqdefault` always exists.
 */
export async function youtubeThumbnail(videoId: string): Promise<string> {
  const maxres = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  try {
    const r = await fetch(maxres, { method: "HEAD", signal: AbortSignal.timeout(8_000) });
    if (r.ok) return maxres;
  } catch { /* fall through to the one that always exists */ }
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/** Every top-level key the parser reads, in any accepted spelling. Anything else lands in
 *  `unknown_keys` so an unexpected payload shape is diagnosable after the fact. */
const KNOWN_KEYS = new Set([
  "topic", "brief", "subject",
  "source_material", "transcript", "content", "markdown", "text", "body", "notes", "context", "material", "document",
  "hero_image_url", "primary_keyword", "keyword", "secondary_keywords", "word_count",
  "must_follow", "instructions", "required_sources", "sources", "urls",
  "cta_text", "cta_url", "voice_slug", "voice", "requested_by", "requester",
  "blog_page_type", "page_type", "persona", "not_hosted",
]);

function asStringArray(v: unknown, cap: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => String(x).trim()).filter(Boolean).slice(0, cap);
  return out.length ? out : undefined;
}

/** Normalise an untrusted JSON body into a request, or say what is wrong with it. */
/** A page-type key, if it is one we actually have. */
function normalisePageType(raw: unknown): string | undefined {
  const k = String(raw ?? "").trim().toLowerCase();
  if (!k) return undefined;
  return PAGE_TYPE_KEYS.includes(k) ? k : undefined;
}

export function parseBlogRequest(body: unknown): { ok: true; input: BlogRequestInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const topic = String(b.topic ?? b.brief ?? b.subject ?? "").trim();
  if (!topic) return { ok: false, error: "topic is required (also accepted as 'brief' or 'subject')." };
  if (topic.length > 2000) {
    return {
      ok: false,
      error: "topic is too long; keep it under 2000 characters and put transcripts, notes or pasted " +
        "markdown in 'source_material' instead.",
    };
  }

  // 400k characters is roughly a three-hour transcript. The cap exists so a runaway paste fails at
  // the door with a clear reason rather than deep inside a model call as a context-length error.
  // Widened after three live requests arrived with ZERO characters of source material while their
  // own must_follow said "keep every number from the transcript exact" and "the only URLs you may
  // use are the ones present in the source material". The writer was being told to work from
  // something that was not there, which is how a run ends in "link provenance failure".
  //
  // Whether Atlas sends it under a name not listed here or does not send it at all is the next
  // question, and `unknown_keys` below exists so that takes one query rather than a conversation.
  const sourceMaterial = String(
    b.source_material ?? b.transcript ?? b.content ?? b.markdown ??
    b.text ?? b.body ?? b.notes ?? b.context ?? b.material ?? b.document ?? "",
  ).trim();
  if (sourceMaterial.length > 400_000) {
    return { ok: false, error: "source_material is too long; keep it under 400,000 characters." };
  }

  const wc = Number(b.word_count);
  return {
    ok: true,
    input: {
      topic,
      source_material: sourceMaterial || undefined,
      // The field first, then the documented `Thumbnail:` line in the material. Atlas sends both on
      // purpose so this works either way; reading the field is the path they asked us to treat as
      // real, and the parse is the fallback that already worked before the field existed.
      //
      // ^ with MULTILINE matters: without it this matches the word "thumbnail" mid-sentence in a
      // transcript and hands back whatever URL happens to follow it.
      // Three paths, and the THIRD is the one Atlas actually uses. Measured on three consecutive
      // live requests: hero_image_url absent, source_material zero characters, and the thumbnail
      // sitting in required_sources as
      // ["https://i.ytimg.com/vi/<id>/maxresdefault.jpg", "https://youtube.com/watch?v=<id>"].
      //
      // Reading only the two documented paths meant every one of those posts rendered a hero from
      // scratch while the video's own poster frame was already in the payload.
      hero_image_url: String(b.hero_image_url ?? "").trim()
        || (sourceMaterial.match(/^Thumbnail(?:\s+image[^:]*)?:\s*(https?:\/\/\S+)/im)?.[1] ?? "").replace(/[.,);]+$/, "")
        || firstImageUrl(asStringArray(b.required_sources ?? b.sources ?? b.urls, 10) ?? [])
        || undefined,
      primary_keyword: String(b.primary_keyword ?? b.keyword ?? "").trim() || undefined,
      secondary_keywords: asStringArray(b.secondary_keywords, 10),
      // Clamped rather than rejected: an external caller asking for 50k words is a typo, not an
      // attack, and failing the whole request over it helps nobody.
      word_count: Number.isFinite(wc) && wc > 0 ? Math.min(Math.max(Math.trunc(wc), 300), 5000) : undefined,
      must_follow: String(b.must_follow ?? b.instructions ?? "").trim() || undefined,
      required_sources: asStringArray(b.required_sources ?? b.sources ?? b.urls, 10),
      cta_text: String(b.cta_text ?? "").trim() || undefined,
      cta_url: String(b.cta_url ?? "").trim() || undefined,
      voice_slug: String(b.voice_slug ?? b.voice ?? "").trim() || undefined,
      // The editorial shape, and the persona for a practitioner post. Validated against the real
      // registry rather than taken on trust: an unknown key would otherwise reach the writer as a
      // branch that never fires, which looks like the feature not working.
      blog_page_type: normalisePageType(b.blog_page_type ?? b.page_type),
      persona: String(b.persona ?? "").trim() || undefined,
      not_hosted: b.not_hosted === true || b.not_hosted === "true" || undefined,
      requested_by: String(b.requested_by ?? b.requester ?? "").trim() || undefined,
      /**
       * Top-level keys we did not read. Stored, never acted on.
       *
       * Three live requests arrived with no source material at all, and answering "did they send it
       * under another name, or not at all?" was impossible after the fact — the raw body is kept
       * nowhere. This makes it a one-query answer next time, without logging payloads that can be
       * forty thousand characters of transcript.
       */
      unknown_keys: Object.keys(b).filter((k) => !KNOWN_KEYS.has(k)),
    },
  };
}

/**
 * Create the rows and hand the work off. Returns as soon as there is something to poll.
 *
 * The draft row is created up front, empty, for the same reason the interactive writer does it:
 * submit_section always needs a target, and it guarantees one draft row per session rather than
 * letting the agent mint its own.
 */
export async function startBlogRequest(input: BlogRequestInput): Promise<
  { ok: true; accepted: BlogRequestAccepted } | { ok: false; error: string; status: number }
> {
  if (!writerEnabled()) {
    return { ok: false, error: "The writer is not configured (ANTHROPIC_API_KEY is unset).", status: 503 };
  }

  let voice: WriterVoice | null = null;
  if (input.voice_slug) {
    voice = await getWriterVoiceBySlug(input.voice_slug);
    // A named voice that does not exist is a caller error worth surfacing — silently falling back
    // to the default would produce an article in the wrong register with no indication why.
    if (!voice) return { ok: false, error: `No voice with slug "${input.voice_slug}".`, status: 400 };
  } else {
    voice = await getDefaultWriterVoice();
    if (!voice) return { ok: false, error: "No default writer voice is configured.", status: 503 };
  }

  const actor = input.requested_by ? `api:${input.requested_by}` : "api:blog-request";

  // ── Our own videos, resolved once ─────────────────────────────────────────────────────────────
  //
  // imagine-web's blog renderer has supported YouTube iframes the whole time (it pipes an iframe src
  // through convertYoutubeToEmbed), and nothing was ever emitting one. Matching happens here because
  // the prompt builder is synchronous and this is a network read — and once, because the channel feed
  // does not change mid-run.
  //
  // A failed read yields undefined rather than [], so the writer can tell "we looked and found
  // nothing" from "we never looked" and does not conclude we have no videos on the subject.
  let videoEmbeds: Array<{ id: string; title: string; url: string; published: string }> | undefined;
  try {
    const { recentChannelVideos, relevantVideos, MAX_EMBEDS } = await import("@/lib/blog/youtube");
    const feed = await recentChannelVideos();
    if (feed.ok) {
      videoEmbeds = relevantVideos(feed.videos, `${input.topic} ${input.primary_keyword ?? ""}`, { limit: MAX_EMBEDS })
        .map((v) => ({ id: v.id, title: v.title, url: v.url, published: v.published }));
    }
  } catch { /* a missing video is not a reason to lose the article */ }

  // ── Links the requester supplied, made legitimate before a word is written ──────────────────────
  //
  // Two gates would otherwise destroy this use case, and both are working as designed:
  //
  //  1. link_provenance (validate.ts) flags any URL in the body that a research tool did not return.
  //     It is a `flag`, explicitly never auto-retried — "needs a human". A post built from a YouTube
  //     transcript is supposed to link the video, so every such link would be called fabricated and
  //     every article would come back flagged.
  //
  //  2. runTurn captures every URL in a user message into required_sources, and propose_outline then
  //     REFUSES to run until each has been fetched. A YouTube watch page is a JavaScript shell, so
  //     fetch_page gets nothing useful from it. Unattended, the model would spend all eight of its
  //     turns failing to satisfy a gate it cannot satisfy and finish with zero sections.
  //
  // Seeding the ledger up front resolves both, and is the honest record rather than a bypass: the
  // requester DID supply these URLs, and the transcript they sent IS the content of that page. The
  // snippet says exactly that, and `fetched: false` keeps "a tool retrieved this" and "a human handed
  // this over" distinguishable to anyone reading the ledger later. The model may still fetch any of
  // them if it wants more.
  //
  // The hero image is in this list for the same reason and one more: Atlas asked for it explicitly,
  // because a URL the validator has not seen gets the finished draft rejected as fabricated — which
  // already killed one of their drafts. It is registered as an allowed ASSET, not as a citation; the
  // article should link the video, never cite a JPEG as a source.
  const suppliedUrls = mergeUrls(
    input.required_sources ?? [],
    input.hero_image_url ? [input.hero_image_url] : [],
    extractUrls(input.source_material ?? ""),
    extractUrls(input.topic),
  );
  const seededSources: Record<string, unknown> = {};
  for (const url of suppliedUrls) {
    const isHero = url === input.hero_image_url;
    seededSources[url] = {
      url,
      title: "",
      snippet: isHero
        ? "The article's hero image, supplied by the requester and cleared for use. An asset, not a citation — do not cite it as a source."
        : "Supplied by the requester alongside the source material, not retrieved by a research tool.",
      fetched: false,
    };
  }

  const draft = await createBlogDraft({
    title: "", slug: placeholderSlug(), body: "", description: "", created_by: actor,
  });

  // ── Would this compete with a page we already own? ─────────────────────────────────────────────
  //
  // Every path that starts an article runs the same check, so a request from Atlas, from Summer or from
  // a person typing a topic gets the same protection the autopilot does. Duplicating the check per
  // caller is how one of them ends up without it.
  //
  // ── Why this ADVISES here and BLOCKS in the autopilot ──────────────────────────────────────────
  //
  // Not an inconsistency. The autopilot is unattended, so a collision it cannot fix has to stop it —
  // nobody is watching. A request arriving here was made by a person or by an integration a person set
  // up: they chose the subject, and the standard is explicit that a deliberate deviation is a real
  // editorial decision. Refusing an authenticated API call over an SEO judgement would also break Atlas
  // on a verdict Atlas cannot act on.
  //
  // So the finding travels into the brief, where it changes what gets written, instead of into an error
  // nobody reads. The writer is told which page owns the term, told not to open on it, and told to link
  // up to it — which is the fix the standard asks for.
  const requestedKeyword = input.primary_keyword || input.topic;
  const gate = await checkCannibalization({
    primaryKeyword: requestedKeyword,
    // Inferred, because this caller has no page-type field. The tier is what the intent matrix reads,
    // and an unrecognised type defaults to informational — correct for a blog, which every article
    // through this path is.
    pageTypeKey: inferPageType(input.topic),
    proposedTitle: input.topic,
  }).catch(() => null);

  const gateDirectives = gate && gate.verdict !== "proceed" ? gate.directives : [];
  const mustFollow = [input.must_follow ?? "", ...gateDirectives].filter((l) => l.trim()).join("\n") || null;

  const session = await createWriterSession({
    voice_id: voice.id,
    voice_revision: voice.prompt_revision,
    kind: "single",
    draft_id: draft.id,
    created_by: actor,
    brief: {
      topic: input.topic,
      primary_keyword: input.primary_keyword || input.topic,
      page_type: "blog",
      blog_page_type: input.blog_page_type,
      persona: input.persona,
      not_hosted: input.not_hosted,
      video_embeds: videoEmbeds,
      word_count: input.word_count ?? voice.default_word_count,
      secondary_keywords: input.secondary_keywords,
      cta_text: input.cta_text ?? voice.default_cta_text,
      cta_url: input.cta_url ?? voice.default_cta_url,
      source_material: input.source_material,
      hero_image_url: input.hero_image_url,
    },
    must_follow: mustFollow,
    required_sources: suppliedUrls,
    research: { sources: seededSources },
  });

  // Hand off. If QStash is not configured the row still exists and /run can be called directly,
  // so a missing queue degrades to "someone triggers it" rather than losing the request.
  const queued = await qstashPublish("/api/blog/request/run", { session_id: session.id });

  return {
    ok: true,
    accepted: {
      request_id: session.id,
      draft_id: draft.id,
      voice: voice.slug,
      status_url: `/api/blog/request?id=${session.id}`,
      ...(gate && gate.verdict !== "proceed" ? { seo_warning: summarise(gate) } : {}),
      ...(queued ? {} : { queued: false }),
    } as BlogRequestAccepted,
  };
}

/** What an external caller can see about a request in flight. */
export async function blogRequestStatus(sessionId: string) {
  const session = await getWriterSession(sessionId);
  if (!session) return null;
  const draft = session.draft_id ? await getBlogDraft(session.draft_id) : null;

  const sections = Object.keys(session.sections ?? {}).length;
  const planned = session.outline?.sections.length ?? 0;
  return {
    request_id: session.id,
    // The writer's own phase is the honest progress signal; there is no separate state machine to
    // drift from it.
    phase: session.phase,
    error: session.error ?? null,
    sections_written: sections,
    sections_planned: planned,
    draft: draft && {
      id: draft.id,
      title: draft.title,
      slug: draft.slug,
      sync_state: deriveSyncState(draft),
      strapi_url: draft.strapi_id ? adminEntryUrl(draft.strapi_id) : null,
    },
  };
}

/** Push a finished draft to Strapi as an unpublished entry. Mirrors the interactive sync route. */
async function syncDraft(draft: BlogDraft): Promise<{ ok: true; strapiId: number } | { ok: false; error: string }> {
  if (!strapiConfigured()) return { ok: false, error: "Strapi is not configured." };
  const problems = syncReadiness(draft);
  if (problems.length) return { ok: false, error: problems.join(" ") };
  if (await blogSlugTaken(draft.slug, draft.id)) {
    return { ok: false, error: `The slug "${draft.slug}" is already used by another draft.` };
  }

  await createBlogDraftRevision(draft.id, draft.rev, "pre_sync", editableSnapshot(draft), "api:blog-request")
    .catch(() => {});

  try {
    // The collection this draft belongs to, not "the blog" by assumption. Checked before the first
    // write: creating an entry in a collection that does not exist is not recoverable by retrying,
    // and the failure would surface as a confusing 404 from deep inside the create call.
    const collection = collectionForDraft(draft);
    if (collection !== blogType() && !(await collectionExists(collection))) {
      return { ok: false, error: `Strapi has no collection "${collection}", or the token cannot read it. Nothing was written.` };
    }
    // Would the collection keep the draft, or silently drop its body? See strapi/collectionFit.ts.
    const fit = await checkCollectionFit(collection, draft);
    if (!fit.ok) return { ok: false, error: fit.reason ?? "this draft cannot sync into that collection." };

    let strapiId = draft.strapi_id ?? null;
    if (strapiId) {
      await updateEntry(collection, strapiId, mapDraftToStrapi(draft, { mode: "draft" }));
    } else {
      const created = await createEntry(
        // `collection`, not blogType(). These two calls disagreed: a first sync created the entry in the
        // BLOG and stored its id, and any later re-sync updated that id in the draft's own collection —
        // a different entry, because Strapi ids are per-collection.
        collection,
        mapDraftToStrapi(draft, { mode: "draft", locale: strapiLocale() }),
        { publish: false },
      );
      strapiId = created.id;
    }
    await markBlogDraftSynced(draft.id, strapiId!, draft.rev, adminEntryUrl(strapiId!));
    return { ok: true, strapiId: strapiId! };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    await markBlogDraftSyncFailed(draft.id, message).catch(() => {});
    return { ok: false, error: message };
  }
}

/** Generate and ATTACH the draft's images. draft_id mode fills the thumbnail, which is the usual
 *  reason a sync is refused, so this runs before the sync rather than after it. */
/**
 * Adopt a caller-supplied hero instead of rendering one.
 *
 * Re-hosted into Strapi rather than linked: the draft's media fields want a Strapi media id, and a
 * hotlinked i.ytimg.com URL would also be a third party's CDN serving our published page — which
 * breaks the day they change a path. The bytes are ours once this returns.
 *
 * Best-effort. If it fails we fall through to generating, because a missing hero is worse than a
 * generated one.
 */
/**
 * Take the supplied image as BOTH the hero and the thumbnail.
 *
 * One upload, two fields. `thumbnail_media_id` is the hard publish blocker — Strapi's type requires
 * it, and 0 of 11 drafts had one, which is why nothing had ever published from this tool. A post
 * about one specific video should carry that video's poster frame on its card as well as at the top;
 * rendering a different picture for the card would be paying for a worse image of the same thing.
 *
 * The aspect ratios differ slightly (a YouTube thumb is 16:9, the card spec is 1.91:1) and that is
 * accepted deliberately: a real frame from the video, very slightly cropped by the card, beats a
 * generated stand-in that is the right shape and the wrong picture.
 *
 * Returns which slots were filled, so the caller knows what still has to be generated rather than
 * assuming a single boolean covers both.
 */
async function adoptSuppliedHero(
  draftId: string, url: string, title: string,
): Promise<{ hero: boolean; thumbnail: boolean }> {
  try {
    const { rehostToStrapi } = await import("@/lib/media/prefill");
    const { planAssets } = await import("@/lib/media/plan");
    // Borrow the planner's own hero spec so the filename and alt text match everything else we
    // upload, rather than inventing a second convention for supplied images.
    const hero = planAssets({ title, keyword: title, words: 0, headings: [], kind: "blog" })
      .assets.find((a) => a.role === "hero");
    if (!hero) return { hero: false, thumbnail: false };
    const hosted = await rehostToStrapi(url, hero);
    if (!hosted?.id) return { hero: false, thumbnail: false };
    const { updateBlogDraft } = await import("@/lib/db/queries");
    await updateBlogDraft(draftId, {
      cover_media_id: hosted.id, cover_media_url: hosted.url,
      // The same media id in both fields. Re-uploading identical bytes to get a second id would
      // cost a round trip and leave two copies of one picture in the media library.
      thumbnail_media_id: hosted.id, thumbnail_media_url: hosted.url,
    } as never);
    return { hero: true, thumbnail: true };
  } catch {
    return { hero: false, thumbnail: false };
  }
}

async function generateAssets(
  draftId: string,
  roles: string[],
  pageTypeKey?: string,
): Promise<{ ok: boolean; detail: string; thumbnail: boolean }> {
  const base = (process.env.APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET ?? "";
  try {
    const res = await fetch(`${base}/api/media/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      // Body images are now included, capped at two on this path.
      //
      // They were hero+thumbnail only, on the reasoning that a 9,000-word guide plans six body
      // images and six renders do not fit the 220s deadline. That reasoning was about the COUNT, not
      // about whether body images are wanted — and a post with one picture at the top reads as
      // thin next to the roundups it competes with. The cap addresses the count directly, so the
      // article gets illustrated without the run being killed mid-render.
      //
      // page_type travels so the planner knows what the body images are FOR: a comparison's first
      // one is the same brief rendered both ways with the variable captioned, which is the image
      // worth having. Interface slots are planned and deliberately not rendered.
      body: JSON.stringify({ draft_id: draftId, roles, page_type: pageTypeKey, inline_cap: 2 }),
      signal: AbortSignal.timeout(220_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}`, thumbnail: false };
    const n = Array.isArray((body as { assets?: unknown[] }).assets) ? (body as { assets: unknown[] }).assets.length : 0;
    // Whether the thumbnail actually reached the draft, not merely whether an image was rendered.
    // Those are different facts and only the second one lets the page publish.
    const thumbnail = !!(body as { promoted?: Record<string, number> }).promoted?.thumbnail;
    return {
      ok: true, thumbnail,
      detail: `${n} image${n === 1 ? "" : "s"}${thumbnail ? ", thumbnail attached" : ", thumbnail NOT attached"}`,
    };
  } catch (e: unknown) {
    return { ok: false, detail: e instanceof Error ? e.message : "generation failed", thumbnail: false };
  }
}

/** Compose the Slack message. Separated from posting so it can be asserted in a test and so a
 *  missing webhook still yields text a person can paste. */
export function composeBlogRequestMessage(input: {
  title: string;
  slug: string;
  /** Links straight to this draft. Absent only in tests that predate the addressable route. */
  draftId?: string | null;
  strapiUrl: string | null;
  requestedBy?: string | null;
  verdict: "done" | "flagged" | "failed";
  assets: string;
  syncError?: string | null;
}): string {
  const lines: string[] = [];
  if (isTestMode()) {
    lines.push("*TEST — automated blog draft*  (this flow is still being trialled)");
  }
  // Pinged when a readable draft EXISTS — no longer when it reached Strapi, because it deliberately
  // no longer goes there. See the note on the sync in runBlogRequest.
  const worthPinging = input.verdict !== "failed";

  // ── The audience depends on WHO asked, not on which function is posting ──────────────────────
  //
  // This said tagFor("atlas") unconditionally, which was right while Atlas was the only caller. The
  // autopilot then started using the same startBlogRequest path and inherited Atlas's audience — so
  // Ahmed, who is in that list because he owns the Atlas integration and can act on ITS failures,
  // got pinged about a post Summit chose and wrote by itself. Nothing he can do with that.
  //
  // Keyed on requested_by, which the autopilot sets to `autopilot:<slot>` and Atlas does not.
  const audience = audienceFor(input.requestedBy);
  // The audience lives in lib/slack/tags.ts now — one directory, per-surface routing. A failed run
  // still posts, in plain names, so it does not ring three phones about a draft that does not exist.
  // Plain names rather than @-mentions when the run is a probe, so testing the pipeline does not
  // notify three people per attempt.
  const who = worthPinging && process.env.BLOG_REQUEST_TAG_PEOPLE !== "0" && !isProbeRequest(input.requestedBy)
    ? tagFor(audience)
    : namesFor(audience);
  lines.push(worthPinging
    ? `${who} — a new blog draft is ready for review in Summit.`
    : `${who} — this run did not produce a reviewable draft.`);
  lines.push("");
  lines.push(`*${input.title || "Untitled"}*`);
  lines.push(`Slug: \`${input.slug}\``);
  if (input.requestedBy) lines.push(`Requested by: ${input.requestedBy}`);
  lines.push(`Images: ${input.assets}`);

  // The verdict is the validator's, and it is reported rather than smoothed over: "flagged" means
  // the article was written but did not pass every gate, which is exactly what a reviewer needs to
  // know before they start reading.
  if (input.verdict === "flagged") {
    lines.push("Validation: *flagged* — written, but some gates did not pass. Worth a closer read.");
  } else if (input.verdict === "failed") {
    lines.push("Validation: *failed* — this one needs work before it is usable.");
  }

  // Summit, not Strapi. These drafts stop in Summit on purpose now — a reviewer reads and edits it
  // here, and pushing to the CMS is their call, made with the Sync button once they are happy.
  // /blog has no per-draft deep link, so the title above is how you find it in the list rather than
  // a URL that would only look like one.
  const open = linkOr(input.draftId ? `/drafts/${input.draftId}` : "/drafts", "Open it in Summit →");
  if (open) lines.push(open);
  if (input.strapiUrl) lines.push(`Also in Strapi: ${input.strapiUrl}`);
  lines.push("");
  lines.push("Not in the CMS and not published. Review it in Summit, then sync and publish when it is right.");
  return lines.join("\n");
}

/**
 * Do the work: write, illustrate, sync, announce.
 *
 * Re-enqueues itself if it runs out of invocation budget before the article is finished. The
 * writer's own section_cursor is what makes that safe — a resumed run continues from the section
 * it reached, not from the top.
 */
export async function runBlogRequest(sessionId: string): Promise<{ ok: boolean; handedOff?: boolean; error?: string }> {
  const startedAt = Date.now();
  const session = await getWriterSession(sessionId);
  if (!session) return { ok: false, error: "No such request." };
  if (!session.draft_id) return { ok: false, error: "Request has no draft." };
  if (session.phase === "done") return { ok: true };

  let verdict: "done" | "flagged" | "failed" | "incomplete";
  try {
    // Hand over the source material as the opening human message, before the writing loop starts.
    //
    // In the conversation once, then cached — as opposed to must_follow, which phaseDirective
    // re-renders verbatim on every turn and would re-bill a 40k-character transcript eight times.
    // Keyed on the session still being in its initial phase so a resumed run (the 200s handoff)
    // does not paste the whole transcript in a second time.
    const material = (session.brief as { source_material?: string } | null)?.source_material;
    if (material && session.phase === "gathering") {
      // Framed rather than pasted bare: without a preamble a transcript reads as an instruction to
      // the model, and it tends to answer the transcript instead of writing from it.
      await runTurn(
        sessionId,
        "Here is the source material for this piece, supplied by the person who requested it. " +
        "Write FROM it: it is the substance of the article, not a brief describing one. Any URLs in " +
        "it were supplied deliberately and are already recorded as sources, so you may link them " +
        "where a reader would genuinely benefit. Quote and attribute rather than paraphrasing away " +
        "the specifics.\n\n" +
        // The video is the piece's primary source. A post built from a transcript that never links
        // the video reads as though it were reported first-hand, and a reader who wants to check a
        // quote has nowhere to go.
        "If the material names a video, LINK IT in the body where the article first draws on it, " +
        "and attribute what is said to the person who said it. Do not link the thumbnail image " +
        "anywhere: it is the article's hero picture, not a citation.\n\n" +
        `<source_material>\n${material}\n</source_material>`,
        () => {},
      );
    } else if (session.phase === "gathering" && !carriesTheBrief(session.must_follow)) {
      // ── Tell the model what it is writing ─────────────────────────────────────────────────────
      //
      // Without this the brief never enters the conversation. `topic`, `primary_keyword` and the page
      // type are stored on the brief ROW, and nothing renders them: phaseDirective's `gathering`
      // branch says "greet and ask the human for the step 1 requirements", which is right for the
      // interactive composer and wrong for an unattended request where the requirements arrived with
      // the request.
      //
      // The autopilot got away with it because it packs "The article to write: X" into `must_follow`,
      // which IS re-rendered every turn. Any other caller — a plain POST with a topic and no
      // must_follow — produced a writer politely asking for a keyword, eight turns of it refusing to
      // invent one, and a run that ended "no sections were written". Reproduced on 2026-09-08.
      //
      // Sent as one opening message rather than added to must_follow so it is cached rather than
      // re-billed on every turn, and keyed on the initial phase so a resumed run does not repeat it.
      //
      // Gated on must_follow NOT already carrying the topic, which is the autopilot's case. Without
      // that gate this fired on autopilot runs too — a redundant extra model turn restating what
      // must_follow says verbatim on every subsequent turn anyway, on the one path that was already
      // working. The seeding is for callers that supply a topic and nothing else.
      const b = (session.brief ?? {}) as Record<string, unknown>;
      const typeKey = String(b.blog_page_type ?? "");
      const type = typeKey ? pageType(typeKey) : null;
      await runTurn(
        sessionId,
        [
          "This piece was requested through the API, so the step 1 requirements are already settled —",
          "they are below. Do not ask for them and do not wait: save the brief and start the research",
          "in this turn.",
          "",
          `Topic and angle: ${String(b.topic ?? "")}`,
          `Primary keyword: ${String(b.primary_keyword ?? b.topic ?? "")}`,
          `Content type: blog post${type ? ` — specifically a ${type.label.toLowerCase()}: ${type.brief}` : ""}`,
          `Target word count: ${String(b.word_count ?? "2500")}`,
          type ? `\nWhat this type owes:\n${type.evidence.map((e) => `  - ${e}`).join("\n")}` : "",
          type ? `\nWhat it must avoid:\n${type.avoid.map((e) => `  - ${e}`).join("\n")}` : "",
        ].filter(Boolean).join("\n"),
        () => {},
      );
    }
    // The deadline is what turns a kill into a handoff. Without it this loop runs until the article
    // is finished or the platform stops the function — and the budget check below never runs, because
    // it is AFTER this line. See the note on writeOneArticle's deadlineAt.
    verdict = await writeOneArticle(sessionId, startedAt + CHUNK_BUDGET_MS);
  } catch (e: unknown) {
    // ── A throw is not necessarily the end of the run ──────────────────────────────────────────
    //
    // This used to mark the session `failed` on the first throw, which is permanent: resumeStalled
    // deliberately skips `failed` sessions, so nothing ever picked it up again. One blip therefore
    // destroyed a run that had done all its research and had five write turns left, and the error it
    // recorded — "writing failed" — did not even say what broke.
    //
    // Retried instead, up to MAX_RUN_ATTEMPTS. The session keeps its phase and its section_cursor, so
    // a retry resumes rather than restarts and no research is repeated. Only the last attempt marks
    // it failed, and it records what was actually thrown.
    const detail = describeThrow(e);
    const brief = (session.brief ?? {}) as Record<string, unknown>;
    const attempts = Number(brief.run_attempts ?? 0) + 1;

    if (attempts < MAX_RUN_ATTEMPTS) {
      await updateWriterSession(sessionId, {
        brief: { ...brief, run_attempts: attempts, last_error: detail },
      } as never).catch(() => {});
      const handed = await qstashPublish("/api/blog/request/run", { session_id: sessionId });
      if (handed) {
        console.warn("[blog-request] %s attempt %d failed (%s); retrying.", sessionId, attempts, detail);
        return { ok: true, handedOff: true };
      }
      // No queue to retry through. Leave the phase alone so the hourly resume sweep can find it —
      // that sweep skips `failed`, so marking it here would hide the one row worth rescuing.
      console.warn("[blog-request] %s failed (%s) and could not be re-enqueued; left for the resume sweep.", sessionId, detail);
      return { ok: false, error: detail };
    }

    verdict = "failed";
    await updateWriterSession(sessionId, {
      phase: "failed",
      error: `${detail} (gave up after ${attempts} attempts)`,
      brief: { ...brief, run_attempts: attempts, last_error: detail },
    } as never).catch(() => {});
  }

  // ── The article is not finished yet: continue it, do not illustrate it ───────────────────────
  //
  // "incomplete" means writeOneArticle yielded between turns because this invocation ran out of
  // clock. Falling through would generate images for a half-written article and announce it.
  if (verdict === "incomplete") {
    const handed = await qstashPublish("/api/blog/request/run", { session_id: sessionId });
    if (handed) return { ok: true, handedOff: true };
    // No queue to hand off to. Say so rather than pressing on with a partial article — the hourly
    // resume sweep is the backstop, and a stuck row it can find beats a bad post it cannot unmake.
    console.warn("[blog-request] %s is incomplete and QStash is unavailable; leaving it for the resume sweep.", sessionId);
    return { ok: false, error: "ran out of time mid-article and could not re-enqueue" };
  }

  // Out of budget before the tail (images are the expensive part): hand the rest off rather than be
  // killed between writing and announcing, which would leave a finished article nobody hears about.
  if (Date.now() - startedAt > CHUNK_BUDGET_MS) {
    const handed = await qstashPublish("/api/blog/request/run", { session_id: sessionId });
    if (handed) return { ok: true, handedOff: true };
  }

  // A supplied hero is used as-is; only the thumbnail is then generated. Rendering a hero for a post
  // about one specific video, when that video's own poster frame was handed to us, would be paying
  // for a worse picture of it.
  // ── Work out the hero, asking nobody ─────────────────────────────────────────────────────────
  //
  // The supplied field first, because an explicit choice beats a derived one. Failing that, look for
  // a YouTube video ANYWHERE in the request — the sources, the material, the instructions, the topic
  // — and derive its poster frame. Four consecutive live requests put the thumbnail in a key we were
  // not reading and got a generated hero instead of the video they were about.
  const brief = (session.brief ?? {}) as Record<string, unknown>;
  const suppliedHero = await (async () => {
    const explicit = String(brief.hero_image_url ?? "").trim();
    if (explicit) return explicit;
    const haystack = [
      (session.required_sources ?? []).join(" "),
      String(brief.source_material ?? ""),
      String(session.must_follow ?? ""),
      String(brief.topic ?? ""),
    ].join("\n");
    const vid = youtubeIdFrom(haystack);
    return vid ? await youtubeThumbnail(vid) : "";
  })();

  const adopted = verdict !== "failed" && suppliedHero
    ? await adoptSuppliedHero(session.draft_id, suppliedHero, String(brief.topic ?? "Untitled"))
    : { hero: false, thumbnail: false };
  // Only the TOP-OF-PAGE slots the supplied image did not cover. Body images are always wanted: a
  // supplied poster frame fills the hero and the card, and says nothing about whether the article
  // itself is illustrated. (This used to be able to come out empty and skip generation entirely,
  // which is why a draft with a supplied hero never got a single body image.)
  const rolesToRender = [
    ...(adopted.thumbnail ? [] : ["thumbnail"]),
    ...(adopted.hero ? [] : ["hero"]),
    "inline",
  ];

  // Images are the one step that spends real money, so a resumed run must never repeat them. The
  // marker is written the moment they finish, and re-entry reads it — see the handoff below, which
  // exists precisely so re-entry happens.
  const alreadyIllustrated = !!brief.assets_done_at;

  const assets = verdict === "failed"
    ? { ok: false, detail: "skipped (article failed)", thumbnail: false }
    : alreadyIllustrated
      ? { ok: true, detail: "already generated on an earlier pass", thumbnail: true }
      : await generateAssets(session.draft_id, rolesToRender,
          typeof brief.blog_page_type === "string" ? brief.blog_page_type : undefined);

  if (!alreadyIllustrated && assets.ok) {
    await updateWriterSession(sessionId, {
      brief: { ...brief, assets_done_at: new Date().toISOString() },
    } as never).catch(() => { /* an optimisation; a lost marker costs one re-render, not the run */ });
  }

  // ── Check the budget AGAIN, because images can outlast it ────────────────────────────────────
  //
  // The checkpoint above runs BEFORE assets, and generateAssets waits up to 220s. So a run that
  // passed that check at 150s can reach here at 370s — past Vercel's 300s ceiling. The function is
  // killed, and because the media route renders server-side on its own the images are already
  // attached: the draft ends up illustrated, unsynced, unannounced, and stuck in `writing`.
  //
  // Measured on three consecutive live Atlas requests. One had a 16,088-character body and cover
  // media 17070 attached, sync_state local_only, no sync_error, and never reached Slack — which
  // reads exactly like "we stopped receiving Atlas blogs" while the finished article sat there.
  //
  // A second checkpoint costs one QStash message and gives the tail — schema, sync, announce — a
  // fresh invocation with its own 300s.
  if (Date.now() - startedAt > CHUNK_BUDGET_MS) {
    const handed = await qstashPublish("/api/blog/request/run", { session_id: sessionId });
    if (handed) return { ok: true, handedOff: true };
  }

  let draft = await getBlogDraft(session.draft_id);
  if (!draft) return { ok: false, error: "Draft vanished." };

  // JSON-LD, derived from the draft rather than written by anyone. It has been null on every post
  // this tool has ever produced, because the only thing that could fill it was a human typing JSON
  // into the editor. Generated here, after the images have been promoted, so the graph carries the
  // real cover URL rather than the null it would have held a moment earlier.
  if (verdict !== "failed") {
    const { buildMarkupSchema } = await import("@/lib/blog/schema");
    const schema = buildMarkupSchema(draft);
    if (schema) {
      const { updateBlogDraft } = await import("@/lib/db/queries");
      await updateBlogDraft(draft.id, { markup_schema: JSON.stringify(schema, null, 2) } as never)
        .catch(() => { /* the article is still fine without it */ });
      draft = (await getBlogDraft(session.draft_id)) ?? draft;
    }
  }

  // ── The draft STOPS in Summit ────────────────────────────────────────────────────────────────
  //
  // It used to sync straight to Strapi as an unpublished entry, which put an unreviewed machine
  // draft into the CMS on every external call — the one place the team treats as "real work" — and
  // left somebody to find and delete it if the article was poor. Nothing published, but the CMS
  // filled up with work nobody had read.
  //
  // Now it lands in Summit, a person reads it, and THEY press Sync. The push is one button away and
  // it is the reviewer's call, which is the same shape as every other draft in this tool.
  //
  // BLOG_REQUEST_AUTOSYNC=1 restores the old behaviour, for a batch where an entry in the CMS is
  // actually what is wanted.
  // ── An unattended run that failed should try something else, not send a message ──────────────
  //
  // A failed autopilot draft used to end as a Slack message reading "this run did not produce a
  // reviewable draft" against an Untitled slug, and the slot was simply gone until the next one. The
  // reader can do nothing with that: there is no draft to fix, and the cause is usually a property of
  // the topic rather than something a person should be paged about.
  //
  // So: mark the subject spent (recentlyDrafted now excludes failed subjects too) and start a fresh
  // pick on a different topic. The failure stays on the audit row for anyone who asks.
  //
  // Bounded by BLOG_AUTOPILOT_PIVOTS_PER_DAY, because "on failure, start another run" is a loop, and a
  // systemic fault — the writer key revoked, Strapi down — would otherwise spend the day rediscovering
  // it. Two is enough to survive a bad topic and cheap enough to survive a bad day.
  if (verdict === "failed" && /^api:autopilot\b/i.test(draft.created_by ?? "")) {
    const pivoted = await pivotAfterFailure(draft, session.id);
    if (pivoted) {
      console.info("[blog-request] draft %s failed; pivoted to a different topic (%s)", draft.id, pivoted);
      // Nothing is announced for this draft. The replacement run announces itself when it lands.
      return { ok: true, handedOff: true };
    }
  }

  const autoSync = process.env.BLOG_REQUEST_AUTOSYNC === "1";
  const synced = verdict === "failed"
    ? { ok: false as const, error: "article failed validation" }
    : autoSync
      ? await syncDraft(draft)
      : { ok: false as const, error: "held in Summit for review (autosync off)" };

  const text = composeBlogRequestMessage({
    title: draft.title,
    slug: draft.slug,
    draftId: draft.id,
    strapiUrl: synced.ok ? adminEntryUrl(synced.strapiId) : null,
    requestedBy: draft.created_by?.replace(/^api:/, "") ?? null,
    verdict,
    assets: assets.ok ? assets.detail : `none (${assets.detail})`,
    syncError: synced.ok ? null : synced.error,
  });

  // ── How many messages one draft is worth ──────────────────────────────────────────────────────
  //
  // Three, before this. Measured on the autopilot's first live run, for ONE post:
  //   09:00  "Autopilot — writing a post"            (the pick, BLOG_AUTOPILOT_ANNOUNCE_PICKS)
  //   09:17  "a new blog draft is ready for review"  (here)
  //   10:01  "a blog draft is ready to publish"      (the hourly notifyReadyDrafts sweep)
  //
  // BLOG_ANNOUNCE_READY_ONLY=1 collapses that to one, and picks the LAST of the three as the one
  // worth keeping: "ready to publish" is the only message that describes something the reader can
  // act on. A draft that is written but missing its thumbnail cannot be published, so announcing it
  // sends somebody to a page with a disabled button.
  //
  // Announced from here rather than left to the sweep whenever the draft is ALREADY publishable, so
  // the message arrives in seconds instead of waiting up to an hour for the next cron tick. When it
  // is not yet publishable this stays silent and leaves slack_notified_at null, which is precisely
  // what the sweep looks for — it announces the draft once the thumbnail pass makes it ready.
  //
  // A FAILED run still speaks, and must: the sweep only ever announces publishable drafts, so a
  // failure would otherwise be pure silence.
  const readyOnly = process.env.BLOG_ANNOUNCE_READY_ONLY === "1";
  const blockers = verdict === "failed" ? ["the article failed validation"] : publishReadiness(draft);

  let toPost: string | null = text;
  let claim = true;
  if (readyOnly) {
    if (verdict === "failed") {
      // Speak, but do not claim: if somebody repairs this draft, the sweep should still announce it.
      claim = false;
    } else if (blockers.length === 0) {
      toPost = composeReadyMessage(draft, tagFor(audienceFor(draft.created_by)));
    } else {
      toPost = null;
      claim = false;
    }
  }

  if (!toPost) {
    console.info(
      "[blog-request] draft %s written but not yet publishable (%s) — staying quiet; the ready sweep will announce it.",
      draft.slug, blockers.join("; "),
    );
  } else if (await getWebhook()) {
    // ── Claim BEFORE posting, and only post if the claim was ours ────────────────────────────────
    //
    // This used to post and then stamp, on the assumption that this path always runs BEFORE the hourly
    // sweep — the comment even said so: "claiming the announcement is what stops the hourly sweep
    // repeating it".
    //
    // The resume pass breaks that ordering, and measured, it broke it every hour. Two sessions sat at
    // phase `writing` with all their sections written and a draft that was already publishable. Each
    // tick, resumeStalledRuns re-enqueued them, the resumed run reached this block, posted, and
    // re-stamped — so `slack_notified_at` kept moving forward (15:01:12, having been 14:01, having been
    // 11:03) and the same two drafts were announced to four reviewers once an hour, indefinitely.
    //
    // notifyReady.ts already claims conditionally. Doing the same here means the two paths are
    // idempotent against EACH OTHER rather than only against themselves, which is the property that was
    // missing — one mechanism, both directions, no assumption about which runs first.
    let mayPost = true;
    if (claim) {
      const res = await supabaseAdmin
        .from("blog_drafts")
        .update({ slack_notified_at: new Date().toISOString() })
        .eq("id", draft.id)
        .is("slack_notified_at", null)
        .select("id");
      // No row back means somebody already announced this draft. Do not post.
      mayPost = !res.error && !!res.data?.length;
      if (!mayPost) {
        console.info(
          "[blog-request] draft %s was already announced (%s) — staying quiet rather than repeating it.",
          draft.slug, res.error ? `claim failed: ${res.error.message}` : "claimed elsewhere",
        );
      }
    }
    // A failure message deliberately does not claim (see above), so it always posts: a run that failed
    // twice is worth hearing about twice.
    if (mayPost) await slackPost(toPost).catch(() => {});
  } else {
    console.warn("[blog-request] no Slack webhook configured; announcement not sent:\n%s", toPost);
  }

  return { ok: true };
}

/**
 * Start a fresh autopilot pick after an unattended run failed.
 *
 * Returns the new subject when it started one, or null when it did not — a null is a normal outcome
 * (cap reached, judge declined, autopilot disabled) and the caller falls through to announcing the
 * failure as before, so a silent dead end is impossible.
 *
 * The import is deliberately lazy. lib/blog/autopilot imports startBlogRequest from this module, and a
 * static import back would be a cycle: at module-init time one of the two halves would be a partially
 * evaluated object and whichever function was reached first would be undefined.
 */
async function pivotAfterFailure(
  draft: Pick<BlogDraft, "id" | "created_by">,
  sessionId: string,
): Promise<string | null> {
  const cap = Number(process.env.BLOG_AUTOPILOT_PIVOTS_PER_DAY ?? 2);
  if (!Number.isFinite(cap) || cap <= 0) return null;

  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const { count } = await supabaseAdmin
    .from("blog_autopilot_runs")
    .select("id", { count: "exact", head: true })
    .eq("status", "failed")
    .gte("started_at", midnight.toISOString());
  if ((count ?? 0) > cap) {
    console.warn("[blog-request] %d failed autopilot run(s) today, above the pivot cap of %d — not pivoting.", count, cap);
    return null;
  }

  try {
    const { runAutopilot } = await import("@/lib/blog/autopilot");
    const slot = (draft.created_by ?? "").replace(/^api:autopilot:?/i, "").trim() || "manual";
    const out = await runAutopilot({ slot: `${slot}-pivot` });
    return out.status === "drafted" ? (out.subject ?? "a different topic") : null;
  } catch (e: unknown) {
    console.warn("[blog-request] pivot after failure did not start (%s); falling back to announcing the failure. session=%s",
      e instanceof Error ? e.message : "unknown", sessionId);
    return null;
  }
}
