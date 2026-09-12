import { NextRequest, NextResponse } from "next/server";
import {
  HERMES_SOUL, HERMES_PROMPT_REVISION, buildHermesSystem, opsDirective, actionResultDirective,
  stripHermesDirectives, applyCacheBreakpoints, isCacheable, pendingToolUseIds,
} from "@/lib/hermes/prompt";
import { HERMES_TOOLS, HERMES_TOOL_NAMES, runHermesTool, numberEditorialRows } from "@/lib/hermes/tools";
import { ACTION_KINDS, validateActionParams, actionRequest } from "@/lib/hermes/confirm";
import { describeHermesTool } from "@/lib/hermes/steps";
import type { HermesAction, HermesActionKind } from "@/lib/db/queries";
import { nextNegotiationStep, normalizeStage } from "@/lib/negotiation/ladder";
import { pickExchangeOffer, pickLinkTarget } from "@/lib/negotiation/inventory";
import { DEFAULT_NEGOTIATION_SETTINGS } from "@/lib/negotiation/settings";
import { scorePartnerWorthiness, type PartnerSignals } from "@/lib/negotiation/worthiness";
import type { ReplyClassification } from "@/lib/negotiation/agent";
import { clipArticleText, openerPrompt, openerFallback } from "@/lib/backlinks/articleContext";
import { resolveInboxSender } from "@/lib/email/manualSender";
import { deliverOutreach, NO_SENDER_ERROR } from "@/lib/email/deliver";
import { getAdminEmails } from "@/lib/auth/admin";
import { classifyUnanswered, formatSlaSummary, isPricedReply, type UnansweredReply } from "@/lib/negotiation/sla";
import { validatePolicyPatch, BUILTIN_DEFAULT_POLICY } from "@/lib/automation/policy";

