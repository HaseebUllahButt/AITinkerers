// Routing scaffold (PRD R4). Groups classified issues into the change-requests that WOULD be
// created — mechanical fixes → GitHub PR previews, judgment calls → ticket previews. This is a
// PREVIEW only: report-only mode builds the payloads and the UI shows them; nothing is ever
// pushed to GitHub or a ticket system, and a human always merges (§1 delivery model).
import type { Issue, Owner, Priority, Route, RootCause } from "./classify";
import type { CwvResult } from "./cwv";
import { repoForPath, type RepoTarget } from "./repoMap";

export interface RoutableUrl {
  url: string;
  path: string;
  template: string;
  isMoney: boolean;
  issues: Issue[];
}

export interface ChangeRequestPreview {
  kind: Route; // "pr" | "ticket"
  reason: string;
  title: string;
  rootCause: RootCause;
  owner: Owner;
  priority: Priority;
  fix: string;
  /** Suggested branch name for PRs. */
  branch?: string;
  /** Markdown body preview. */
  body: string;
  /** Affected URLs (deduped). */
  urls: string[];
  /** Templates the affected URLs belong to. */
  templates: string[];
  /**
   * For PR-routed previews: the repo this fix should open in, resolved from the page section via
   * REPO_MAP. null = the section has no repo mapped (the route notifies instead of opening a PR).
   * undefined/absent for ticket-routed previews (tickets don't target a repo).
   */
  repo?: RepoTarget | null;
}

const PRIORITY_RANK: Record<Priority, number> = { p0: 0, p1: 1, p2: 2 };
const higher = (a: Priority, b: Priority): Priority =>
  PRIORITY_RANK[a] <= PRIORITY_RANK[b] ? a : b;

function slug(reason: string): string {
  return reason.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

/**
 * Build change-request previews. PR-routed issues group by reason (a template-wide fix is one
 * PR); ticket-routed issues (rendering, thin/dup) group by reason + template so each failing
 * template becomes one engineering/content ticket. Money-page + top-template first via priority.
 */
export function buildRoutingPreviews(urls: RoutableUrl[]): ChangeRequestPreview[] {
  // key → aggregate
  const groups = new Map<
    string,
    {
      sample: Issue;
      urls: Set<string>;
      templates: Set<string>;
      priority: Priority;
      anyMoney: boolean;
      repo: RepoTarget | null;
    }
  >();

  for (const u of urls) {
    // Resolve the repo once per URL; PR grouping keys on it so each PR targets exactly ONE repo
    // (a mechanical fix that spans several sections becomes one PR per repo). null = unmapped.
    const repo = repoForPath(u.path);
    for (const issue of u.issues) {
      // "unreachable" is a crawl failure (timeout/bot-block), not a page defect a team can fix —
      // it's surfaced as a count/note, never as a change request.
      if (issue.reason === "unreachable") continue;
      const key =
        issue.route === "ticket"
          ? `${issue.reason}::${u.template}`
          : `${issue.reason}::${repo?.section ?? "__unmapped__"}`;
      const g = groups.get(key);
      if (g) {
        g.urls.add(u.url);
        g.templates.add(u.template);
        g.priority = higher(g.priority, issue.priority);
        g.anyMoney = g.anyMoney || u.isMoney;
      } else {
        groups.set(key, {
          sample: issue,
          urls: new Set([u.url]),
          templates: new Set([u.template]),
          priority: issue.priority,
          anyMoney: u.isMoney,
          repo: issue.route === "pr" ? repo : null,
        });
      }
    }
  }

  const previews: ChangeRequestPreview[] = [];
  for (const [, g] of groups) {
    const { sample } = g;
    const urlList = [...g.urls];
    const templateList = [...g.templates];
    const count = urlList.length;
    const scope =
      sample.route === "ticket" && templateList.length === 1
        ? `template \`${templateList[0]}\``
        : `${count} page${count === 1 ? "" : "s"}`;

    const title =
      sample.route === "pr"
        ? `[SEO] ${sample.label} — ${scope}`
        : `[SEO] ${sample.label} — ${scope}`;

    const repoLine =
      sample.route === "pr"
        ? g.repo
          ? `**Repo:** ${g.repo.owner}/${g.repo.repo} (${g.repo.baseBranch})`
          : "**Repo:** no repo mapped for this section — add it to REPO_MAP"
        : null;

    const bodyLines = [
      ...(repoLine ? [repoLine] : []),
      `**Root cause:** ${sample.rootCause}`,
      `**Owner:** ${g.anyMoney ? `${sample.owner} (money page)` : sample.owner}`,
      `**Priority:** ${g.priority.toUpperCase()}`,
      "",
      `**Fix:** ${sample.fix}`,
      "",
      `**Affected (${count}):**`,
      ...urlList.slice(0, 25).map((u) => `- ${u}`),
      ...(count > 25 ? [`- …and ${count - 25} more`] : []),
      "",
      "_Preview only — no PR/ticket was created. A human reviews + merges._",
    ];

    previews.push({
      kind: sample.route,
      reason: sample.reason,
      title,
      rootCause: sample.rootCause,
      owner: sample.owner,
      priority: g.priority,
      fix: sample.fix,
      branch: sample.route === "pr" ? `seo/${slug(sample.reason)}` : undefined,
      body: bodyLines.join("\n"),
      urls: urlList,
      templates: templateList,
      repo: sample.route === "pr" ? g.repo : undefined,
    });
  }

  // Highest priority first, then larger blast radius.
  return previews.sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.urls.length - a.urls.length,
  );
}

