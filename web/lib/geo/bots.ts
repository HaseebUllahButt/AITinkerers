// The AI crawlers, and what each one actually controls.
//
// ── Why this table carries a `controls` field ───────────────────────────────────────────────────
//
// Every AI-visibility dashboard lists bot names and hit counts. That is the easy half and it is not
// the half that misleads people. The dangerous confusion is that these agents do DIFFERENT JOBS and
// blocking them has opposite consequences:
//
//   GPTBot         decides whether our content trains a future model.       Blocking costs us NOTHING
//                                                                          in ChatGPT visibility.
//   OAI-SearchBot  decides whether we can appear in ChatGPT's search.       Blocking makes us invisible.
//
// From OpenAI's own documentation, verbatim: "Each setting is independent of the others – for example,
// a webmaster can allow OAI-SearchBot in order to appear in search results while disallowing GPTBot to
// indicate that crawled content should not be used for training." So the common defensive rule —
// "block the AI bots" — is a decision that can cost all of our retrieval visibility while the person
// making it believes they only opted out of training.
//
// The practical trap is not robots.txt either. Cloudflare's verified-bot taxonomy files OAI-SearchBot
// under "AI Search" and the training crawler under "AI Crawler", so one WAF toggle labelled
// "block AI bots" can remove retrieval sitewide. That is why this module exists as a lookup a person
// can read, rather than a set of strings buried in a parser.
//
// Sources: developers.openai.com/api/docs/bots, support.claude.com (Anthropic crawler article),
// docs.perplexity.ai/docs/resources/perplexity-crawlers, developers.google.com/search AI features,
// developers.cloudflare.com/ai-crawl-control/reference/bots.

/** What blocking this agent actually costs us. */
export type BotControls =
  /** Training-corpus inclusion. Blocking does NOT remove us from that product's answers. */
  | "training"
  /** Indexing for retrieval. Blocking DOES make us invisible in that product's answers. */
  | "retrieval"
  /** A live fetch triggered by a user in the moment. Blocking breaks link previews and follow-ups. */
  | "live-fetch"
  /** Ad-page safety validation. Only matters if we advertise on that surface. */
  | "ads";

export interface AiBot {
  /** Normalised key stored in geo_bot_hits.bot. */
  key: string;
  /** How it appears in a User-Agent string, lowercased for matching. */
  match: string;
  label: string;
  vendor: string;
  controls: BotControls;
  /** Said in one sentence, for the UI. This is the part nobody else shows. */
  blockingCosts: string;
}

