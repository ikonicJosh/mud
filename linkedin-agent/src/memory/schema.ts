/**
 * Agent memory schema.
 *
 * Kept as a TS module rather than a .sql file so it survives the tsc build
 * without a copy step. The `actions` table is the audit log and is append-only
 * by convention: every attempted action lands there with the model's draft
 * attached, including the ones the governor blocked.
 */

export const SCHEMA = `
-- Agent memory. Everything the agent knows and everything it has ever done.
--
-- The \`actions\` table is the audit log and is append-only by convention: every
-- attempted action lands here with the model's draft attached, including the ones
-- the governor blocked. If the account is ever reviewed, this table is the record.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS prospects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id       TEXT    NOT NULL UNIQUE,
  profile_url     TEXT    NOT NULL,
  full_name       TEXT    NOT NULL,
  headline        TEXT,
  company         TEXT,
  company_domain  TEXT,
  location        TEXT,
  industry        TEXT,
  fleet_size      INTEGER,
  employee_count  INTEGER,
  source          TEXT    NOT NULL,
  score           INTEGER,
  score_rationale TEXT,
  state           TEXT    NOT NULL DEFAULT 'sourced',
  excluded_reason TEXT,
  ghl_contact_id  TEXT,
  ghl_opportunity_id TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prospects_state ON prospects(state);
CREATE INDEX IF NOT EXISTS idx_prospects_score ON prospects(score DESC);

CREATE TABLE IF NOT EXISTS interactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  direction   TEXT    NOT NULL CHECK (direction IN ('outbound','inbound')),
  action_type TEXT    NOT NULL,
  target_url  TEXT,
  body        TEXT,
  occurred_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_interactions_prospect ON interactions(prospect_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_interactions_type ON interactions(action_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS threads (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id             INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  conversation_id         TEXT    NOT NULL UNIQUE,
  classification          TEXT,
  classification_rationale TEXT,
  last_message_at         TEXT,
  last_message_from       TEXT CHECK (last_message_from IN ('them','us')),
  awaiting_reply          INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_threads_awaiting ON threads(awaiting_reply);

-- Individual messages within a thread, so the brain can read real history
-- rather than guessing at what was already said.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender      TEXT    NOT NULL CHECK (sender IN ('them','us')),
  body        TEXT    NOT NULL,
  sent_at     TEXT    NOT NULL,
  UNIQUE (thread_id, sender, sent_at, body)
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, sent_at);

-- The audit log.
CREATE TABLE IF NOT EXISTS actions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type     TEXT    NOT NULL,
  prospect_id     INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  target_url      TEXT,
  draft           TEXT,
  decision        TEXT    NOT NULL CHECK (decision IN ('allow','defer','block')),
  decision_reason TEXT,
  outcome         TEXT    NOT NULL CHECK (outcome IN ('success','failed','blocked','deferred','dry_run')),
  error           TEXT,
  occurred_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_actions_day ON actions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_actions_type_outcome ON actions(action_type, outcome, occurred_at);

CREATE TABLE IF NOT EXISTS escalations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  reason      TEXT    NOT NULL,
  detail      TEXT    NOT NULL,
  draft       TEXT,
  target_url  TEXT,
  resolved    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_escalations_open ON escalations(resolved, created_at DESC);

-- Posts seen during mining, so the agent never comments on the same post twice
-- and can tell Josh which post a comment attached to.
CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_urn     TEXT    NOT NULL UNIQUE,
  post_url     TEXT    NOT NULL,
  author_public_id TEXT,
  author_name  TEXT,
  body         TEXT,
  seen_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  engaged      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_posts_engaged ON posts(engaged, seen_at DESC);

-- Free-form key/value for run state: first-run date, breaker status, last brief, etc.
CREATE TABLE IF NOT EXISTS agent_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
