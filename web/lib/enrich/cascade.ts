import { getAuthorArticleUrls, getKnownEmailsByDomain, getStoredLinkedin } from "@/lib/db/queries";
import { scrapePageSignals, type PageSignals } from "./pageSignals";
import { findLinkedinUrl } from "./findLinkedin";
import {
  linkedinToEmail, blitzEnabled, BlitzDomainCache, matchPerson, type BlitzPerson,
} from "./blitz";
import { emailCandidates } from "./patterns";
import { resolveDomainPattern, patternFromHunter, type DomainPattern } from "./patternInfer";
import { extractContacts } from "@/lib/extract/contacts";
import { fetchRaw } from "@/lib/indexing/fetchRendered";
import { aiScrapeEmail, aiScrapeEnabled } from "./aiScrape";
import { hermesEnabled, hermesScrape } from "@/lib/hermes/client";
import { isRoleEmail, isPlaceholderEmail } from "./personFilter";
import { emailMatchesPerson } from "./nameAffinity";
import {
  findEmailHunter, pickFromDomainSearch, hunterEnabled,
  type HunterDomainResult,
} from "./hunter";
import { cachedDomainSearch } from "./hunterCache";
import { findEmailEnrichSo, enrichSoEnabled } from "./enrichso";
import { verifyEmail } from "./verify";
import { discoverViaFeed } from "./feedSignals";
import { registrableDomain } from "@/lib/util/domain";

export interface CascadeTarget { id: string; name: string; host: string; publication: string }
export interface CascadeResult {
  email: string;
  source: string;
  score?: number;
  /** Set ONLY when the address belongs to someone other than the author we were resolving — a Hunter
   *  domain-search alt contact. The pitch must greet this person, not the byline, or it goes out
   *  misaddressed. Null/undefined means "this is the author's own address", the normal case. */
  ownerName?: string | null;
  ownerPosition?: string | null;
}

