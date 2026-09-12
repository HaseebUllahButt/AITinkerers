// The wire shapes the rail works in. Mirrors HermesProject in src/lib/db/queries.ts, minus
// `user_email` — the API only ever returns your own, so carrying it to the client would be a field
// nothing reads and one more place for someone to think scoping happens on the client.

export interface ProjectRow {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
  updated_at: string;
}

/** What the rail needs of a conversation. Structurally a subset of the page's SessionRow.
 *
 *  `project_id` is optional rather than `string | null` because /api/hermes/sessions does not send
 *  it today — its select names its columns and predates projects. The rail therefore treats the
 *  assignment map from /api/hermes/projects as the source of truth and this field as a bonus, so
 *  the day that select widens, nothing here has to change. */
export interface RailSession {
  id: string;
  title: string | null;
  updated_at: string;
  project_id?: string | null;
}
