import { execute, queryOne } from "@/lib/db/pg";

export interface SlackIdentity {
  slack_user_id: string;
  slack_team_id: string;
  user_email: string | null;
}

export async function ensureSlackUser(slackUserId: string, teamId: string): Promise<void> {
  await execute(
    `insert into slack_identities (slack_team_id, slack_user_id)
     values ($1, $2) on conflict (slack_team_id, slack_user_id) do nothing`,
    [teamId, slackUserId],
  );
}

export async function resolveSlackUser(
  slackUserId: string, teamId: string,
): Promise<SlackIdentity | null> {
  return queryOne<SlackIdentity>(
    `select slack_user_id, slack_team_id, user_email
       from slack_identities where slack_team_id = $1 and slack_user_id = $2`,
    [teamId, slackUserId],
  );
}

export async function linkSlackUser(
  slackUserId: string, teamId: string, userEmail: string, linkedBy: string,
): Promise<void> {
  await execute(
    `insert into slack_identities
       (slack_team_id, slack_user_id, user_email, linked_by, linked_at)
     values ($1, $2, $3, $4, now())
     on conflict (slack_team_id, slack_user_id) do update set
       user_email = excluded.user_email, linked_by = excluded.linked_by, linked_at = now()`,
    [teamId, slackUserId, userEmail.trim().toLowerCase(), linkedBy],
  );
}
