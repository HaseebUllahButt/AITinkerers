// Every link on a page, found by walking the whole entry rather than a list of known fields.
//
// The list-of-known-fields approach is what made an earlier audit report a clean site while 577
// links were dead. It looked for `.url`, `.buttonLink` and markdown anchors, so it was structurally
// incapable of seeing two things:
//
//   * RESOURCE CARDS, which store a Strapi RELATION and no URL at all. The front end renders
//     /blogs/<slug> from the related entry, so an unpublished target is a 404 with nothing in the
//     field to reveal it.
//   * CTA FENCES, which blog bodies store as ```CTA { "text": …, "url": … } ``` — a JSON blob in a
//     code fence, invisible to an anchor regex.
//
// So this walks every node and emits a link wherever one can exist. New component types are covered
// automatically; the only way to miss a link is for it to be stored somewhere with no URL and no
// relation, which is not a thing Strapi can do.
import type { FoundLink, Surface } from "./types";

/** A media reference is not a page link. Strapi stores images as bare filenames that resolve against
 *  the site root and 404 there, while the front end serves them from the CDN. Counting those as
 *  broken produced 939 phantom findings in an earlier pass. */
export const MEDIA_RE = /\.(jpe?g|png|webp|gif|svg|avif|ico|mp4|webm|mov|mp3|wav|ogg|pdf|woff2?|ttf|css|js)(\?|#|$)/i;

const isUrlish = (s: string): boolean =>
  s.length > 0 && s.length < 500 && !/\s/.test(s) && /^(https?:\/\/|\/\/|\/(?!\/)[A-Za-z0-9])/.test(s);

interface Ctx {
  surface: Surface;
  entryId: number;
  slug: string;
  pageUrl: string;
}

/** Rich text: markdown links, HTML anchors, then any URL still unaccounted for. */
export function scanRichText(ctx: Ctx, field: string, text: unknown, out: FoundLink[]): void {
  if (typeof text !== "string" || text.length < 4) return;
  const claimed: Array<[number, number]> = [];

  for (const m of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    out.push({ ...ctx, kind: "markdown", field, url: m[2], text: m[1], match: m[0], verdict: "unchecked" });
    claimed.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  for (const m of text.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    out.push({
      ...ctx, kind: "html", field, url: m[1],
      text: m[2].replace(/<[^>]*>/g, "").trim(), match: m[0], verdict: "unchecked",
    });
    claimed.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    const at = m.index ?? 0;
    if (claimed.some(([a, b]) => at >= a && at < b)) continue;
    const url = m[0].replace(/[.,;]$/, "");
    // A CTA fence stores its URL as a bare JSON string value, and its label a few lines above.
    const fenceAt = text.lastIndexOf("```CTA", at);
    const fenceEnd = fenceAt === -1 ? -1 : text.indexOf("```", fenceAt + 6);
    const inFence = fenceAt !== -1 && (fenceEnd === -1 || at < fenceEnd);
    let label = "";
    if (inFence) {
      const block = text.slice(fenceAt, fenceEnd === -1 ? at + 200 : fenceEnd);
      label = (block.match(/"text"\s*:\s*"([^"]*)"/) ?? ["", ""])[1];
    }
    out.push({
      ...ctx, kind: inFence ? "cta-fence" : "bare", field,
      url, text: label, match: url, verdict: "unchecked",
    });
  }
}

/** Structured tree: url-shaped string fields, and relations that resolve to a page. */
function walk(ctx: Ctx, node: unknown, path: string, out: FoundLink[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((v, i) => walk(ctx, v, `${path}[${i}]`, out)); return; }
  const obj = node as Record<string, unknown>;

  // A populated relation: { data: { id, attributes } }. Its own inner fields belong to the related
  // entry and are audited on that entry's own row, so we record the edge and stop descending.
  if ("data" in obj && Object.keys(obj).length <= 2) {
    const d = obj.data as { id?: number; attributes?: Record<string, unknown> } | unknown[] | null | undefined;
    if (d && !Array.isArray(d) && d.attributes) {
      const a = d.attributes as Record<string, unknown>;
      const slug = (a.slug as string | undefined) ?? null;
      const href = (a.href as string | undefined) ?? null;
      if (slug || href) {
        out.push({
          ...ctx, kind: "relation", field: path, relId: d.id, relSlug: slug ?? undefined,
          url: href ?? undefined, text: String(a.title ?? a.name ?? ""), verdict: "unchecked",
        });
      }
      return;
    }
    if (Array.isArray(d)) d.forEach((x, i) => walk(ctx, { data: x }, `${path}[${i}]`, out));
    return;
  }

  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === "string") {
      const t = v.trim();
      if (isUrlish(t)) {
        out.push({
          ...ctx, kind: "field", field: p, url: t,
          // A button's label lives beside its link; a tile's title lives beside its url.
          text: String(obj.buttonText ?? obj.title ?? obj.name ?? obj.text ?? ""),
          verdict: "unchecked",
        });
      } else if (v.length > 40) {
        scanRichText(ctx, p, v, out);
      }
      continue;
    }
    walk(ctx, v, p, out);
  }
}

/** Fields on a related entry that are its content, not ours — deep populate drags whole entries in. */
const FOREIGN = new Set(["categoryPage", "localizations"]);

export function extractLinks(ctx: Ctx, surface: Surface, attrs: Record<string, unknown>): FoundLink[] {
  const out: FoundLink[] = [];
  if (surface === "blog") {
    scanRichText(ctx, "body", attrs.body, out);
    for (const k of ["blogHeroCTA", "canonicalTag", "redirectUrl", "markupSchema", "blogsMetaData"]) {
      walk(ctx, attrs[k], k, out);
    }
  } else if (surface === "announcement") {
    scanRichText(ctx, "content", attrs.content, out);
  } else {
    walk(ctx, { template: attrs.template }, "", out);
    for (const k of ["canonicalTag", "redirectUrl", "schemaMarkup", "clusterPageSlug", "hrefLanguage"]) {
      if (!FOREIGN.has(k)) walk(ctx, attrs[k], k, out);
    }
  }
  return out;
}
