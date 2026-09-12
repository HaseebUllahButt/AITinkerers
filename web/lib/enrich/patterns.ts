// Generate candidate email addresses from a name + domain, ordered most-common first.
// Paired with a verifier (Reoon) so we only keep the address that actually exists.

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
}

export function emailCandidates(fullName: string, domain: string): string[] {
  const clean = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
  const parts = fullName.trim().split(/\s+/).map(norm).filter(Boolean);
  if (parts.length === 0 || !clean) return [];

  const first = parts[0];
  const last = parts[parts.length - 1];
  const fi = first[0];
  const li = last[0];

  const locals = new Set<string>();
  if (first && last && first !== last) {
    locals.add(`${first}.${last}`);   // jane.smith
    locals.add(`${first}`);           // jane
    locals.add(`${fi}${last}`);       // jsmith
    locals.add(`${first}${last}`);    // janesmith
    locals.add(`${first}_${last}`);   // jane_smith
    locals.add(`${fi}.${last}`);      // j.smith
    locals.add(`${last}`);            // smith
    locals.add(`${last}${fi}`);       // smithj
    locals.add(`${first}${li}`);      // janes
  } else {
    locals.add(first);
  }

  return [...locals].map((l) => `${l}@${clean}`);
}
