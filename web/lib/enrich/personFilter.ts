// Guards against enriching/emailing things that aren't real people. Discovery sometimes
// extracts publication names, section labels, or role blurbs as "authors" — we don't want
// to find emails for those, nor attribute generic inboxes (contact@, tips@) to a person.

// Words that signal a company / publication / label / job title rather than a person's name.
const NON_PERSON_WORDS = new Set([
  "inc", "llc", "ltd", "corp", "gmbh", "co", "company", "group", "ventures", "labs",
  "technologies", "solutions", "systems", "services", "media", "news", "newsroom",
  "magazine", "journal", "review", "times", "post", "wire", "daily", "weekly", "report",
  "digest", "hub", "insider", "network", "press", "editorial", "staff", "team", "authors",
  "author", "contributor", "contributors", "guest", "admin", "editor", "editors", "desk",
  "video", "tv", "podcast", "blog", "official", "department", "director", "engineer",
  "manager", "platform", "requirements", "product", "marketing", "sales", "support",
  // job-title words that were slipping through as "names" (e.g. "Consultant and Applied scientist")
  "scientist", "consultant", "analyst", "specialist", "officer", "founder", "cofounder",
  "ceo", "cto", "cmo", "coo", "vp", "journalist", "reporter", "correspondent", "columnist",
  "freelance", "freelancer", "writer", "researcher", "strategist", "lead", "head", "applied",
  // page-fragment phrases scraped as bylines: PCMag's "About Our Expert" box passed every other
  // gate (three clean capitalized tokens, no connector words) and became a prospect named
  // "About Our Expert" in eval round 1
  "about", "our", "your", "expert", "experts",
  // scraper nav-junk tokens (skip-links / menu labels scraped as bylines, e.g. Semrush's
  // "Jump to Authorization" accessibility link)
  "navigation", "links", "jump", "skip", "menu", "toggle", "authorization", "login",
  "logout", "signin", "signup", "search", "subscribe", "newsletter", "cookie", "cookies",
]);

// Connector words a real name never contains, but a scraped title/phrase does
// ("Head of Content", "Consultant and Applied scientist", "Editor at CNET", "Jump to X").
const TITLE_CONNECTOR = /\s(and|of|the|for|at|with|to|&)\s/i;

// A single token that is the same word doubled ("AuthorizationAuthorization",
// "MenuMenu") — a classic scraped-nav-label glitch, never a real name token.
const DOUBLED_WORD = /^(.{3,})\1$/i;

// Scraper junk that gets concatenated onto a byline ("...Social Links Navigation", "By ...").
const LEADING_JUNK = /^(by|written by|words by|author|posted by)[:\s]+/i;
const TRAILING_JUNK = /\s*(social links navigation|continue reading|read (more|full)|share (this)?|sign ?in|subscribe|view all posts|follow (us)?|leave a comment|newsletter|see all).*$/i;

import { isRoleEmail as isRoleEmailCanonical } from "@/lib/email/roleEmail";

// Normalize a scraped byline into a clean personal name (strip "By ", trailing nav junk, and a
// role word smushed onto the surname like "CaiContributor" -> "Cai"). Returns "" if nothing usable.
export function cleanAuthorName(raw?: string | null): string {
  let n = (raw ?? "").trim();
  if (!n) return "";
  n = n.replace(LEADING_JUNK, "").replace(TRAILING_JUNK, "");
  // "CatherineCaiContributor" / "Alistair CampbellEditor" → drop a role word fused onto a lowercase tail
  n = n.replace(/(?<=[a-z])(Contributor|Editor|Staff|Correspondent|Columnist|Reporter|Journalist|Writer)$/u, "");
  return n.replace(/\s+/g, " ").trim();
}

export function isLikelyPersonName(name: string, publication?: string): boolean {
  const n = cleanAuthorName(name);
  if (!n) return false;
  if (/\d/.test(n)) return false;               // digits → not a name
  if (/[,/|]/.test(n)) return false;            // commas/slashes → title or company
  if (TITLE_CONNECTOR.test(n)) return false;    // "and/of/the/at" → a title phrase, not a name
  const tokens = n.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return false; // need first+last, not a blurb
  const lower = n.toLowerCase();
  for (const t of tokens) {
    if (NON_PERSON_WORDS.has(t.toLowerCase().replace(/[^a-z]/g, ""))) return false;
    if (DOUBLED_WORD.test(t)) return false;     // "AuthorizationAuthorization" → scraped nav junk
  }
  // matches the publication name → it's the outlet, not a person
  if (publication) {
    const pub = publication.toLowerCase();
    if (lower === pub || pub.includes(lower) || lower.includes(pub.replace(/\.(com|ai|org|net|io).*$/, ""))) return false;
  }
  return true;
}

