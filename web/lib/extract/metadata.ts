export interface ExtractedMeta {
  title?: string;
  author?: string;
  authorUrl?: string;
  publishedAt?: string;
  description?: string;
  image?: string;
  publisher?: string;
  canonicalUrl?: string;
}

function attr(html: string, pattern: RegExp): string | undefined {
  return html.match(pattern)?.[1]?.trim() || undefined;
}

function decode(s?: string): string | undefined {
  return s?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

export function extractMetadata(html: string, url: string): ExtractedMeta {
  const meta: ExtractedMeta = {};

  // 1. JSON-LD
  const jsonldBlocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of jsonldBlocks) {
    try {
      const obj = JSON.parse(block[1]);
      // Flatten @graph (Yoast and most modern CMSs nest the Article/Person nodes in @graph).
      const raw = Array.isArray(obj) ? obj : [obj];
      const items = raw.flatMap((o: any) => (o && Array.isArray(o["@graph"]) ? [o, ...o["@graph"]] : [o]));
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        if (!meta.title && item.headline) meta.title = item.headline;
        if (!meta.publishedAt && (item.datePublished || item.dateModified)) {
          meta.publishedAt = item.datePublished ?? item.dateModified;
        }
        if (!meta.image && item.image) {
          meta.image = typeof item.image === "string" ? item.image : item.image?.url ?? item.image?.contentUrl;
        }
        if (!meta.description && item.description) meta.description = item.description;
        if (!meta.publisher && item.publisher?.name) meta.publisher = item.publisher.name;
        if (!meta.author && item.author) {
          let a: any = Array.isArray(item.author) ? item.author[0] : item.author;
          // author is often just an @id reference to a Person node elsewhere in @graph.
          if (a && typeof a === "object" && !a.name && a["@id"]) {
            const person = items.find((it: any) => it && it["@id"] === a["@id"] && (it.name || it["@type"] === "Person"));
            if (person) a = person;
          }
          const name = typeof a === "string" ? a : a?.name;
          if (name && typeof name === "string") {
            meta.author = name;
            const same = typeof a === "object" ? (a?.url ?? (Array.isArray(a?.sameAs) ? a.sameAs[0] : a?.sameAs)) : undefined;
            if (same) meta.authorUrl = same;
          }
        }
        if (!meta.canonicalUrl && item.url && typeof item.url === "string") meta.canonicalUrl = item.url;
      }
    } catch {}
  }

  // 2. OpenGraph
  if (!meta.title) meta.title = decode(attr(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i));
  if (!meta.image) meta.image = attr(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i);
  if (!meta.description) meta.description = decode(attr(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i));
  if (!meta.publisher) meta.publisher = attr(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i);
  if (!meta.canonicalUrl) meta.canonicalUrl = attr(html, /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)/i);

  // 3. Twitter Card
  if (!meta.title) meta.title = decode(attr(html, /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)/i));
  if (!meta.image) meta.image = attr(html, /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i);

  // 4. Standard HTML meta
  if (!meta.title) {
    meta.title = decode(attr(html, /<title[^>]*>([^<]+)<\/title>/i));
  }
  if (!meta.description) {
    meta.description = decode(attr(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i));
  }
  if (!meta.author) {
    meta.author = decode(attr(html, /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)/i));
  }
  // Author fallbacks for sites that don't put it in JSON-LD or <meta name=author> (e.g. 9to5mac,
  // Analytics India Mag, Analytics Vidhya). Downstream isLikelyPersonName filters out non-names.
  if (!meta.author) {
    const aa = attr(html, /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)/i);
    if (aa && !/^https?:\/\//i.test(aa)) meta.author = decode(aa);
  }
  if (!meta.author) {
    const rel = html.match(/<a[^>]+rel=["'][^"']*\bauthor\b[^"']*["'][^>]*>([^<]{2,60})<\/a>/i);
    if (rel) meta.author = decode(rel[1].replace(/^by\s+/i, "").trim());
  }
  // schema.org microdata (itemprop="author" scope with a nested itemprop="name"). The name
  // often sits several nodes deep — an avatar <img>, a "by" text node, and a profile <a> can
  // all come between the author marker and the name span (e.g. Shopify's blog). So search a
  // window after the author marker for the first itemprop="name" rather than requiring it
  // immediately adjacent (the old regex failed on exactly that structure → 0 authors).
  if (!meta.author) {
    const ip = html.match(/itemprop=["']author["'][\s\S]{0,600}?itemprop=["']name["'][^>]*>\s*([^<]{2,60})</i);
    if (ip) { const t = decode(ip[1].replace(/^(?:by|par|von|por)[:\s]+/i, "").trim()); if (t) meta.author = t; }
  }
  // Author-profile link slug fallback (e.g. Shopify's href="/blog/authors/alicia-clark" →
  // "Alicia Clark"). Only accept a multi-word result (first + last) so single-token slugs
  // like "staff" or "team" don't masquerade as a person; downstream isLikelyPersonName still
  // filters. Real casing from itemprop="name" above is preferred; this is the fallback.
  if (!meta.author) {
    const slug = html.match(/href=["'][^"']*\/authors?\/([a-z][a-z0-9]+(?:-[a-z0-9]+)+)["']/i);
    if (slug) {
      const name = slug[1].split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      if (/\s/.test(name)) meta.author = name;
    }
  }
  if (!meta.author) {
    const by = html.match(/<(?:a|span|div|p)[^>]+class=["'][^"']*(?:\bauthor\b|byline|by-line|author-name)[^"']*["'][^>]*>\s*(?:<a[^>]*>)?\s*([^<]{2,60})</i);
    if (by) { const t = decode(by[1].replace(/^by[:\s]+/i, "").trim()); if (t) meta.author = t; }
  }
  if (!meta.publishedAt) {
    meta.publishedAt =
      attr(html, /<meta[^>]+(?:name|property)=["'](?:article:published_time|pubdate)["'][^>]+content=["']([^"']+)/i) ??
      attr(html, /<time[^>]+datetime=["']([^"']+)/i);
  }
  if (!meta.canonicalUrl) {
    meta.canonicalUrl = attr(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i);
  }

  return meta;
}
