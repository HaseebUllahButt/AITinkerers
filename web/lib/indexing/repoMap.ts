// URL → GitHub repo mapping (PRD R4 follow-up: "which repo renders this page"). Resolves the
// repo a fix PR should open in from the audited page's URL section, so PRs land in the repo that
// actually renders the page instead of one hardcoded target.
//
// Config: a REPO_MAP env-JSON (inline JSON in one env var — same convention as GSC_SA_JSON in
// gsc.ts, best for Vercel). Keys are URL path prefixes / sections; values are "owner/repo", or
// "owner/repo#branch" to override the base branch. An optional "*" key is a catch-all default.
//   REPO_MAP={"/blog":"Vyro-ai/blog-web","/apps":"Vyro-ai/apps-web#master","/ai-image-generator":"Vyro-ai/marketing-web"}
import { toPath } from "./template";

export interface RepoTarget {
  owner: string;
  repo: string;
  baseBranch: string;
  /** The REPO_MAP key that matched (for display + "no repo mapped for <section>" messages). */
  section: string;
}

interface Entry {
  key: string; // the map key ("/blog", "*", …)
  owner: string;
  repo: string;
  baseBranch: string;
}

// Parse once — REPO_MAP is a deploy-time env var, so memoizing is safe within a process.
let cached: Entry[] | null = null;

function defaultBranch(): string {
  return process.env.TARGET_REPO_BASE_BRANCH || "main";
}

// "owner/repo" or "owner/repo#branch" → parts, or null if malformed.
function parseValue(value: unknown): { owner: string; repo: string; baseBranch: string } | null {
  if (typeof value !== "string") return null;
  const [ownerRepo, branch] = value.trim().split("#");
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) return null;
  return { owner: owner.trim(), repo: repo.trim(), baseBranch: (branch || defaultBranch()).trim() };
}

function loadEntries(): Entry[] {
  if (cached) return cached;
  const raw = process.env.REPO_MAP;
  if (!raw || !raw.trim()) {
    cached = [];
    return cached;
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const entries: Entry[] = [];
    for (const [key, value] of Object.entries(obj)) {
      const parsed = parseValue(value);
      if (parsed) entries.push({ key, ...parsed });
      else console.warn(`REPO_MAP: skipping "${key}" — value must be "owner/repo" or "owner/repo#branch".`);
    }
    cached = entries;
  } catch (e: any) {
    console.warn(`REPO_MAP: invalid JSON — no per-page repo mapping active. (${e?.message ?? e})`);
    cached = [];
  }
  return cached;
}

/** True if the map is empty/unset (used to explain "no mapping configured" to the user). */
export function repoMapConfigured(): boolean {
  return loadEntries().length > 0;
}

/**
 * Resolve the repo that renders `pathOrUrl`. Longest-prefix match over REPO_MAP keys (same prefix
 * style as isMoneyPage): a key matches when the path equals it or starts with `${key}/`. The
 * longest matching key wins. An explicit "*" key is a catch-all used only when nothing else
 * matches. Returns null when unmapped.
 */
export function repoForPath(pathOrUrl: string): RepoTarget | null {
  const entries = loadEntries();
  if (entries.length === 0) return null;
  const path = toPath(pathOrUrl);

  let best: Entry | null = null;
  let catchAll: Entry | null = null;
  for (const e of entries) {
    if (e.key === "*") { catchAll = e; continue; }
    const k = e.key;
    const matches = path === k || path.startsWith(k.endsWith("/") ? k : `${k}/`);
    if (matches && (!best || k.length > best.key.length)) best = e;
  }
  const hit = best ?? catchAll;
  return hit ? { owner: hit.owner, repo: hit.repo, baseBranch: hit.baseBranch, section: hit.key } : null;
}

// Test-only: reset the memoized parse (so a test can swap REPO_MAP between cases).
export function __resetRepoMapCache(): void {
  cached = null;
}
