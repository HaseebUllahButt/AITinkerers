// Reading and writing one Strapi entry, gently.
//
// ── "Gently" is a hard requirement here, not a courtesy ────────────────────────────────────────
//
// This codebase has a standing rule about imagine-blog.vyro.ai: never loop-probe it and never fire
// concurrent requests at it. It folds before it errors, the content-type-builder goes first, and it
// cannot be restarted from this side. A bulk link rewriter is exactly the shape of tool that breaks
// that rule by accident — hundreds of entries, each needing a read and maybe a write.
//
// So every request in this module goes through `gently()`: one at a time, process-wide, with a floor
// on the gap between them. It is slower on purpose. A rewrite of 500 entries that takes twenty minutes
// and finishes is worth more than one that takes two and takes the CMS down with it.
//
// ── Populate is built from the schema, not a wildcard ──────────────────────────────────────────
//
// `populate=*` returns one level and silently drops everything below it, which on a cluster-page means
// the entire template — the dynamic zone where most of the links actually live. The landing work in
// this repo hit the same wall. So the populate object is built from the bundled schema, and dynamic
// zones need a shallow first pass to discover which components are present before the real fetch can
// ask for them by uid.
import snapshot from "./schemaSnapshot.json";

interface SchemaField { kind: "component" | "relation" | "dynamiczone" | "other"; targetUid?: string }
interface SchemaEntry { uid: string; kind: string; attributes: Record<string, SchemaField> }
const SCHEMA = snapshot as unknown as Record<string, SchemaEntry>;

/** Nesting depth to build populate for. Measured in this repo: nothing goes deeper than 3 below a
 *  template, and the walk starts at 1, so 4 covers the corpus with a level in hand. */
const MAX_DEPTH = 4;

// ── the throttle ──────────────────────────────────────────────────────────────────────────────────

const MIN_GAP_MS = Number(process.env.STRAPI_MIN_GAP_MS ?? 120);
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;

/**
 * Serialise every Strapi call in this process, with a minimum gap between them.
 *
 * A promise chain rather than a semaphore because the guarantee wanted is ORDER as well as a cap of
 * one: two callers awaiting the same tail cannot interleave, so there is no window where a retry and a
 * fresh request overlap.
 */
function gently<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { lastAt = Date.now(); }
  });
  // Keep the chain alive after a rejection, or one failed read stops every later call forever.
  chain = run.then(() => undefined, () => undefined);
  return run as Promise<T>;
}

