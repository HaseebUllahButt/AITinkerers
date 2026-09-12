// One decision per broken link. The goal is narrow and absolute: no crawler reaches a 4xx.
//
//   published elsewhere  -> rewrite to the real URL. Nothing is lost.
//   in-body hyperlink    -> unwrap. The sentence keeps its words, the dead link stops existing.
//   CTA / bare URL       -> send to the public studio route the button itself implies.
//   resource tile / card -> repoint to the nearest LIVE equivalent when one genuinely exists,
//                           otherwise DELETE the item.
//
// That last rule is the one worth defending. There are 165 live blogs against 641 drafts, so
// "nearest" is frequently nothing of the kind: matching on shared words alone once paired
// `hailuo-2-3-overview` with `google-whisk-overview`, because "overview" counted as much as
// "hailuo". Two guards follow from that. Scores are IDF-weighted, so a brand name outweighs a filler
// word by roughly seven to one. And below a floor the item is removed rather than repointed — a
// deleted card is invisible to a crawler and misleads nobody, while a card repointed at a 0.06 match
// is a live Runway page recommending an unrelated article. Deletions are recorded so any of them can
// be restored, and publishing the draft is always the better fix where the draft is still wanted.
import type { FoundLink, LinkFixPlan, PlannedFix } from "./types";
import { SITE, type Inventory, type EntryState } from "./sources";

/** Below this a "nearest equivalent" is not one. Tuned so the median accepted match sits near 0.43. */
export const MATCH_FLOOR = 0.3;

const STOP = new Set("a an the and or for to of in on with by your you is are it its as at from".split(" "));
const tokens = (s: string): string[] =>
  String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));

interface Scorer {
  vec: (...parts: string[]) => Map<string, number>;
  sim: (a: Map<string, number>, b: Map<string, number>) => number;
}

/** Inverse document frequency over every title on the site, so common words stop deciding matches. */
function buildScorer(inv: Inventory): Scorer {
  const docs: string[][] = [];
  for (const m of [inv.blogs, inv.landings]) {
    for (const e of m.values()) docs.push([...tokens(e.title), ...tokens(e.slug)]);
  }
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = Math.max(docs.length, 1);
  const idf = (t: string) => Math.log(N / ((df.get(t) ?? 0) + 1));
  const vec = (...parts: string[]) => {
    const m = new Map<string, number>();
    for (const p of parts) for (const t of tokens(p)) m.set(t, idf(t));
    return m;
  };
  const weight = (v: Map<string, number>) => [...v.values()].reduce((a, b) => a + b, 0);
  const sim = (a: Map<string, number>, b: Map<string, number>) => {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const [t, w] of a) if (b.has(t)) shared += w;
    return (2 * shared) / (weight(a) + weight(b));
  };
  return { vec, sim };
}

interface Candidate extends EntryState { v: Map<string, number>; url: string }

/** Only pages proven live AND present in the sitemap can be proposed — otherwise the "fix" 404s too. */
function pools(inv: Inventory, s: Scorer): { blogs: Candidate[]; landings: Candidate[] } {
  const mk = (e: EntryState, url: string): Candidate => ({ ...e, v: s.vec(e.title, e.slug), url });
  const blogs: Candidate[] = [];
  for (const b of inv.blogs.values()) {
    if (b.published && inv.livePaths.has(`/blogs/${b.slug}`)) blogs.push(mk(b, `${SITE}/blogs/${b.slug}`));
  }
  const landings: Candidate[] = [];
  for (const c of inv.landings.values()) {
    const p = inv.pathBySlug.get(c.slug);
    if (c.published && p) landings.push(mk(c, `${SITE}${p}`));
  }
  return { blogs, landings };
}

/**
 * Two legitimate readings of "nearest similar", and the slot deserves the better of them:
 *   fidelity  — closest to what the dead link was about;
 *   relevance — the best live page for the page this link sits on.
 * When a topic has no live counterpart at all, fidelity chases a ghost and relevance is the only
 * signal left, so an /ai-3d-logo-generator page gets a logo post rather than whatever happens to
 * share a word with a retired 2024 listicle.
 */
function nearest(pool: Candidate[], want: Map<string, number>, page: Map<string, number>, taken: Set<number>, s: Scorer) {
  let best: { c: Candidate; score: number } | null = null;
  for (const c of pool) {
    if (taken.has(c.id)) continue;
    const fidelity = s.sim(want, c.v);
    const relevance = s.sim(page, c.v);
    const score = Math.max(0.7 * fidelity + 0.3 * relevance, 0.25 * fidelity + 0.75 * relevance);
    if (!best || score > best.score) best = { c, score };
  }
  return best && best.score >= MATCH_FLOOR ? best : null;
}

