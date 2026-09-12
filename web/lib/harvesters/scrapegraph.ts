import type { RawHit } from "@/lib/types";

// ScrapeGraphAI web search — LLM-powered search that returns source URLs to ingest as
// discovery hits. Gated by SGAI_API_KEY (500 free credits one-time; ~2 credits/result
// with no prompt), so it stays off until a key is set. Kept conservative to save credits.
export const scrapegraphHarvester = {
  name: "scrapegraph" as const,

  async run(query: string, opts?: { maxResults?: number; signal?: AbortSignal }): Promise<RawHit[]> {
    if (!process.env.SGAI_API_KEY) return [];
    const now = new Date().toISOString();
    try {
      const { ScrapeGraphAI } = await import("scrapegraph-js");
      const sgai = ScrapeGraphAI({ apiKey: process.env.SGAI_API_KEY });
      // No prompt = cheapest (harvest URLs only). Recent results only.
      const res = await sgai.search({
        query,
        numResults: Math.min(opts?.maxResults ?? 5, 10),
        format: "markdown",
        mode: "normal",
      });
      if (opts?.signal?.aborted) return [];
      if (res?.status !== "success") return [];

      return (((res.data as any)?.results ?? []) as any[])
        .map((r: any) => ({
          url: r.url as string,
          title: (r.title as string) ?? "",
          snippet: (r.content as string)?.slice(0, 300) ?? "",
          source: "scrapegraph",
          query,
          discoveredAt: now,
        }))
        .filter((h: RawHit) => h.url?.startsWith("http"));
    } catch {
      return [];
    }
  },
};