function base(): { url: string; token: string } | null {
  const url = process.env.STRAPI_URL?.trim().replace(/\/$/, "");
  const token = process.env.STRAPI_API_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const cfg = base();
  if (!cfg) throw new Error("Strapi is not configured (STRAPI_URL / STRAPI_API_TOKEN).");
  return gently(async () => {
    const res = await fetch(`${cfg.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text();
    if (!res.ok) {
      // The body carries Strapi's own reason (a validation detail, a permission message) and losing it
      // turns every failure into an unactionable "400".
      throw new Error(`Strapi ${res.status} on ${path}${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    return text ? JSON.parse(text) : {};
  });
}

/**
 * Normalise Strapi v4's response shape, RECURSIVELY.
 *
 * v4 wraps a relation as `{ data: { id, attributes: {...} } }` at EVERY level, not just the top. A
 * top-level-only unwrap was the more dangerous of two bugs here: the walker looks for `item.id` to
 * decide that a nested object is a separate RECORD and that a write must target it instead. With the
 * wrapper left in place `value.id` is undefined, `crossed` never becomes true, and a link living inside
 * a related author or category is attributed to the page that merely references it — so a "fix" would
 * have written the referencing page's field path onto the wrong entry.
 */
function flatten(node: unknown): Record<string, unknown> {
  const out = flat(node);
  // The recursive version returns whatever it was given for a non-object, so an absent row came back
  // as `undefined` while still typed as a record — and the very next line, `first[zoneField]`, threw
  // "Cannot read properties of undefined". The old top-level-only flatten happened to return {} here,
  // which is why the failure only appeared after that fix. Two pages in a six-page scan hit it.
  return out && typeof out === "object" ? (out as Record<string, unknown>) : {};
}

function flat(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(flat);
  if (!node || typeof node !== "object") return node;
  const n = node as Record<string, unknown>;
  // `{data}` and `{data, meta}` are both the relation wrapper. More keys than that and `data` is a
  // real field belonging to somebody's content, which must not be unwrapped.
  if ("data" in n && Object.keys(n).length <= 2) return flat(n.data);
  if ("id" in n && "attributes" in n) return { id: n.id, ...(flat(n.attributes) as Record<string, unknown>) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) out[k] = flat(v);
  return out;
}

// ── populate ──────────────────────────────────────────────────────────────────────────────────────

type Populate = string | Record<string, { populate: Populate }>;

function componentPopulate(uid: string, depth = 0, seen: Set<string> = new Set()): Populate {
  if (depth >= MAX_DEPTH || seen.has(uid)) return "*";
  const schema = SCHEMA[uid];
  if (!schema) return "*";
  const nested = Object.entries(schema.attributes).filter(([, a]) => a.kind === "component" && a.targetUid);
  if (!nested.length) return "*";
  const next = new Set(seen).add(uid);
  const out: Record<string, { populate: Populate }> = {};
  for (const [field, attr] of nested) out[field] = { populate: componentPopulate(attr.targetUid!, depth + 1, next) };
  return out;
}

/** Flatten a populate object into Strapi's bracket query syntax, since `qs` is not a dependency here. */
function encodePopulate(prefix: string, value: Populate, out: string[]): void {
  if (typeof value === "string") { out.push(`${prefix}=${encodeURIComponent(value)}`); return; }
  for (const [k, v] of Object.entries(value)) encodePopulate(`${prefix}[${k}][populate]`, v.populate, out);
}

function topLevelPopulate(apiUid: string, zoneUids: Map<string, Set<string>>): string[] {
  const schema = SCHEMA[apiUid];
  const parts: string[] = [];
  if (!schema) return ["populate=*"];
  for (const [field, attr] of Object.entries(schema.attributes)) {
    if (attr.kind === "component" && attr.targetUid) {
      encodePopulate(`populate[${field}][populate]`, componentPopulate(attr.targetUid), parts);
    } else if (attr.kind === "relation") {
      // ONE level, and this matters enormously. `[populate]=*` on a relation populates that record's
      // OWN relations too, which pulls a back-reference: measured on /blogs/google-flow-overview, the
      // `category` relation dragged in every blog in that category with its full body and turned 52
      // real links into 4,945. The related record's own scalar fields are all that is wanted — enough
      // to find a link in an author bio, without inhaling the corpus.
      parts.push(`populate[${field}]=true`);
    } else if (attr.kind === "dynamiczone") {
      const present = zoneUids.get(field);
      if (present?.size) {
        // `on` is the only way to populate a polymorphic zone properly — each present component asked
        // for by uid, with its own nested populate.
        for (const uid of present) {
          encodePopulate(`populate[${field}][on][${uid}][populate]`, componentPopulate(uid), parts);
        }
      } else {
        parts.push(`populate[${field}][populate]=*`);
      }
    }
  }
  return parts.length ? parts : ["populate=*"];
}

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────

export interface FetchedEntry { id: number; entry: Record<string, unknown> }

/**
 * Fetch one entry by slug, fully populated.
 *
 * Two passes when the content type has a dynamic zone: the first is shallow and exists only to learn
 * which components the zone actually holds, because `on` has to name them by uid and the schema alone
 * cannot say which of 105 possible components this particular page uses.
 */
export async function fetchEntryBySlug(
  contentType: { pluralApi: string; slugField: string; apiUid: string },
  slug: string,
): Promise<FetchedEntry | null> {
  const zones = Object.entries(SCHEMA[contentType.apiUid]?.attributes ?? {})
    .filter(([, a]) => a.kind === "dynamiczone").map(([f]) => f);

  const filter = `filters[${contentType.slugField}][$eq]=${encodeURIComponent(slug)}&publicationState=preview&pagination[pageSize]=1`;

  const zoneUids = new Map<string, Set<string>>();
  if (zones.length) {
    const shallow = await request(`/api/${contentType.pluralApi}?${filter}&${zones.map((z) => `populate[${z}][populate]=*`).join("&")}`);
    const first = flatten((shallow.data as unknown[])?.[0]);
    for (const z of zones) {
      const arr = first[z];
      if (!Array.isArray(arr)) continue;
      const uids = new Set<string>();
      for (const item of arr) {
        const uid = (item as { __component?: string })?.__component;
        if (uid) uids.add(uid);
      }
      if (uids.size) zoneUids.set(z, uids);
    }
  }

  const parts = topLevelPopulate(contentType.apiUid, zoneUids);
  const json = await request(`/api/${contentType.pluralApi}?${filter}&${parts.join("&")}`);
  const row = (json.data as unknown[])?.[0];
  if (!row) return null;
  const entry = flatten(row);
  return { id: Number(entry.id), entry };
}

/**
 * A raw GET for callers that need something the populated fetchers don't cover (e.g. a batched
 * existence/publication probe across fifty slugs). Same throttle, same auth — just no populate
 * machinery, so it stays one cheap request.
 */
export async function strapiGet(path: string): Promise<Record<string, unknown>> {
  return request(path);
}

/** A record reached through a relation, which is not one of the page-level types we resolve URLs for. */
export async function fetchRawEntryById(pluralApi: string, id: number): Promise<Record<string, unknown> | null> {
  const json = await request(`/api/${pluralApi}/${id}?populate=*`);
  const row = json.data;
  return row ? flatten(row) : null;
}

export async function fetchEntryById(pluralApi: string, apiUid: string, id: number): Promise<Record<string, unknown> | null> {
  const zones = Object.entries(SCHEMA[apiUid]?.attributes ?? {})
    .filter(([, a]) => a.kind === "dynamiczone").map(([f]) => f);
  const zoneUids = new Map<string, Set<string>>();
  if (zones.length) {
    const shallow = await request(`/api/${pluralApi}/${id}?${zones.map((z) => `populate[${z}][populate]=*`).join("&")}`);
    const first = flatten(shallow.data);
    for (const z of zones) {
      const arr = first[z];
      if (!Array.isArray(arr)) continue;
      const uids = new Set<string>();
      for (const item of arr) {
        const uid = (item as { __component?: string })?.__component;
        if (uid) uids.add(uid);
      }
      if (uids.size) zoneUids.set(z, uids);
    }
  }
  const json = await request(`/api/${pluralApi}/${id}?${topLevelPopulate(apiUid, zoneUids).join("&")}`);
  return json.data ? flatten(json.data) : null;
}

// ── writes ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Off unless explicitly enabled.
 *
 * This module can edit live published pages. That is the whole point of the fixer, and it is also why
 * the capability does not exist by default — a misconfigured cron or a stray test run should not be
 * able to rewrite the site. The flag is the line between a tool that reports and a tool that acts.
 */
export function writesEnabled(): boolean {
  return process.env.RENDER_LAB_WRITES === "1";
}

export async function updateEntryFields(pluralApi: string, id: number, data: Record<string, unknown>): Promise<void> {
  if (!writesEnabled()) throw new Error("Writes are disabled (set RENDER_LAB_WRITES=1 to allow them).");
  await request(`/api/${pluralApi}/${id}`, { method: "PUT", body: JSON.stringify({ data }) });
}
