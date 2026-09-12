// Is this blog slug allowed to exist, and is it the right shape?
//
// Implements the checkable rules from the house blog-slug standard. Not a style linter — every rule
// here is either a measurable collision or a formula the standard names, and anything subjective is
// left to a person.
//
// ── The rule that actually matters ──────────────────────────────────────────────────────────────
//
// A blog slug must never be a bare product name that already exists as a feature or app page. The
// site has `/features/flux-3` live right now; a post published at `/blogs/flux-3` would put two pages
// in front of Google for the branded term with nothing to tell them apart, and would make every
// internal link that says "the FLUX 3 page" ambiguous. The standard calls this the single easiest way
// to confuse search engines about which page should rank, and it is the one failure a human reviewer
// reliably misses because the slug looks clean in isolation.
//
// Checked against `site_urls`, which is the real sitemap: 1,501 live pages, 747 of them blogs, 40
// features, 77 apps. Memory is not an acceptable substitute — the standard says to search the live
// site before finalising a slug, not after.
import { supabaseAdmin } from "@/lib/db/supabase";

/** Namespaces a blog slug must not shadow. A bare name matching one of these is a hard problem. */
const PRODUCT_NAMESPACES = ["features", "apps", "imagine-computer"] as const;

/** Words the standard says almost never survive into a slug. */
const FILLER = new Set([
  "the", "a", "an", "of", "to", "for", "and", "your", "you", "with",
  "complete", "ultimate", "guide-to", "actually", "everything",
]);

/** Subjective claims. The standard: they do not match how people search and do not age well. */
const SUBJECTIVE = new Set(["amazing", "ultimate", "best-ever", "incredible", "insane", "perfect"]);

export interface SlugProblem {
  /** "collision" is a publish blocker; "shape" is advice a person may override. */
  kind: "collision" | "shape";
  message: string;
}

export interface SlugVerdict {
  slug: string;
  ok: boolean;
  problems: SlugProblem[];
  /** The formula slug for the detected content type, when it differs from what was given. */
  suggestion: string | null;
  /** Which formula matched, for explaining the suggestion. */
  contentType: string | null;
  /** Live pages that informed the verdict, so the caller can see the evidence. */
  evidence: string[];
}

/**
 * The content type, read off the TITLE rather than the slug.
 *
 * Deliberately: the slug is the thing under review, so inferring intent from it would just agree with
 * whatever was proposed. The title is independent evidence of what the piece actually is.
 */
export function contentTypeOf(title: string): { type: string; formula: (kw: string) => string } | null {
  const t = title.toLowerCase();
  if (/\bvs\.?\b|\bversus\b/.test(t)) return { type: "comparison", formula: (k) => `${k}-vs-` };
  if (/\bpricing\b|\bprice\b|\bhow much\b/.test(t)) return { type: "pricing", formula: (k) => `${k}-pricing` };
  if (/\bprompt(ing)? guide\b|\bprompts?\b/.test(t)) return { type: "prompt guide", formula: (k) => `${k}-prompt-guide` };
  if (/^what is\b|\bwhat is\b/.test(t)) return { type: "explainer", formula: (k) => `what-is-${k}` };
  if (/\bbest\b/.test(t)) return { type: "listicle", formula: (k) => `best-${k}` };
  if (/^how to\b|\bhow to\b/.test(t)) return { type: "how-to", formula: (k) => `how-to-${k}` };
  if (/\bfeatures\b/.test(t)) return { type: "feature deep-dive", formula: (k) => `${k}-features` };
  if (/\bcost\b|\bbudget\b/.test(t)) return { type: "cost analysis", formula: (k) => `${k}-cost` };
  return null;
}

/** Live paths that share this slug's stem, across every namespace. One query, no scans. */
async function livePaths(slug: string): Promise<Array<{ path: string; section: string }>> {
  const candidates = [
    `/blogs/${slug}`,
    ...PRODUCT_NAMESPACES.map((ns) => `/${ns}/${slug}`),
  ];
  const { data, error } = await supabaseAdmin
    .from("site_urls")
    .select("path,section")
    .or(candidates.map((p) => `path.eq.${p}`).join(","));
  if (error) return [];
  return data ?? [];
}

/** Live blog paths whose slug is a near-neighbour — same words, different order or one word apart. */
async function nearBlogDuplicates(slug: string): Promise<string[]> {
  const words = slug.split("-").filter((w) => w.length > 2 && !FILLER.has(w));
  if (words.length < 2) return [];
  // Two most distinctive words is enough of a probe; more and the ILIKE stops matching anything.
  const probe = words.slice(0, 2).join("%");
  const { data } = await supabaseAdmin
    .from("site_urls").select("path").eq("section", "blogs").ilike("path", `%${probe}%`).limit(12);
  return (data ?? []).map((r) => r.path).filter((p) => p !== `/blogs/${slug}`);
}

