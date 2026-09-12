// Single model client for the writing agent AND for Summer, in the same spirit as llmEnabled() /
// strapiConfigured() / isGscConfigured() elsewhere in the repo: a boolean gate, and one place that
// knows the credential.
//
// This is a DIFFERENT stack from src/lib/seo-agents/llm.ts (OpenRouter chat/completions, no
// streaming, no caching). Don't route writer calls through that helper and don't route the ~20
// existing llmChat call sites through this one — they solve different problems (cheap
// classification vs. a long, cached, streaming authoring session).
//
// ── Two providers behind one client ─────────────────────────────────────────────────────────────
//
// Everything that thinks in this app comes through anthropicClient(): Summer's chat loop, the blog
// judge, the article writer, metadata, revisions, cluster planning, landing autofill. All of it was
// pinned to a direct Anthropic key, and on 2026-08-28 that key hit its configured spend cap and then
// started returning 401 — which took out the blog pipeline for three days and Summer with it.
//
// OpenRouter exposes an Anthropic-Messages-compatible endpoint ("the Anthropic skin") at
// https://openrouter.ai/api. Verified against it live before this was written, because the whole
// value of the fallback is that the ADVANCED parameters survive — a gateway that only speaks plain
// completions would silently break the parts that matter:
//
//   thinking: {type:"adaptive", display:"summarized"}   accepted
//   output_config: {effort}                             accepted
//   messages.stream()                                   accepted (12 events on a 3-token reply)
//   cache_control ephemeral ttl 1h                       accepted, cache_creation_input_tokens 1804
//   tools + tool_choice                                  accepted, stop_reason "tool_use"
//   bare model ids ("claude-opus-5")                     accepted, mapped to anthropic/claude-opus-5
//
// So no model-name mapping is needed and no call site changes. `authToken` rather than `apiKey`
// because OpenRouter authenticates with `Authorization: Bearer`, and `apiKey: null` is explicit so
// the SDK cannot also attach an `x-api-key` header from the ambient ANTHROPIC_API_KEY.
//
// One difference worth knowing: the skin returned no `thinking` content block in testing, only
// `text`. Nothing depends on thinking blocks being present — agent.ts filters for text and treats
// thinking as decoration — but Summer's live "thinking" ticker will be quieter on this provider.
//
// What is NOT covered: src/lib/agents/managed.ts (the landing-page builder) uses Anthropic's Managed
// Agents product, not the Messages API. It has no OpenRouter equivalent and still needs a working
// ANTHROPIC_API_KEY of its own.
import Anthropic from "@anthropic-ai/sdk";

/** OpenRouter's Anthropic-compatible base. NOT /api/v1 — that path 404s with an HTML page. */
const OPENROUTER_BASE = "https://openrouter.ai/api";

export type WriterProvider = "anthropic" | "openrouter";

/** A credential is only usable if it is actually a value; >20 chars filters empty and placeholder. */
function credential(name: string): string | null {
  const v = process.env[name]?.trim();
  return v && v.length > 20 ? v : null;
}

/**
 * Which provider this process will call, or null when neither is configured.
 *
 * OpenRouter wins by default when its key is present, and that ordering is deliberate rather than a
 * preference: setting OPENROUTER_API_KEY is the deliberate act, and the direct key is the one that has
 * already failed twice in a week (spend cap, then 401). Pin it either way with WRITER_PROVIDER, which
 * is the escape hatch for "the gateway is the problem today" — the same shape as the SLACK_TAG_* env
 * overrides, and for the same reason: a fallback nobody can turn off is not a fallback.
 *
 * Worth knowing on cost: OpenRouter adds a margin over Anthropic list price, so pinning
 * WRITER_PROVIDER=anthropic once the direct key is healthy is the cheaper steady state.
 */
export function writerProvider(): WriterProvider | null {
  const forced = process.env.WRITER_PROVIDER?.trim().toLowerCase();
  const openrouter = credential("OPENROUTER_API_KEY");
  const direct = credential("ANTHROPIC_API_KEY");
  if (forced === "anthropic") return direct ? "anthropic" : null;
  if (forced === "openrouter") return openrouter ? "openrouter" : null;
  return openrouter ? "openrouter" : direct ? "anthropic" : null;
}

/** Which credential is missing, for an error a person can act on. */
export function writerReadiness(): { ready: boolean; provider: WriterProvider | null; detail: string } {
  const provider = writerProvider();
  if (provider) return { ready: true, provider, detail: `Using ${provider}.` };
  const forced = process.env.WRITER_PROVIDER?.trim().toLowerCase();
  if (forced === "anthropic") return { ready: false, provider: null, detail: "WRITER_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set." };
  if (forced === "openrouter") return { ready: false, provider: null, detail: "WRITER_PROVIDER=openrouter but OPENROUTER_API_KEY is not set." };
  return { ready: false, provider: null, detail: "Neither OPENROUTER_API_KEY nor ANTHROPIC_API_KEY is set." };
}

export const WRITER_MODEL = "claude-opus-5";