/** Where a dashboard button should point instead. Scored on the PATH and the label, never the host —
 *  including the host made "imagine.art" match /art/ and pick a destination by accident. */
export function publicRoute(url: string, label: string, pageSlug: string): string {
  let path = url;
  try { path = new URL(url, SITE).pathname; } catch { /* keep raw */ }
  const hay = `${path} ${label} ${pageSlug}`.toLowerCase();
  if (/music|song|audio|beat|lyric|voice|speech/.test(hay)) return `${SITE}/music-studio`;
  // Shorts and reels route to /video, not /shorts — a standing instruction from the SEO team.
  // Keep "short" and "reel" ahead of the generic video words so the intent still lands somewhere
  // deliberate rather than falling through to the image default.
  if (/video|clip|film|animat|motion|short|reel/.test(hay)) return `${SITE}/video`;
  if (/image|photo|picture|logo|thumbnail|poster|sticker|avatar|headshot/.test(hay)) return `${SITE}/image`;
  return `${SITE}/image`;
}

export function buildPlan(links: FoundLink[], inv: Inventory): LinkFixPlan {
  const scorer = buildScorer(inv);
  const { blogs, landings } = pools(inv, scorer);

  const byPage = new Map<string, FoundLink[]>();
  for (const l of links) {
    const k = `${l.surface}:${l.entryId}`;
    if (!byPage.has(k)) byPage.set(k, []);
    byPage.get(k)!.push(l);
  }

  const fixes: PlannedFix[] = [];
  const unfixable: PlannedFix[] = [];

  for (const rows of byPage.values()) {
    const pageSlug = rows[0].slug;
    const pageVec = scorer.vec(pageSlug);
    // Never propose something the page already links to, and never the page itself.
    const taken = new Set<number>(rows.filter((r) => r.verdict === "ok" && r.targetId != null).map((r) => r.targetId!));
    const self = inv.landings.get(pageSlug.toLowerCase()) ?? inv.blogs.get(pageSlug.toLowerCase());
    if (self) taken.add(self.id);

    for (const r of rows) {
      if (r.verdict === "dashboard") {
        fixes.push({ ...r, action: "rewrite", to: publicRoute(r.target ?? r.url ?? "", r.text, pageSlug), reason: "app route behind login -> public studio page" });
        continue;
      }
      if (r.verdict !== "broken") continue;

      if (r.fixTo) { fixes.push({ ...r, action: "rewrite", to: r.fixTo, reason: r.why ?? "moved" }); continue; }

      if (r.kind === "markdown" || r.kind === "html") {
        fixes.push({ ...r, action: "unlink", reason: r.why ?? "target does not resolve" });
        continue;
      }
      if (r.kind === "cta-fence" || r.kind === "bare") {
        fixes.push({ ...r, action: "rewrite", to: publicRoute(r.target ?? r.url ?? "", r.text, pageSlug), reason: `${r.why ?? "dead target"}; sent to the public studio page` });
        continue;
      }

      // A tile or a card: repoint if something genuinely close is live, else remove the item.
      const want = scorer.vec(r.targetTitle ?? "", String(r.relSlug ?? r.target ?? "").split("/").pop() ?? "");
      const pool = r.kind === "relation" || /^\/blogs\//.test(String(r.target ?? "").replace(SITE, "")) ? blogs : landings;
      const hit = nearest(pool, want, pageVec, taken, scorer);
      if (hit) {
        taken.add(hit.c.id);
        fixes.push({
          ...r, action: "rewrite", to: hit.c.url, toId: hit.c.id, toTitle: hit.c.title,
          score: Number(hit.score.toFixed(3)), reason: `${r.why ?? "dead target"}; nearest live equivalent`,
        });
      } else if (/\[\d+\]/.test(r.field)) {
        fixes.push({ ...r, action: "delete", reason: `${r.why ?? "dead target"}; no live equivalent above ${MATCH_FLOOR}` });
      } else {
        // Not an array item, so removing it would leave a required field empty. Report, don't guess.
        unfixable.push({ ...r, action: "delete", reason: `${r.why ?? "dead target"}; not a removable list item` });
      }
    }
  }

  return { fixes, unfixable };
}
