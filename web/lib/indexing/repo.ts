// GitHub PR client — write path for mechanical fixes (PRD R4/§6.2). Opens a PR on a NEW
// branch; never merges (a human always reviews + merges). Ported from imagine-seo-engine's
// RepoClient (Octokit-based branch/commit/PR flow), adapted to this app's env conventions.
//
// IMPORTANT: this is currently pointed at a proof-of-concept target repo
// (Vyro-ai/imagine-motion-design-web), NOT the repo that actually renders the scanned
// northwind.example pages. So the PR content is a clearly-labeled proposal document (markdown),
// never a guessed edit to a real template file — there is no URL-to-source-file mapping for
// this target, and inventing one would be actively wrong.
import { Octokit } from "@octokit/rest";
import { decrypt } from "@/lib/connections/crypto";
import { queryOne } from "@/lib/db/pg";
import type { ChangeRequestPreview } from "./routing";
import type { RepoTarget } from "./repoMap";

export interface FileChange {
  path: string;
  content: string;
}

/** A resolved repository target plus the credential that can write it. */
export interface RepoConnection {
  owner: string;
  repo: string;
  baseBranch: string;
  /** Per-site token from the connections table, or null → env GITHUB_BOT_TOKEN. */
  token: string | null;
}

/** "owner/repo" or "owner/repo#branch" — the same convention REPO_MAP uses. */
function parseRepo(input: string): { owner: string; repo: string; baseBranch: string } | null {
  const [ownerRepo, branch] = input.split("#");
  const [owner, repo] = (ownerRepo ?? "").split("/");
  if (!owner?.trim() || !repo?.trim()) return null;
  return {
    owner: owner.trim(), repo: repo.trim(),
    baseBranch: (branch ?? "").trim() || process.env.TARGET_REPO_BASE_BRANCH || "main",
  };
}

/**
 * The repo a site's agent may read and PR into: the site's `github` connection. Returns null
 * when nothing is connected — callers answer "connect GitHub" rather than guessing at a repo.
 */
export async function repoForSite(siteId: string): Promise<RepoConnection | null> {
  const conn = await queryOne<{ config: { repository?: unknown }; secret_enc: string | null }>(
    `select config, secret_enc from connections where site_id = $1 and kind = 'github'`,
    [siteId],
  );
  const repo = parseRepo(String(conn?.config?.repository ?? ""));
  if (!repo) return null;
  const token = conn?.secret_enc ? decrypt(conn.secret_enc) : null;
  return { ...repo, token };
}

// Paths worth reading for SEO/page edits. Lockfiles, binaries and build output are skipped —
// listing a repo is for finding the file that renders a page, not for inventorying it.
const READABLE = /\.(tsx?|jsx?|mjs|cjs|html?|mdx?|css|scss|json|ya?ml|toml|xml|txt|svelte|vue|astro)$/i;
const SKIP = /(^|\/)(node_modules|dist|build|out|\.next|\.git|coverage|vendor|public\/(images|assets|fonts)|__generated__)\//i;
const SKIP_NAME = /(lock|\.min\.|\.map$|package-lock|pnpm-lock|yarn\.lock)/i;

export interface RepoFile {
  path: string;
  size: number;
}

/** The repo's file tree — readable source files only, capped so a monorepo can't blow the
 *  tool response. */
export async function listRepoFiles(conn: RepoConnection, limit = 600): Promise<RepoFile[]> {
  const octokit = client(conn.token ?? undefined);
  const tree = await octokit.git.getTree({
    owner: conn.owner, repo: conn.repo,
    tree_sha: conn.baseBranch, recursive: "1",
  });
  return (tree.data.tree ?? [])
    .filter((n) => n.type === "blob" && n.path && READABLE.test(n.path) && !SKIP.test(n.path) && !SKIP_NAME.test(n.path))
    .map((n) => ({ path: n.path as string, size: n.size ?? 0 }))
    .slice(0, limit);
}

const MAX_FILE_CHARS = 24_000;

/** One file's contents, truncated past the cap — enough to edit a page component, never enough
 *  to swallow a context window. */