const METRIC_LABEL: Record<"lcp" | "inp" | "cls", string> = {
  lcp: "loading speed (LCP)",
  inp: "responsiveness (INP)",
  cls: "visual stability (CLS)",
};

/**
 * Turn failing Core Web Vitals templates into engineering tickets (PRD R9). One ticket per
 * template that fails the field p75 bar, owned by webdev (CWV fixes are architectural), with
 * the per-metric diagnosis in the body. CWV is a secondary ranking signal, so money-page
 * templates are P1 and the rest P2 — never P0.
 */
export function buildCwvTickets(
  cwv: CwvResult[],
  isMoneyByTemplate: Record<string, boolean>,
): ChangeRequestPreview[] {
  const tickets: ChangeRequestPreview[] = [];
  for (const c of cwv) {
    if (!c.hasField || c.evaluation.passesField) continue;
    const failing = (["lcp", "inp", "cls"] as const).filter(
      (m) => c.evaluation[m].rating === "needs_improvement" || c.evaluation[m].rating === "poor",
    );
    if (failing.length === 0) continue;

    const money = isMoneyByTemplate[c.template] ?? false;
    const priority: Priority = money ? "p1" : "p2";
    const diagnosisLines = failing.flatMap((m) => c.diagnosis[m].map((d) => `- ${METRIC_LABEL[m]}: ${d}`));

    const bodyLines = [
      `**Root cause:** CWV_PERFORMANCE`,
      `**Owner:** webdev${money ? " (money page)" : ""}`,
      `**Priority:** ${priority.toUpperCase()}`,
      "",
      `**Failing metrics (field p75, ${c.device}):** ${failing
        .map((m) => `${METRIC_LABEL[m]} = ${c.evaluation[m].value ?? "n/a"}${m === "cls" ? "" : "ms"} (${c.evaluation[m].rating})`)
        .join(", ")}`,
      "",
      diagnosisLines.length ? "**Likely causes:**" : "",
      ...diagnosisLines,
      "",
      `**Representative URL:** ${c.representativeUrl}`,
      "",
      "_Preview only — no ticket was created until a human clicks Create._",
    ].filter((l) => l !== "");

    tickets.push({
      kind: "ticket",
      reason: "cwv_slow",
      title: `[SEO] Slow Core Web Vitals — template \`${c.template}\``,
      rootCause: "CWV_PERFORMANCE",
      owner: "webdev",
      priority,
      fix: `Improve ${failing.map((m) => METRIC_LABEL[m]).join(", ")} on this template. Fixes are architectural (defer/split JS, preload the hero image, reserve space for late elements).`,
      body: bodyLines.join("\n"),
      urls: [c.representativeUrl],
      templates: [c.template],
    });
  }
  return tickets;
}
