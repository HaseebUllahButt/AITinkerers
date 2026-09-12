import type { RawHit } from "@/lib/types";
import { upsertAuthor, upsertDomain, linkArticleAuthor, upsertArticle, upsertContact } from "@/lib/db/queries";

const UA = "GenAI-Scout/1.0 (+http://localhost:3000)";

export const wordpressHarvester = {
  name: "wordpress" as const,

  async isWordPress(domain: string): Promise<boolean> {
    try {
      const res = await fetch(`https://${domain}/wp-json/wp/v2/`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(8_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  async run(query: string, opts?: { domains?: string[]; signal?: AbortSignal }): Promise<RawHit[]> {
    const domains = opts?.domains ?? [];
    const now = new Date().toISOString();
    const hits: RawHit[] = [];
    const abort = opts?.signal;

    for (const domain of domains) {
      if (abort?.aborted) break;
      if (!(await this.isWordPress(domain))) continue;

      try {
        const params = new URLSearchParams({
          search: query,
          _embed: "true",
          per_page: "20",
          orderby: "date",
          order: "desc",
        });

        const res = await fetch(`https://${domain}/wp-json/wp/v2/posts?${params}`, {
          headers: { "User-Agent": UA },
          signal: mergeSignal(abort, 12_000),
        });

        if (!res.ok) continue;
        const posts: any[] = await res.json().catch(() => []);

        for (const post of posts) {
          const url = post.link ?? post.guid?.rendered;
          if (!url) continue;

          hits.push({
            url,
            title: post.title?.rendered?.replace(/<[^>]+>/g, "") ?? "",
            snippet: post.excerpt?.rendered?.replace(/<[^>]+>/g, "").slice(0, 300) ?? "",
            source: "wordpress",
            query,
            discoveredAt: now,
          });

          // Extract author directly from WP API
          const embeddedAuthor = post._embedded?.author?.[0];
          if (embeddedAuthor) {
            await ingestWordPressAuthor(embeddedAuthor, domain, url);
          }
        }
      } catch {
        continue;
      }
    }

    return hits;
  },
};

function mergeSignal(abort: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  if (!abort) return t;
  return AbortSignal.any([abort, t]);
}

async function ingestWordPressAuthor(wpAuthor: any, domain: string, articleUrl: string) {
  try {
    const domainRow = await upsertDomain(domain, { cms_guess: "wordpress" });
    const author = await upsertAuthor({
      full_name: wpAuthor.name ?? "Unknown",
      slug: wpAuthor.slug,
      avatar_url: wpAuthor.avatar_urls?.["96"] ?? wpAuthor.avatar_urls?.["48"],
      bio: wpAuthor.description,
      role: "writer",
      primary_domain_id: domainRow.id,
      source: "wordpress",
      same_as_json: wpAuthor.link ? [wpAuthor.link] : [],
    });

    // Store author page as contact
    if (wpAuthor.link) {
      await upsertContact({
        author_id: author.id,
        type: "author_page",
        value: wpAuthor.link,
        confidence: 0.95,
        source: "wordpress",
        verified_syntax: true,
      });
    }

    // Link to article if we have it
    const articleRow = await upsertArticle({
      url_canonical: articleUrl,
      domain_id: domainRow.id,
      source: "wordpress",
    });
    await linkArticleAuthor(articleRow.id, author.id);
  } catch {
    // non-fatal
  }
}