export async function readRepoFile(
  conn: RepoConnection, path: string,
): Promise<{ path: string; content: string; truncated: boolean } | null> {
  const octokit = client(conn.token ?? undefined);
  const res = await octokit.repos.getContent({
    owner: conn.owner, repo: conn.repo, path, ref: conn.baseBranch,
  });
  const data = res.data as { content?: string; encoding?: string; type?: string };
  if (data.type !== "file" || !data.content) return null;
  const text = Buffer.from(data.content, "base64").toString("utf8");
  return { path, content: text.slice(0, MAX_FILE_CHARS), truncated: text.length > MAX_FILE_CHARS };
}

export interface PullRequestResult {
  number: number;
  url: string;
  branch: string;
}

function client(token?: string): Octokit {
  // A per-site connection token wins over the shared env bot token: when a customer connects
  // their repo the PR should come from their account, not ours.
  const auth = token?.trim() || process.env.GITHUB_BOT_TOKEN;
  if (!auth) throw new Error("No GitHub token — connect a repository or set GITHUB_BOT_TOKEN.");
  return new Octokit({ auth });
}

/**
 * Creates `branch` off the base branch, commits `changes`, and opens a PR. Returns the PR
 * number + URL. Never merges — the PR sits open for human review.
 */
export async function openPullRequest(input: {
  repo: RepoTarget;
  branch: string;
  title: string;
  body: string;
  changes: FileChange[];
  token?: string;
}): Promise<PullRequestResult> {
  const octokit = client(input.token);
  const { owner, repo, baseBranch } = input.repo;

  const baseRef = await octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
  const baseSha = baseRef.data.object.sha;
  const baseCommit = await octokit.git.getCommit({ owner, repo, commit_sha: baseSha });

  const blobs = await Promise.all(
    input.changes.map((change) =>
      octokit.git
        .createBlob({ owner, repo, content: change.content, encoding: "utf-8" })
        .then((blob) => ({ path: change.path, sha: blob.data.sha })),
    ),
  );

  const tree = await octokit.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.data.tree.sha,
    tree: blobs.map((blob) => ({ path: blob.path, mode: "100644" as const, type: "blob" as const, sha: blob.sha })),
  });

  const commit = await octokit.git.createCommit({
    owner,
    repo,
    message: input.title,
    tree: tree.data.sha,
    parents: [baseSha],
  });

  await octokit.git.createRef({ owner, repo, ref: `refs/heads/${input.branch}`, sha: commit.data.sha });

  const pr = await octokit.pulls.create({
    owner,
    repo,
    title: input.title,
    body: input.body,
    head: input.branch,
    base: baseBranch,
  });

  return { number: pr.data.number, url: pr.data.html_url, branch: input.branch };
}

function slugify(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

/**
 * Build the proposal markdown file for a PR-routed change request. This is a PROPOSAL
 * DOCUMENT, not an edit to a real source file — the target repo here is a proof-of-concept,
 * not the codebase that renders the audited pages.
 */
function proposalMarkdown(preview: ChangeRequestPreview, timestamp: string): string {
  return [
    `# ${preview.title}`,
    "",
    `_Generated by SearchOps's Indexing & Core Web Vitals tool — ${timestamp}._`,
    "",
    "> **Proof-of-concept PR.** This repo is a scratch target used to prove out the automated",
    "> branch → commit → PR flow. It is NOT the codebase that renders the audited pages, so",
    "> this PR proposes a fix rather than attempting to patch real template files.",
    "",
    preview.body,
  ].join("\n");
}

/** Open a proposal PR for one routing preview. Only call this from an explicit user action. */
export async function openProposalPr(
  preview: ChangeRequestPreview,
  timestamp: string,
): Promise<PullRequestResult> {
  // Repo is resolved upstream in routing (REPO_MAP → preview.repo). The route guards the null
  // case (notify-to-add-repo) before calling here; this is a defensive backstop.
  if (!preview.repo) {
    throw new Error("No repo mapped for this page's section — add it to REPO_MAP before opening a PR.");
  }
  const branch = `seo/${slugify(preview.reason)}-${Date.now()}`;
  const path = `seo-proposals/${slugify(preview.reason)}.md`;
  return openPullRequest({
    repo: preview.repo,
    branch,
    title: preview.title,
    body: `${preview.body}\n\n---\n_Proposal file: \`${path}\`._`,
    changes: [{ path, content: proposalMarkdown(preview, timestamp) }],
  });
}
