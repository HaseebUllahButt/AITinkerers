// The Link Exchange inventory — ImagineArt's own blog pages, classified exactly as in the
// SEO team's "Link Exchange Guidelines" (Appendix A). This is the SINGLE source of truth for
// what the negotiation agent may offer a partner in a link swap, and under what conditions.
//
// Tiers (from the guidelines):
//   - open       Relevant listicle / roundup below the traffic threshold. "Offer freely."
//   - governed   Comparison / "alternatives" / "vs" page. Offer ONLY with guardrails (§3.2) —
//                nofollow out to competitors, we stay #1, never link the target competitor, no
//                exact-match anchor. These need human judgement, so the agent NEVER auto-offers
//                them: it hands the thread to a person instead.
//   - restricted High-traffic or money/conversion page. Never offered — protected.
//   - offtable   Topically unrelated (ideas / inspiration / how-to). Not offered to competitors.
//
// Design choice: the AI auto-offers OPEN pages only (the "offer freely" lane). Anything that
// would need a Governed page, a protected page, or has no relevant page routes to a human. That
// keeps the autonomous path inside the guidelines' safe zone and escalates every borderline case,
// exactly as §2/§3.2 ("escalate to the SEO Lead rather than improvising") ask.

export type Tier = "open" | "governed" | "restricted" | "offtable";

export interface InventoryPage {
  slug: string;             // path under /blogs/
  tier: Tier;
  traffic: number;          // monthly organic sessions, from Appendix A
  topics: string[];         // keywords describing the page's subject, for relevance matching
}

const BLOG = "https://www.imagine.art/blogs/";
export const pageUrl = (slug: string) => `${BLOG}${slug}`;

