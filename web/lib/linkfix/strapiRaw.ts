// A raw Strapi v4 client, deliberately separate from lib/strapi/client.ts.
//
// That client `flatten`s every response — `{data:{id,attributes}}` becomes `{id, ...attributes}` —
// which is exactly right for reading and exactly wrong here. This module has to WRITE dynamic zones
// back, and Strapi's write format for a populated relation is a bare id while its read format is the
// `{data:{...}}` wrapper. Flattening destroys the distinction, so link fixing needs the raw shape.
//
// Two hard constraints shape the rest:
//   1. imagine-blog.vyro.ai folds under concurrency. Every request here is queued and SEQUENTIAL,
//      with a pause between, no matter how many callers there are.
//   2. Nothing may throw into a chunked background run. Every call returns a result object.
const BASE = () => (process.env.STRAPI_URL ?? "").trim().replace(/\/$/, "");
const TOKEN = () => (process.env.STRAPI_API_TOKEN ?? "").trim();

export function strapiReady(): boolean {
  return Boolean(BASE() && TOKEN());
}

export type Raw<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** Serialises every request to the CMS. Two callers do not become two concurrent requests. */
let chain: Promise<unknown> = Promise.resolve();
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pause after each call. Small, but it is what keeps a 400-page sweep from behaving like a load test. */
const PAUSE_MS = 900;
const TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;

async function once<T>(path: string, init: RequestInit): Promise<Raw<T>> {
  try {
    const res = await fetch(`${BASE()}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN()}`, Accept: "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, error: `Strapi ${res.status}: ${text.slice(0, 300)}` };
    return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

async function request<T>(path: string, init: RequestInit): Promise<Raw<T>> {
  return queued(async () => {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const r = await once<T>(path, init);
      if (r.ok) { await sleep(PAUSE_MS); return r; }
      // Retry only what a retry can fix: rate limiting, a 5xx, or a transport failure.
      const retryable = /Strapi (429|5\d\d)|timeout|aborted|fetch failed|network/i.test(r.error);
      if (!retryable || attempt === ATTEMPTS) { await sleep(PAUSE_MS); return r; }
      await sleep(PAUSE_MS * attempt * 3);
    }
    return { ok: false, error: "unreachable" };
  });
}

export function strapiGetRaw<T = any>(path: string): Promise<Raw<T>> {
  return request<T>(path, { method: "GET" });
}

export function strapiPutRaw<T = any>(path: string, body: unknown): Promise<Raw<T>> {
  return request<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Populated read shape -> Strapi's write shape.
 *   { data: { id, attributes } }  -> id
 *   { data: [ {id}, {id} ] }      -> [id, id]
 *   { data: null }                -> null
 *
 * Component `id` keys are preserved deliberately. Per the v4 docs: "If a component id is specified,
 * the component is updated, otherwise the old one is deleted and a new one is created" — dropping
 * ids would silently recreate every component and lose every field we did not send.
 */
export function toWriteShape(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(toWriteShape);
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length <= 2 && keys.includes("data")) {
    const d = obj.data;
    if (d == null) return null;
    if (Array.isArray(d)) return d.map((x) => (x as { id?: unknown })?.id).filter((x) => x != null);
    if (typeof d === "object" && "id" in (d as object)) return (d as { id: unknown }).id;
    return toWriteShape(d);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toWriteShape(v);
  return out;
}

/**
 * Paths in a fetched tree that came back as a bare `{id}`.
 *
 * `populate=deep,N` is a plugin, not core Strapi, and it truncates below its depth. At depth 4 the
 * blog relation behind every "More Resources" card collapses to `{id: 65}` — which reads as an empty
 * component, not as a link. A whole class of broken link hid behind that for an entire audit. A
 * dynamic zone is replaced wholesale on write, so sending a truncated tree back is also destructive.
 * Callers check this before writing and refuse rather than guess.
 */
export function truncatedPaths(node: unknown, path = "", hits: string[] = []): string[] {
  if (node === null || typeof node !== "object") return hits;
  if (Array.isArray(node)) { node.forEach((v, i) => truncatedPaths(v, `${path}[${i}]`, hits)); return hits; }
  const keys = Object.keys(node as object);
  if (keys.length === 1 && keys[0] === "id") { hits.push(path); return hits; }
  for (const k of keys) truncatedPaths((node as Record<string, unknown>)[k], path ? `${path}.${k}` : k, hits);
  return hits;
}

/** Read a value at a dotted/bracketed path, e.g. `template[0].heroSection.title`. */
export function digPath(root: unknown, path: string): unknown {
  return path
    .split(/[.[\]]+/)
    .filter(Boolean)
    .reduce<unknown>((n, k) => (n == null ? undefined : (n as Record<string, unknown>)[k]), root);
}

/** Write a value at a dotted/bracketed path. Returns false when the path does not exist. */
export function setPath(root: unknown, path: string, value: unknown): boolean {
  const parts = path.split(/[.[\]]+/).filter(Boolean);
  const last = parts.pop();
  if (!last) return false;
  let node: any = root;
  for (const p of parts) {
    if (node == null || typeof node !== "object") return false;
    node = node[p];
  }
  if (node == null || typeof node !== "object") return false;
  node[last] = value;
  return true;
}
