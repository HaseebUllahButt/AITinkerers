// Finding a link inside a Strapi entry precisely enough to rewrite it.
//
// ── Provenance ─────────────────────────────────────────────────────────────────────────────────
//
// Ported from Vyro-ai/page-links-validator (muhammadarsalan100), which solved this properly. The hard
// parts are not obvious and every one of them is load-bearing, so they are kept rather than
// reinterpreted:
//
//   fieldPath            an array path into the entry, so a write targets one field and not the record
//   bodyOccurrenceIndex  WHICH occurrence — the same URL appears many times in one body, and replacing
//                        the first when the reader meant the third silently edits the wrong sentence
//   raw                  the exact original substring, so a replacement is byte-for-byte
//   bodyFormat           markdown-link | cta-fence | bare-url — each rewrites differently
//   owner                a link behind a RELATION belongs to a different record; writing it to the
//                        scanned page would either fail or corrupt the wrong entry
//
// ── What is new here ───────────────────────────────────────────────────────────────────────────
//
// That tool fixes one link at a time, typed in by hand. This is the same locator wired to a bulk
// queue, and the matcher is pluggable — a "target is dead" matcher and a "path starts with /features/"
// matcher are the same operation over the same walk, which is why the prefix rename and the 404 repair
// are one engine rather than two.
//
// ── Schema is bundled, not fetched ─────────────────────────────────────────────────────────────
//
// The walk needs to know whether a nested object is a COMPONENT (same record) or a RELATION (different
// record). That distinction lives in Strapi's content-type-builder API, which this codebase has a
// standing rule against probing: it is the first thing to fall over under concurrent requests and it
// cannot be restarted from here. So the snapshot ships as JSON — 367 uids, generated once by the
// upstream tool's own script. Stale schema degrades to treating a relation as a component, which is
// caught at write time by the owner check rather than corrupting anything.
import snapshot from "./schemaSnapshot.json";

interface SchemaField { kind: "component" | "relation" | "dynamiczone" | "other"; targetUid?: string }
interface SchemaEntry { uid: string; kind: string; attributes: Record<string, SchemaField> }

const SCHEMA = snapshot as unknown as Record<string, SchemaEntry>;

export function fieldInfo(uid: string | null, key: string): SchemaField | undefined {
  if (!uid) return undefined;
  return SCHEMA[uid]?.attributes?.[key];
}

/** `api::imagine-web.imagine-web` → `imagine-webs`. Needed to write to a relation's own record. */
export function pluralApiOf(uid: string): string | null {
  const entry = SCHEMA[uid];
  if (!entry) return null;
  const singular = uid.split(".").pop() ?? "";
  // Strapi's own pluralisation for the collections in play: a trailing 'y' → 'ies', else + 's'.
  if (!singular) return null;
  return /y$/.test(singular) ? `${singular.slice(0, -1)}ies` : `${singular}s`;
}

// ── URL → content type ────────────────────────────────────────────────────────────────────────────
//
// Replicates imagine-web's own route scheme. Ordered, most specific first — `/features/x` has to be
// tested before the single-segment catch-all, or every feature page resolves as a category page.

export interface ContentTypeMeta {
  key: string;
  pluralApi: string;
  slugField: string;
  apiUid: string;
}

export const CONTENT_TYPES: Record<string, ContentTypeMeta> = {
  "imagine-web": { key: "imagine-web", pluralApi: "imagine-webs", slugField: "slug", apiUid: "api::imagine-web.imagine-web" },
  resource: { key: "resource", pluralApi: "resources", slugField: "slug", apiUid: "api::resource.resource" },
  "cluster-page": { key: "cluster-page", pluralApi: "cluster-pages", slugField: "slug", apiUid: "api::cluster-page.cluster-page" },
  "category-page": { key: "category-page", pluralApi: "category-pages", slugField: "category", apiUid: "api::category-page.category-page" },
  "mini-app": { key: "mini-app", pluralApi: "mini-apps", slugField: "slug", apiUid: "api::mini-app.mini-app" },
  announcement: { key: "announcement", pluralApi: "announcements", slugField: "slug", apiUid: "api::announcement.announcement" },
};