/**
 * Check a proposed blog slug.
 *
 * Returns problems rather than throwing, and separates collisions (which should stop a publish) from
 * shape advice (which a person is entitled to overrule — a deliberate deviation from a formula is a
 * real editorial decision, and a checker that cannot be overruled gets worked around).
 */
export async function checkBlogSlug(input: { slug: string; title?: string }): Promise<SlugVerdict> {
  const slug = (input.slug ?? "").trim().toLowerCase();
  const out: SlugVerdict = { slug, ok: true, problems: [], suggestion: null, contentType: null, evidence: [] };
  if (!slug) {
    out.ok = false;
    out.problems.push({ kind: "collision", message: "No slug given." });
    return out;
  }

  // ── mechanical, no network needed ────────────────────────────────────────
  if (/[^a-z0-9-]/.test(slug)) {
    out.problems.push({ kind: "shape", message: `"${slug}" has characters outside a-z, 0-9 and hyphen. Lowercase and hyphens only, never underscores.` });
  }
  // Split on underscores too. A slug with underscores is already flagged above, but if the word-level
  // checks only split on hyphens then "ultimate_ai_video_tools" reads as ONE word and its subjective
  // claim goes unreported — the person fixes the separators, re-runs, and only then hears about
  // "ultimate". Surfacing every problem in one pass is the difference between one round trip and three.
  const words = slug.split(/[-_]+/).filter(Boolean);
  const meaningful = words.filter((w) => !FILLER.has(w));
  if (meaningful.length < 3) {
    out.problems.push({ kind: "shape", message: `Only ${meaningful.length} meaningful word(s). Under three, a slug usually cannot carry enough specificity to be unambiguous.` });
  }
  if (meaningful.length > 6) {
    out.problems.push({ kind: "shape", message: `${meaningful.length} meaningful words — over six is almost always filler that crept back in. Cut anything that could go without changing what the slug implies.` });
  }
  const filler = words.filter((w) => FILLER.has(w));
  if (filler.length) {
    out.problems.push({ kind: "shape", message: `Filler to cut: ${filler.join(", ")}.` });
  }
  const subjective = words.filter((w) => SUBJECTIVE.has(w));
  if (subjective.length) {
    out.problems.push({ kind: "shape", message: `"${subjective.join(", ")}" is a subjective claim. It does not match how people search and does not age well.` });
  }

  // ── the collision checks, against the live sitemap ───────────────────────
  const live = await livePaths(slug);
  for (const row of live) {
    out.evidence.push(row.path);
    if (row.path === `/blogs/${slug}`) {
      out.ok = false;
      out.problems.push({ kind: "collision", message: `/blogs/${slug} is already live. This would overwrite or compete with an existing post.` });
      continue;
    }
    // The rule this module exists for.
    out.ok = false;
    out.problems.push({
      kind: "collision",
      message:
        `${row.path} is already live, so /blogs/${slug} would be a bare product-name slug sitting next to its own ` +
        `product page. Add the word that says this is an article: -prompt-guide, -features, -pricing, or -vs-<other>.`,
    });
  }

  const near = await nearBlogDuplicates(slug);
  if (near.length) {
    out.evidence.push(...near);
    out.problems.push({
      kind: "shape",
      message:
        `Close existing posts: ${near.slice(0, 4).join(", ")}. If this is a genuine second angle, add a year or the ` +
        "distinguishing angle rather than letting two pages compete for the same query.",
    });
  }

  // ── formula ──────────────────────────────────────────────────────────────
  if (input.title) {
    const ct = contentTypeOf(input.title);
    if (ct) {
      out.contentType = ct.type;
      const shaped = ct.formula("");
      const tail = shaped.replace(/^-|-$/g, "");
      if (tail && !slug.includes(tail)) {
        out.problems.push({
          kind: "shape",
          message: `The title reads as a ${ct.type}, whose formula is "${ct.formula("<product>")}". This slug does not carry "${tail}", so the content type is not legible from the URL alone.`,
        });
      }
      // The standard: a ranked listicle is a snapshot and should say which year.
      if (ct.type === "listicle" && !/\b20\d\d\b/.test(slug)) {
        out.problems.push({ kind: "shape", message: "A ranked listicle should carry a year — it dates the snapshot honestly and matches how people search (\"best x 2026\")." });
      }
    }
  }

  return out;
}