// Appendix A, verbatim classification. Keep this list in sync with the guidelines doc; re-run the
// classification whenever traffic shifts materially (the guidelines say the numbers are starting
// recommendations, not fixed law).
export const INVENTORY: InventoryPage[] = [
  // ── Restricted — never offer (protected high-traffic / money pages) ──
  { slug: "best-photo-editing-apps", tier: "restricted", traffic: 1840, topics: ["photo editing", "photo editor", "edit photos"] },
  { slug: "video-editing-tips", tier: "restricted", traffic: 560, topics: ["video editing", "edit video"] },
  { slug: "headshot-examples", tier: "restricted", traffic: 365, topics: ["headshot", "portrait", "profile photo"] },

  // ── Open inventory — offer freely to relevant partners (listicles & roundups) ──
  { slug: "short-form-video-platforms", tier: "open", traffic: 104, topics: ["short form video", "reels", "tiktok", "shorts", "social video", "short video"] },
  { slug: "top-free-ai-image-to-video-tools", tier: "open", traffic: 62, topics: ["image to video", "animate image", "ai video", "photo to video"] },
  { slug: "best-ai-video-generators", tier: "open", traffic: 44, topics: ["ai video generator", "text to video", "video generation", "generate video", "ai video"] },
  { slug: "best-aesthetic-photo-editing-apps", tier: "open", traffic: 41, topics: ["aesthetic photo", "photo editing app", "photo filters", "photo apps"] },
  { slug: "best-apps-for-changing-background-in-photo", tier: "open", traffic: 41, topics: ["change background", "background removal", "remove background", "photo background"] },
  { slug: "best-ai-tools-to-remove-object-from-video", tier: "open", traffic: 10, topics: ["remove object", "video cleanup", "object removal", "video editing"] },
  { slug: "ai-video-generator-apps", tier: "open", traffic: 5, topics: ["ai video app", "video generator app", "mobile video", "ai video"] },
  { slug: "ai-image-compositing-tools", tier: "open", traffic: 3, topics: ["image compositing", "composite", "photo composite", "blend images"] },
  { slug: "ai-image-generation-models", tier: "open", traffic: 2, topics: ["ai image generation", "text to image", "image generation", "image models", "generate images"] },
  { slug: "clothes-swap-ai-apps", tier: "open", traffic: 2, topics: ["clothes swap", "virtual try on", "outfit", "fashion ai", "clothing"] },
  { slug: "best-fashion-design-apps", tier: "open", traffic: 1, topics: ["fashion design", "apparel", "clothing design", "fashion"] },
  { slug: "architecture-design-apps", tier: "open", traffic: 1, topics: ["architecture", "interior design", "building design", "architectural"] },
  { slug: "best-ai-face-swap-apps", tier: "open", traffic: 0, topics: ["face swap", "faceswap", "swap faces", "face"] },
  { slug: "best-ai-tool-to-generate-music", tier: "open", traffic: 0, topics: ["ai music", "music generation", "generate music", "audio", "song"] },
  { slug: "best-ai-video-generators-for-long-videos", tier: "open", traffic: 0, topics: ["long video", "long form video", "ai video"] },
  { slug: "ai-tools", tier: "open", traffic: 0, topics: ["ai tools", "ai software", "generative ai", "ai", "creative tools", "design", "media"] },

  // ── Governed — offer only with §3.2 guardrails (comparison / alternatives / vs) — AI never auto-offers ──
  { slug: "pictory-ai-alternatives", tier: "governed", traffic: 108, topics: ["pictory", "video", "alternatives"] },
  { slug: "nightcafe-alternatives", tier: "governed", traffic: 78, topics: ["nightcafe", "image", "alternatives"] },
  { slug: "veo-3-alternatives", tier: "governed", traffic: 68, topics: ["veo", "video", "alternatives"] },
  { slug: "grok-alternative", tier: "governed", traffic: 61, topics: ["grok", "alternatives"] },
  { slug: "8-top-sora-ai-alternatives-to-consider-2025-review", tier: "governed", traffic: 45, topics: ["sora", "video", "alternatives"] },
  { slug: "midjourney-alternatives", tier: "governed", traffic: 40, topics: ["midjourney", "image", "alternatives"] },
  { slug: "dall-e-alternatives", tier: "governed", traffic: 16, topics: ["dall-e", "dalle", "image", "alternatives"] },
  { slug: "adobe-firefly-alternatives", tier: "governed", traffic: 10, topics: ["firefly", "adobe", "image", "alternatives"] },
  { slug: "leonardo-ai-alternatives", tier: "governed", traffic: 3, topics: ["leonardo", "image", "alternatives"] },
  { slug: "heygen-alternative", tier: "governed", traffic: 3, topics: ["heygen", "avatar", "video", "alternatives"] },
  { slug: "capcut-alternatives", tier: "governed", traffic: 2, topics: ["capcut", "video editing", "alternatives"] },
  { slug: "picsart-alternatives", tier: "governed", traffic: 1, topics: ["picsart", "photo", "alternatives"] },
  { slug: "invideo-alternatives", tier: "governed", traffic: 1, topics: ["invideo", "video", "alternatives"] },
  { slug: "hailuo-ai-alternatives", tier: "governed", traffic: 0, topics: ["hailuo", "video", "alternatives"] },
  { slug: "pixverse-ai-alternatives", tier: "governed", traffic: 0, topics: ["pixverse", "video", "alternatives"] },
  { slug: "google-flow-alternatives", tier: "governed", traffic: 0, topics: ["google flow", "flow", "video", "alternatives"] },
  { slug: "canva-alternatives", tier: "governed", traffic: 0, topics: ["canva", "design", "alternatives"] },
  { slug: "imagen-4-vs-midjourney", tier: "governed", traffic: 0, topics: ["imagen", "midjourney", "vs", "image"] },
  { slug: "hailuo-ai-vs-other-ai-video-generators", tier: "governed", traffic: 0, topics: ["hailuo", "vs", "video"] },
  { slug: "kling-ai-vs-other-ai-video-generators", tier: "governed", traffic: 0, topics: ["kling", "vs", "video"] },
  { slug: "pix-verse-vs-other-ai-video-generators", tier: "governed", traffic: 0, topics: ["pixverse", "vs", "video"] },
  { slug: "nano-banana-vs-other-ai-image-generation-models", tier: "governed", traffic: 0, topics: ["nano banana", "vs", "image"] },
  { slug: "higgsfield-vs-artlist-vs-imagineart", tier: "governed", traffic: 0, topics: ["higgsfield", "artlist", "vs", "video"] },

  // ── Off-table — not offered to competitors (idea / inspiration / how-to) ──
  { slug: "product-photography-ideas", tier: "offtable", traffic: 75, topics: ["product photography", "ideas"] },
  { slug: "instagram-reels-ideas", tier: "offtable", traffic: 66, topics: ["reels ideas", "instagram"] },
  { slug: "principles-of-design", tier: "offtable", traffic: 15, topics: ["principles of design", "design theory"] },
  { slug: "hair-color-ideas", tier: "offtable", traffic: 9, topics: ["hair color", "ideas"] },
  { slug: "podcast-logo-ideas", tier: "offtable", traffic: 9, topics: ["podcast logo", "ideas"] },
  { slug: "tiktok-ideas", tier: "offtable", traffic: 8, topics: ["tiktok ideas"] },
  { slug: "short-film-ideas", tier: "offtable", traffic: 7, topics: ["short film", "ideas"] },
  { slug: "product-design-trends", tier: "offtable", traffic: 6, topics: ["product design", "trends"] },
  { slug: "video-background-ideas", tier: "offtable", traffic: 6, topics: ["video background", "ideas"] },
  { slug: "book-cover-ideas", tier: "offtable", traffic: 5, topics: ["book cover", "ideas"] },
  { slug: "mascot-logo-ideas", tier: "offtable", traffic: 5, topics: ["mascot logo", "ideas"] },
];