// Delegate to the single canonical role-email detector (src/lib/email/roleEmail.ts) so the
// enrich/finder path and the storage/send path agree. The canonical version matches compound
// role addresses too (pressinquiries@, brandlicensing@, no-reply@…), which the old exact-token
// set here missed — letting pressinquiries@medium.com slip through as a "found" email.
export function isRoleEmail(email: string): boolean {
  return isRoleEmailCanonical(email);
}

// A "guess" = an email we CONSTRUCTED from a domain pattern (not SMTP-verified), or one scraped
// off a page that matches neither the byline nor the page's domain (probably someone else's).
// Sourced emails (page/LinkedIn/Blitz/social/found-on-site) and pattern-verified are NOT guesses.
export function isGuessSource(source?: string | null): boolean {
  return source === "pattern" || source === "pattern-catchall" || source === "page-scrape-unmatched";
}

// Domains reserved for documentation and therefore never a real mailbox. example.* is RFC 2606;
// the rest are the placeholders that actually turn up in page markup and form templates.
const PLACEHOLDER_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "example.edu",
  "domain.com", "domain.net", "yourdomain.com", "mydomain.com", "site.com", "yoursite.com",
  "youremail.com", "company.com", "yourcompany.com", "acme.com",
  "test.com", "sample.com", "somewhere.com", "address.com", "abc.com",
  "localhost", "localhost.com",
]);

// Local parts that mean "put your own here". Matched exactly, so a real person called Jane Doe at
// jane.doe@realco.com is unaffected — only the bare `doe@`/`johndoe@` placeholder shapes are caught.
//
// Deliberately NOT here: `me` and `you`. `me@someone-personal-domain.com` is an extremely common real
// alias, and deleting a real contact costs an outreach opportunity — a worse trade than leaving one
// placeholder in. Same reasoning excludes `email.com` and `mail.com` from the domain list above: both are
// genuine free-mail providers, not documentation stand-ins.
const PLACEHOLDER_LOCALS = new Set([
  "user", "username", "youremail", "your-email", "your_email", "email", "e-mail",
  "example", "sample", "test", "testing", "demo", "placeholder", "changeme", "yourname",
  "your-name", "your_name", "name", "firstname", "lastname", "firstnamelastname",
  "johndoe", "john.doe", "janedoe", "jane.doe", "joe.bloggs", "foo", "bar", "baz", "abc", "xyz",
  "someone", "somebody", "anyone", "nobody", "myname", "myemail",
]);

/**
 * Is this a documentation placeholder rather than a real mailbox?
 *
 * This exists because it was NOT caught, and the failure was expensive. `pageSignals.ts` guarded with
 * `e.includes("example.")` — a trailing dot, so it matched `foo@example.com` and missed both
 * `example@domain.com` (that is `example@`) and `user@domain.com` entirely. Eight authors ended up with
 * a literal `user@domain.com` stored at 0.9 confidence and source `page-scrape`.
 *
 * Why that is the worst possible shape for this bug: `page-scrape` maps to `"sourced"` in emailTrust(),
 * the HIGHEST trust rank — above a pattern-verified address — so the send gate waved it straight through.
 * A guessed email gets blocked; an invented one that looks scraped does not. Every one of those is a
 * guaranteed bounce, and bounces cost sender reputation for everyone on the domain.
 *
 * Checked at extraction time (so nothing new lands) and worth re-checking before a send.
 */
export function isPlaceholderEmail(email: string): boolean {
  const e = email.toLowerCase().trim().replace(/^mailto:/, "");
  const at = e.lastIndexOf("@");
  if (at < 1) return true; // not an address at all

  const local = e.slice(0, at);
  const domain = e.slice(at + 1);

  if (PLACEHOLDER_DOMAINS.has(domain)) return true;
  if (PLACEHOLDER_LOCALS.has(local)) return true;

  // A domain whose own label is a placeholder word, at any TLD: yourdomain.co.uk, example.io.
  const label = domain.split(".")[0];
  if (["example", "domain", "yourdomain", "mydomain", "yoursite", "youremail", "test", "sample"].includes(label)) {
    return true;
  }

  // Asset filenames that the address regex happily matches out of markup: logo@2x.png, sprite@3x.svg.
  if (/\.(png|jpe?g|gif|webp|svg|css|js|woff2?|ico)$/.test(domain)) return true;

  // Error-tracking and build tooling that embeds pseudo-addresses in page JavaScript.
  if (/(^|\.)(sentry|wixpress|squarespace|shopify|cloudflare|gstatic|googleapis)\./.test(`.${domain}`)) {
    return true;
  }

  return false;
}
