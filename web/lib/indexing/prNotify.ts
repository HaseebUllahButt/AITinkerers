// Slack message builders for the fix-PR flow. Shared by the PR route (production sends) and the
// Slack test sweep (labeled samples), so the two never drift.
import type { RepoTarget } from "./repoMap";

/** Sent when a fix PR is opened — asks the team to review + merge. */
export function prReviewMessage(title: string, repo: RepoTarget, url: string): string {
  return [
    ":wrench: *SEO fix PR — review needed*",
    title,
    `Repo: ${repo.owner}/${repo.repo} · ${url}`,
    "_Auto-drafted, never merged — a human reviews + merges._",
  ].join("\n");
}

/** Sent when a page's section has no repo mapped — nudges the user to add it to REPO_MAP. */
export function prNoRepoMessage(title: string, sections: string[], pageCount: number): string {
  const secList = sections.length ? sections.map((s) => `\`${s}\``).join(", ") : "this page's section";
  return [
    ":warning: *SEO fix — repo needed*",
    `Can't open a fix PR for "${title}".`,
    `No repo mapped for ${secList} (${pageCount} page${pageCount === 1 ? "" : "s"} affected).`,
    "Add it to REPO_MAP, then retry.",
  ].join("\n");
}

/** Distinct top-level "/section" prefixes across a set of URLs (for the no-repo message + UI). */
export function sectionsOf(urls: string[]): string[] {
  const set = new Set<string>();
  for (const u of urls) {
    try {
      const seg = new URL(u).pathname.split("/").filter(Boolean)[0];
      set.add(seg ? `/${seg}` : "/");
    } catch {
      /* skip unparseable */
    }
  }
  return [...set];
}