export const AI_BOTS: AiBot[] = [
  {
    key: "oai-searchbot", match: "oai-searchbot", label: "OAI-SearchBot", vendor: "OpenAI",
    controls: "retrieval",
    blockingCosts: "Removes us from ChatGPT search answers. This is the one that must not be blocked.",
  },
  {
    key: "gptbot", match: "gptbot", label: "GPTBot", vendor: "OpenAI",
    controls: "training",
    blockingCosts: "Nothing in ChatGPT visibility — it only opts our content out of training future models.",
  },
  {
    key: "chatgpt-user", match: "chatgpt-user", label: "ChatGPT-User", vendor: "OpenAI",
    controls: "live-fetch",
    blockingCosts: "Breaks pages a user asks ChatGPT to open or summarise in the moment.",
  },
  {
    key: "oai-adsbot", match: "oai-adsbot", label: "OAI-AdsBot", vendor: "OpenAI",
    controls: "ads",
    blockingCosts: "Only matters if we run ads on ChatGPT — it validates the safety of ad landing pages.",
  },
  {
    key: "perplexitybot", match: "perplexitybot", label: "PerplexityBot", vendor: "Perplexity",
    controls: "retrieval",
    blockingCosts: "Removes us from Perplexity answers.",
  },
  {
    key: "perplexity-user", match: "perplexity-user", label: "Perplexity-User", vendor: "Perplexity",
    controls: "live-fetch",
    blockingCosts: "Breaks pages a Perplexity user opens directly.",
  },
  {
    key: "claudebot", match: "claudebot", label: "ClaudeBot", vendor: "Anthropic",
    controls: "training",
    blockingCosts: "Nothing in Claude's answers — training corpus only.",
  },
  {
    key: "claude-searchbot", match: "claude-searchbot", label: "Claude-SearchBot", vendor: "Anthropic",
    controls: "retrieval",
    blockingCosts: "Removes us from Claude's web-search answers.",
  },
  {
    key: "claude-user", match: "claude-user", label: "Claude-User", vendor: "Anthropic",
    controls: "live-fetch",
    blockingCosts: "Breaks pages a Claude user asks it to fetch.",
  },
  {
    // Not a crawler. Google-Extended is a robots.txt token that governs whether content already
    // crawled by Googlebot may train Gemini — so it never appears in logs, and its absence from this
    // table's hit counts is expected rather than a gap.
    key: "google-extended", match: "google-extended", label: "Google-Extended", vendor: "Google",
    controls: "training",
    blockingCosts:
      "Nothing in AI Overviews or AI Mode — those use Googlebot. It only opts out of Gemini training. "
      + "It is a robots.txt token, not a crawler, so it will never show a hit here.",
  },
  {
    key: "googlebot", match: "googlebot", label: "Googlebot", vendor: "Google",
    controls: "retrieval",
    blockingCosts: "Removes us from Google Search AND from AI Overviews / AI Mode, which read the same index.",
  },
  {
    key: "bingbot", match: "bingbot", label: "Bingbot", vendor: "Microsoft",
    controls: "retrieval",
    blockingCosts: "Removes us from Bing and from Copilot, which is built on the same index.",
  },
  {
    key: "ccbot", match: "ccbot", label: "CCBot", vendor: "Common Crawl",
    controls: "training",
    blockingCosts: "Nothing directly, but Common Crawl feeds many models' training sets second-hand.",
  },
  {
    key: "bytespider", match: "bytespider", label: "Bytespider", vendor: "ByteDance",
    controls: "training",
    blockingCosts: "Nothing we sell into. Widely blocked for crawl-rate reasons rather than GEO ones.",
  },
  {
    key: "applebot-extended", match: "applebot-extended", label: "Applebot-Extended", vendor: "Apple",
    controls: "training",
    blockingCosts: "Nothing in Siri or Spotlight results — training opt-out only.",
  },
  {
    key: "applebot", match: "applebot", label: "Applebot", vendor: "Apple",
    controls: "retrieval",
    blockingCosts: "Removes us from Siri and Spotlight suggestions.",
  },
  {
    key: "meta-externalagent", match: "meta-externalagent", label: "Meta-ExternalAgent", vendor: "Meta",
    controls: "training",
    blockingCosts: "Training corpus for Meta's models.",
  },
  {
    key: "amazonbot", match: "amazonbot", label: "Amazonbot", vendor: "Amazon",
    controls: "retrieval",
    blockingCosts: "Affects Alexa answers.",
  },
];

/**
 * Which AI bot is this User-Agent, if any?
 *
 * Longest match first, and that ordering is load-bearing rather than tidy: "claudebot" is a substring
 * of nothing, but "perplexity-user" contains "perplexity" and "oai-searchbot" would be missed by a
 * naive scan that hit "bot" first. Sorting by match length means the most specific agent wins, so
 * Claude-SearchBot is never miscounted as ClaudeBot — which matters because the two control opposite
 * things and would otherwise be averaged into one meaningless row.
 */
const BY_LENGTH = [...AI_BOTS].sort((a, b) => b.match.length - a.match.length);

export function identifyBot(userAgent: string | null | undefined): AiBot | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  return BY_LENGTH.find((b) => ua.includes(b.match)) ?? null;
}

/** The bots whose absence is a real visibility problem, in the order a person should worry about them. */
export const RETRIEVAL_BOTS = AI_BOTS.filter((b) => b.controls === "retrieval");

export function botByKey(key: string): AiBot | null {
  return AI_BOTS.find((b) => b.key === key) ?? null;
}
