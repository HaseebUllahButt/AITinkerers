// What the SEO work actually earned — signups, generations and revenue, attributed to the page a
// person first landed on and the source that first sent them.
//
// ── Three things measured on the live project before this was written ───────────────────────────
//
// 1. `$initial_referrer` is NOT set on the Purchase event. Breaking Purchase down by it returns a
//    single "undefined" bucket holding every purchase — a channel table that looks populated and says
//    nothing. Attribution has to come from the USER profile (`user["$initial_referring_domain"]`),
//    which is set for purchasers, and which also arrives as a clean host rather than a full URL.
//
// 2. Classifying by referring domain alone counts ads as SEO. Measured over 30 days: cpc = $813,601
//    and ppc = $38,348, ~$852k, and most of it carries `www.google.com` as its referring domain. A
//    "does the domain look like a search engine" test books all of that as organic revenue. So paid is
//    decided FIRST, from `user["initial_utm_medium"]`, and wins outright.
//
// 3. Not every google.com host is search. `accounts.google.com` ($14,498), `mail.google.com` and
//    `com.google.android.gm` are auth and mail; `googleads.g.doubleclick.net` is an ad network. A
//    `"google." in domain` test files all four under organic. They are excluded by name.
//
// The order of the ladder in `classify()` is load-bearing for all three, and `gemini.google.com`
// (real, $152) is why AI is checked before search.

import { segmentation, segmentationSum, daysAgo, type Segments } from "./client";

export const EVENT = {
  signup: "Signup Completed",
  purchase: "Purchase",
  generation: "Generation",
} as const;

/** The landing page a person first saw — an EVENT property, present on all three events. */
const PAGE = 'properties["first_page_view"]';
/** Attribution — USER profile properties. See note 1 above for why not the event property. */
const DOMAIN = 'user["$initial_referring_domain"]';
const UTM_MEDIUM = 'user["initial_utm_medium"]';
/** Revenue net of refunds and fees — the property the finance-facing Mixpanel board sums. */
const NET_AMOUNT = 'properties["net_amount"]';

export type Channel = "organic" | "ai" | "paid" | "direct" | "social" | "referral" | "internal" | "unattributed";

export const CHANNEL_LABEL: Record<Channel, string> = {
  organic: "Organic search",
  ai: "AI assistants",
  paid: "Paid",
  direct: "Direct",
  social: "Social",
  referral: "Other referral",
  internal: "Internal / auth",
  unattributed: "Unattributed",
};

/** utm_medium values that mean somebody paid for the click. Substring, not equality: one real value
 *  on this project is an entire mangled query string that merely CONTAINS `cpc`. */
const PAID_MEDIUMS = ["cpc", "ppc", "paid", "display", "retargeting"];
const AI_HOSTS = ["chatgpt.com", "chat.openai.com", "claude.ai", "perplexity.ai", "gemini.google.com",
  "copilot.microsoft.com", "you.com", "poe.com", "grok.com"];
/** Search-engine-shaped hosts that are not organic search — auth, webmail, ad serving. Checked before
 *  the search list, because every one of them would otherwise match it. */
const NOT_SEARCH = ["accounts.google.com", "mail.google.com", "com.google.android.gm",
  "googleads.g.doubleclick.net", "adsensecustomsearchads.com"];
const SEARCH_HOSTS = ["google.", "bing.com", "yahoo.com", "duckduckgo.com", "yandex.", "baidu.com",
  "ecosia.org", "search.brave.com", "startpage.com", "syndicatedsearch.goog", "googlequicksearchbox",
  "naver.com", "coccoc.com", "search.nortonsafesearch.com", "avastbrowser.com"];
const SOCIAL_HOSTS = ["facebook.com", "instagram.com", "youtube.com", "twitter.com", "t.co",
  "reddit.com", "linkedin.com", "tiktok.com", "pinterest.", "threads.com", "discord.com",
  "telegram.org", "quora.com", "medium.com", "vk.ru"];
/** Our own estate. A self-referral is not a channel — it is a person bouncing through auth or billing. */
const INTERNAL_HOSTS = ["northwind.example", "vyro.ai", "checkout.stripe.com", "app.link.com"];

/**
 * Which channel a (referring domain, utm_medium) pair belongs to.
 *
 * Pure and order-dependent — see the three measured notes at the top of the file. Paid before
 * everything, AI before search, non-search Google hosts before search, internal last so a self-referral
 * that carries no other signal still lands somewhere honest rather than in "other referral".
 */
