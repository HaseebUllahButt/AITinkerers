import { emailCandidates } from "./patterns";
import { verifyEmail } from "./verify";
import { findEmailHunter, hunterEnabled } from "./hunter";
import { BlitzDomainCache, matchPerson, linkedinToEmail, blitzEnabled } from "./blitz";
import { aiScrapeEmail, aiScrapeEnabled } from "./aiScrape";

export interface ResolveResult {
  email: string;
  source: "guess+verify" | "hunter" | "blitz" | "pattern" | "ai-scrape";
  score?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Guess email patterns and verify (Reoon, or free local SMTP fallback). Stops early on a
// catch-all domain (where "valid" is meaningless) and returns the first safe mailbox.
export async function guessAndVerify(name: string, domain: string, maxTries = 4): Promise<ResolveResult | null> {
  const candidates = emailCandidates(name, domain).slice(0, maxTries);
  for (let i = 0; i < candidates.length; i++) {
    const v = await verifyEmail(candidates[i]);
    if (v.status === "catch_all") return null; // domain accepts anything — can't trust a guess
    if (v.status === "safe") return { email: candidates[i], source: "guess+verify" };
    if (i < candidates.length - 1) await sleep(150);
  }
  return null;
}

// Full waterfall for one person: cheapest/most-scalable free source first.
//  1) guess + Reoon verify (600/mo free, name+domain, real mailbox check)
//  2) Hunter finder (25/mo free, DB-backed)
//  3) Blitz (LinkedIn employee chain)
export async function resolveEmail(
  name: string,
  domain: string,
  opts?: { blitzCache?: BlitzDomainCache },
): Promise<ResolveResult | null> {
  if (!name || !domain) return null;

  const guessed = await guessAndVerify(name, domain);
  if (guessed) return guessed;

  if (hunterEnabled()) {
    const h = await findEmailHunter(name, domain);
    if (h) return { email: h.email, source: "hunter", score: h.score };
  }

  if (blitzEnabled()) {
    const cache = opts?.blitzCache ?? new BlitzDomainCache();
    const people = await cache.employeesForDomain(domain);
    const match = matchPerson(name, people);
    if (match?.linkedin_url) {
      const email = await linkedinToEmail(match.linkedin_url);
      if (email) return { email, source: "blitz" };
    }
  }

  // Last resort: AI-scrape the publication site for the author's email, using your own
  // Claude access (OpenRouter) — no third-party scraping credits.
  if (aiScrapeEnabled()) {
    const cleanHost = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const email = await aiScrapeEmail(name, `https://${cleanHost}`);
    if (email) return { email, source: "ai-scrape" };
  }

  return null;
}

export function anyEnricherEnabled(): boolean {
  // guess + local SMTP verify needs no key, so enrichment is always possible.
  return true;
}