// A link-back target: a page on our site we want the partner to link TO, plus a natural anchor.
// Defaults mirror the real winning threads in the sample data (they offered a link on one of our
// blogs and asked for a mention of ImagineArt + a link to /workflow). Editable in settings.
export interface LinkTarget { url: string; anchor: string; topics?: string[] }

export const DEFAULT_LINK_TARGETS: LinkTarget[] = [
  { url: "https://www.imagine.art/workflow", anchor: "AI creative workflow", topics: ["workflow", "video", "creative", "pipeline", "automation"] },
  { url: "https://www.imagine.art", anchor: "ImagineArt", topics: [] },
];

// One-paragraph internal brief the model follows for exchange offers. Kept human and short; the
// per-tier guardrails are enforced in code (we simply never auto-offer Governed/Restricted), so
// this is about TONE and WHAT to ask for, not the rules the code already guarantees.
export const DEFAULT_LINK_EXCHANGE_BRIEF =
  "Lead with a link exchange, no money. Offer to add the partner's link on one of our relevant blog " +
  "posts, and in return ask for a mention of ImagineArt with a link to one of our pages (a natural, " +
  "varied anchor, never the same exact-match phrase every time). Be specific about which post of ours " +
  "fits their coverage and why. Prefer a three-way (ABC) arrangement over a direct reciprocal swap once " +
  "a relationship exists. Keep it warm, concise, and human.";

// The partner-site quality bar (§6) and hard-nos (§8), surfaced so a human reviewing a handoff sees
// the same checklist the guidelines define. Not enforced automatically — advisory context.
export const QUALITY_BAR =
  "Partner bar: DR 50+ preferred (lower only with strong relevance + real traffic); genuine non-zero " +
  "traffic; same/adjacent niche (AI, design, media, marketing, tech); indexed; clean spam profile; " +
  "linking page not stuffed with unrelated outbound links.";

const STOP = new Set(["the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with", "best", "top", "ai", "app", "apps", "tool", "tools", "free", "vs", "review", "2024", "2025", "2026"]);

function tokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