export function classify(domain: string | null | undefined, utmMedium?: string | null): Channel {
  const m = (utmMedium ?? "").toLowerCase();
  if (m && m !== "undefined" && PAID_MEDIUMS.some((p) => m.includes(p))) return "paid";

  const r = (domain ?? "").toLowerCase().trim();
  if (!r || r === "undefined" || r === "null") return "unattributed";
  if (r === "$direct" || r === "direct") return "direct";
  if (AI_HOSTS.some((h) => r.includes(h))) return "ai";
  if (NOT_SEARCH.some((h) => r === h || r.endsWith(h))) return "internal";
  if (SEARCH_HOSTS.some((h) => r.includes(h))) return "organic";
  if (SOCIAL_HOSTS.some((h) => r.includes(h))) return "social";
  if (INTERNAL_HOSTS.some((h) => r.includes(h))) return "internal";
  return "referral";
}

const quoted = (xs: string[], expr: string) => xs.map((x) => `("${x}" in ${expr})`).join(" or ");

/** "Arrived from organic search, and not via an ad." Kept in sync with `classify()` by construction:
 *  same lists, same precedence, so the page-level table and the channel table cannot disagree. */
export function organicWhere(): string {
  return [
    `(${quoted(SEARCH_HOSTS, DOMAIN)})`,
    `not (${quoted(PAID_MEDIUMS, UTM_MEDIUM)})`,
    `not (${quoted(AI_HOSTS, DOMAIN)})`,
    `not (${quoted(NOT_SEARCH, DOMAIN)})`,
  ].join(" and ");
}

/** The channel the SEO team is actively trying to grow, and currently the smallest real one. */
export function aiWhere(): string {
  return `(${quoted(AI_HOSTS, DOMAIN)}) and not (${quoted(PAID_MEDIUMS, UTM_MEDIUM)})`;
}

export interface PageRoi {
  page: string;
  section: string;
  signups: number;
  purchases: number;
  revenue: number;
  generations: number;
  /** Purchases per signup, as a percentage. Null when there were no signups to divide by. */
  conversion: number | null;
}

export interface ChannelRoi {
  channel: Channel;
  label: string;
  purchases: number;
  revenue: number;
}

export interface RoiTotals {
  signups: number;
  purchases: number;
  revenue: number;
  generations: number;
  conversion: number | null;
  /** Mean revenue per purchase — says whether this traffic buys the cheap plan or the real one. */
  revenuePerPurchase: number | null;
}

export type Scope = "organic" | "ai" | "all";

export interface RoiReport {
  from: string;
  to: string;
  scope: Scope;
  totals: RoiTotals;
  pages: PageRoi[];
  channels: ChannelRoi[];
  notes: string[];
}

/** `/blogs/x` → `blogs`. The unit the SEO team plans in. */
function sectionOf(page: string): string {
  if (!page || page === "$overall" || page === "undefined") return "(none)";
  const seg = page.replace(/^\/+/, "").split("/")[0];
  return seg || "(root)";
}

function whereFor(scope: Scope): string | undefined {
  if (scope === "organic") return organicWhere();
  if (scope === "ai") return aiWhere();
  return undefined;
}

/**
 * The page-level ROI table plus the channel split, for one window.
 *
 * Six queries in parallel. Mixpanel segmentation is seconds per call, so serialising these is the
 * difference between a page that loads and a page people stop opening.
 */
