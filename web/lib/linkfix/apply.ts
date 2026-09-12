// Writing the fixes back, to the Strapi v4 contract.
//
// From docs-v4.strapi.io, each rule earned by something that would otherwise go wrong here:
//   * PUT /api/:pluralApiId/:numericId, body { data: { … } }. v4 keys on the numeric id; documentId
//     is a v5 concept and this instance is v4.
//   * update() is a PARTIAL update — "existing fields that are not included won't be replaced" — so
//     each PUT carries only the field being changed.
//   * A dynamic zone is the exception: it is replaced wholesale, and "omitting an existing component
//     deletes it", so `template` always goes back complete.
//   * Components are matched by `id`. "If a component id is specified, the component is updated,
//     otherwise the old one is deleted and a new one is created." Every id is preserved.
//   * A single relation writes as a bare id; connect/set longhand is for multi-relations.
//
// Two further guards, both from real incidents: every page is re-read immediately before its write
// so a concurrent editor is never reverted, and any page whose tree comes back truncated is skipped
// rather than written from a partial view.
import { strapiPutRaw, toWriteShape, truncatedPaths, digPath, setPath } from "./strapiRaw";
import { fetchEntry, collectionOf, publicUrl, type Inventory } from "./sources";
import type { ApplyOutcome, PlannedFix, Surface } from "./types";

/** Remove a markdown or HTML link, keeping its visible text. */
function unlink(text: string, fix: PlannedFix): string {
  if (!fix.match) return text;
  return text.split(fix.match).join(fix.text ?? "");
}

interface ApplyOpts {
  /** Stop and return once this many milliseconds have passed, so a serverless chunk finishes cleanly. */
  deadline?: number;
  /** Keys already written by an earlier chunk. */
  done?: Set<string>;
  onProgress?: (key: string, edits: number) => void;
}