// Score how well an Open page matches a free-text topic hint (the partner's coverage). Counts
// overlap between the hint's words and the page's topic keywords + slug words. Purely lexical and
// deterministic — no network, no model — so the selfcheck can assert it.
function scorePage(page: InventoryPage, hintTokens: Set<string>): number {
  if (hintTokens.size === 0) return 0;
  const pageWords = new Set<string>([...page.slug.split("-"), ...page.topics.flatMap((t) => t.split(/\s+/))].map((w) => w.toLowerCase()).filter((w) => w.length > 2 && !STOP.has(w)));
  let score = 0;
  for (const w of pageWords) if (hintTokens.has(w)) score += 1;
  // A full multi-word topic phrase appearing in the hint is a strong signal.
  return score;
}

export interface ExchangePick {
  // The page we can safely auto-offer (Open tier). Null when none is safe to auto-offer.
  page: InventoryPage | null;
  score: number;
  // When set, the agent must NOT auto-offer — hand to a human with this reason. Fires when the only
  // relevant page is Governed/Restricted (needs guardrails) or nothing relevant exists at all.
  handoffReason?: string;
}

// Pick the best OPEN page to offer for a partner's topic, excluding any pages already offered on
// this thread. Governed/Restricted matches never auto-offer — they escalate. Pure + deterministic.
export function pickExchangeOffer(
  topicHint: string,
  opts?: { excludeSlugs?: string[]; partnerBrand?: string | null },
): ExchangePick {
  const exclude = new Set((opts?.excludeSlugs ?? []).map((s) => s.replace(/^\/?blogs\//, "")));
  const hintTokens = new Set(tokens(`${topicHint} ${opts?.partnerBrand ?? ""}`));

  const open = INVENTORY.filter((p) => p.tier === "open" && !exclude.has(p.slug));
  const governed = INVENTORY.filter((p) => p.tier === "governed" && !exclude.has(p.slug));

  const rankedOpen = open
    .map((p) => ({ p, s: scorePage(p, hintTokens) }))
    .sort((a, b) => b.s - a.s || b.p.traffic - a.p.traffic);
  const bestOpen = rankedOpen[0];

  // A confident Open match — offer it.
  if (bestOpen && bestOpen.s > 0) return { page: bestOpen.p, score: bestOpen.s };

  // No Open match, but a Governed (comparison/alternatives) page is on-topic → needs guardrails → human.
  const bestGoverned = governed
    .map((p) => ({ p, s: scorePage(p, hintTokens) }))
    .sort((a, b) => b.s - a.s)[0];
  if (bestGoverned && bestGoverned.s > 0) {
    return { page: null, score: 0, handoffReason: `the most relevant page (/blogs/${bestGoverned.p.slug}) is a comparison/alternatives page that needs §3.2 guardrails — a person should decide` };
  }

  // Nothing scored. If we have never offered anything yet, fall back to our broadest Open page
  // (ai-tools / best-ai-video-generators) so a first offer still goes out; the copy stays generic.
  const fallback = open.find((p) => p.slug === "ai-tools") ?? open.find((p) => p.slug === "best-ai-video-generators") ?? open[0] ?? null;
  if (fallback) return { page: fallback, score: 0 };
  return { page: null, score: 0, handoffReason: "no topically relevant page left to offer for an exchange" };
}

// Pick the link-back target (a page of ours we want linked) best matching the partner's topic.
// Falls back to the first configured target (default /workflow). Pure.
export function pickLinkTarget(topicHint: string, targets: LinkTarget[]): LinkTarget {
  const list = targets.length ? targets : DEFAULT_LINK_TARGETS;
  const hintTokens = new Set(tokens(topicHint));
  let best = list[0];
  let bestScore = -1;
  for (const t of list) {
    const tks = new Set((t.topics ?? []).flatMap((x) => tokens(x)));
    let s = 0;
    for (const w of tks) if (hintTokens.has(w)) s += 1;
    if (s > bestScore) { bestScore = s; best = t; }
  }
  return best;
}