/**
 * The path prefixes that map onto CMS content.
 *
 * `FEATURE_PREFIX` is deliberately a variable rather than a literal in the regex: the prefix-rename
 * automation has to be able to resolve a page under either the old or the new prefix while a migration
 * is in flight, and a hardcoded /features would stop resolving the day the route is renamed.
 */
export const CLUSTER_PREFIXES = ["features", "models", "tools", "tool"] as const;

const PATH_RULES: Array<{ test: RegExp; contentType: string; slug: (m: RegExpMatchArray) => string }> = [
  { test: /^\/blogs\/([^/]+)\/?$/, contentType: "imagine-web", slug: (m) => m[1] },
  { test: /^\/announcements\/([^/]+)\/?$/, contentType: "announcement", slug: (m) => m[1] },
  { test: /^\/business\/resources\/([^/]+)\/?$/, contentType: "resource", slug: (m) => m[1] },
  { test: /^\/business\/(?:industries|solutions)\/([^/]+)\/?$/, contentType: "cluster-page", slug: (m) => m[1] },
  { test: new RegExp(`^/(?:${CLUSTER_PREFIXES.join("|")})/([^/]+)/?$`), contentType: "cluster-page", slug: (m) => m[1] },
  { test: /^\/lp\/[^/]+\/([^/]+)\/?$/, contentType: "cluster-page", slug: (m) => m[1] },
  { test: /^\/apps\/([^/]+)\/?$/, contentType: "mini-app", slug: (m) => m[1] },
  { test: /^\/([^/]+)\/?$/, contentType: "category-page", slug: (m) => m[1] },
];

/** Paths with no CMS record behind them, so nothing to rewrite. */
const OUT_OF_SCOPE = ["/business/case-studies", "/community", "/dashboard", "/read", "/c/"];

export interface ResolvedPage {
  path: string;
  contentType: string;
  pluralApi: string;
  slugField: string;
  slugValue: string;
}

