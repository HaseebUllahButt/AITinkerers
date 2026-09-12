// Shared shapes for the 404 detect-and-fix engine.

/** Which Strapi collection a page lives in. Everything else on the site is front-end code. */
export type Surface = "blog" | "landing" | "announcement";

/** How a link is stored, which decides how it can be repaired. */
export type LinkKind =
  | "markdown"   // [text](url) inside a rich-text field
  | "html"       // <a href> inside a rich-text field
  | "cta-fence"  // ```CTA { "text": …, "url": … } ``` block inside a blog body
  | "bare"       // a naked URL inside prose
  | "field"      // a url-shaped string field, e.g. relatedPages[3].url or footerHeroSection.buttonLink
  | "relation";  // a Strapi relation the front end renders as /blogs/<slug> — the resource cards

export type Verdict =
  | "ok"
  | "broken"     // the target does not resolve for a visitor or a crawler
  | "dashboard"  // resolves, but only behind the app login
  | "blocked"    // an external host refused an automated request; not evidence of a dead link
  | "asset"      // media, not a page link
  | "unchecked";

export interface FoundLink {
  surface: Surface;
  entryId: number;
  slug: string;
  /** The page's real public URL, from the sitemap where possible. */
  pageUrl: string;
  kind: LinkKind;
  /** Dotted path to the field holding this link, or "body"/"content" for rich text. */
  field: string;
  /** The exact source substring, so a rich-text edit can replace precisely this occurrence. */
  match?: string;
  /** Anchor text or button label. */
  text: string;
  /** The href as authored. Absent for a relation, which stores no URL. */
  url?: string;
  /** For relations: the related entry. */
  relId?: number;
  relSlug?: string;
  /** Absolute target this resolves to. */
  target?: string;
  targetId?: number;
  targetTitle?: string;
  verdict: Verdict;
  why?: string;
  status?: number;
  /** Set when the target is published but lives at a different URL — the cheapest possible fix. */
  fixTo?: string;
}

export type Action = "unlink" | "rewrite" | "delete";

export interface PlannedFix extends FoundLink {
  action: Action;
  /** Replacement URL for a rewrite. */
  to?: string;
  /** Replacement entry for a relation rewrite. */
  toId?: number;
  toTitle?: string;
  /** Match quality 0-1 where a nearest-equivalent was chosen. */
  score?: number;
  reason: string;
}

export interface LinkFixPlan {
  fixes: PlannedFix[];
  /** Broken links nothing can be done about automatically, kept so they are visible not silent. */
  unfixable: PlannedFix[];
}

export interface RunCounts {
  pagesScanned: number;
  linksFound: number;
  ok: number;
  broken: number;
  dashboard: number;
  assets: number;
  blocked: number;
}

export type Phase = "idle" | "inventory" | "scanning" | "checking" | "planned" | "applying" | "done" | "error";

export interface LinkFixState {
  runId: string;
  phase: Phase;
  startedAt: number;
  updatedAt: number;
  counts: RunCounts;
  /** Progress through whichever phase is current. */
  cursor: number;
  total: number;
  log: string[];
  error?: string;
  /** Set once the fix has been applied. */
  applied?: { pages: number; edits: number; removed: number; failed: number; at: number };
  /** Only true when a person asked for writes. Detection never implies repair. */
  dryRun: boolean;
}

export interface ApplyOutcome {
  pages: number;
  edits: number;
  removed: number;
  failed: number;
  failures: Array<{ key: string; error: string }>;
  /** Everything deleted, recorded so any of it can be put back. */
  removedItems: Array<{ pageUrl: string; field: string; target: string; title: string }>;
}