// Upper bound on how many of an author's posts we scan for their LinkedIn. Scanning stops
// early the moment a LinkedIn (or direct email) is found, so most authors scan far fewer.
const MAX_POSTS_SCAN = 50;

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// Full per-person cascade. Emits onStep(detail) for the live verbose feed. Order:
//  1. scrape their recent article/author pages → direct email + social links
//  2. get LinkedIn (from those pages, or a DuckDuckGo name+company search)
//  3. LinkedIn → Blitz → email   ← the unlock (Blitz is unlimited)
//  4. scrape their socials/personal site for an email
//  5. domain email-pattern (from emails we already have)
//  6. AI-scan the site with your Claude key
//  7. Hunter domain-search — needs NO name, so it catches the prospects email-finder cannot
export async function resolveEmailCascade(
  t: CascadeTarget,
  ctx: {
    onStep: (detail: string) => void;
    // onIssue records a REAL provider failure (Blitz/Reoon/AI/search error) — distinct
    // from a clean "nothing found" — so the UI can say "couldn't complete" vs "no email".
    onIssue?: (detail: string) => void;
    // onLinkedin fires when a LinkedIn URL is discovered en route to the email — the caller
    // persists it so an email run ALSO harvests LinkedIns (even if no email is found).
    onLinkedin?: (url: string) => void;
    // onContact fires for EVERY contact signal seen on the way, whatever the email outcome.
    //
    // Before this the cascade collected socials in absorb() and then discarded them on `return null` —
    // so a prospect with a public X profile and a working contact form was recorded as having no way to
    // reach them at all. Roughly 13 of 15 prospects in a real campaign came back "no email", and most of
    // them were reachable by some other route we had already found and thrown away.
    //
    // An email is the best channel, not the only one. Storing the rest turns a dead prospect into a
    // manual one, which for backlink outreach is the difference between a lost link and a slower link.
    onContact?: (c: { type: "twitter" | "linkedin" | "instagram" | "mastodon" | "form" | "author_page"; value: string; confidence: number }) => void;
    patternCache: Map<string, DomainPattern | null>;
    // Shared across a run so several authors at one publication reuse Blitz's company + employee
    // lookups instead of repeating them per person. Optional: a caller that omits it still works,
    // it just pays the lookup each time.
    blitzCache?: BlitzDomainCache;
    // Hunter domain-search costs one credit per CALL regardless of how many addresses come back, and a
    // campaign routinely has several prospects at one publication. Cached per run so a 15-prospect
    // campaign across 6 domains spends 6 credits, not 15. `null` caches a miss so we don't retry it.
    hunterDomains?: Map<string, HunterDomainResult | null>;
    domainVerify: Map<string, "safe" | "catch_all" | "invalid" | "unknown">;
  },
): Promise<CascadeResult | null> {
  const { onStep } = ctx;
  // Fires on any provider failure: log it as a "!"-prefixed step AND record it as an issue.
  // The prefix is the wire format the step list styles on — see email-finder/page.tsx.
  const onFail = (provider: string) => (msg: string) => {
    onStep(`! ${provider} failed: ${msg}`);
    ctx.onIssue?.(`${provider}: ${msg}`);
  };
  const socials: PageSignals = { emails: [] };
  // Flush whatever was found to the caller. Called at every return path, because the path that matters
  // most is the one where no email turned up.
  const flushContacts = () => {
    const seen: Array<[string, string | undefined, number]> = [
      ["linkedin", socials.linkedin, 0.85],
      ["twitter", socials.twitter, 0.8],
      ["instagram", socials.instagram, 0.7],
      ["mastodon", socials.mastodon, 0.7],
      ["author_page", socials.personalSite, 0.6],
    ];
    for (const [type, value, confidence] of seen) {
      if (value) ctx.onContact?.({ type: type as never, value, confidence });
    }
  };
  const absorb = (sig: PageSignals | null) => {
    if (!sig) return;
    socials.linkedin ??= sig.linkedin;
    socials.twitter ??= sig.twitter;
    socials.instagram ??= sig.instagram;
    socials.mastodon ??= sig.mastodon;
    socials.personalSite ??= sig.personalSite;
  };

  // If we ALREADY have this author's LinkedIn on file (from the LinkedIn finder or a prior
  // email run), reuse it and skip the post scan + web search entirely — no wasted search.
  const stored = await getStoredLinkedin(t.id).catch(() => null);
  let linkedin: string | undefined = stored ?? undefined;
  let linkedinIsNew = false;

  if (linkedin) {
    onStep(`LinkedIn already on file (${linkedin.replace(/^https?:\/\//, "")}) — skipping search`);
  } else {
    // 1) Scan ALL their posts for a direct email + their LinkedIn (stop scanning once
    //    LinkedIn turns up — that's enough to get the email via Blitz).
    const urls = await getAuthorArticleUrls(t.id, MAX_POSTS_SCAN).catch(() => []);
    if (urls.length) {
      onStep(`scanning ${urls.length} post${urls.length === 1 ? "" : "s"} for email & LinkedIn…`);
      for (let i = 0; i < urls.length; i++) {
        onStep(`↳ post ${i + 1}/${urls.length}: ${hostOf(urls[i])}`);
        const sig = await scrapePageSignals(urls[i]);
        // A page footer/nav often lists a generic org mailbox (plus@shopify.com, press@…) that
        // is NOT the author's — take the first address that isn't a role/generic mailbox.
        //
        // And even a personal-looking address can be someone ELSE'S: sponsor links, co-author
        // credits and footer contacts share the page with the byline. Eval round 1 filed
        // caleb@vfx.city as "Tyler Smith's email" at confidence 90 this way. An address that
        // matches neither the person nor the page's own domain keeps only guess-level trust
        // ("page-scrape-unmatched" maps to "guess" in emailTrust), so the send gate holds it
        // until a human confirms — instead of it outranking a verified pattern.
        const candidates = (sig?.emails ?? []).filter((e) => !isRoleEmail(e));
        const affine = candidates.find((e) => emailMatchesPerson(e, t.name, hostOf(urls[i])));
        if (affine) { onStep(`found email on their page`); flushContacts(); return { email: affine, source: "page-scrape", score: 90 }; }
        if (candidates[0]) {
          onStep(`found an email on their page, but it matches neither the byline nor the site — storing as low-trust`);
          flushContacts();
          return { email: candidates[0], source: "page-scrape-unmatched", score: 55 };
        }
        absorb(sig);
        if (socials.linkedin) { onStep(`found LinkedIn on a post: ${socials.linkedin.replace("https://", "")}`); break; }
      }
    }

    // 2) No LinkedIn yet? Check their social profiles (bios often link LinkedIn + email).
    if (!socials.linkedin) {
      for (const [label, surl] of [["X", socials.twitter], ["Instagram", socials.instagram], ["site", socials.personalSite]] as const) {
        if (!surl || socials.linkedin) continue;
        onStep(`checking ${label} profile for LinkedIn/email…`);
        const sig = await scrapePageSignals(surl);
        const sem = sig?.emails.find((e) => !isRoleEmail(e));
        if (sem) { onStep(`found email on ${label}`); flushContacts(); return { email: sem, source: "social", score: 80 }; }
        absorb(sig);
        if (socials.linkedin) onStep(`found LinkedIn on ${label}: ${socials.linkedin.replace("https://", "")}`);
      }
    }

    // 2.5) The host's RSS/Atom feed — free, one plain GET, and measured as the best free source for
    //      the population that actually lacks emails. A sample of tracked prospects with no address
    //      on file was mostly Substack/Medium authors, and their feeds carry both the byline and,
    //      sometimes, a personal address on the author's OWN domain
    //      (beckyauer369.substack.com/feed -> becky@beckyauer.com).
    //
    //      Placed here, before the paid web search below, because it costs nothing and returns a
    //      SOURCED address rather than a constructed one. feedSignals.ts refuses to attribute
    //      anything it cannot tie to this person, and rejects platform addresses outright — three
    //      of the four addresses in that measurement belonged to Substack or Medium, not the author.
    if (t.name) {
      onStep(`checking ${t.host}'s feed for their address…`);
      const fed = await discoverViaFeed(t.host, t.name, onStep).catch(() => null);
      if (fed) {
        flushContacts();
        return { email: fed.email, source: "feed", score: fed.score };
      }
    }

    // 3) Still no LinkedIn? Search the web by name + publication (the paid search).
    linkedin = socials.linkedin;
    if (!linkedin) {
      onStep(`searching the web for LinkedIn (${t.name} @ ${t.publication})…`);
      linkedin = (await findLinkedinUrl(t.name, t.publication, undefined, onFail("web search")).catch(() => null)) ?? undefined;
      if (linkedin) onStep(`found LinkedIn: ${linkedin.replace("https://", "")}`);
      else onStep(`no LinkedIn found anywhere`);
    }
    linkedinIsNew = !!linkedin;
  }

  // Harvest a NEWLY discovered LinkedIn (a stored one is already saved). LinkedIns are
  // higher-hit-rate and reusable (Blitz can convert them later).
  if (linkedin && linkedinIsNew) ctx.onLinkedin?.(linkedin);

  // 4) LinkedIn → Blitz → email (Blitz has unlimited credits and needs exactly this)
  if (linkedin && blitzEnabled()) {
    onStep(`Blitz: resolving email from LinkedIn…`);
    let blitzFailed = false;
    const email = (await linkedinToEmail(linkedin, (m) => { blitzFailed = true; onFail("Blitz")(m); }).catch(() => null))?.toLowerCase();
    if (email && !isRoleEmail(email)) { onStep(`Blitz returned an email`); flushContacts(); return { email, source: "blitz-linkedin", score: 90 }; }
    if (!blitzFailed) onStep(email ? `Blitz email was generic — skipping` : `Blitz had no email for that profile`);
  }

  // 4.5) Blitz by DOMAIN ROSTER — no LinkedIn URL required.
  //
  // Restored from the discovery pipeline (enrich/resolve.ts), which has always had it. Step 4 above
  // can only run when a LinkedIn URL was already found by scraping or search; when it was not, this
  // cascade skipped Blitz entirely and fell through to the paid providers and then to a guess. The
  // discovery path never had that hole: it asks Blitz for the whole employee roster at the domain and
  // fuzzy-matches the byline against it, so a person with no discoverable LinkedIn still resolves.
  //
  // This matters more than its position suggests. Blitz supplied 41 of the 72 emails in the measured
  // 1,000-author run, and its credits are unlimited, so skipping it to reach a metered provider is
  // backwards on both yield and cost. Placed directly after the LinkedIn attempt and before every paid
  // step for exactly that reason.
  if (blitzEnabled() && t.name) {
    onStep(`Blitz: checking who works at ${hostOf(t.host)}…`);
    const cache = ctx.blitzCache ?? new BlitzDomainCache();
    const people = await cache.employeesForDomain(hostOf(t.host)).catch(() => [] as BlitzPerson[]);
    if (people.length) {
      const match = matchPerson(t.name, people);
      if (match?.linkedin_url) {
        onStep(`Blitz matched ${t.name} on the roster — resolving their email…`);
        ctx.onLinkedin?.(match.linkedin_url);
        const email = (await linkedinToEmail(match.linkedin_url, onFail("Blitz")).catch(() => null))?.toLowerCase();
        if (email && !isRoleEmail(email)) {
          onStep(`Blitz returned an email from the roster`);
          flushContacts();
          return { email, source: "blitz-roster", score: 88 };
        }
      }
      onStep(`Blitz had ${people.length} people at that domain but no match for ${t.name}`);
    } else {
      onStep(`Blitz knows no one at that domain`);
    }
  }

  // 5) AI-scan the site for an email ACTUALLY on the page (not constructed) — your Claude key.
  if (aiScrapeEnabled()) {
    onStep(`AI-scanning ${t.host} for a contact email…`);
    const email = await aiScrapeEmail(t.name, t.host, onFail("AI-scan")).catch(() => null);
    if (email) { onStep(`AI found an email`); flushContacts(); return { email, source: "ai-scrape", score: 75 }; }
  }

  // 5.5) Hermes stealth browser — the last attempt at a REAL address before we resort to guessing.
  //
  // Placed here on purpose. Steps 1-5 all use plain fetches, which publishers increasingly block;
  // when they fail we fall through to step 6 and construct an address from a domain pattern, and
  // those constructed guesses are where the bounces come from. A browser that can actually render
  // the page turns some of those guesses back into sourced addresses.
  //
  // Last resort rather than first, because a browser session per prospect is expensive — this only
  // runs when everything cheap has already failed. No-ops entirely when HERMES_BASE_URL is unset.
  //
  // The author's own article page first, then the site root: the byline box and author bio are
  // where a personal address actually appears, and the root was the ONLY page this step used to
  // open — a bot-walled article (the measured CNET-class miss) never got its one browser chance.
  if (hermesEnabled()) {
    const articleUrls = await getAuthorArticleUrls(t.id, 1).catch(() => []);
    const pages = [...new Set([...(articleUrls[0] ? [articleUrls[0]] : []), `https://${t.host}`])];
    for (const page of pages) {
      onStep(`opening ${page.replace(/^https?:\/\//, "")} in a real browser…`);
      const hit = await hermesScrape({ url: page, want: "email" }).catch(() => null);
      if (hit?.ok && hit.value && !isRoleEmail(hit.value)) {
        onStep(`found an email with the browser`);
        flushContacts();
        return { email: hit.value, source: "hermes-browser", score: 88 };
      }
      if (hit && !hit.ok && hit.error) onStep(`! browser could not read ${page.replace(/^https?:\/\//, "")}: ${hit.error}`);
    }
  }

  const mailDomain = registrableDomain(t.host);

  // 5.8) Hunter email-finder — name + domain.
  //
  // This is the gap that made the hit rate look like a dead end. Hunter has been configured the whole
  // time and had produced exactly ZERO emails, because findEmailHunter() is wired into
  // enrich/resolve.ts, which only the discovery pipeline calls. Backlink enrichment runs through this
  // cascade, which never reached it. Measured before the fix: 72 emails across 1,000 searched authors
  // (7.2%), 41 of them from Blitz alone, and 20 of the 72 were pattern guesses the send gate blocks.
  //
  // Placed here for the same reason as the other paid steps: after everything free has failed, before we
  // manufacture an address. A found address beats a constructed one every time.
  if (hunterEnabled() && t.name) {
    onStep(`Hunter: looking up ${t.name} at ${mailDomain}…`);
    const h = await findEmailHunter(t.name, mailDomain).catch(() => null);
    if (h?.email && !isRoleEmail(h.email)) {
      onStep(`Hunter found an address (${h.score}% confidence)`);
      flushContacts();
      return { email: h.email, source: "hunter-finder", score: h.score };
    }
    onStep(`Hunter had no match for that name`);
  }

  // 5.85) enrich.so — a second name+domain finder.
  //
  // Chained after Hunter rather than instead of it: these vendors cover overlapping but different slices
  // of the same market, so the first hit wins and a miss costs one failed lookup. Runs BEFORE
  // domain-search because it answers the same question Hunter's finder did — this person's address —
  // whereas domain-search widens to whoever is at the domain, which may be someone else entirely.
  if (enrichSoEnabled() && t.name) {
    onStep(`enrich.so: looking up ${t.name} at ${mailDomain}…`);
    const e = await findEmailEnrichSo(t.name, mailDomain).catch(() => null);
    if (e && !isRoleEmail(e.email) && !isPlaceholderEmail(e.email)) {
      // A catch-all domain accepts anything, so a hit there is not proof the mailbox exists — scored down
      // to sit below a confirmed find, and the step log says so.
      const catchAllNote = e.isCatchAll ? " (catch-all domain, so unconfirmed)" : "";
      onStep(`enrich.so found an address, ${e.confidence} confidence${catchAllNote}`);
      flushContacts();
      return {
        email: e.email,
        source: e.isCatchAll ? "enrichso-catchall" : "enrichso",
        score: e.isCatchAll ? Math.min(60, e.score) : e.score,
      };
    }
    onStep(`enrich.so had no match`);
  }

  // 5.9) Hunter domain-search — the last REAL source before we resort to constructing an address.
  //
  // Deliberately placed here, after every free attempt and before the pattern guess, for the same reason
  // the Hermes browser step sits at 5.5: it costs a credit, so it should only run when the cheap paths have
  // failed, but it must run BEFORE we manufacture a guess, because a guess is what produces bounces.
  //
  // Why this step exists at all: `email-finder` (in resolve.ts) requires a correct `full_name` and returns
  // nothing without one, so a prospect with a badly-scraped byline or a "Staff" credit finds no email.
  // Measured: a Film Studio campaign found emails for 2 of 15 prospects, while Hunter's browser extension
  // showed lion@filmcrux.com (Lion Aton, Founder, 99%) for one of the misses. domain-search needs no name,
  // which is exactly the gap.
  if (hunterEnabled()) {
    const cache = ctx.hunterDomains;
    let ds: HunterDomainResult | null | undefined = cache?.get(mailDomain);
    if (ds === undefined) {
      onStep(`asking Hunter who works at ${mailDomain}…`);
      // Through the 14-day durable cache (074): a publication already searched this fortnight —
      // by any run, any teammate, or the domain_emails tool — answers with zero credits.
      const cached = await cachedDomainSearch(mailDomain).catch(() => null);
      ds = cached;
      if (cached?.cached) onStep(`served from the Hunter cache of ${cached.searched_at.slice(0, 10)} — zero credits`);
      cache?.set(mailDomain, ds);
      if (!ds) onFail("Hunter")("domain-search returned nothing");
    } else {
      onStep(`reusing Hunter's ${mailDomain} lookup from earlier in this run`);
    }

    // Hunter's detected pattern beats ours, which is inferred from whatever addresses we happen to have
    // seen. Seeded into the cache here so the fallback below builds on real evidence even when no usable
    // address came back — pattern quality is what decides whether that guess bounces. (The seeding this
    // comment promised was missing for months: the pattern was logged and thrown away.)
    if (ds?.pattern && !ctx.patternCache.has(mailDomain)) {
      const hp = patternFromHunter(ds.pattern);
      if (hp) {
        ctx.patternCache.set(mailDomain, hp);
        onStep(`Hunter says ${mailDomain} uses "${ds.pattern}" — seeded for the pattern step`);
      } else {
        onStep(`Hunter says ${mailDomain} uses "${ds.pattern}" (a shape we can't build — not seeded)`);
      }
    }

    if (ds) {
      const hit = pickFromDomainSearch(ds, t.name);
      if (hit && !isPlaceholderEmail(hit.person.email)) {
        const { person, matchedName } = hit;
        if (matchedName) {
          onStep(`Hunter matched ${t.name} at ${mailDomain} (${person.confidence}%)`);
          flushContacts();
          return { email: person.email, source: "hunter-domain", score: Math.max(80, person.confidence) };
        }
        // A DIFFERENT person at the same publication. Often the better contact for a link — an editor or
        // founder can place one where a freelance contributor cannot — but it is not who we set out to
        // reach, so it is tagged distinctly and scored below a name match. The UI must show who it is, or
        // the pitch gets addressed to the wrong person.
        if (person.type === "personal" && !isRoleEmail(person.email)) {
          const who = [person.firstName, person.lastName].filter(Boolean).join(" ") || person.email;
          const role = person.position ? `, ${person.position}` : "";
          onStep(`Hunter had no match for ${t.name}, but found ${who}${role} at ${mailDomain}`);
          flushContacts();
          return {
            email: person.email,
            source: "hunter-domain-alt",
            score: Math.min(75, person.confidence),
            // Carried so the pitch greets whoever this actually is. Without it the draft would open
            // "Hi <byline>," and be delivered to a different person — the one mistake a recipient
            // cannot un-see, and it burns the prospect permanently.
            ownerName: [person.firstName, person.lastName].filter(Boolean).join(" ") || null,
            ownerPosition: person.position ?? null,
          };
        }
      }
    }
  }

  // 6) Domain email pattern — CONSTRUCTED (a guess), tagged so it's never mistaken for a
  // sourced email. Built at the ORG's registrable mail domain (research.ibm.com →
  // ibm.com), inferred from emails there (or a known-publication fallback), verified once
  // per domain via Reoon; catch-all/unverified stay "guess".

  if (!ctx.patternCache.has(mailDomain)) {
    const known = await getKnownEmailsByDomain(t.host).catch(() => []);
    ctx.patternCache.set(mailDomain, resolveDomainPattern(mailDomain, known));
  }
  const pat = ctx.patternCache.get(mailDomain);
  if (pat) {
    const local = pat.format(t.name);
    if (local) {
      const candidate = `${local}@${mailDomain}`;
      onStep(`no source found — building from ${mailDomain} pattern (${pat.key})…`);
      // Verify once per domain (only cache the domain-level truths: safe / catch-all).
      let verdict = ctx.domainVerify.get(mailDomain);
      if (verdict === undefined) {
        onStep(`verifying pattern (Reoon)…`);
        verdict = (await verifyEmail(candidate, onFail("Reoon"))).status;
        if (verdict === "safe" || verdict === "catch_all") ctx.domainVerify.set(mailDomain, verdict);
        onStep(`Reoon: ${verdict === "catch_all" ? "catch-all (accepts anything)" : verdict}`);
      }
      // Always produce the pattern email (tagged as a guess) — like IBM/Fast Company. A
      // per-person "invalid"/"unknown" verdict just means we can't confirm, not that the
      // pattern is wrong, so we still return it (tagged), never a dead end.
      const source = verdict === "safe" ? "pattern-verified" : verdict === "catch_all" ? "pattern-catchall" : "pattern";
      const score = verdict === "safe" ? 95 : verdict === "catch_all" ? 65 : 55;
      flushContacts();
      return { email: candidate, source, score };
    }
  }

  // 6.5) No inferable pattern — try the standard name shapes and let Reoon pick the real one.
  //
  // Also restored from the discovery pipeline, whose guessAndVerify() walks emailCandidates()
  // (jane.smith, jsmith, janesmith, j.smith, …) and returns the first address Reoon calls "safe".
  // This cascade had no equivalent: step 6 needs `resolveDomainPattern` to infer a pattern from
  // addresses we happen to already hold at that domain, so a publication we have never seen an
  // address for produced no pattern, and the whole cascade returned null.
  //
  // Deliberately narrower than the discovery version. It runs LAST rather than first, because a
  // sourced address always beats a constructed one and running it early would shadow the real
  // providers above. And it stops the moment the domain answers catch-all, where "valid" proves
  // nothing and every candidate would look accepted — returning one then would manufacture a
  // confident-looking address out of a domain that accepts anything, which is how bounces happen.
  if (!pat && t.name) {
    const cached = ctx.domainVerify.get(mailDomain);
    if (cached === "catch_all") {
      onStep(`${mailDomain} accepts any address — a guess here would prove nothing, stopping`);
    } else {
      const candidates = emailCandidates(t.name, mailDomain).slice(0, 4);
      if (candidates.length) {
        onStep(`no known pattern for ${mailDomain} — testing ${candidates.length} standard name shapes…`);
        for (const cand of candidates) {
          const v = (await verifyEmail(cand, onFail("Reoon"))).status;
          if (v === "catch_all") {
            ctx.domainVerify.set(mailDomain, "catch_all");
            onStep(`${mailDomain} is catch-all — stopping rather than guessing`);
            break;
          }
          if (v === "safe") {
            ctx.domainVerify.set(mailDomain, "safe");
            onStep(`${cand.split("@")[0]}@ verified as a real mailbox`);
            flushContacts();
            return { email: cand, source: "guess-verified", score: 92 };
          }
        }
        onStep(`none of the standard shapes verified`);
      }
    }
  }

  // Truly no email. Before giving up, one plain fetch of the site root for the contact channels
  // an email hunt never records — most usefully a contact/write-for-us page. The detector
  // (extract/contacts.ts) and the contacts.type='form' column have existed since migration 001,
  // but only the discovery pipeline ever called it, so a backlink prospect with a working contact
  // form was filed as unreachable. Form outreach is manual by design — a form URL is a channel to
  // surface, never an address to send to — so this can't touch the send gate.
  if (ctx.onContact) {
    // The root first, then the well-known contact paths. The root alone was the whole sweep, which
    // misses every site that links its contact page from a nav the homepage renders client-side —
    // and forbes.com/contact, for instance, is a real page the root never surfaced to us.
    // Emails are deliberately NOT harvested here: measured, these pages yield role inboxes
    // (corrections@, readers@, feedback@) and platform desks (pressinquiries@medium.com), none of
    // which belong to the author we are resolving. A contact PAGE is an honest manual channel; a
    // role address filed against a person is a misattribution.
    for (const path of ["", "/contact", "/contact-us", "/about", "/write-for-us"]) {
      const raw = await fetchRaw(`https://${t.host}${path}`).catch(() => null);
      if (!raw?.ok || !raw.html) continue;
      const found = extractContacts(raw.html, "", `https://${t.host}${path}`);
      const form = found.find((c) => c.type === "form");
      if (form) {
        onStep(`no email — but ${t.host} links a contact page (${form.value}); keeping it as the channel`);
        ctx.onContact({ type: "form", value: form.value, confidence: form.confidence });
        break;
      }
    }
  }

  flushContacts();
  return null;
}