export async function buildRoiReport(opts: { days?: number; scope?: Scope; limit?: number } = {}): Promise<RoiReport> {
  const days = opts.days ?? 30;
  const scope = opts.scope ?? "organic";
  const limit = opts.limit ?? 250;
  // to_date is yesterday: today is still accumulating and a half-day always reads as a crash.
  const from = daysAgo(days), to = daysAgo(1);
  const where = whereFor(scope);
  const notes: string[] = [];

  const [signups, purchases, revenue, generations, domainRevenue, domainPurchases, paidRevenue] = await Promise.all([
    segmentation({ event: EVENT.signup, from, to, on: PAGE, where, type: "unique", limit }),
    segmentation({ event: EVENT.purchase, from, to, on: PAGE, where, type: "unique", limit }),
    segmentationSum({ event: EVENT.purchase, from, to, on: PAGE, where, expression: NET_AMOUNT }),
    segmentation({ event: EVENT.generation, from, to, on: PAGE, where, type: "unique", limit }),
    // Channel split is deliberately unscoped — the point of that panel is the comparison, and
    // filtering to organic first would leave one bar.
    segmentationSum({ event: EVENT.purchase, from, to, on: DOMAIN, expression: NET_AMOUNT }),
    segmentation({ event: EVENT.purchase, from, to, on: DOMAIN, type: "unique", limit: 1000 }),
    // Paid cannot be derived from the domain breakdown (an ad click still reports google.com), so it
    // is measured on its own axis and folded in below.
    segmentationSum({ event: EVENT.purchase, from, to, on: UTM_MEDIUM, expression: NET_AMOUNT }),
  ]);

  const pages: PageRoi[] = [...new Set([
    ...Object.keys(signups), ...Object.keys(purchases), ...Object.keys(revenue), ...Object.keys(generations),
  ])]
    .filter((p) => p !== "$overall")
    .map((page) => {
      const s = signups[page] ?? 0;
      const p = purchases[page] ?? 0;
      return {
        page,
        section: sectionOf(page),
        signups: s,
        purchases: p,
        revenue: Math.round((revenue[page] ?? 0) * 100) / 100,
        generations: generations[page] ?? 0,
        conversion: s > 0 ? Math.round((p / s) * 10000) / 100 : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.signups - a.signups);

  // ── Channels ────────────────────────────────────────────────────────────────────────────────
  //
  // Two axes that overlap: the domain breakdown covers every purchase, and the utm_medium breakdown
  // identifies the paid subset hiding inside it. Paid revenue is taken from the medium axis and
  // subtracted from organic, rather than double-counted into both.
  const byChannel = new Map<Channel, ChannelRoi>();
  const add = (ch: Channel, field: "purchases" | "revenue", n: number) => {
    const row = byChannel.get(ch) ?? { channel: ch, label: CHANNEL_LABEL[ch], purchases: 0, revenue: 0 };
    row[field] += n;
    byChannel.set(ch, row);
  };
  for (const [domain, n] of Object.entries(domainRevenue)) {
    if (domain !== "$overall") add(classify(domain), "revenue", n);
  }
  for (const [domain, n] of Object.entries(domainPurchases)) {
    if (domain !== "$overall") add(classify(domain), "purchases", n);
  }
  const paidTotal = Object.entries(paidRevenue)
    .filter(([m]) => m !== "$overall" && PAID_MEDIUMS.some((p) => m.toLowerCase().includes(p)))
    .reduce((n, [, v]) => n + v, 0);
  if (paidTotal > 0) {
    const organic = byChannel.get("organic");
    // The ad click reported a search-engine domain, so its revenue is currently sitting in organic.
    const moved = Math.min(paidTotal, organic?.revenue ?? 0);
    if (organic) organic.revenue -= moved;
    add("paid", "revenue", paidTotal);
    notes.push(`$${Math.round(paidTotal).toLocaleString()} of revenue came from ads (utm_medium cpc/ppc) and has been moved out of organic — most ad clicks still report a search engine as their referring domain.`);
  }
  const channels = [...byChannel.values()]
    .map((c) => ({ ...c, revenue: Math.round(c.revenue * 100) / 100 }))
    .filter((c) => c.revenue > 0 || c.purchases > 0)
    .sort((a, b) => b.revenue - a.revenue);

  const totals = pages.reduce<RoiTotals>((t, p) => ({
    ...t,
    signups: t.signups + p.signups,
    purchases: t.purchases + p.purchases,
    revenue: t.revenue + p.revenue,
    generations: t.generations + p.generations,
  }), { signups: 0, purchases: 0, revenue: 0, generations: 0, conversion: null, revenuePerPurchase: null });
  totals.revenue = Math.round(totals.revenue * 100) / 100;
  totals.conversion = totals.signups > 0 ? Math.round((totals.purchases / totals.signups) * 10000) / 100 : null;
  totals.revenuePerPurchase = totals.purchases > 0 ? Math.round((totals.revenue / totals.purchases) * 100) / 100 : null;

  const unattributed = pages.find((p) => p.section === "(none)");
  if (unattributed?.revenue) {
    notes.push(`$${Math.round(unattributed.revenue).toLocaleString()} could not be attributed to a landing page — those users have no first_page_view recorded.`);
  }
  if (pages.length >= limit) {
    notes.push(`Showing the top ${limit} pages; Mixpanel aggregates the tail into $other.`);
  }

  return { from, to, scope, totals, pages, channels, notes };
}
