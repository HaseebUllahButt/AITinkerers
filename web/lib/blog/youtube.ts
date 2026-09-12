// Embedding ImagineArt's own YouTube videos in blog posts.
//
// A leaf module: no database, no Strapi. The blog writer, Summer and the validator read from here.
//
// ── The renderer already supports this; nothing was emitting it ─────────────────────────────────
//
// imagine-web's blog body is `ReactMarkdown` with `rehypePlugins={[rehypeRaw]}` and no element
// whitelist, and BLOG_MARKDOWN_COMPONENTS defines an `iframe` component that pipes its src through
// `convertYoutubeToEmbed()`. So a raw <iframe> in the markdown body renders as a real, responsive,
// 16:9 player with rounded corners. That has been true the whole time — Summit simply never produced
// one, which is why 750 posts carry no video.
//
// ── The one detail that decides whether the embed works ─────────────────────────────────────────
//
// Read from apps/imagine/src/utils/Blogs/index.tsx:
//
//     const YOUTUBE_WATCH_URL = 'youtube.com/watch';
//     const convertYoutubeToEmbed = (url) => {
//       if (!url.includes(YOUTUBE_WATCH_URL)) return url;   // <-- passthrough
//       ...reads ?v= and optional ?list=, returns the /embed/ URL
//     };
//
// The conversion is gated on the string "youtube.com/watch". A `youtu.be/ID` short link therefore
// passes through UNCHANGED into the iframe src — and YouTube refuses to be framed from a watch or
// short URL, so the reader gets an empty box. Same for `/shorts/ID`. So this module emits the long
// watch form and nothing else, and `embedFor()` is the only thing allowed to build the tag.
//
// ── Where the videos come from ──────────────────────────────────────────────────────────────────
//
// The channel's RSS feed, which needs no API key:
//
//     https://www.youtube.com/feeds/videos.xml?channel_id=UCPo3m7P4hC0ZYDA5ty8CAOg
//
// The YouTube Data API would be better — it can search the whole back catalogue — but all three
// Google keys in this project return 403 "Requests to this API youtube method ... are blocked",
// i.e. the Data API is not enabled on the Cloud project. So RSS it is, with the honest limitation
// that it returns only the FIFTEEN most recent uploads. That is enough for the actual job (a post
// about something we just shipped wants the video about what we just shipped) and not enough for an
// evergreen post about a two-year-old feature. `feedLimitation` says so out loud rather than letting
// a writer conclude we have no video on a subject we have covered ten times.
//
// If someone enables the Data API later, set YOUTUBE_API_KEY and searchChannel() will use it.

/** ImagineArt's channel — @imagineartofficial. Resolved from the channel page's externalId. */
export const IMAGINEART_CHANNEL_ID = "UCPo3m7P4hC0ZYDA5ty8CAOg";
export const IMAGINEART_CHANNEL_URL = "https://www.youtube.com/@imagineartofficial";

export interface ChannelVideo {
  id: string;
  title: string;
  published: string;
  /** The long watch URL. The ONLY form the renderer converts — see the header. */
  url: string;
}

export interface ChannelFeed {
  ok: boolean;
  videos: ChannelVideo[];
  problem?: string;
  /** Stated on every successful read, because "no match" and "not in the last 15" differ. */
  feedLimitation: string;
}

const FEED_LIMITATION =
  "This is the channel's RSS feed, which only carries the 15 most recent uploads — the YouTube Data "
  + "API is not enabled on our Cloud project. So a miss means 'not in the last 15 uploads', NOT 'we "
  + "have no video about this'. Never write that we have no video on a subject; say you could not find "
  + "a recent one.";

/** Strip XML entities and CDATA out of a feed field. */
function unescapeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * The channel's recent uploads.
 *
 * Never throws — the callers are a writing turn and an autopilot run, and neither should die because
 * YouTube was slow.
 */
export async function recentChannelVideos(channelId = IMAGINEART_CHANNEL_ID): Promise<ChannelFeed> {
  try {
    const res = await fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
      { signal: AbortSignal.timeout(15_000), headers: { accept: "application/atom+xml" } },
    );
    if (!res.ok) {
      return { ok: false, videos: [], problem: `The channel feed returned HTTP ${res.status}.`, feedLimitation: FEED_LIMITATION };
    }
    const xml = await res.text();
    const videos: ChannelVideo[] = [];
    for (const entry of xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []) {
      const id = entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1]?.trim();
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
      const published = entry.match(/<published>(.*?)<\/published>/)?.[1]?.trim();
      if (!id || !title) continue;
      videos.push({
        id,
        title: unescapeXml(title),
        published: (published ?? "").slice(0, 10),
        url: watchUrl(id),
      });
    }
    // The feed lists the same upload twice when a Short and a long cut share a title; keep the first.
    const seen = new Set<string>();
    const deduped = videos.filter((v) => {
      const k = v.title.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase().slice(0, 60);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { ok: true, videos: deduped, feedLimitation: FEED_LIMITATION };
  } catch (e) {
    return {
      ok: false, videos: [],
      problem: `The channel feed could not be read: ${e instanceof Error ? e.message : String(e)}`,
      feedLimitation: FEED_LIMITATION,
    };
  }
}