// GET /api/hermes/selfcheck?key=$CRON_SECRET — assertions over the pure helpers behind the Hermes
// agent, in the blog selfcheck's mould: this repo has no test framework, so this route is the
// automatable net. Refuses to run in production.
export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "selfcheck does not run in production" }, { status: 403 });
  }
  const key = req.nextUrl.searchParams.get("key");
  if (process.env.CRON_SECRET && key !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "bad key" }, { status: 401 });
  }

  const results: Array<{ group: string; name: string; pass: boolean; detail?: string }> = [];
  const check = (group: string, name: string, pass: boolean, detail?: string) =>
    results.push({ group, name, pass, ...(pass ? {} : { detail }) });

  // ── prompt: frozen + deterministic ──
  {
    const a = buildHermesSystem();
    const b = buildHermesSystem();
    check("prompt", "system is byte-deterministic", a[0].text === b[0].text && a.length === 1);
    check("prompt", "system block carries the 1h cache TTL",
      (a[0] as { cache_control?: { ttl?: string } }).cache_control?.ttl === "1h");
    // The soul may contain nothing dynamic: a stray template literal or date interpolation would
    // invalidate the cache on every request. Years appear only in prose, never as today's date.
    check("prompt", "soul has no leftover interpolation", !HERMES_SOUL.includes("${"));
    check("prompt", "soul does not embed a timestamp", !/\d{4}-\d{2}-\d{2}/.test(HERMES_SOUL));
  }

  // ── directives: injected machine text never reaches the display ──
  {
    const fakeAction: HermesAction = {
      id: "a", session_id: "s", kind: "publish_draft", summary: "Publish X", params: {},
      status: "executed", proposed_at: "", resolved_at: "", resolved_by: "someone@northwind.example",
      result: { http_status: 200 },
    };
    const ops = opsDirective({
      userEmail: "probe@northwind.example", isAdmin: false, overview: null, pendingActions: [fakeAction],
      now: new Date("2026-01-01T00:00:00Z"),
    });
    check("directives", "ops directive is wholly wrapped", ops.startsWith("<ops>") && ops.endsWith("</ops>"));
    check("directives", "ops directive strips to nothing", stripHermesDirectives(ops) === "");
    check("directives", "action result strips to nothing", stripHermesDirectives(actionResultDirective(fakeAction)) === "");
    check("directives", "unclosed directive tail is stripped", stripHermesDirectives("<ops>\nhalf a") === "");
    check("directives", "human text survives stripping",
      stripHermesDirectives("what needs my attention?") === "what needs my attention?");
    check("directives", "ops directive is deterministic given a fixed clock",
      ops === opsDirective({ userEmail: "probe@northwind.example", isAdmin: false, overview: null, pendingActions: [fakeAction], now: new Date("2026-01-01T00:00:00Z") }));
  }

  // ── tools: one frozen registry, fully labeled ──
  {
    check("tools", "registry has unique names", new Set(HERMES_TOOLS.map((t) => t.name)).size === HERMES_TOOLS.length);
    const unlabeled = HERMES_TOOLS.filter((t) => describeHermesTool(t.name, {}).label === t.name);
    check("tools", "every tool has a human label (no raw names in the UI)", unlabeled.length === 0,
      unlabeled.map((t) => t.name).join(", "));
    check("tools", "tool name set matches the registry", HERMES_TOOL_NAMES.size === HERMES_TOOLS.length);
    const propose = HERMES_TOOLS.find((t) => t.name === "propose_action");
    const kindEnum = (propose?.input_schema as { properties?: { kind?: { enum?: string[] } } })?.properties?.kind?.enum ?? [];
    check("tools", "propose_action's kind enum matches ACTION_KINDS",
      kindEnum.length === ACTION_KINDS.length && ACTION_KINDS.every((k) => kindEnum.includes(k)),
      `enum: ${kindEnum.join(",")}`);
    check("tools", "competitor flow tools are registered",
      HERMES_TOOL_NAMES.has("competitor_backlinks") && HERMES_TOOL_NAMES.has("add_prospects_from_urls") && HERMES_TOOL_NAMES.has("show_picker"));
    const numbered = numberEditorialRows(
      [{ url_from: "https://www.blog.example.com/blog/post", title: "T", domain_rating_source: 40, traffic_domain: 1, anchor: "a", first_seen: null, is_dofollow: true }],
      new Set(["blog.example.com"]));
    check("tools", "editorial rows number from 1, strip www and annotate the dedupe",
      numbered[0]?.n === 1 && numbered[0]?.domain === "blog.example.com" && numbered[0]?.already_prospect === true,
      JSON.stringify(numbered[0]));
    // Cross-campaign annotation: present when the other-campaign set is known, ABSENT (not false)
    // when it isn't — an unchecked collision must never read as checked-clean.
    const crossKnown = numberEditorialRows(
      [{ url_from: "https://blog.example.com/blog/post", title: "T", domain_rating_source: 40, traffic_domain: 1, anchor: "a", first_seen: null, is_dofollow: true }],
      new Set<string>(), new Set(["blog.example.com"]));
    check("tools", "cross-campaign flag set from the other-campaign host set",
      (crossKnown[0] as Record<string, unknown>)?.in_other_campaign === true, JSON.stringify(crossKnown[0]));
    check("tools", "cross-campaign flag omitted when the set is unknown",
      !("in_other_campaign" in (numbered[0] as Record<string, unknown>)), JSON.stringify(numbered[0]));
    check("prompt", "revision bumped for the competitor-flow tool-shape change", HERMES_PROMPT_REVISION >= 3);
  }

  // ── sourcing v2: the pure cores of intersect, scoring and email-name affinity ──
  {
    const { intersectReferringDomains } = await import("@/lib/backlinks/intersect");
    const { scoreBacklinkProspect } = await import("@/lib/backlinks/scoring");
    const { emailMatchesPerson } = await import("@/lib/enrich/nameAffinity");
    const b = (url: string, dr: number) => ({ url_from: url, title: "t", domain_rating_source: dr, traffic_domain: 1, anchor: "", first_seen: null, is_dofollow: true });
    const rows = intersectReferringDomains({
      "comp-a.com": [b("https://both.example/post", 40), b("https://only-a.example/post", 90), b("https://ours.example/post", 80)],
      "comp-b.com": [b("https://both.example/other", 55), b("https://strong.example/x", 70)],
      "comp-c.com": [b("https://strong.example/y", 70), b("https://both.example/third", 20)],
    }, new Set(["ours.example"]));
    check("sourcing", "intersect keeps only 2+ overlaps and excludes our linkers",
      rows.length === 2 && rows.every((r) => r.competitor_count >= 2) && !rows.some((r) => r.domain === "only-a.example" || r.domain === "ours.example"),
      JSON.stringify(rows.map((r) => r.domain)));
    check("sourcing", "intersect ranks by overlap count before DR",
      rows[0]?.domain === "both.example" && rows[0]?.competitor_count === 3 && rows[0]?.best.domain_rating_source === 55,
      JSON.stringify(rows[0]));
    const now = new Date("2026-01-01T00:00:00Z");
    const topical = scoreBacklinkProspect({ topic: "ai video generator", title: "Best AI video generator tools", dr: 60, firstSeen: "2025-10-01", now });
    const offTopic = scoreBacklinkProspect({ topic: "ai video generator", title: "Knitting patterns weekly", dr: 60, firstSeen: "2019-01-01", now });
    check("sourcing", "scoring prefers topical + recent over off-topic + stale",
      topical > offTopic && topical >= 0 && topical <= 100 && offTopic >= 0 && offTopic <= 100,
      `topical ${topical} vs off-topic ${offTopic}`);
    check("sourcing", "affinity rejects the eval round 1 mismatch",
      !emailMatchesPerson("caleb@vfx.city", "Tyler Smith", "curiousrefuge.com"));
    check("sourcing", "affinity accepts name and publication matches",
      emailMatchesPerson("tyler.smith@gmail.com", "Tyler Smith", "curiousrefuge.com") &&
      emailMatchesPerson("editorial-desk@curiousrefuge.com", "Tyler Smith", "www.curiousrefuge.com"));
    check("tools", "sourcing v2 tools are registered",
      HERMES_TOOL_NAMES.has("competitor_link_intersect") && HERMES_TOOL_NAMES.has("competitor_authors") && HERMES_TOOL_NAMES.has("sourcing_report"));
    check("prompt", "revision bumped for the sourcing v2 tool-shape change", HERMES_PROMPT_REVISION >= 6);
  }

  // ── the machine: policy bounds, trust floor, auto-pause, decay, channels, digest honesty ──
  {
    const { validatePolicyPatch, policyAllowsTrust, policyActive, shouldAutoPause } = await import("@/lib/automation/policy");
    check("machine", "policy patch bounds are enforced",
      validatePolicyPatch({ daily_cap: 0 }) !== null && validatePolicyPatch({ daily_cap: 501 }) !== null &&
      validatePolicyPatch({ min_trust: "vibes" }) !== null && validatePolicyPatch({ nonsense: true }) !== null &&
      validatePolicyPatch({}) !== null && validatePolicyPatch({ weekly_link_goal: 0 }) !== null);
    check("machine", "a valid patch passes",
      validatePolicyPatch({ enabled: true, daily_cap: 10, min_trust: "sourced", weekly_link_goal: 5, paused_reason: null }) === null);
    check("machine", "trust floor: 'verified' admits sourced+verified, never guesses",
      policyAllowsTrust("sourced", "verified") && policyAllowsTrust("verified", "verified") &&
      !policyAllowsTrust("guess", "verified") && !policyAllowsTrust("none", "verified"));
    check("machine", "trust floor: 'sourced' admits only directly-sourced addresses",
      policyAllowsTrust("sourced", "sourced") && !policyAllowsTrust("verified", "sourced"));
    check("machine", "a paused policy is inactive no matter what enabled says",
      !policyActive({ enabled: true, paused_reason: "bounce spike" }) && policyActive({ enabled: true, paused_reason: null }));
    check("machine", "auto-pause trips on a real bounce spike, not on noise",
      shouldAutoPause({ sent7d: 20, bounced7d: 8 }) !== null &&
      shouldAutoPause({ sent7d: 5, bounced7d: 5 }) === null &&
      shouldAutoPause({ sent7d: 20, bounced7d: 2 }) === null);
    check("confirm", "set_policy validates its patch at proposal time",
      validateActionParams("set_policy", { patch: { daily_cap: 9999 } }) !== null &&
      validateActionParams("set_policy", { patch: "not-an-object" }) !== null &&
      validateActionParams("set_policy", { patch: { daily_cap: 10, enabled: true } }) === null);

    const { decayDecision, contactChannel } = await import("@/lib/backlinks/pipeline");
    const now = Date.parse("2026-01-15T00:00:00Z");
    check("machine", "decay: fresh wins skip, stale wins re-check, non-wins always check",
      decayDecision({ linkLiveAt: "2026-01-10T00:00:00Z", linkCheckedAt: "2026-01-14T00:00:00Z", linkMisses: 0, cadenceDays: 7, now }) === "skip-fresh" &&
      decayDecision({ linkLiveAt: "2025-12-01T00:00:00Z", linkCheckedAt: "2026-01-01T00:00:00Z", linkMisses: 1, cadenceDays: 7, now }) === "recheck" &&
      decayDecision({ linkLiveAt: "2025-12-01T00:00:00Z", linkCheckedAt: null, linkMisses: 0, cadenceDays: 7, now }) === "recheck" &&
      decayDecision({ linkLiveAt: null, linkCheckedAt: null, linkMisses: 0, cadenceDays: 7, now }) === "check-new");
    check("machine", "channel derivation: email > whatsapp > form > linkedin > social > none",
      contactChannel(["mailto", "whatsapp"]) === "email" && contactChannel(["whatsapp", "form"]) === "whatsapp" &&
      contactChannel(["form", "linkedin"]) === "form" && contactChannel(["linkedin", "twitter"]) === "linkedin" &&
      contactChannel(["twitter"]) === "social" && contactChannel([]) === "none");

    // WhatsApp channel helpers (082). Pure, so the number a person pastes and the link a page
    // carries can be asserted to land as the same canonical value — a mangled number here means
    // a human opens a chat with a stranger.
    const { normalizeWaNumber, waLink, clampWaNote } = await import("@/lib/email/whatsappNote");
    check("machine", "wa numbers: formatting stripped, 00/+ prefixes dropped, junk rejected",
      normalizeWaNumber("+1 (555) 010-2030") === "15550102030" &&
      normalizeWaNumber("00923001234567") === "923001234567" &&
      normalizeWaNumber("12345") === null && normalizeWaNumber("") === null);
    check("machine", "wa numbers: percent-escapes never inject digits (%2B is a +, not a 2)",
      normalizeWaNumber("https://wa.me/%2B923001234567") === "923001234567");
    check("machine", "wa link: canonical wa.me, message prefilled only when given",
      waLink("+1 555 010 2030", "hi there") === "https://wa.me/15550102030?text=hi%20there" &&
      waLink("+1 555 010 2030") === "https://wa.me/15550102030" && waLink("nope") === null);
    check("machine", "wa note clamp: AI dashes stripped, oversize cut at a word",
      clampWaNote("a — b") === "a, b" && clampWaNote("x".repeat(600)).length <= 451);

    // WhatsApp vendor-thread helpers (085). The parser is deterministic-first ON PURPOSE — a
    // paste filed under the wrong side poisons every draft grounded on the thread, so everything
    // that can be asserted without a model is asserted here.
    const wt = await import("@/lib/email/whatsappThread");
    check("machine", "wa export timestamps: day-first default, US month-first flip, AM/PM, UTC-stable",
      wt.parseWaTimestamp("22/08/26", "14:03") === "2026-08-22T14:03:00.000Z" &&
      wt.parseWaTimestamp("8/22/26", "2:03", "PM") === "2026-08-22T14:03:00.000Z" &&
      wt.parseWaTimestamp("2026-08-22", "12:15", "AM") === "2026-08-22T00:15:00.000Z" &&
      wt.parseWaTimestamp("99/99/99", "14:03") === null);
    {
      const ios = wt.parseWaExport("[22/08/2026, 14:03:11] Ali Vendor: rate kya hai\n[22/08/2026, 14:05:00] Waleed: 40 usd\naur TAT?");
      const android = wt.parseWaExport("22/08/26, 14:03 - Ali: salam\n22/08/26, 14:04 - Messages and calls are end-to-end encrypted.\n22/08/26, 14:05 - Ali: rate list bhejta hun");
      check("machine", "wa export parse: both dialects, continuations attached, system notices dropped",
        ios?.messages.length === 2 && ios.senders.length === 2 && ios.messages[1].body === "40 usd\naur TAT?" &&
        android?.messages.length === 2 && android.senders.join(",") === "Ali");
      check("machine", "wa export parse: freeform text is NOT mistaken for an export",
        wt.parseWaExport("bhai rate kya hai aaj kal ka?") === null);
      check("machine", "wa vendor matching: containment both ways, ambiguity refuses (never guesses)",
        wt.matchVendorSender(["Ali Guest Post", "Waleed"], "Ali") === "Ali Guest Post" &&
        wt.matchVendorSender(["Ali", "Ali Backup"], "Ali") === null &&
        wt.matchVendorSender(["Someone Else", "Waleed"], "Ali") === null);
    }
    check("machine", "wa reply shaping: dashes stripped, whitespace collapsed, never truncated",
      wt.shapeWaReply("theek hai — 40 pe final\n\n\n\nkal bhejo") === "theek hai, 40 pe final\n\nkal bhejo");
    // 095. The negotiator greeted a vendor the team knows as Ali Ahmed with "Hello Katie" because
    // "Katie Grose" is the display name on his own WhatsApp profile. A name is usable to someone's
    // face only once a person confirmed it — no fallback, no inference.
    // A phone-book entry is filed, not addressed: "ali Ahmed Vendor" is the right contact label and
    // the wrong thing to greet someone with.
    check("machine", "wa name tidying: filing tags trimmed, real names never mangled",
      wt.tidyPersonName("ali Ahmed Vendor") === "Ali Ahmed" &&
      wt.tidyPersonName("Umer SEO 2") === "Umer" &&
      wt.tidyPersonName("Shahid guest post") === "Shahid" &&
      wt.tidyPersonName("vendor Touheed bhai") === "Touheed" &&
      wt.tidyPersonName("Katie Grose") === "Katie Grose" &&
      wt.tidyPersonName("us marketing") === "Us marketing" &&
      wt.tidyPersonName("Guest Post Vendor") === "" &&
      wt.tidyPersonName("  ") === "");
    check("machine", "wa naming: unconfirmed pushnames are never addressable, placeholders never are",
      wt.addressableName({ name: "Katie Grose", name_confirmed: false }) === null &&
      wt.addressableName({ name: "us marketing" }) === null &&
      wt.addressableName({ name: "Katie Grose", name_confirmed: true }) === "Katie Grose" &&
      wt.addressableName({ name: "WhatsApp +923438658088", name_confirmed: true }) === null &&
      wt.addressableName({ name: "  ", name_confirmed: true }) === null);
    {
      // The rule has to survive into the instruction the model actually receives, which is where
      // "Hello Katie" was born. Asserted on the prompt string, not on a model round trip.
      const transcript = [{ direction: "inbound" as const, body: "kisay hai ap" }];
      const anon = wt.waDraftPrompt({ vendorName: null, transcript });
      const named = wt.waDraftPrompt({ vendorName: "Ali Ahmed", transcript });
      check("machine", "wa draft prompt: no vouched name means no name reaches the model",
        !anon.includes("Katie") && anon.includes("Do NOT address them by name") &&
        anon.includes("to a backlink vendor we already work with") &&
        named.includes("to Ali Ahmed, a backlink vendor") &&
        named.includes("You may address them as Ali Ahmed") &&
        !named.includes("Do NOT address them by name"));
    }

    // The language axis rides the same allowlist contract as the tones (see pitchTones.ts).
    const langs = await import("@/lib/email/pitchTones");
    check("machine", "pitch langs: allowlisted ids resolve, unknown ids degrade to null",
      langs.isPitchLang("roman_ur") && !!langs.langDirective("roman_ur") && langs.langLabel("roman_ur") === "Roman Urdu" &&
      !langs.isPitchLang("urdu") && langs.langDirective("urdu") === null);

    // Cloud API helpers (086): the webhook's gate and the send path's window logic.
    const cloud = await import("@/lib/whatsapp/cloudApi");
    {
      const { createHmac } = await import("crypto");
      const body = '{"entry":[]}';
      const good = "sha256=" + createHmac("sha256", "s3cret").update(body, "utf8").digest("hex");
      check("machine", "wa webhook signature: valid HMAC passes, everything else refuses",
        cloud.verifyWaSignature(body, good, "s3cret") &&
        !cloud.verifyWaSignature(body + " ", good, "s3cret") &&
        !cloud.verifyWaSignature(body, good, "wrong") &&
        !cloud.verifyWaSignature(body, "sha256=zz", "s3cret") &&
        !cloud.verifyWaSignature(body, null, "s3cret") &&
        !cloud.verifyWaSignature(body, good, null));
      const now = Date.parse("2026-08-22T12:00:00Z");
      check("machine", "wa service window: 24h rolling from their last inbound, junk closed",
        cloud.serviceWindowOpen("2026-08-22T11:00:00Z", now) &&
        !cloud.serviceWindowOpen("2026-08-21T11:59:00Z", now) &&
        !cloud.serviceWindowOpen(null, now) && !cloud.serviceWindowOpen("not a date", now));
    }

    // Negotiator extraction + Roman Urdu heuristics (pure layer under the LLM classifier).
    const wn = await import("@/lib/whatsapp/negotiator");
    check("machine", "wa price extraction: $/usd/Rs/pkr/hazar resolved, bare 5k stays currencyless",
      JSON.stringify(wn.extractWaPrice("$40 per post")) === '{"amount":40,"currency":"USD"}' &&
      JSON.stringify(wn.extractWaPrice("45 usd final")) === '{"amount":45,"currency":"USD"}' &&
      JSON.stringify(wn.extractWaPrice("Rs 5,000 hoga")) === '{"amount":5000,"currency":"PKR"}' &&
      JSON.stringify(wn.extractWaPrice("8000 pkr")) === '{"amount":8000,"currency":"PKR"}' &&
      JSON.stringify(wn.extractWaPrice("5 hazar lagenge")) === '{"amount":5000,"currency":"PKR"}' &&
      JSON.stringify(wn.extractWaPrice("5k mein ho jayega")) === '{"amount":5000,"currency":null}' &&
      wn.extractWaPrice("koi rate nahi") === null);
    check("machine", "wa price extraction: every figure in a message, not just the first",
      // Our own counters name two numbers, theirs and ours; reading only the first is how the
      // negotiator forgot what it had already offered.
      JSON.stringify(wn.extractWaPrices("Bratgen pe 80$ note kar liya, par 60-65$ bana dein").map((p) => p.amount)) === "[80,65]" &&
      JSON.stringify(wn.extractWaPrices("75-80$ pe kar dein").map((p) => p.amount)) === "[80]" &&
      JSON.stringify(wn.extractWaPrices("Rs 5000 ya 40$").map((p) => `${p.amount}${p.currency}`)) === '["5000PKR","40USD"]' &&
      wn.extractWaPrices("koi rate nahi").length === 0 &&
      // Drift guard: the plural reader is built on the singular one and must agree with it.
      JSON.stringify(wn.extractWaPrices("$40 per post")[0]) === JSON.stringify(wn.extractWaPrice("$40 per post")));
    {
      // The production incident this rule exists for, replayed. We offered 80, the vendor wrote
      // "bratgen.io 80$ ok for this site", and the negotiator answered "80$ note kar liya, par
      // 60-65$ bana dein" — then undercut the 65 they conceded. Their price finished HIGHER than
      // where it started. Both moves must now be refused.
      const thread = [
        { direction: "inbound", body: "https://bratgen.io 100$ gp" },
        { direction: "outbound", body: "75-80$ pe kar dein? Hum regularly orders bhej rahe hain" },
        { direction: "inbound", body: "https://tomoson.com 140$ link insertion" },
        { direction: "outbound", body: "Tomoson pe 105-110$ kar dein, link insertion ke liye ye reasonable hai" },
      ];
      const ours = wn.pricesWeNamed(thread);
      const met = (t: string) => wn.vendorMetOurNumber(wn.extractWaPrice(t), ours);
      check("machine", "wa haggling: a price we already offered is an acceptance, never a counter",
        // Undercut #1: they take our own 80.
        met("https://bratgen.io 80$ ok for this site") &&
        // Undercut #2: 65 was on our table in the message that made it.
        wn.vendorMetOurNumber(wn.extractWaPrice("bratgen.io 65$ if you send consistently orders"),
          wn.pricesWeNamed(thread.concat([{ direction: "outbound", body: "Bratgen pe 80$ note kar liya, par 60-65$ bana dein" }]))) &&
        // Anything under our lowest offer is acceptance too — nobody haggles a better price.
        met("50$ final") &&
        // Still above every number we named: countering is legitimate.
        !met("https://tomoson.com 140$ link insertion") &&
        // Nothing offered yet, so nothing to be bound by.
        !wn.vendorMetOurNumber(wn.extractWaPrice("100$ gp"), []) &&
        // Currencies are not interchangeable: 80 PKR does not meet an 80 USD offer.
        !wn.vendorMetOurNumber({ amount: 80, currency: "PKR" }, [{ amount: 80, currency: "USD" }]));
      check("machine", "wa haggling: our own offers are counted, theirs are not",
        JSON.stringify(ours.map((p) => p.amount)) === "[80,110]");
    }
    check("machine", "wa heuristics: strong cues park, agree/decline/quote read through Roman Urdu",
      wn.classifyWaHeuristic("bhai ye scam lag raha hai").intent === "needs_human" &&
      wn.classifyWaHeuristic("advance easypaisa kar dein").intent === "needs_human" &&
      wn.classifyWaHeuristic("nahi ho sakta itne mein").intent === "decline" &&
      wn.classifyWaHeuristic("done bhai pakka").intent === "agree" &&
      wn.classifyWaHeuristic("45 usd final hai").intent === "price_quote" &&
      wn.classifyWaHeuristic("TAT kitna hoga?").intent === "question");
    check("machine", "wa email capture from chat",
      wn.extractEmail("meri email ali.seo@gmail.com pe bhej dein") === "ali.seo@gmail.com" &&
      wn.extractEmail("koi email nahi") === null);

    // WAHA bridge helpers (087): chatId round-trip, id normalization, and the shared-token gate.
    const br = await import("@/lib/whatsapp/bridge");
    // The phone's address book is the name the team actually uses; the pushname is the vendor's
    // own claim about themselves. Field precedence is asserted here because WAHA's contact shape
    // varies by engine and there is no bridge to try it against outside production.
    check("machine", "wa contact name: address book wins, the vendor's own profile name never counts",
      br.bridgeContactSavedName({ name: "ali Ahmed Vendor", pushname: "Katie Grose" }) === "ali Ahmed Vendor" &&
      br.bridgeContactSavedName([{ shortName: "Ali", pushname: "Katie Grose" }]) === "Ali" &&
      br.bridgeContactSavedName({ pushname: "Katie Grose" }) === null &&
      br.bridgeContactSavedName({ name: "   " }) === null &&
      br.bridgeContactSavedName(null) === null && br.bridgeContactSavedName("nope") === null);
    check("machine", "bridge chatId: digits <-> @c.us round-trip, groups/junk rejected",
      br.bridgeChatId("923001234567") === "923001234567@c.us" &&
      br.digitsFromChatId("923001234567@c.us") === "923001234567" &&
      br.digitsFromChatId("12300@g.us") === null && br.digitsFromChatId("") === null &&
      br.isIndividualChat("923001234567@c.us") && !br.isIndividualChat("120363@g.us"));
    // LID addressing: real inbound arrives as "<lid>@lid" and MUST be treated as a direct chat
    // (else every vendor message is silently skipped — the 2026-08-24 outage) while never being
    // mistaken for a phone number (a 15-digit LID passes the E.164 length check).
    check("machine", "bridge LID: recognized as direct, never read as a phone number",
      br.isLidChat("256126767611962@lid") && !br.isLidChat("923001234567@c.us") &&
      br.isDirectChat("256126767611962@lid") && br.isDirectChat("923001234567@c.us") &&
      !br.isDirectChat("120363001@g.us") && !br.isDirectChat("status@broadcast") &&
      !br.isIndividualChat("256126767611962@lid"));
    // Media messages. A caption-less screenshot of a rate card used to be dropped outright — the
    // ingest wanted non-empty text — so the thread quietly lost what the vendor actually sent.
    // Known media types get a label; protocol events with empty bodies still get nothing, because
    // filing those would feed noise to the negotiator as if the vendor had spoken.
    check("machine", "bridge media: caption wins, empty media labeled, protocol events dropped",
      br.bridgeMessageBody("rates attached", "image") === "rates attached" &&
      br.bridgeMessageBody("", "image") === "[image received on WhatsApp]" &&
      br.bridgeMessageBody("   ", "ptt") === "[ptt received on WhatsApp]" &&
      br.bridgeMessageBody("", "e2e_notification") === "" &&
      br.bridgeMessageBody(null, "chat") === "" &&
      br.bridgeMediaType({ type: "image", media: { mimetype: "image/jpeg" } }) === "image/jpeg" &&
      br.bridgeMediaType({ type: "sticker" }) === "sticker" &&
      br.bridgeMediaType({ type: "chat" }) === null && br.bridgeMediaType(null) === null);
    // Vendor-chat ownership (094). One number serves the whole team, so the filter that carves a
    // person's chats out of the shared list is what makes the page usable — and an unowned chat
    // must never fold into somebody's "mine", or every stranger who messages the number silently
    // becomes their problem.
    const ow = await import("@/lib/whatsapp/owners");
    check("machine", "vendor owner filter: mine/unassigned/everyone/teammate, case-insensitive",
      ow.chatMatchesOwner(ow.OWNER_ALL, null, "me@x.com") &&
      ow.chatMatchesOwner(ow.OWNER_ALL, "other@x.com", "me@x.com") &&
      ow.chatMatchesOwner(ow.OWNER_UNASSIGNED, null, "me@x.com") &&
      !ow.chatMatchesOwner(ow.OWNER_UNASSIGNED, "me@x.com", "me@x.com") &&
      ow.chatMatchesOwner(ow.OWNER_MINE, "ME@x.com", "me@x.com") &&
      !ow.chatMatchesOwner(ow.OWNER_MINE, null, "me@x.com") &&
      !ow.chatMatchesOwner(ow.OWNER_MINE, "other@x.com", "me@x.com") &&
      !ow.chatMatchesOwner(ow.OWNER_MINE, "me@x.com", null) &&
      ow.chatMatchesOwner("arham@x.com", "ARHAM@x.com", "me@x.com") &&
      !ow.chatMatchesOwner("arham@x.com", null, "me@x.com"));
    check("machine", "bridge id normalization: string, {_serialized}, {id}, junk",
      br.normalizeWaId("true_92300@c.us_ABC") === "true_92300@c.us_ABC" &&
      br.normalizeWaId({ _serialized: "X_1" }) === "X_1" &&
      br.normalizeWaId({ id: "Y_2" }) === "Y_2" &&
      br.normalizeWaId(null) === null && br.normalizeWaId(42) === null);
    {
      const saved = process.env.WHATSAPP_BRIDGE_SECRET;
      process.env.WHATSAPP_BRIDGE_SECRET = "brdg-secret";
      const passOk = br.verifyBridgeToken("brdg-secret");
      const failWrong = br.verifyBridgeToken("nope");
      const failEmpty = br.verifyBridgeToken(null);
      if (saved === undefined) delete process.env.WHATSAPP_BRIDGE_SECRET; else process.env.WHATSAPP_BRIDGE_SECRET = saved;
      const noSecret = br.verifyBridgeToken("anything"); // secret restored to original (probably unset)
      check("machine", "bridge token: exact match passes, wrong/empty refuse, unset refuses all",
        passOk && !failWrong && !failEmpty && (saved ? true : !noSecret));
    }

    const { formatAutomationSection } = await import("@/lib/digest/daily");
    const quiet = formatAutomationSection({ runs: [], needsHuman: [], formOnlyReady: 0 });
    check("machine", "a missing heartbeat renders as an alarm, not as silence",
      quiet.some((l) => l.includes("no nightly heartbeat")));
    const busy = formatAutomationSection({
      runs: [
        { scope: "backlinks-cron", workflow_id: null, result: {}, anomalies: [] },
        { scope: "backlinks-cron", workflow_id: "w1", result: { campaign: "/x", drafted: 2, lost: 1 }, anomalies: ["auto-paused: bounce spike"] },
        { scope: "autopilot", workflow_id: "w1", result: { scheduled: 5 }, anomalies: [] },
        { scope: "send-processor", workflow_id: null, result: { sent: 4 }, anomalies: [] },
      ],
      needsHuman: [{ who: "editor@site.com", ask: "wants an invoice" }],
      formOnlyReady: 3,
    });
    const text = busy.join("\n");
    check("machine", "the digest section reports drafts, losses, queue, sends, asks and form pitches",
      text.includes("2 pitches drafted") && text.includes("1 link LOST") && text.includes("queued 5") &&
      text.includes("sent 4") && text.includes("wants an invoice") && text.includes("3 paste-ready"), text);

    const { patternFromHunter } = await import("@/lib/enrich/patternInfer");
    check("machine", "Hunter's pattern grammar seeds our pattern table",
      patternFromHunter("{first}.{last}")?.format("Jane van der Berg") === "jane.berg" &&
      patternFromHunter("{f}{last}")?.format("Jane Berg") === "jberg" &&
      patternFromHunter("{unknown}") === null && patternFromHunter(null) === null);
  }

  // ── zero-unit prospecting: footprint queries, row shaping, mention classifier ──
  {
    const { buildFootprintQueries, shapeLinkPageRows } = await import("@/lib/sourcing/linkPages");
    const q = buildFootprintQueries("ai video", "guest_post", 2026);
    check("prospecting", "guest-post footprints carry the write-for-us pattern and the topic",
      q.some((s) => s.includes("write for us")) && q.every((s) => s.includes("ai video")));
    const shaped = shapeLinkPageRows([
      [{ url: "https://a.example/list", title: "A", snippet: "" }, { url: "https://www.youtube.com/watch?v=1", title: "drop me", snippet: "" }],
      [{ url: "https://a.example/list", title: "A", snippet: "" }, { url: "https://b.example/best", title: "B", snippet: "" }],
    ], 10);
    check("prospecting", "shaping dedupes per domain, drops platforms, ranks by corroboration",
      shaped.length === 2 && shaped[0]?.url === "https://a.example/list" && shaped[0]?.hits === 2 &&
      !shaped.some((r) => r.domain.includes("youtube")), JSON.stringify(shaped));
    const { htmlLinksToUs } = await import("@/lib/sourcing/mentions");
    check("prospecting", "mention classifier sees our link, and a mere text mention is not one",
      htmlLinksToUs('<p>x</p><a href="https://www.northwind.example/ai-video">y</a>') === true &&
      htmlLinksToUs('<a href="https://other.example">northwind.example is great</a>') === false);
    check("tools", "machine + prospecting tools are registered",
      HERMES_TOOL_NAMES.has("automation_status") && HERMES_TOOL_NAMES.has("find_link_pages") && HERMES_TOOL_NAMES.has("find_unlinked_mentions"));
    check("prompt", "revision bumped for the autonomy tool-shape change", HERMES_PROMPT_REVISION >= 7);
  }

  // ── domain address book: the hunter.io-parity merge is pure ──
  {
    const { mergeDomainEmails } = await import("@/lib/sourcing/domainEmails");
    const merged = mergeDomainEmails(
      [
        { email: "info@petapixel.com", firstName: null, lastName: null, position: null, type: "generic", confidence: 90 },
        { email: "matt@petapixel.com", firstName: "Matt", lastName: "Growcoot", position: "Senior Editor", type: "personal", confidence: 98 },
      ],
      ["mailto:matt@petapixel.com", "tips@petapixel.com", "user@domain.com"],
    );
    check("addressbook", "index + page merge: dedupe, named-human-first, placeholder dropped",
      merged.length === 3 && merged[0]?.email === "matt@petapixel.com" && merged[0]?.found_by === "both" &&
      merged[0]?.name === "Matt Growcoot" && !merged.some((r) => r.email === "user@domain.com"),
      JSON.stringify(merged));
    check("addressbook", "a bare scraped role address labels as generic",
      merged.find((r) => r.email === "tips@petapixel.com")?.kind === "generic" &&
      merged.find((r) => r.email === "tips@petapixel.com")?.found_by === "page-scrape");
    check("tools", "address-book tools are registered",
      HERMES_TOOL_NAMES.has("domain_emails") && HERMES_TOOL_NAMES.has("add_prospects_with_emails"));
    check("prompt", "revision bumped for the address-book tool-shape change", HERMES_PROMPT_REVISION >= 8);
    check("tools", "pitch editing is registered", HERMES_TOOL_NAMES.has("edit_pitches"));
    check("prompt", "revision bumped for the pitch-editing tool-shape change", HERMES_PROMPT_REVISION >= 9);
    const emptyEdit = await runHermesTool("edit_pitches", { edits: [] }, { sessionId: "s", userEmail: "probe@northwind.example" });
    check("tools", "edit_pitches refuses an empty edit list as a tool error", emptyEdit.is_error === true);
  }

  // ── mailbox verification: the outcome mapping never blames an address for the verifier ──
  {
    const { normalizeEmailList, mapVerifyOutcome } = await import("@/lib/enrich/verifyBulk");
    const norm = normalizeEmailList([" MAILTO:Jane@Site.com ", "jane@site.com", "not-an-email", "b@c.d", ""]);
    check("verify", "emails normalize, dedupe, and count (not swallow) malformed input",
      norm.emails.length === 2 && norm.emails[0] === "jane@site.com" && norm.dropped === 1 && norm.truncated === 0,
      JSON.stringify(norm));
    const capped = normalizeEmailList(Array.from({ length: 60 }, (_, i) => `a${i}@x.com`));
    check("verify", "the batch caps at 50 and REPORTS the overflow",
      capped.emails.length === 50 && capped.truncated === 10, JSON.stringify({ n: capped.emails.length, truncated: capped.truncated }));
    check("verify", "a missing verifier maps to unchecked, never to invalid",
      mapVerifyOutcome(null, "out of credits").verdict === "unchecked" &&
      mapVerifyOutcome(null, null).verdict === "unchecked" &&
      /out of credits/.test(mapVerifyOutcome(null, "out of credits").detail));
    check("verify", "verdicts map honestly (unknown/role stay inconclusive, not dead)",
      mapVerifyOutcome({ safe: true, catchAll: false, score: 99, status: "safe" }, null).verdict === "safe" &&
      mapVerifyOutcome({ safe: false, catchAll: true, score: 0, status: "catch_all" }, null).verdict === "catch_all" &&
      mapVerifyOutcome({ safe: false, catchAll: false, score: 0, status: "invalid" }, null).verdict === "invalid" &&
      mapVerifyOutcome({ safe: false, catchAll: false, score: 0, status: "disposable" }, null).verdict === "invalid" &&
      mapVerifyOutcome({ safe: false, catchAll: false, score: 40, status: "unknown" }, null).verdict === "inconclusive" &&
      mapVerifyOutcome({ safe: false, catchAll: false, score: 0, status: "role_account" }, null).verdict === "inconclusive");
    check("verify", "a probe the host refused is inconclusive, and says so",
      mapVerifyOutcome({ safe: false, catchAll: false, score: 0, status: "probe_refused", provider: "smtp" }, null).verdict === "inconclusive" &&
      /refused our probe/.test(mapVerifyOutcome({ safe: false, catchAll: false, score: 0, status: "probe_refused" }, null).detail));
    check("verify", "the answering route is named in the detail",
      / \(via smtp\)$/.test(mapVerifyOutcome({ safe: true, catchAll: false, score: 95, status: "safe", provider: "smtp" }, null).detail));
  }

  // ── free verification routes: the measured false-invalid trap must never reopen ──
  {
    const { classifySmtpReply, foldSmtpOutcomes, mailProviderFromMx, mapMicrosoftResult } =
      await import("@/lib/enrich/verifyFree");

    // Real replies captured from real hosts on 2026-08-26. The middle two are the whole point:
    // both are 550s that are about OUR IP reputation, not the recipient.
    check("verify-free", "550 5.1.1 NoSuchUser is a real answer about the mailbox",
      classifySmtpReply(550, "550 5.1.1 https://support.google.com/mail/?p=NoSuchUser - gsmtp") === "no-such-mailbox");
    check("verify-free", "a Spamhaus/PBL 550 is a refused PROBE, not a bad address",
      classifySmtpReply(550, "550 zen.mimecast.org Listed by PBL, see https://check.spamhaus.org/query/ip/1.2.3.4") === "probe-refused");
    check("verify-free", "a 5.7.1 'client host blocked' is a refused PROBE, not a bad address",
      classifySmtpReply(550, "550 5.7.1 Service unavailable, Client host [1.2.3.4] blocked using Spamhaus") === "probe-refused");
    check("verify-free", "250 is an acceptance and 4xx is always transient",
      classifySmtpReply(250, "250 2.1.5 OK") === "accepted" &&
      classifySmtpReply(451, "451 4.7.1 Greylisted, try again later") === "probe-refused" &&
      classifySmtpReply(252, "252 cannot VRFY user") === "unclear");

    // An acceptance means nothing until the control address has been REFUSED — this is what caught
    // theverge.com and northwind.example, both of which accept every address.
    check("verify-free", "target accepted + control accepted = catch-all, never safe",
      foldSmtpOutcomes("accepted", "accepted", "smtp").catchAll === true &&
      foldSmtpOutcomes("accepted", "accepted", "smtp").safe === false);
    check("verify-free", "target accepted + control refused = safe",
      foldSmtpOutcomes("accepted", "no-such-mailbox", "smtp").safe === true);
    check("verify-free", "a refused probe never becomes invalid",
      foldSmtpOutcomes("probe-refused", "probe-refused", "smtp").status === "probe_refused" &&
      foldSmtpOutcomes("probe-refused", "probe-refused", "smtp").safe === false);
    check("verify-free", "target rejected + control rejected = invalid",
      foldSmtpOutcomes("no-such-mailbox", "no-such-mailbox", "smtp").status === "invalid");

    check("verify-free", "MX routing recognises the platforms we measured",
      mailProviderFromMx(["microsoft-com.mail.protection.outlook.com"]) === "microsoft" &&
      mailProviderFromMx(["aspmx.l.google.com"]) === "google" &&
      mailProviderFromMx(["us-smtp-inbound-1.mimecast.com"]) === "mimecast" &&
      mailProviderFromMx([]) === "none");

    check("verify-free", "Microsoft IfExistsResult maps 0=exists / 1=absent / other=unknown",
      mapMicrosoftResult(0, 0).safe === true &&
      mapMicrosoftResult(1, 0).status === "invalid" &&
      mapMicrosoftResult(5, 0).status === "unknown" &&
      mapMicrosoftResult(0, 2).status === "probe_refused");
  }

  // ── free authority signals: DR is corroborated, and an UNCHECKED domain is never "clean" ──
  {
    const { assessSpamRisk, domainAgeYears } = await import("@/lib/score/spamRisk");
    const { registrationFromRdap } = await import("@/lib/enrich/domainSignals");
    const { qualifyProspect } = await import("@/lib/score/qualify");
    const NOW = new Date("2026-08-26T00:00:00Z");

    check("signals", "domain age is null when unknown, never 0",
      domainAgeYears(null, NOW) === null && domainAgeYears("nonsense", NOW) === null &&
      Math.round(domainAgeYears("1998-04-29", NOW)!) === 28);
    check("signals", "a domain we never checked is 'unknown', not 'none'",
      assessSpamRisk({ dr: 55, now: NOW }).level === "unknown");
    check("signals", "no DR means no authority claim to contradict",
      assessSpamRisk({ dr: null, registeredOn: "2026-01-01", now: NOW }).level === "unknown");
    check("signals", "high DR on a months-old domain is high risk",
      assessSpamRisk({ dr: 52, registeredOn: "2026-01-20", trancoChecked: true, now: NOW }).level === "high");
    check("signals", "a young domain with low DR is not suspicious",
      assessSpamRisk({ dr: 12, registeredOn: "2026-06-01", trancoChecked: true, now: NOW }).level === "none");
    check("signals", "an absent Tranco rank counts only if the list was actually consulted",
      assessSpamRisk({ dr: 60, registeredOn: "1998-01-01", trancoRank: null, trancoChecked: false, now: NOW }).level === "none" &&
      assessSpamRisk({ dr: 60, registeredOn: "1998-01-01", trancoRank: null, trancoChecked: true, now: NOW }).level === "low");
    check("signals", "RDAP parsing takes the registration event and nothing else",
      registrationFromRdap({ events: [{ eventAction: "registration", eventDate: "2005-06-10T22:56:20Z" }] }) === "2005-06-10" &&
      registrationFromRdap({ events: [{ eventAction: "last changed", eventDate: "2026-05-09T00:00:00Z" }] }) === null);

    // Risk moves `fit` but must NOT silently redefine `qualified` — those four filters are the
    // client's requirement sheet.
    const base = {
      dr: 55, organicTraffic: null, usTrafficShare: null, relevance: 80, mentionCount: 6,
      articleCount: 10, hasEmail: true, contactConfidence: 0.9, now: NOW,
    };
    const clean = qualifyProspect({ ...base, registeredOn: "1998-04-29", trancoRank: 5000, trancoChecked: true });
    const pbn = qualifyProspect({ ...base, registeredOn: "2026-01-20", trancoRank: null, trancoChecked: true });
    check("signals", "a likely PBN still 'qualifies' on the sheet but rates far lower on fit",
      clean.qualified === true && pbn.qualified === true && pbn.fit < clean.fit,
      JSON.stringify({ cleanFit: clean.fit, pbnFit: pbn.fit }));
    check("signals", "spamRisk is reported with reasons",
      pbn.spamRisk.level === "high" && pbn.spamRisk.reasons.length > 0 && clean.spamRisk.level === "none");
  }

  // ── free search: autocomplete expansion, and SearXNG being inert until deployed ──
  {
    const { seedTokens, isOnTopic } = await import("@/lib/writer/autocomplete");
    const { searchProviders } = await import("@/lib/search/webSearch");

    check("free-search", "seed tokens drop stopwords and 1-2 letter noise",
      JSON.stringify(seedTokens("how to use the best ai image generator")) === JSON.stringify(["use", "image", "generator"]),
      JSON.stringify(seedTokens("how to use the best ai image generator")));
    check("free-search", "drifted autocomplete suggestions are filtered out",
      isOnTopic("ai image generator free", ["image", "generator"]) &&
      !isOnTopic("best laptop deals", ["image", "generator"]) &&
      isOnTopic("anything", []));
    // Ordering is the whole point: an unmetered provider behind a metered one saves nothing.
    const provs = searchProviders();
    check("free-search", "SearXNG leads the provider order when configured, and is absent when not",
      process.env.SEARXNG_URL ? provs[0] === "searxng" : !provs.includes("searxng"),
      provs.join(","));
  }

  // ── feed discovery: a platform's address is never filed as an author's ──
  {
    const { isPlatformMailDomain, parseFeed, pickFeedEmail, declaredFeeds } =
      await import("@/lib/enrich/feedSignals");

    check("feed", "platform addresses are rejected outright, real domains are not",
      isPlatformMailDomain("yourfriends@medium.com") && isPlatformMailDomain("x@substack.com") &&
      !isPlatformMailDomain("becky@beckyauer.com") && !isPlatformMailDomain("jane@forbes.com"));

    const feed = parseFeed(`<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
      <managingEditor>hello@substack.com</managingEditor>
      <item><dc:creator><![CDATA[Becky Auer]]></dc:creator><description>write to becky@beckyauer.com</description></item>
    </channel></rss>`);
    check("feed", "channel-level addresses stay out of item attribution",
      feed.creators[0] === "Becky Auer" &&
      feed.channelEmails.includes("hello@substack.com") &&
      !feed.items[0].emails.includes("hello@substack.com"));
    check("feed", "an address is picked for the matching author only",
      pickFeedEmail(feed, "Becky Auer", "beckyauer369.substack.com")?.email === "becky@beckyauer.com" &&
      pickFeedEmail(feed, "Someone Else", "beckyauer369.substack.com") === null);

    const multi = parseFeed(`<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
      <item><dc:creator>Jane Doe</dc:creator><description>x</description></item>
      <item><dc:creator>Other Writer</dc:creator><description>other@elsewhere.com</description></item>
    </channel></rss>`);
    check("feed", "one author's address is never lent to another",
      pickFeedEmail(multi, "Jane Doe", "example.com") === null);

    // ── provider policy: the free-only switch, and the credential-level gate ──
    {
      const { freeOnlyMode, meteredProviderEnabled, meteredKey } = await import("@/lib/providers/policy");
      const free = freeOnlyMode();
      check("policy", "freeOnlyMode tracks PROVIDER_FREE_ONLY",
        free === (process.env.PROVIDER_FREE_ONLY === "1"));
      check("policy", "an unconfigured provider is never enabled", meteredProviderEnabled(false) === false);
      check("policy", "a configured provider follows the switch", meteredProviderEnabled(true) === !free);
      // Gating the KEY is what closes the bypass: serpAnalysis / topCompetitors / the Ahrefs call
      // helper all re-read their env var inside the fetch, past any …Enabled() check.
      check("policy", "the credential itself is gated, not just the enabled flag",
        meteredKey("abc123") === (free ? null : "abc123"));
      check("policy", "blank credentials normalise to null in either mode",
        meteredKey("  ") === null && meteredKey(undefined) === null);
    }

    check("feed", "only rss/atom alternates are treated as feeds",
      JSON.stringify(declaredFeeds(
        `<link rel="alternate" type="application/rss+xml" href="/r.xml">` +
        `<link rel="stylesheet" href="/a.css">` +
        `<link rel="alternate" type="text/html" href="/other">`, "https://x.test/",
      )) === JSON.stringify(["https://x.test/r.xml"]));
    check("tools", "verify_emails is registered", HERMES_TOOL_NAMES.has("verify_emails"));
    check("prompt", "revision bumped for the verification tool-shape change", HERMES_PROMPT_REVISION >= 29);
    const emptyVerify = await runHermesTool("verify_emails", { emails: ["nonsense"] }, { sessionId: "s", userEmail: "probe@northwind.example" });
    check("tools", "verify_emails refuses an all-junk list as a tool error", emptyVerify.is_error === true);
  }

  // ── picker: the selection UI is pure, capped and clamps its key column ──
  {
    const ctx = { sessionId: "s", userEmail: "probe@northwind.example" };
    const r = await runHermesTool("show_picker", {
      title: "t", columns: ["url", "dr"], key_column_index: 5,
      rows: Array.from({ length: 60 }, (_, i) => [`https://x${i}.example/post`, String(i)]),
    }, ctx);
    check("picker", "show_picker returns a picker payload", r.ui?.type === "picker");
    check("picker", "rows are capped at 50 (the same cap the projection re-applies)",
      r.ui?.type === "picker" && r.ui.rows.length === 50);
    check("picker", "an out-of-range key column clamps to the last column",
      r.ui?.type === "picker" && r.ui.key_col === 1);
    const bad = await runHermesTool("show_picker", { title: "t", columns: [], rows: [] }, ctx);
    check("picker", "empty input is a tool error, not a throw", bad.is_error === true);
  }

  // ── negotiation ladder: the pure decision core encodes the SOP (link exchange → push → money/human) ──
  {
    const S = DEFAULT_NEGOTIATION_SETTINGS;
    const C = (over: Partial<ReplyClassification>): ReplyClassification =>
      ({ intent: "interested", priceMentioned: null, reason: "", exchangeStance: "none", complex: false, ...over });
    const step = (stage: any, cls: ReplyClassification, over: any = {}) =>
      nextNegotiationStep({ stage, cls, settings: S, ceiling: 100, usCount: 1, offeredSlugs: [], ...over });

    check("negotiation", "opens with a link-exchange offer by default",
      step("link_exchange", C({})).action === "offer_exchange");
    check("negotiation", "accepting the swap closes as agreed",
      step("link_exchange", C({ exchangeStance: "accept" })).action === "close_agreed");
    check("negotiation", "a soft decline pushes the exchange once",
      step("link_exchange", C({ exchangeStance: "decline" })).nextStage === "link_exchange_push");
    check("negotiation", "a complex counter hands to a human at once",
      step("link_exchange", C({ complex: true })).interventionType === "complex_negotiation");
    check("negotiation", "hard no closes the thread",
      step("link_exchange", C({ intent: "hard_no" })).action === "close_declined");
    check("negotiation", "an AI-can't-do ask surfaces its own intervention type",
      step("link_exchange", C({ intent: "needs_human", interventionType: "asset_request" })).interventionType === "asset_request");
    // Exchange failed at the push stage: default (ai_handles_money off) hands to a human.
    const failed = step("link_exchange_push", C({ exchangeStance: "decline" }));
    check("negotiation", "a failed exchange hands to a human when the AI doesn't handle money",
      failed.action === "handoff" && failed.interventionType === "link_exchange_failed");
    // With ai_handles_money on and a ceiling, the same failure escalates to a money offer.
    const money = nextNegotiationStep({ stage: "link_exchange_push", cls: C({ exchangeStance: "decline" }), settings: { ...S, ai_handles_money: true }, ceiling: 100, usCount: 1, offeredSlugs: [] });
    check("negotiation", "with money enabled a failed exchange goes to a paid offer",
      money.action === "go_money" && money.nextStage === "money");
    // Thread-length backstop.
    check("negotiation", "an over-length thread hands over rather than nagging",
      step("link_exchange", C({}), { usCount: 99 }).action === "handoff");
    // Legacy stage tolerance.
    check("negotiation", "a null stage normalizes to link_exchange", normalizeStage(null) === "link_exchange");
    check("negotiation", "a known stage is preserved", normalizeStage("money") === "money");
  }

  // ── link-exchange inventory: only OPEN pages auto-offer; Governed/Restricted escalate ──
  {
    const openPick = pickExchangeOffer("best ai video generator tool");
    check("inventory", "a relevant topic yields an OPEN page to offer",
      openPick.page != null && openPick.page.tier === "open");
    // A topic that only maps to a comparison/alternatives page must NOT auto-offer — it escalates.
    const governedPick = pickExchangeOffer("midjourney alternatives");
    check("inventory", "a comparison/alternatives-only topic escalates instead of offering",
      governedPick.page === null && !!governedPick.handoffReason);
    // Excluding an already-offered page returns a different page.
    const first = pickExchangeOffer("photo editing background");
    const second = pickExchangeOffer("photo editing background", { excludeSlugs: first.page ? [first.page.slug] : [] });
    check("inventory", "excluding an offered page picks a different one",
      !!first.page && !!second.page && first.page.slug !== second.page.slug);
    const target = pickLinkTarget("workflow video", DEFAULT_NEGOTIATION_SETTINGS.link_targets);
    check("inventory", "a link-back target resolves to one of our pages",
      typeof target.url === "string" && target.url.startsWith("https://www.northwind.example"));
    check("prompt", "revision bumped for the link-exchange ladder", HERMES_PROMPT_REVISION >= 11);
    check("prompt", "the soul teaches the link-exchange ladder", /link exchange/i.test(HERMES_SOUL));
  }

  // ── worthiness: the §6 quality bar as a pure scorer; §8 hard-nos disqualify outright ──
  {
    const sig = (over: Partial<PartnerSignals>): PartnerSignals => ({
      dr: null, organicTraffic: null, relevance: null, indexed: null,
      spamSuspect: null, spamNiche: null, outboundLinks: null, outboundStuffed: null, ...over,
    });
    const strong = scorePartnerWorthiness(sig({ dr: 70, organicTraffic: 20000, relevance: 85, indexed: true, spamSuspect: false, outboundStuffed: false }));
    check("worthiness", "a strong partner scores green", strong.band === "green" && strong.hardNo === null, `got ${strong.band} ${strong.score}`);
    const unknown = scorePartnerWorthiness(sig({}));
    check("worthiness", "all-unverified signals are neutral, never red (unverified doesn't fail)", unknown.band !== "red", `got ${unknown.band} ${unknown.score}`);
    const gambling = scorePartnerWorthiness(sig({ dr: 80, relevance: 90, spamNiche: "gambling" }));
    check("worthiness", "a §8 niche is a hard no regardless of score", gambling.band === "red" && !!gambling.hardNo);
    const deindexed = scorePartnerWorthiness(sig({ dr: 80, indexed: false }));
    check("worthiness", "a de-indexed site is a hard no", deindexed.band === "red" && !!deindexed.hardNo);
    const lowDr = scorePartnerWorthiness(sig({ dr: 20, relevance: 40, indexed: true, spamSuspect: false, outboundStuffed: false }));
    check("worthiness", "verified-low DR without strong relevance+traffic cannot reach green", lowDr.band !== "green", `got ${lowDr.band} ${lowDr.score}`);
    const lowDrBacked = scorePartnerWorthiness(sig({ dr: 40, organicTraffic: 15000, relevance: 90, indexed: true, spamSuspect: false, outboundStuffed: false }));
    check("worthiness", "low DR WITH strong relevance and real traffic can still pass (§6's own caveat)", lowDrBacked.band === "green", `got ${lowDrBacked.band} ${lowDrBacked.score}`);
    const stuffed = scorePartnerWorthiness(sig({ dr: 55, relevance: 70, outboundStuffed: true, outboundLinks: 120 }));
    check("worthiness", "a link-stuffed page costs points and surfaces a reason", stuffed.reasons.some((r) => /stuffed/.test(r)));
    check("worthiness", "reasons are always populated", strong.reasons.length >= 6);
    check("prompt", "revision bumped for the worthiness gate", HERMES_PROMPT_REVISION >= 12);
    check("prompt", "the soul teaches the worthiness gate", /worthiness/i.test(HERMES_SOUL));
  }

  // ── pitch grounding: specifics come from extracted article text, never from thin air ──
  {
    const withText = openerPrompt({ relation: "You are writing to A, who wrote the article.", title: "T", articleText: "The piece compares free tiers." });
    const withoutText = openerPrompt({ relation: "You are writing to A, who wrote the article.", title: "T", articleText: "" });
    check("grounding", "the prompt carries the extracted text when there is some",
      withText.includes("The piece compares free tiers.") && /ACTUALLY THERE/.test(withText));
    check("grounding", "a missing text is declared, not papered over",
      withoutText.includes("ONLY the title") && !withoutText.includes('"""') && /NEVER invent/.test(withoutText));
    check("grounding", "clipping lands on a word boundary and collapses whitespace",
      clipArticleText("aaaa bbbb cccc dddd", 12) === "aaaa bbbb"
      && clipArticleText("alpha  beta\n\n\ngamma", 100) === "alpha beta\ngamma");
    // The fallback replaced one that asserted the piece was "a roundup" — a fabricated format.
    check("grounding", "the fallback quotes the real title and claims nothing else",
      openerFallback("Ten Tools", false) === `I really enjoyed your piece "Ten Tools".`
      && !/roundup/i.test(openerFallback(null, true)) && !/roundup/i.test(openerFallback(null, false)));
    check("grounding", "the owner-addressed fallback never says \"your piece\"",
      !openerFallback("Ten Tools", true).includes("your piece") && !openerFallback(null, true).includes("your piece"));
  }

  // ── confirm: validation + every kind routes somewhere real ──
  {
    check("confirm", "unknown kind is rejected", validateActionParams("frobnicate" as HermesActionKind, {}) !== null);
    check("confirm", "missing params are rejected", validateActionParams("publish_draft", {}) !== null);
    check("confirm", "complete params pass", validateActionParams("publish_draft", { draft_id: "x" }) === null);
    check("confirm", "mark_payment action enum is enforced",
      validateActionParams("mark_payment", { email_id: "x", action: "request" }) !== null &&
      validateActionParams("mark_payment", { email_id: "x", action: "paid" }) === null);
    const bad: string[] = [];
    for (const kind of ACTION_KINDS) {
      const stub: HermesAction = {
        id: "a", session_id: "s", kind, summary: "", status: "proposed",
        params: { workflow_id: "w", anchor_id: "a", draft_id: "d", cluster_id: "c", landing_page_id: "l", preview: {}, text: "t", email_id: "e", action: "paid" },
        proposed_at: "", resolved_at: null, resolved_by: null, result: null,
      };
      const r = actionRequest(stub);
      if (r.method !== "POST" || !r.path.startsWith("/api/") || r.path.includes("//")) bad.push(kind);
    }
    check("confirm", "every action kind maps to a well-formed route", bad.length === 0, bad.join(", "));
  }

  // ── cache breakpoints: reused from the writer, re-asserted on this loop's shapes ──
  {
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      { role: "assistant" as const, content: [{ type: "thinking" as const, thinking: "…", signature: "sig" }] },
    ];
    const out = applyCacheBreakpoints(messages as never);
    const marked = JSON.stringify(out).includes('"cache_control"');
    const thinkingMarked = JSON.stringify(out[1]).includes('"cache_control"');
    check("cache", "a breakpoint lands on a cacheable block", marked);
    check("cache", "thinking blocks are never marked (400 otherwise)", !thinkingMarked);
    check("cache", "originals are not mutated", !JSON.stringify(messages).includes('"cache_control"'));
    check("cache", "isCacheable rejects thinking", !isCacheable({ type: "thinking" }) && isCacheable({ type: "text" }));
  }

  // ── loop: interrupted-turn self-heal (the Vercel session-bricking edge) ──
  {
    const blocks = [
      { type: "text", text: "checking…" },
      { type: "tool_use", id: "tu_1", name: "overview", input: {} },
      { type: "tool_use", id: "tu_2", name: "list_drafts", input: {} },
    ];
    check("loop", "dangling tool_use ids are all detected",
      JSON.stringify(pendingToolUseIds(blocks)) === JSON.stringify(["tu_1", "tu_2"]));
    check("loop", "text-only blocks dangle nothing", pendingToolUseIds([{ type: "text", text: "done." }]).length === 0);
    check("loop", "malformed blocks are ignored, not thrown",
      pendingToolUseIds([null, {}, { type: "tool_use" }]).length === 0);
  }

  // ── sender identity: an outreach email always leaves a mailbox somebody chose ──
  // The rule these guard is one bug, found twice: mail went out from a real teammate's Gmail on
  // somebody else's action. First through the cron's env-SMTP fallback (removed), then through the
  // Inbox, where the permission to READ any team mailbox was also being used as the permission to
  // SEND from it. Both refusals are reachable without a database or an SMTP socket, so they can be
  // asserted here rather than only in review.
  {
    const admin = getAdminEmails()[0];
    const outsider = "definitely-not-an-admin@example.invalid";

    const own = await resolveInboxSender({ actor: outsider, requestedAs: null });
    check("sender", "no ?as= sends from the caller's own mailbox",
      own.ok && own.account === outsider && own.sentBy === outsider);

    const self = await resolveInboxSender({ actor: outsider, requestedAs: outsider.toUpperCase() });
    check("sender", "?as= yourself in another case is still yourself, not an act-as",
      self.ok && self.account === outsider);

    const stranger = await resolveInboxSender({ actor: outsider, requestedAs: admin });
    check("sender", "a non-admin cannot send from another teammate's mailbox",
      !stranger.ok && stranger.status === 403);

    // Machine-ness outranks the admin list: a leaked agent token must not become the power to
    // send as a named person.
    const machine = await resolveInboxSender({ actor: admin, machine: true, requestedAs: outsider });
    check("sender", "a machine caller cannot act as a person even from an admin actor",
      !machine.ok && machine.status === 403);

    // Returns before any credential read, so this asserts the refusal itself, not a config gap.
    const unstamped = await deliverOutreach({ to: "someone@example.invalid", subject: "s", body: "b", sender: null });
    check("sender", "outreach with no sender assigned is refused, never sent",
      !unstamped.ok && unstamped.error === NO_SENDER_ERROR);
  }

  // ── sla: the unanswered-reply verdicts the sweep, the page and the digest all rely on ──
  {
    const base: UnansweredReply = {
      anchorId: "a", authorId: "au", workflowId: "w", senderEmail: "you@northwind.example", aiManaged: false,
      negotiationStatus: null, replyIntent: null, replyExcerpt: "Sure, happy to include you.", replyFrom: "them@site.test",
      repliedAt: "2026-01-01T00:00:00Z", lastAnswerAt: null, ageHours: 3, hasFreshDraft: false,
    };
    const fresh = classifyUnanswered(base, 24);
    check("sla", "inside the SLA is not over it", !fresh.overSla && fresh.priority === 2);
    const late = classifyUnanswered({ ...base, ageHours: 30 }, 24);
    check("sla", "past the SLA is priority 1", late.overSla && late.priority === 1);
    const priced = classifyUnanswered({ ...base, ageHours: 30, replyIntent: "asks_price" }, 24);
    check("sla", "a priced reply past the SLA is priority 0", priced.priority === 0 && priced.priced);
    check("sla", "a dollar figure in the excerpt counts as priced even with no intent",
      isPricedReply(null, "ok for $150") && isPricedReply(null, "USD 297 per post") && !isPricedReply(null, "thanks, no"));
    check("sla", "an unmanaged thread is owned by nobody", classifyUnanswered(base, 24).owner === "nobody");
    check("sla", "an AI-managed thread is owned by the AI", classifyUnanswered({ ...base, aiManaged: true }, 24).owner === "ai");
    check("sla", "a parked thread is owned by a person even when AI-managed",
      classifyUnanswered({ ...base, aiManaged: true, negotiationStatus: "needs_human" }, 24).owner === "human"
      && classifyUnanswered({ ...base, negotiationStatus: "handoff" }, 24).owner === "human");
    check("sla", "the label names the age and the gap", /3h unanswered.*no AI send/.test(fresh.label));
    const summary = formatSlaSummary([{ ...base, ageHours: 30, replyIntent: "asks_price" }, base], 24);
    check("sla", "summary counts total, over-SLA and priced", summary[0].includes("2 unanswered") && summary[0].includes("1 older than 24h") && summary[0].includes("1 with a price"));
    check("sla", "summary lists only the over-SLA rows", summary.length === 2 && summary[1].includes("them@site.test"));
    check("sla", "an empty list renders as zero, not as nothing", formatSlaSummary([], 24)[0].startsWith("Replies waiting on us: 0 unanswered"));
    // The policy switch that rides onto machine-armed rows.
    check("sla", "ai_replies is a valid boolean policy field", validatePolicyPatch({ ai_replies: false }) === null && validatePolicyPatch({ ai_replies: "yes" }) !== null);
    check("sla", "the built-in policy defaults ai_replies on", BUILTIN_DEFAULT_POLICY.ai_replies === true);
  }

  const failed = results.filter((r) => !r.pass);
  return NextResponse.json({
    ok: failed.length === 0,
    pass: results.length - failed.length,
    fail: failed.length,
    failures: failed,
    results,
  }, { status: failed.length === 0 ? 200 : 500 });
}
