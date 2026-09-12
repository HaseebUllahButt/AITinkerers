// The database, such as it is.
//
// One pool, one query function, parameterised only. There is no query builder and no ORM here on
// purpose: the schema is four tables (web/migrations/002_searchops.sql) and every call site is a
// handful of lines of SQL that reads as SQL. An abstraction over that would be more code than the
// thing it hides.
//
// ── Missing DATABASE_URL is not a crash ─────────────────────────────────────────────────────────
//
// The audit works with no database at all — it computes a report and returns it. Only the parts that
// have to REMEMBER something need this. So an unset DATABASE_URL logs once and makes every read
// return nothing rather than taking down a page that never needed the database in the first place.
// Writes throw, because a write that silently vanished is the worst of the three outcomes: the
// caller believes it saved.
import { Pool, type QueryResultRow } from "pg";

let pool: Pool | null = null;
let warned = false;

export function dbConfigured(): boolean {
  return !!process.env.DATABASE_URL?.trim();
}

function getPool(): Pool | null {
  if (!dbConfigured()) {
    if (!warned) {
      warned = true;
      console.warn(
        "[db] DATABASE_URL is not set — reads return nothing and writes will throw. " +
        "Start it with `docker compose up -d db`.",
      );
    }
    return null;
  }
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    // A serverless-style runtime opens pools per instance; a small cap keeps a reload storm from
    // exhausting Postgres' own connection limit, which fails in a way that looks like the app
    // hanging rather than like a database problem.
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return pool;
}

/** Read. Returns [] when there is no database, so callers can render an empty state. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string, params: unknown[] = [],
): Promise<T[]> {
  const p = getPool();
  if (!p) return [];
  const res = await p.query<T>(sql, params);
  return res.rows;
}

/** Read expecting at most one row. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string, params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** Write. Throws when there is no database — see the note at the top of this file. */
export async function execute<T extends QueryResultRow = QueryResultRow>(
  sql: string, params: unknown[] = [],
): Promise<T[]> {
  const p = getPool();
  if (!p) throw new Error("DATABASE_URL is not set — cannot write. Run `docker compose up -d db`.");
  const res = await p.query<T>(sql, params);
  return res.rows;
}