export function toPath(raw: string): string {
  try {
    const u = raw.startsWith("http") ? new URL(raw) : new URL(raw, "https://www.imagine.art");
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch { return raw; }
}

export function resolvePage(raw: string): ResolvedPage | { error: string } {
  const path = toPath(raw);
  if (OUT_OF_SCOPE.some((p) => path.startsWith(p))) {
    return { error: `${path} has no CMS record behind it, so there is nothing here to rewrite.` };
  }
  for (const rule of PATH_RULES) {
    const m = path.match(rule.test);
    if (!m) continue;
    const meta = CONTENT_TYPES[rule.contentType];
    return { path, contentType: meta.key, pluralApi: meta.pluralApi, slugField: meta.slugField, slugValue: rule.slug(m) };
  }
  return { error: `Could not map ${path} to a known content type.` };
}

// ── The link walk ─────────────────────────────────────────────────────────────────────────────────

const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g;
const BARE_URL = /https?:\/\/[^\s)<>"'\]]+/g;
const CTA_FENCE = /```[ \t]*CTA[ \t]*\r?\n([\s\S]*?)```/gi;
const LINK_KEY = /url|link|href/i;
const TEXT_KEY = /text|label|title|heading|name/i;
const SKIP_KEYS = new Set(["id", "createdAt", "updatedAt", "publishedAt", "locale"]);
const MIN_SCANNABLE = 12;

export interface LinkOwner { pluralApi: string; entryId: number }

export interface FoundLink {
  id: string;
  url: string;
  text: string;
  /**
   * How this link is expressed, which decides how it is rewritten:
   *   "cta"           the field IS a url
   *   "body"          free text containing one (markdown link, CTA fence, bare autolink)
   *   "blog-resource" a blogResourceItems entry — a RELATION to a blog, not a url at all
   */
  source: "cta" | "body" | "blog-resource";
  fieldPath: string[];
  section?: string;
  /** body only */
  raw?: string;
  bodyFormat?: "markdown-link" | "cta-fence" | "bare-url";
  bodyOccurrenceIndex?: number;
  arrayIndex?: number;
  /** Set when the link lives on a DIFFERENT record reached through a relation. */
  owner?: LinkOwner;
  ownerFieldPath?: string[];
  /**
   * blog-resource only: the related blog, and whether it is currently published.
   *
   * `publishedAt: null` is the authoritative test for a broken card — better than an HTTP check,
   * because it is the actual cause rather than a symptom, and it needs no network call.
   */
  relation?: { collection: string; id: number; slug: string | null; published: boolean };
  /** blog-resource only: index of this item within blogResourceItems, for removal. */
  itemIndex?: number;
  /** blog-resource only: the item component's own Strapi id. */
  itemId?: number;
}

function looksLikeUrl(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && (v.startsWith("http") || v.startsWith("/"));
}

function humanize(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

/** ["template","0","heroSection","cta"] → "Hero Section". Skips zone/array index selectors. */
function sectionLabel(path: Array<string | number>): string | undefined {
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (typeof seg !== "string") continue;
    const next = path[i + 1];
    if (typeof next === "number" || (typeof next === "string" && /^\d+$/.test(next))) { i++; continue; }
    return humanize(seg);
  }
  return undefined;
}

function textLinks(text: string, fieldPath: Array<string | number>): FoundLink[] {
  if (!text || text.length < MIN_SCANNABLE) return [];
  const out: FoundLink[] = [];
  const consumed: Array<[number, number]> = [];
  const counts = new Map<string, number>();
  const key = fieldPath.join(".");
  const overlaps = (s: number, e: number) => consumed.some(([cs, ce]) => s < ce && e > cs);

  const push = (e: Omit<FoundLink, "id" | "fieldPath" | "bodyOccurrenceIndex">, occ: number) => {
    out.push({ ...e, id: `${key}:${out.length}`, fieldPath: fieldPath.map(String), bodyOccurrenceIndex: occ });
  };

  for (const m of text.matchAll(CTA_FENCE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    let parsed: unknown;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    const isArray = Array.isArray(parsed);
    const items = (isArray ? parsed : [parsed]) as Array<{ text?: unknown; url?: unknown }>;
    const valid = items.map((_, i) => i).filter((i) => typeof items[i]?.text === "string" && typeof items[i]?.url === "string");
    if (!valid.length) continue;
    consumed.push([start, start + raw.length]);
    // Every button in one fence shares the FENCE's occurrence index — they are the same physical
    // substring. Counting per-button would treat one appearance as several and splice the wrong one.
    const occ = counts.get(raw) ?? 0;
    counts.set(raw, occ + 1);
    for (const i of valid) {
      push({
        url: String(items[i].url), text: String(items[i].text), source: "body", raw,
        bodyFormat: "cta-fence", ...(isArray ? { arrayIndex: i } : {}),
      }, occ);
    }
  }

  for (const m of text.matchAll(MARKDOWN_LINK)) {
    const [raw, label, url] = m;
    const start = m.index ?? 0;
    if (overlaps(start, start + raw.length)) continue;
    consumed.push([start, start + raw.length]);
    const occ = counts.get(raw) ?? 0;
    counts.set(raw, occ + 1);
    push({ url, text: label, source: "body", raw, bodyFormat: "markdown-link" }, occ);
  }

  for (const m of text.matchAll(BARE_URL)) {
    const start = m.index ?? 0;
    // "visit https://x.com." — the full stop is a sentence, not the URL. Trim it and shrink the span
    // so occurrence-splicing does not eat the punctuation.
    const trimmed = m[0].replace(/[.,;:!?]+$/, "");
    if (!trimmed) continue;
    if (overlaps(start, start + trimmed.length)) continue;
    const occ = counts.get(trimmed) ?? 0;
    counts.set(trimmed, occ + 1);
    push({ url: trimmed, text: trimmed, source: "body", raw: trimmed, bodyFormat: "bare-url" }, occ);
  }

  return out;
}

interface Cursor {
  uid: string | null;
  owner: LinkOwner;
  ownerPath: Array<string | number>;
  crossed: boolean;
}

function walk(node: unknown, path: Array<string | number>, out: FoundLink[], cur: Cursor): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, [...path, i], out, { ...cur, ownerPath: [...cur.ownerPath, i] }));
    return;
  }
  if (!node || typeof node !== "object") return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (SKIP_KEYS.has(key)) continue;

    if (LINK_KEY.test(key) && looksLikeUrl(value)) {
      const obj = node as Record<string, unknown>;
      const textKey = Object.keys(obj).find((k) => k !== key && TEXT_KEY.test(k) && typeof obj[k] === "string");
      out.push({
        id: [...path, key].join("."),
        url: value, text: textKey ? String(obj[textKey]) : humanize(key),
        source: "cta", fieldPath: [...path, key].map(String), section: sectionLabel(path),
        ...(cur.crossed ? { owner: cur.owner, ownerFieldPath: [...cur.ownerPath, key].map(String) } : {}),
      });
      continue;
    }

    if (typeof value === "string") {
      const found = textLinks(value, [...path, key]);
      for (const l of found) {
        l.section = sectionLabel(path);
        if (cur.crossed) { l.owner = cur.owner; l.ownerFieldPath = [...cur.ownerPath, key].map(String); }
      }
      out.push(...found);
      continue;
    }

    if (!value || typeof value !== "object") continue;

    // ── blogResourceItems: one finding per card, and do NOT descend ────────────────────────────
    //
    // Each item is `{ id, blog: <relation to imagine-webs> }` and the card on the page renders from
    // that blog's own title and asset. So the "link" is the relation, not a url string, and the
    // generic walk below would miss it entirely.
    //
    // Descending is also actively wrong here. The relation populates the whole blog — body included —
    // so walking into it harvests every link inside five full articles and attributes them to those
    // articles. Measured on /features/ai-tattoo-generator: 135 links found, 91 of them "on a related
    // record", which is this. Correct ownership, useless granularity: a scan of a feature page should
    // not offer to edit the body of five blogs.
    if (key === "blogResourceItems" && Array.isArray(value)) {
      value.forEach((item, i) => {
        const it = item as { id?: unknown; blog?: Record<string, unknown> | null };
        const blog = it?.blog ?? null;
        const bid = typeof blog?.id === "number" ? blog.id : null;
        const slug = typeof blog?.slug === "string" ? blog.slug : null;
        const published = !!blog?.publishedAt;
        out.push({
          id: [...path, key, i].join("."),
          // The live URL the card points a reader at. Null slug means the relation itself is missing.
          url: slug ? `https://www.imagine.art/blogs/${slug}` : "",
          text: typeof blog?.title === "string" ? blog.title : "(no blog attached)",
          source: "blog-resource",
          fieldPath: [...path, key, i].map(String),
          section: sectionLabel(path),
          itemIndex: i,
          itemId: typeof it?.id === "number" ? it.id : undefined,
          relation: bid !== null ? { collection: "imagine-webs", id: bid, slug, published } : undefined,
          ...(cur.crossed ? { owner: cur.owner, ownerFieldPath: [...cur.ownerPath, key, i].map(String) } : {}),
        });
      });
      continue;
    }

    const info = fieldInfo(cur.uid, key);

    if (info?.kind === "relation" && info.targetUid) {
      const plural = pluralApiOf(info.targetUid);
      if (plural) {
        const items = Array.isArray(value) ? value : [value];
        items.forEach((item, i) => {
          const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
          const itemPath = Array.isArray(value) ? [...path, key, i] : [...path, key];
          // A relation with a real id is a different RECORD — everything below it is owned by that
          // record and a write must go there. Without an id it is an inline object, so ownership
          // does not change.
          const next: Cursor = typeof id === "number"
            ? { uid: info.targetUid!, owner: { pluralApi: plural, entryId: id }, ownerPath: [], crossed: true }
            : { ...cur, uid: info.targetUid!, ownerPath: [...cur.ownerPath, key] };
          walk(item, itemPath, out, next);
        });
        continue;
      }
    }

    if (info?.kind === "dynamiczone" && Array.isArray(value)) {
      value.forEach((item, i) => {
        const uid = item && typeof item === "object" ? (item as { __component?: string }).__component : undefined;
        walk(item, [...path, key, i], out, { ...cur, uid: uid ?? null, ownerPath: [...cur.ownerPath, key, i] });
      });
      continue;
    }

    walk(value, [...path, key], out, { ...cur, uid: info?.targetUid ?? null, ownerPath: [...cur.ownerPath, key] });
  }
}

export function extractLinks(contentType: string, entry: Record<string, unknown>): FoundLink[] {
  const meta = CONTENT_TYPES[contentType];
  if (!meta) return [];
  const out: FoundLink[] = [];
  walk(entry, [], out, {
    uid: meta.apiUid,
    owner: { pluralApi: meta.pluralApi, entryId: entry.id as number },
    ownerPath: [], crossed: false,
  });
  return out;
}
