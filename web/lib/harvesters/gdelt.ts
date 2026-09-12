import type { RawHit } from "@/lib/types";

const GDELT_API = "https://api.gdeltproject.org/api/v2/doc/doc";

export const gdeltHarvester = {
  name: "gdelt" as const,
  async run(query: string, opts?: { maxResults?: number; signal?: AbortSignal }): Promise<RawHit[]> {
    const max = opts?.maxResults ?? 250;
    const now = new Date().toISOString();

    const params = new URLSearchParams({
      query: query,
      mode: "artlist",
      maxrecords: String(Math.min(max, 250)),
      timespan: "CUSTOM",
      startdatetime: formatDate(new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)),
      enddatetime: formatDate(new Date()),
      format: "json",
      sort: "HybridRel",
    });

    try {
      const res = await fetch(`${GDELT_API}?${params}`, {
        headers: { "User-Agent": "GenAI-Scout/1.0" },
        signal: mergeSignal(opts?.signal, 15_000),
      });

      if (!res.ok) return [];
      const data = await res.json().catch(() => null);
      if (!data?.articles) return [];

      return (data.articles as any[]).map((a) => ({
        url: a.url ?? "",
        title: a.title ?? "",
        snippet: a.seendate ?? "",
        source: "gdelt",
        query,
        discoveredAt: now,
      })).filter((h) => h.url.startsWith("http"));
    } catch {
      return [];
    }
  },
};

function formatDate(d: Date): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function mergeSignal(abort: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  if (!abort) return t;
  return AbortSignal.any([abort, t]);
}
