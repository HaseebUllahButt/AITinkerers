// Does this email plausibly belong to this person, on this page? Eval round 1 found the failure
// this guards: the page-scrape step took the FIRST non-role address on an author's post and stored
// it at confidence 90 — which is how caleb@vfx.city was filed as "Tyler Smith's email" off a
// curiousrefuge.com byline. Sponsor links, co-author credits and footer addresses all live on the
// same page as the byline; only an address that matches the person or the publication should keep
// page-scrape's top-rank trust.
import { registrableDomain } from "@/lib/util/domain";

export function emailMatchesPerson(email: string, fullName: string, pageHost?: string | null): boolean {
  const at = email.toLowerCase().trim().lastIndexOf("@");
  if (at < 1) return false;
  const local = email.toLowerCase().slice(0, at).replace(/[^a-z]/g, "");
  const emailHost = email.toLowerCase().slice(at + 1);

  // Name affinity: any name token (≥3 chars) in the local part, or the classic first-initial +
  // surname shape (jsmith). "Tyler Smith" matches tyler@, smith@, tsmith@, tyler.smith@ — not caleb@.
  const tokens = fullName.toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z]/g, "")).filter((t) => t.length >= 3);
  if (tokens.some((t) => local.includes(t))) return true;
  if (tokens.length >= 2) {
    const initialLast = tokens[0][0] + tokens[tokens.length - 1];
    if (local.includes(initialLast)) return true;
  }

  // Publication affinity: an address on the article's own (registrable) domain is plausibly the
  // author's work inbox even when the local part is opaque (editorial handles, initials).
  if (pageHost) {
    const page = registrableDomain(pageHost.replace(/^www\./, ""));
    if (page && registrableDomain(emailHost) === page) return true;
  }
  return false;
}