/**
 * Models a person may switch the chat to, and the only ones accepted.
 *
 * An allowlist rather than a free-text field: the model id goes straight into a billed API call, so
 * a typo would fail every turn of a conversation with an error nobody reads as "you misspelled the
 * model", and an arbitrary string would let a caller point production at anything.
 *
 * Opus is deliberately NOT in this list. It proved too expensive per chat turn to leave one click
 * away, so it was pulled from the picker (Aug 2026) — it remains the writer's model (WRITER_MODEL
 * above) and available to code, just not a per-conversation choice in the UI. A session that stored
 * "claude-opus-5" before then resolves to the chat default below rather than erroring.
 */
export const SELECTABLE_MODELS = [
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "Default. Fast, sharp, and a fraction of the price of the big models." },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "Fastest and cheapest. Simple reads only." },
] as const;

export type SelectableModel = (typeof SELECTABLE_MODELS)[number]["id"];

/** What a chat conversation runs on when no (valid) choice is stored. Distinct from WRITER_MODEL on
 *  purpose: the blog writer is a few long, high-stakes runs a day and keeps Opus; the chat is many
 *  quick turns and defaults to Sonnet. */
export const CHAT_MODEL = "claude-sonnet-5";

/** Resolve a requested model to one we will actually call. Anything unrecognised — a typo, a stale
 *  id from an old session, a hand-edited row — falls back to the default rather than erroring the
 *  turn, because a conversation that cannot start is a worse answer than one on the wrong model. */
export function resolveModel(requested?: string | null): string {
  const want = requested?.trim();
  if (!want) return WRITER_MODEL;
  return SELECTABLE_MODELS.some((m) => m.id === want) ? want : WRITER_MODEL;
}

/** The chat's version of resolveModel: same fall-back-don't-error contract, but everything lands on
 *  CHAT_MODEL — including "claude-opus-5" stored by sessions from before Opus left the picker,
 *  which is exactly the spend this exists to stop. */
export function resolveChatModel(requested?: string | null): string {
  const want = requested?.trim();
  if (!want) return CHAT_MODEL;
  return SELECTABLE_MODELS.some((m) => m.id === want) ? want : CHAT_MODEL;
}

let _client: Anthropic | null | undefined;
let _clientProvider: WriterProvider | null = null;

export function writerEnabled(): boolean {
  return writerProvider() !== null;
}

/**
 * Lazily constructed, reused across requests in the same server process. Returns null when
 * unconfigured so callers degrade (503/"not configured") rather than throwing at import time.
 *
 * The memo is keyed on the PROVIDER, not just on being built: a process that cached an Anthropic
 * client and then had WRITER_PROVIDER flipped would keep calling the dead provider until it was
 * recycled, which on serverless is indistinguishable from the switch not working.
 */
export function anthropicClient(): Anthropic | null {
  const provider = writerProvider();
  if (_client !== undefined && _clientProvider === provider) return _client;
  _clientProvider = provider;
  _client =
    provider === "openrouter"
      ? new Anthropic({
          baseURL: OPENROUTER_BASE,
          // Bearer, not x-api-key. `apiKey: null` stops the SDK reading ANTHROPIC_API_KEY from the
          // environment and sending both headers, which OpenRouter rejects as an auth conflict.
          authToken: credential("OPENROUTER_API_KEY"),
          apiKey: null,
        })
      : provider === "anthropic"
        ? new Anthropic({ apiKey: credential("ANTHROPIC_API_KEY") })
        : null;
  return _client;
}

/**
 * The parameters every writer call shares. Centralised because getting any of these wrong is a
 * silent failure, not an error:
 *   - `temperature`/`top_p`/`top_k` are REJECTED (400) on Opus 5 when non-default — never pass them.
 *   - `thinking: {type:"enabled", budget_tokens}` is REJECTED (400) on Opus 5 — adaptive only.
 *   - On Opus 5 thinking is ON BY DEFAULT (unlike Sonnet 5, where omitting the field meant no
 *     thinking). We set it explicitly anyway so the behaviour is readable at the call site, and
 *     because `display` still has to be forced — see below. Note `max_tokens` caps thinking AND
 *     response text together, so a budget sized around the prose alone can now truncate mid-answer.
 *   - `thinking: {type:"disabled"}` is only accepted at effort `high` or lower on Opus 5; pairing
 *     it with `xhigh`/`max` is a 400. Nothing here disables thinking, but a caller adding a
 *     fast path later needs to know.
 *   - `display: "summarized"` is NOT the SDK's advertised default. The installed SDK's docstring
 *     (v0.107.0, predates Sonnet 5) claims "summarized" is default; verified live that the real
 *     default is "omitted", which streams thinking blocks with EMPTY text — a silent dead pause in
 *     a chat UI, not an error. Omitting `display` here would reproduce that bug.
 */
export function baseWriterParams(effort: "low" | "medium" | "high" | "xhigh" | "max" = "high", model?: string | null) {
  return {
    model: resolveModel(model),
    thinking: { type: "adaptive" as const, display: "summarized" as const },
    output_config: { effort },
  };
}