export async function applyFixes(fixes: PlannedFix[], inv: Inventory, opts: ApplyOpts = {}): Promise<ApplyOutcome> {
  const out: ApplyOutcome = { pages: 0, edits: 0, removed: 0, failed: 0, failures: [], removedItems: [] };
  const done = opts.done ?? new Set<string>();

  const byEntry = new Map<string, PlannedFix[]>();
  for (const f of fixes) {
    const k = `${f.surface}:${f.entryId}`;
    if (!byEntry.has(k)) byEntry.set(k, []);
    byEntry.get(k)!.push(f);
  }

  for (const [key, edits] of byEntry) {
    if (done.has(key)) continue;
    if (opts.deadline && Date.now() > opts.deadline) break;

    const [surface, idStr] = key.split(":") as [Surface, string];
    const id = Number(idStr);
    const got = await fetchEntry(surface, id);
    if (!got.ok) { out.failures.push({ key, error: `fetch: ${got.error}` }); out.failed++; continue; }
    const attrs = got.attrs;

    let wrote = 0;
    let removed = 0;

    if (surface === "blog" || surface === "announcement") {
      // Rich text lives in one field; components such as blogHeroCTA are separate top-level fields.
      const richField = surface === "blog" ? "body" : "content";
      const richEdits = edits.filter((e) => e.field === richField);
      const compEdits = edits.filter((e) => e.field !== richField);

      const payload: Record<string, unknown> = {};
      for (const e of compEdits) {
        const top = e.field.split(".")[0];
        if (!(top in payload)) payload[top] = JSON.parse(JSON.stringify(attrs[top] ?? null));
        const cur = digPath(payload, e.field);
        if (cur == null) continue;
        if (String(cur) !== String(e.url)) continue;   // someone else changed it; leave theirs
        setPath(payload, e.field, e.to);
        wrote++;
      }

      let text = String(attrs[richField] ?? "");
      const before = text;
      // Unwraps first: they match the whole [text](url) construct, so doing them before URL rewrites
      // stops a rewrite from mutating a link that is about to be removed anyway.
      for (const e of richEdits.filter((x) => x.action === "unlink")) {
        if (!e.match || !text.includes(e.match)) continue;
        text = unlink(text, e);
        wrote++;
      }
      // A URL repeated 24 times in one body is one change, not 24 — split/join replaces them all.
      for (const e of richEdits.filter((x) => x.action === "rewrite")) {
        if (!e.url || !e.to || !text.includes(e.url)) continue;
        text = text.split(e.url).join(e.to);
        wrote++;
      }
      if (text !== before) payload[richField] = text;

      if (!Object.keys(payload).length) { done.add(key); continue; }
      const put = await strapiPutRaw(`/api/${collectionOf(surface)}/${id}`, { data: payload });
      if (!put.ok) { out.failures.push({ key, error: put.error }); out.failed++; continue; }
    } else {
      const template = attrs.template;
      const trunc = truncatedPaths(template, "template");
      if (trunc.length) {
        out.failures.push({ key, error: `populate truncated ${trunc.length} node(s), e.g. ${trunc[0]} — not written` });
        out.failed++;
        continue;
      }
      const tree = { template: JSON.parse(JSON.stringify(template)) };

      for (const e of edits.filter((x) => x.action === "rewrite")) {
        if (e.kind === "relation") {
          const item = digPath(tree, e.field.replace(/\.[A-Za-z]+$/, "")) as Record<string, unknown> | undefined;
          if (!item || e.toId == null) continue;
          const relField = e.field.split(".").pop()!;
          item[relField] = { data: { id: e.toId } };   // toWriteShape turns this into the bare id v4 wants
        } else {
          const cur = digPath(tree, e.field);
          if (cur == null || String(cur) !== String(e.url)) continue;
          setPath(tree, e.field, e.to);
          // A tile carries a title beside its url; leaving it would label the new target with the
          // old page's name, which a reader spots immediately.
          if (e.toTitle) setPath(tree, e.field.replace(/\.url$/, ".title"), e.toTitle);
        }
        wrote++;
      }

      // Deletions last, descending index per array, so earlier indices stay valid while later ones go.
      const dels = edits
        .filter((x) => x.action === "delete")
        .map((e) => {
          const itemPath = e.field.replace(/\.[A-Za-z]+$/, "");
          const m = itemPath.match(/^(.*)\[(\d+)\]$/);
          return m ? { arrPath: m[1], idx: Number(m[2]), e } : null;
        })
        .filter((x): x is { arrPath: string; idx: number; e: PlannedFix } => x !== null)
        .sort((a, b) => b.idx - a.idx);

      for (const d of dels) {
        const arr = digPath(tree, d.arrPath);
        if (!Array.isArray(arr) || !arr[d.idx]) continue;
        out.removedItems.push({
          pageUrl: publicUrl(inv, "landing", d.e.slug),
          field: d.e.field,
          target: d.e.target ?? d.e.url ?? "",
          title: d.e.targetTitle ?? d.e.text ?? "",
        });
        arr.splice(d.idx, 1);
        removed++;
      }

      if (!wrote && !removed) { done.add(key); continue; }

      // A pre-existing invalid value blocks every write to the page. The front end already treats
      // this null as falsy, so writing false preserves exactly what the page renders today.
      const first = Array.isArray(tree.template) ? (tree.template[0] as Record<string, unknown> | undefined) : undefined;
      const hero = first?.solutionHero as Record<string, unknown> | undefined;
      if (hero && hero.isHeroSectionContentWhite === null) hero.isHeroSectionContentWhite = false;

      const put = await strapiPutRaw(`/api/cluster-pages/${id}`, { data: { template: toWriteShape(tree.template) } });
      if (!put.ok) { out.failures.push({ key, error: put.error }); out.failed++; continue; }
    }

    done.add(key);
    out.pages++;
    out.edits += wrote;
    out.removed += removed;
    opts.onProgress?.(key, wrote + removed);
  }

  return out;
}
