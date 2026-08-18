/**
 * SQLite handle plus schema bootstrap.
 *
 * A single connection is shared process-wide. better-sqlite3 is synchronous,
 * which suits this agent — it does one thing at a time on purpose, and the
 * pacing between actions dwarfs any query cost.
 */

import Database from 'better-sqlite3';
import { PATHS, ensureDirs } from '../config/config.js';
import { SCHEMA } from './schema.js';

let handle: Database.Database | null = null;

export function db(): Database.Database {
  if (handle) return handle;
  ensureDirs();
  handle = new Database(PATHS.db);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  migrate(handle);
  return handle;
}

function migrate(conn: Database.Database): void {
  conn.exec(SCHEMA);
}

/** Point the DB at a different file. Used by tests to stay off the real database. */
export function useDatabase(file: string): Database.Database {
  if (handle) handle.close();
  handle = new Database(file);
  handle.pragma('foreign_keys = ON');
  migrate(handle);
  return handle;
}

export function closeDatabase(): void {
  if (handle) {
    handle.close();
    handle = null;
  }
}

export function getState(key: string): string | null {
  const row = db().prepare('SELECT value FROM agent_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setState(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO agent_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}
