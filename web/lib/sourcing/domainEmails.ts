// "Who can I email at this domain?" — the hunter.io-extension answer, in the tool.
//
// The team's measured complaint: our chat path FETCHED the page and reported "no email" for
// domains where Hunter's extension shows ten named people. Hunter answers from an INDEX of
// addresses it has seen anywhere on the web, so page-reading can never match it. This module
// asks both: the (durably cached) Hunter index first, then what the domain's own root and
// contact page actually list — merged, deduped, and labeled with where each address came from
// and whether it is a named person or a shared inbox. Generic addresses are kept deliberately:
// the team uses contacto@/info@ openers to get routed to editors, and hiding them is exactly
// the "our tool returned Null" failure being reported.
import { fetchRaw } from "@/lib/indexing/fetchRendered";
import { extractContacts } from "@/lib/extract/contacts";
import { isPlaceholderEmail, isRoleEmail } from "@/lib/enrich/personFilter";
import { cachedDomainSearch } from "@/lib/enrich/hunterCache";
import type { HunterDomainPerson } from "@/lib/enrich/hunter";

export interface DomainEmailRow {
  email: string;
  name: string | null;
  position: string | null;
  /** "personal" = a named human; "generic" = a shared inbox (info@, contacto@) — a legitimate
   *  opener for reaching editors, but the send machine refuses it unless ALLOW_ROLE_EMAILS=1. */
  kind: "personal" | "generic";
  confidence: number | null;
  found_by: "hunter-index" | "page-scrape" | "both";
}

/** Merge the index and the page, one row per address. Hunter's metadata wins on overlap (it has
 *  names and roles; the page has a bare mailto), placeholders are dropped, and named humans sort
 *  before shared inboxes. Pure, so the selfcheck can pin it. */
export function mergeDomainEmails(hunterPeople: HunterDomainPerson[], scrapedEmails: string[]): DomainEmailRow[] {
  const rows = new Map<string, DomainEmailRow>();
  for (const p of hunterPeople) {
    const email = p.email.toLowerCase().trim();
    if (!email.includes("@") || isPlaceholderEmail(email)) continue;
    rows.set(email, {
      email,
      name: [p.firstName, p.lastName].filter(Boolean).join(" ") || null,
      position: p.position ?? null,
      kind: p.type === "generic" || (p.type === null && isRoleEmail(email)) ? "generic" : "personal",
      confidence: p.confidence || null,
      found_by: "hunter-index",
    });
  }
  for (const raw of scrapedEmails) {
    const email = raw.toLowerCase().trim().replace(/^mailto:/, "");
    if (!email.includes("@") || isPlaceholderEmail(email)) continue;
    const existing = rows.get(email);
    if (existing) { existing.found_by = "both"; continue; } // seen on the page too — corroboration
    rows.set(email, {
      email, name: null, position: null,
      kind: isRoleEmail(email) ? "generic" : "personal",
      confidence: null, found_by: "page-scrape",
    });
  }
  return [...rows.values()].sort((a, b) =>
    Number(b.kind === "personal") - Number(a.kind === "personal") || (b.confidence ?? 0) - (a.confidence ?? 0));
}

export interface DomainEmailsReport {
  domain: string;
  rows: DomainEmailRow[];
  pattern: string | null;
  organization: string | null;
  hunter: "cached" | "live" | "unavailable";
  credits_spent: number;
  pages_read: number;
  notes: string[];
}

/** One domain, both sources. The page pass reads the root and, when the root links a
 *  contact/write-for-us page, that page too — which is where mastheads actually list addresses. */
export async function domainEmails(domainRaw: string): Promise<DomainEmailsReport> {
  const domain = domainRaw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase();
  const notes: string[] = [];

  const index = await cachedDomainSearch(domain).catch(() => null);
  if (!index) notes.push("Hunter index unavailable (no key, quota spent, or the API did not answer) — page scrape only.");
  else if (index.cached) notes.push(`Hunter index from the cache of ${index.searched_at.slice(0, 10)} — zero credits spent.`);

  const scraped: string[] = [];
  let pagesRead = 0;
  const root = await fetchRaw(`https://${domain}`).catch(() => null);
  let contactHref: string | null = null;
  if (root?.ok && root.html) {
    pagesRead++;
    for (const c of extractContacts(root.html, "", `https://${domain}`)) {
      if (c.type === "mailto") scraped.push(c.value);
      if (c.type === "form" && !contactHref) contactHref = c.value;
    }
  } else {
    notes.push(`The site root could not be fetched${root?.status ? ` (HTTP ${root.status})` : ""} — likely bot-walled; the index above is unaffected.`);
  }
  if (contactHref) {
    const contact = await fetchRaw(contactHref).catch(() => null);
    if (contact?.ok && contact.html) {
      pagesRead++;
      for (const c of extractContacts(contact.html, "", contactHref)) {
        if (c.type === "mailto") scraped.push(c.value);
      }
    }
  }

  return {
    domain,
    rows: mergeDomainEmails(index?.people ?? [], scraped),
    pattern: index?.pattern ?? null,
    organization: index?.organization ?? null,
    hunter: index ? (index.cached ? "cached" : "live") : "unavailable",
    credits_spent: index?.credits_spent ?? 0,
    pages_read: pagesRead,
    notes,
  };
}
