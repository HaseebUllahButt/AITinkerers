// Linear ticket client — write path for judgment-call issues (rendering, thin/duplicate;
// PRD R4/§6.2). Uses Linear's GraphQL API directly (no SDK dependency needed for one mutation).
// Needs LINEAR_API_KEY + either LINEAR_TEAM_ID or LINEAR_TEAM_KEY in .env.local.
import type { ChangeRequestPreview } from "./routing";

const LINEAR_API = "https://api.linear.app/graphql";

async function linearRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error("LINEAR_API_KEY not set in .env.local.");
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      // Linear personal API keys go directly in the Authorization header, no "Bearer " prefix.
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    const msg = data.errors?.[0]?.message ?? `Linear API HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data.data as T;
}

async function resolveTeamId(): Promise<string> {
  const explicit = process.env.LINEAR_TEAM_ID;
  if (explicit) return explicit;
  const key = process.env.LINEAR_TEAM_KEY;
  if (!key) throw new Error("Set LINEAR_TEAM_ID or LINEAR_TEAM_KEY in .env.local.");
  const data = await linearRequest<{ teams: { nodes: { id: string; key: string }[] } }>(
    `query { teams { nodes { id key } } }`,
    {},
  );
  const team = data.teams.nodes.find((t) => t.key.toLowerCase() === key.toLowerCase());
  if (!team) throw new Error(`No Linear team found with key "${key}".`);
  return team.id;
}

// SEO tickets are filed into a DEDICATED project so they never mix with existing work
// (a self-contained container the team can archive/delete wholesale). Overridable via
// LINEAR_PROJECT_ID; otherwise found-or-created by name.
const SEO_PROJECT_NAME = "SEO — Indexing & CWV (automated)";

async function resolveProjectId(teamId: string): Promise<string> {
  const explicit = process.env.LINEAR_PROJECT_ID;
  if (explicit) return explicit;

  const found = await linearRequest<{ projects: { nodes: { id: string; name: string }[] } }>(
    `query { projects(first:100) { nodes { id name } } }`,
    {},
  );
  const existing = found.projects.nodes.find((p) => p.name === SEO_PROJECT_NAME);
  if (existing) return existing.id;

  const created = await linearRequest<{
    projectCreate: { success: boolean; project: { id: string } };
  }>(
    `mutation CreateProject($input: ProjectCreateInput!) {
       projectCreate(input: $input) { success project { id } }
     }`,
    {
      input: {
        name: SEO_PROJECT_NAME,
        description:
          "Auto-filed indexing + Core Web Vitals issues from the Summit Indexing tool. Safe to archive.",
        teamIds: [teamId],
      },
    },
  );
  if (!created.projectCreate.success) throw new Error("Linear projectCreate returned success=false.");
  return created.projectCreate.project.id;
}

export interface LinearIssueResult {
  id: string;
  identifier: string;
  url: string;
}

const PRIORITY_TO_LINEAR: Record<string, number> = { p0: 1, p1: 2, p2: 3 }; // Linear: 1=Urgent..4=Low

/** Create a Linear issue for one ticket-routed change request. */
export async function createLinearIssue(preview: ChangeRequestPreview): Promise<LinearIssueResult> {
  if (preview.kind !== "ticket") throw new Error("createLinearIssue expects a ticket-routed preview.");
  const teamId = await resolveTeamId();
  const projectId = await resolveProjectId(teamId);

  const data = await linearRequest<{
    issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } };
  }>(
    `mutation CreateIssue($input: IssueCreateInput!) {
       issueCreate(input: $input) { success issue { id identifier url } }
     }`,
    {
      input: {
        teamId,
        projectId,
        title: preview.title,
        description: preview.body,
        priority: PRIORITY_TO_LINEAR[preview.priority] ?? 3,
      },
    },
  );
  if (!data.issueCreate.success) throw new Error("Linear issueCreate returned success=false.");
  return data.issueCreate.issue;
}
