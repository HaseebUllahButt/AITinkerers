export interface ReadabilityResult {
  title?: string;
  textContent: string;
  excerpt?: string;
  byline?: string;
}

export async function extractReadability(html: string, url: string): Promise<ReadabilityResult | null> {
  try {
    const { Readability } = await import("@mozilla/readability");
    // linkedom instead of jsdom: jsdom spins up a V8 VM context per parse that is
    // never reclaimed by GC, leaking ~1MB/article (verified — heap climbs to 1GB+ over
    // a run and never drops). linkedom is a pure-JS DOM with no VM context; heap stays flat.
    const { parseHTML } = await import("linkedom");

    const { document } = parseHTML(html);
    const reader = new Readability(document);
    const article = reader.parse();
    if (!article) return null;
    return {
      title: article.title ?? undefined,
      textContent: article.textContent ?? "",
      excerpt: article.excerpt ?? article.textContent?.slice(0, 300),
      byline: article.byline ?? undefined,
    };
  } catch {
    return null;
  }
}
