import { NextRequest, NextResponse } from "next/server";
import { upsertDomain, upsertAuthor, upsertArticle, linkArticleAuthor, upsertContact, linkAuthorsToCampaign, upsertScore } from "@/lib/db/queries";

function hostFrom(input: string): string {
  const s = input.trim().toLowerCase();
  try {
    if (s.startsWith("http")) return new URL(s).hostname.replace(/^www\./, "");
  } catch { /* fall through */ }
  return s.replace(/^www\./, "").replace(/\/.*$/, "");
}

function titleFromUrl(u: string): string {
  try {
    const last = new URL(u).pathname.split("/").filter(Boolean).pop() ?? "";
    return last.replace(/[-_]+/g, " ").replace(/\.\w+$/, "").trim() || u;
  } catch { return u; }
}

// POST { full_name, email?, publication?, article_urls: string[], campaign_id? } — manually
// add a prospect. Requires at least one article link (a prospect is an article author), so
// they always have article context and surface consistently. Creates author + domain +
// article(s) + optional email, and links to a campaign.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const fullName = (body.full_name ?? "").trim();
    if (!fullName) return NextResponse.json({ error: "full_name is required" }, { status: 400 });

    // Article links — accept an array (or a single legacy article_url). At least one required.
    const rawUrls: string[] = Array.isArray(body.article_urls)
      ? body.article_urls
      : body.article_url ? [body.article_url] : [];
    const articleUrls = [...new Set(rawUrls.map((u) => (u ?? "").trim()).filter((u) => /^https?:\/\//i.test(u)))];
    if (articleUrls.length === 0) {
      return NextResponse.json({ error: "At least one article link (https://…) is required." }, { status: 400 });
    }

    const email = (body.email ?? "").trim();
    // Derive the publication domain: explicit field → email domain → first article's host.
    let host = body.publication ? hostFrom(body.publication) : "";
    if (!host && email.includes("@")) host = email.split("@")[1].toLowerCase();
    if (!host) host = hostFrom(articleUrls[0]);
    if (!host) return NextResponse.json({ error: "Could not determine a publication domain." }, { status: 400 });

    const domain = await upsertDomain(host, { name: body.publication_name ?? host });
    const author = await upsertAuthor({
      full_name: fullName,
      primary_domain_id: domain.id,
      source: "manual",
      role: "writer",
    });

    // Create each article and link it to the author (dedup by url_canonical).
    for (const url of articleUrls) {
      const articleHost = hostFrom(url);
      const artDomain = articleHost === host ? domain : await upsertDomain(articleHost, { name: articleHost }).catch(() => domain);
      const article = await upsertArticle({
        url_canonical: url,
        title: titleFromUrl(url),
        domain_id: (artDomain ?? domain).id,
        source: "manual",
      }).catch(() => null);
      if (article) await linkArticleAuthor(article.id, author.id).catch(() => {});
    }

    if (email && email.includes("@")) {
      await upsertContact({
        author_id: author.id, type: "mailto", value: `mailto:${email}`,
        confidence: 1, source: "manual", verified_syntax: true,
      }).catch(() => {});
    }

    // Seed a minimal score so manual adds surface in sorted prospect lists.
    await upsertScore({ author_id: author.id, composite: 50, relevance: 50, authority: 50, freshness: 50 }).catch(() => {});

    if (body.campaign_id) {
      await linkAuthorsToCampaign(body.campaign_id, [author.id]).catch(() => {});
    }

    return NextResponse.json({ ok: true, author_id: author.id, articles: articleUrls.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