/** The long watch URL. Use this rather than building one — see the header on youtu.be. */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * The embed, as the blog body should carry it.
 *
 * A bare iframe on its own line, blank lines either side so react-markdown treats it as a block
 * rather than nesting it inside a <p> (which the custom `p` component would wrap in styling meant
 * for text). The heading above it does the describing: the renderer hardcodes title="Embedded
 * content", so a title attribute here would be discarded.
 */
export function embedFor(video: { id: string } | string): string {
  const id = typeof video === "string" ? video : video.id;
  return `\n\n<iframe src="${watchUrl(id)}"></iframe>\n\n`;
}

/** Does this markdown already carry a video embed? */
export function embedsIn(body: string): string[] {
  return [...body.matchAll(/<iframe[^>]+src="([^"]+)"/g)].map((m) => m[1]);
}

/** Is this URL one of ours, in the form the renderer can convert? */
export function isOurEmbeddableUrl(url: string): boolean {
  return url.includes("youtube.com/watch") && /[?&]v=[A-Za-z0-9_-]{5,}/.test(url);
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "for", "with", "to", "in", "on", "of", "is", "are", "how", "what",
  "your", "you", "it", "at", "by", "from", "best", "new", "using", "use", "ai", "imagineart", "imagine",
]);

/**
 * Distinctive tokens from a title.
 *
 * Version numbers are extracted BEFORE the punctuation strip, and this is the whole reason the
 * function exists. Naively splitting on non-alphanumerics turns "Seedance 2.5" into
 * ["seedance","2","5"], and the length filter then drops both digits — so "Seedance 2.5 review"
 * scored 1 against the Seedance 2.5 video and fell under the threshold. The version is precisely the
 * token that tells 2.5 apart from 1.5 Pro, so it has to survive intact.
 *
 * Model-and-number names ("gpt-6", "v7", "o3", "wan 3.0") are kept whole for the same reason.
 */
function tokens(s: string): Set<string> {
  const lower = s.toLowerCase();
  const out = new Set<string>();
  // 2.5, 3.0, 1.1.2 — kept with the dot, so "2.5" never collides with "2"
  for (const m of lower.match(/\d+(?:\.\d+)+/g) ?? []) out.add(m);
  // gpt-6, v7, o3, wan3 — a name welded to a number
  for (const m of lower.match(/[a-z]{1,10}-?\d+(?:\.\d+)?/g) ?? []) out.add(m.replace("-", ""));
  // a bare version after a known-model word: "seedance 2 5" is already covered above, but "kling 3"
  // arrives as two tokens and the number is the distinguishing half.
  for (const m of lower.match(/(?<=[a-z]\s)\d+(?:\.\d+)?/g) ?? []) out.add(m);
  for (const w of lower.replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (w.length > 2 && !STOP.has(w)) out.add(w);
  }
  return out;
}

/**
 * The channel's videos that are actually about this subject, best first.
 *
 * Scored on shared distinctive tokens, and it returns NOTHING below a real overlap. That floor is
 * the point: a loosely related video is worse than no video, because a reader who clicks a "Kling
 * 2.6" embed on a Seedream article learns that our embeds are decorative and stops clicking. Model
 * and version tokens survive the stop-word strip, so "seedance 2.5" matches its own video and not
 * the general Workflows one.
 */
export function relevantVideos(
  videos: ChannelVideo[],
  subject: string,
  opts: { limit?: number } = {},
): Array<ChannelVideo & { score: number; matched: string[] }> {
  const want = tokens(subject);
  if (want.size === 0) return [];
  const scored = videos.map((v) => {
    const have = tokens(v.title);
    const matched = [...want].filter((w) => have.has(w));
    // Numeric version tokens are worth more: "2.5" in both titles is a strong signal, "video" is not.
    // A shared token containing a digit is a version match and worth double: "2.5" appearing in both
    // titles is strong evidence they are about the same release; "video" is not evidence of anything.
    const score = matched.reduce((n, w) => n + (/\d/.test(w) ? 2 : 1), 0);
    return { ...v, score, matched };
  });
  return scored
    .filter((v) => v.score >= 2)
    .sort((a, b) => b.score - a.score || b.published.localeCompare(a.published))
    .slice(0, opts.limit ?? 2);
}

