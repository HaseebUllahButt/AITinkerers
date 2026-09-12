// Derive the registrable domain (eTLD+1) from a host, so email addresses are built at the
// ORG's mail domain — not a web subdomain. research.ibm.com → ibm.com, www.fastcompany.com
// → fastcompany.com. Public-suffix aware for the common multi-label TLDs so co.uk-style
// domains keep their third label (bbc.co.uk stays bbc.co.uk, not co.uk).

// Common two-label public suffixes. Not exhaustive (the full PSL is huge) but covers the
// suffixes we actually encounter; anything else falls back to the last two labels.
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.jp", "or.jp", "ne.jp", "go.jp", "ac.jp",
  "com.br", "net.br", "org.br", "gov.br",
  "co.in", "net.in", "org.in", "gen.in", "firm.in",
  "com.sg", "com.hk", "com.tw", "com.mx", "com.tr", "com.cn", "com.ua",
  "co.za", "co.kr", "co.il", "co.id", "co.th",
]);

export function registrableDomain(host: string): string {
  const clean = host
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:.*$/, "")
    .toLowerCase()
    .replace(/\.$/, "");
  const labels = clean.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

// Do two hosts belong to the same organisation (same registrable domain)?
export function sameRegistrableDomain(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}
