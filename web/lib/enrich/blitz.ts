// BlitzAPI lead enrichment. There is no direct name+domain→email endpoint, so we chain:
//   domain → company LinkedIn → employees at company → match by name → LinkedIn → email.
// Auth is the x-api-key header. Rate limit is 5 req/s per endpoint.

const BASE = "https://api.blitz-api.ai";

function key(): string | null {
  return process.env.BLITZ_API_KEY ?? null;
}

// onError (optional) fires ONLY on a real API failure (HTTP error / network / timeout),
// never on a clean "found: false". Lets callers tell "Blitz broke" from "Blitz had nothing".
async function post<T = any>(path: string, body: object, onError?: (msg: string) => void): Promise<T | null> {
  const k = key();
  if (!k) { onError?.("no BLITZ_API_KEY"); return null; }
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "x-api-key": k, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) { onError?.(`HTTP ${res.status}`); return null; }
    return (await res.json()) as T;
  } catch (e: any) {
    onError?.(e?.name === "TimeoutError" ? "timeout" : (e?.message ?? "network error"));
    return null;
  }
}

export interface BlitzPerson {
  full_name?: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  linkedin_url?: string;
}

export function blitzEnabled(): boolean {
  return !!key();
}

export async function domainToCompany(domain: string): Promise<string | null> {
  const r = await post<{ found?: boolean; company_linkedin_url?: string }>("/v2/enrichment/domain-to-linkedin", { domain });
  return r?.found && r.company_linkedin_url ? r.company_linkedin_url : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Paginate the employee finder (50/page cap) to build a bigger pool → better name matches.
export async function findEmployees(companyLinkedinUrl: string, maxPages = 6, throttleMs = 220): Promise<BlitzPerson[]> {
  const all: BlitzPerson[] = [];
  let page = 1, totalPages = 1;
  do {
    const r = await post<{ results?: BlitzPerson[]; total_pages?: number }>("/v2/search/employee-finder", {
      company_linkedin_url: companyLinkedinUrl,
      max_results: 50,
      page,
    });
    if (r?.results?.length) all.push(...r.results);
    totalPages = r?.total_pages ?? 1;
    page++;
    if (page <= Math.min(totalPages, maxPages)) await sleep(throttleMs);
  } while (page <= Math.min(totalPages, maxPages));
  return all;
}

export async function linkedinToEmail(personLinkedinUrl: string, onError?: (msg: string) => void): Promise<string | null> {
  const r = await post<{ found?: boolean; email?: string }>("/v2/enrichment/email", { person_linkedin_url: personLinkedinUrl }, onError);
  return r?.found && r.email ? r.email : null;
}

export function normalizeName(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
}

// Match an author name against a company's employee list. Exact normalized match first,
// else require both first and last name tokens to appear.
export function matchPerson(authorName: string, people: BlitzPerson[]): BlitzPerson | null {
  const target = normalizeName(authorName);
  if (!target) return null;
  const targetTokens = target.split(" ").filter(Boolean);

  for (const p of people) {
    if (p.full_name && normalizeName(p.full_name) === target) return p;
  }
  if (targetTokens.length >= 2) {
    const first = targetTokens[0], last = targetTokens[targetTokens.length - 1];
    for (const p of people) {
      const pn = normalizeName(p.full_name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`);
      if (pn.includes(first) && pn.includes(last)) return p;
    }
  }
  return null;
}

// Company/employee cache so multiple authors at the same domain reuse the two lookups.
export class BlitzDomainCache {
  private companies = new Map<string, string | null>();
  private employees = new Map<string, BlitzPerson[]>();

  async employeesForDomain(domain: string): Promise<BlitzPerson[]> {
    if (!this.companies.has(domain)) {
      this.companies.set(domain, await domainToCompany(domain));
    }
    const company = this.companies.get(domain);
    if (!company) return [];
    if (!this.employees.has(company)) {
      this.employees.set(company, await findEmployees(company));
    }
    return this.employees.get(company) ?? [];
  }
}

// One-shot: name + domain → email (uses a fresh cache; for bulk use BlitzDomainCache directly).
export async function findEmailByNameDomain(name: string, domain: string): Promise<string | null> {
  const cache = new BlitzDomainCache();
  const people = await cache.employeesForDomain(domain);
  const match = matchPerson(name, people);
  if (!match?.linkedin_url) return null;
  return linkedinToEmail(match.linkedin_url);
}

// Bulk: resolve emails for many authors, grouping by domain (shared company/employee
// lookups) and throttling to stay under the rate limit. Returns authorId → email for hits.
export async function bulkFindEmails(
  authors: Array<{ id: string; name: string; domain: string }>,
  opts?: { throttleMs?: number; cap?: number; onResult?: (id: string, email: string) => void | Promise<void> },
): Promise<Record<string, string>> {
  const throttle = opts?.throttleMs ?? 220;
  const cap = opts?.cap ?? authors.length;
  const cache = new BlitzDomainCache();
  const out: Record<string, string> = {};

  // Group by domain so each company's employee list is fetched once.
  const byDomain = new Map<string, typeof authors>();
  for (const a of authors) {
    if (!a.domain) continue;
    if (!byDomain.has(a.domain)) byDomain.set(a.domain, []);
    byDomain.get(a.domain)!.push(a);
  }

  let processed = 0;
  for (const [domain, list] of byDomain) {
    if (processed >= cap) break;
    const people = await cache.employeesForDomain(domain); // cached lookups (throttled inside findEmployees)
    if (!people.length) continue;
    for (const a of list) {
      if (processed >= cap) break;
      processed++;
      const match = matchPerson(a.name, people);
      if (!match?.linkedin_url) continue;
      await sleep(throttle);
      const email = await linkedinToEmail(match.linkedin_url);
      if (email) { out[a.id] = email; await opts?.onResult?.(a.id, email); }
    }
  }
  return out;
}