/** At most this many embeds in one article. */
export const MAX_EMBEDS = 2;

export const YOUTUBE_RULES = [
  "Embed ONLY videos from ImagineArt's own channel, and only ones genuinely about this subject. A "
    + "loosely related video teaches the reader that our embeds are decorative.",
  `At most ${MAX_EMBEDS} per article, and zero is the right number when nothing on the channel fits. `
    + "Never pad a post with a video to look richer.",
  "Emit the long watch URL inside a bare iframe: <iframe src=\"https://www.youtube.com/watch?v=ID\"></iframe> "
    + "on its own line with a blank line either side. Do NOT use a youtu.be link, a /shorts/ link or an "
    + "/embed/ link — the renderer only converts a URL containing \"youtube.com/watch\", and anything else "
    + "is passed straight through and renders as an empty box.",
  "Put a real sentence above it saying what the video shows and why it is there. The player has no "
    + "caption of its own — the renderer hardcodes its title — so the surrounding prose is the only "
    + "thing telling a reader whether to spend two minutes.",
  "Never invent a video id, a title or a URL. Only ids that came back from the channel feed.",
  "A video is not evidence for a claim in the text. If the article states a spec or a result, it still "
    + "needs a real source; an embed is illustration on top of that, never instead of it.",
];

/**
 * The block handed to the writer from the videos already resolved onto the brief.
 *
 * Separate from youtubeNote() because the brief carries the ANSWER (matched videos) rather than the
 * feed, and the two "nothing to embed" cases are genuinely different: `undefined` means the feed
 * could not be read, `[]` means it was read and nothing matched. Saying "we have no video about
 * this" in the first case would be a false statement about the channel.
 */
export function briefVideoNote(
  videos: Array<{ id: string; title: string; url: string; published: string }> | undefined,
): string {
  if (videos === undefined) {
    return [
      "## ImagineArt video embeds",
      "",
      "The channel feed could not be read for this run, so no video was matched. Do not guess a URL or",
      "an id — an invented one renders as an empty player. Write the article without a video, and do",
      "not tell the reader we have no video on the subject; we did not manage to look.",
    ].join("\n");
  }
  if (videos.length === 0) {
    return [
      "## ImagineArt video embeds",
      "",
      "Nothing on the channel's recent uploads matches this subject closely enough, so this article gets",
      "no video. That is a correct outcome, not a gap to fill — and it means 'not in the last 15",
      "uploads', so never write that we have no video about this.",
    ].join("\n");
  }
  return [
    "## ImagineArt video embeds",
    "",
    `${videos.length} of our own videos match this subject. Embed them where the prose reaches what they show:`,
    ...videos.flatMap((v) => [
      "",
      `- ${v.title}  (${v.published})`,
      `  paste exactly: <iframe src="${v.url}"></iframe>`,
    ]),
    "",
    "Rules:",
    ...YOUTUBE_RULES.map((r) => `- ${r}`),
  ].join("\n");
}

/** Compressed reminder for the section turns. */
export function youtubeReminder(count: number): string {
  if (count <= 0) return "";
  return (
    "If a section reaches what one of the ImagineArt videos shows, embed it there: a bare "
    + "<iframe src=\"https://www.youtube.com/watch?v=ID\"></iframe> on its own line, with a sentence "
    + "above saying what it shows. Only the ids you were given, and never a youtu.be or /shorts link."
  );
}

/** The block handed to the writer when videos are available. */
export function youtubeNote(feed: ChannelFeed, subject: string): string {
  if (!feed.ok) {
    return [
      "## ImagineArt video embeds",
      "",
      `The channel feed could not be read: ${feed.problem}`,
      "Write the article without a video rather than guessing a URL — an invented video id renders as a broken player.",
    ].join("\n");
  }
  const hits = relevantVideos(feed.videos, subject, { limit: MAX_EMBEDS });
  const lines = ["## ImagineArt video embeds", ""];

  if (hits.length === 0) {
    lines.push(
      "Nothing on the channel's recent uploads matches this subject closely enough to embed, so this",
      "article gets no video. That is a correct outcome, not a gap to fill.",
      "",
      feed.feedLimitation,
    );
    return lines.join("\n");
  }

  lines.push("These are ours and they match this subject. Embed at most " + MAX_EMBEDS + ":");
  for (const v of hits) {
    lines.push(
      "",
      `- ${v.title}  (${v.published})`,
      `  matched on: ${v.matched.join(", ")}`,
      `  embed exactly: <iframe src="${v.url}"></iframe>`,
    );
  }
  lines.push("", "Rules:", ...YOUTUBE_RULES.map((r) => `- ${r}`), "", feed.feedLimitation);
  return lines.join("\n");
}
