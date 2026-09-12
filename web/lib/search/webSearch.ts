// Web search for competitor discovery.
//
// Deliberately single-provider: Exa only. Competitor discovery asks "who else does what this site
// does", which is a question about meaning; a keyword engine answers it with pages that happen to
// share words, which is a different and worse list. One provider also keeps cost and data routing
// predictable — no key present in the environment can quietly become a fallback.
//
// `type: "auto"` lets Exa choose between its neural index and a keyword fallback per query;
// forcing "neural" makes a query that is genuinely keyword-shaped (a brand name, a URL) return
// semantically-adjacent pages instead of the obvious exact match.

export interface SearchHit { url: string; title: string; snippet: string }

/** Every configured provider, in order of preference. */
export function searchProviders(): string[] {
  return process.env.EXA_API_KEY ? ["exa"] : [];
}

export function searchProvider(): string | null {
  return searchProviders()[0] ?? null;
}

export function searchEnabled(): boolean {
  return searchProviders().length > 0;
}

/**
 * Search with fall-through, reporting which provider actually answered — callers that label
 * their sources need the real one, not the first configured.
 */
export async function webSearchDetailed(
  query: string,
  count = 8,
  signal?: AbortSignal,
  onError?: (msg: string) => void,
): Promise<{ provider: string | null; hits: SearchHit[] }> {
  const providers = searchProviders();
  if (!providers.length) { onError?.("EXA_API_KEY is not set"); return { provider: null, hits: [] }; }
  for (const provider of providers) {
    const hits = await searchOne(provider, query, count, signal, onError);
    if (hits.length) return { provider, hits };
  }
  return { provider: null, hits: [] };
}

export async function webSearch(query: string, count = 8, signal?: AbortSignal, onError?: (msg: string) => void): Promise<SearchHit[]> {
  return (await webSearchDetailed(query, count, signal, onError)).hits;
}

/** One provider, one attempt. Every failure mode — HTTP error, timeout, thrown fetch — comes
 *  back as [] so callers degrade rather than break. */
async function searchOne(
  provider: string,
  query: string,
  count: number,
  signal: AbortSignal | undefined,
  onError?: (msg: string) => void,
): Promise<SearchHit[]> {
  const sig = signal ?? AbortSignal.timeout(12000);
  try {
    if (provider === "exa") {
      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.EXA_API_KEY ?? "" },
        body: JSON.stringify({
          query,
          numResults: count,
          type: "auto",
          // Ask for a short extract rather than the full page: callers want a snippet to judge
          // relevance, and full text would be megabytes across ten results.
          contents: { text: { maxCharacters: 400 } },
        }),
        signal: sig,
      });
      if (!res.ok) { onError?.(`exa HTTP ${res.status}`); return []; }
      const d = await res.json();
      return ((d.results ?? []) as Array<{ url?: string; title?: string; text?: string; snippet?: string }>)
        .slice(0, count)
        .map((r) => ({
          url: String(r.url ?? ""),
          title: String(r.title ?? ""),
          snippet: String(r.text ?? r.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
        }))
        .filter((h: SearchHit) => h.url.startsWith("http"));
    }

    return [];
  } catch (e: any) {
    onError?.(`${provider}: ${e?.name === "TimeoutError" ? "search timed out" : (e?.message ?? "search network error")}`);
    return [];
  }
}
