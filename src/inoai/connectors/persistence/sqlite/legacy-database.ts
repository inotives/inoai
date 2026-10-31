import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Configuration } from "../../../agent-instance/config.js";
import { inspectRuntimeHomeLock, resolveRuntimeHome, type RuntimeHome } from "../../../agent-instance/runtime-home.js";
import { nextRunAt, taskSpecFromRow, toTaskColumns, type TaskColumns, type TaskSpec } from "../../../tasks/schedule.js";

export const databaseBusyTimeoutMs = 5_000;

const initialSchema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  transport TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'family' CHECK (role IN ('owner', 'family')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)),
  UNIQUE (transport, workspace_id, external_user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  transport TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  parent_conversation_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  initiating_external_message_id TEXT NOT NULL,
  agent_provider TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'ended', 'failed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  ended_at INTEGER,
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_session_per_conversation ON sessions(transport, workspace_id, conversation_id) WHERE state = 'active' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS unique_initiating_message ON sessions(transport, workspace_id, initiating_external_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS unique_agent_session ON sessions(agent_provider, agent_session_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  transport TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  external_message_id TEXT,
  external_author_id TEXT,
  user_id INTEGER REFERENCES users(id),
  direction TEXT NOT NULL CHECK (direction IN ('user', 'agent')),
  body TEXT NOT NULL,
  reply_to_external_message_id TEXT,
  in_reply_to_message_id INTEGER REFERENCES messages(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
  failure_detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  started_at INTEGER,
  runtime_started_at INTEGER,
  completed_at INTEGER,
  provisional_id TEXT UNIQUE,
  delivery_state TEXT CHECK (delivery_state IN ('pending', 'uncertain', 'confirmed', 'failed')),
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK (direction != 'user' OR external_message_id IS NOT NULL),
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_external_message ON messages(transport, workspace_id, external_message_id);
CREATE INDEX IF NOT EXISTS pending_user_messages ON messages(direction, state, id);
CREATE INDEX IF NOT EXISTS messages_by_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id),
  message_id INTEGER REFERENCES messages(id),
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS events_by_session ON events(session_id, id);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  runtime_approval_id TEXT NOT NULL UNIQUE,
  request_message_id INTEGER REFERENCES messages(id),
  resolution_message_id INTEGER REFERENCES messages(id),
  summary TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected', 'expired', 'failed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS pending_approvals_by_session ON approvals(session_id, id) WHERE state = 'pending' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS memory_reviews (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  from_message_id INTEGER NOT NULL REFERENCES messages(id),
  through_message_id INTEGER NOT NULL REFERENCES messages(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
  recap TEXT,
  failure_detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  started_at INTEGER,
  completed_at INTEGER,
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS due_memory_reviews ON memory_reviews(state, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  source_message_id INTEGER REFERENCES messages(id),
  created_by_user_id INTEGER REFERENCES users(id),
  review_id INTEGER REFERENCES memory_reviews(id),
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'review')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleted')),
  kind TEXT NOT NULL DEFAULT 'topic' CHECK (kind IN ('core', 'topic')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS active_memories ON memories(state, id);

CREATE TABLE IF NOT EXISTS memory_proposals (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  normalized_body TEXT NOT NULL CHECK (length(normalized_body) > 0),
  kind TEXT NOT NULL DEFAULT 'topic' CHECK (kind IN ('core', 'topic')),
  review_id INTEGER NOT NULL REFERENCES memory_reviews(id),
  source_message_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_message_ids_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'confirmed', 'rejected', 'expired')),
  card_message_id TEXT,
  expires_at INTEGER NOT NULL,
  answered_at INTEGER,
  created_memory_id INTEGER REFERENCES memories(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((state = 'pending' AND answered_at IS NULL) OR (state != 'pending' AND answered_at IS NOT NULL)),
  CHECK (created_memory_id IS NULL OR state = 'confirmed'),
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS pending_memory_proposals ON memory_proposals(state, expires_at, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS memory_proposals_by_normalized_body ON memory_proposals(normalized_body, state) WHERE deleted_at IS NULL;

-- Append-only: one row per Memory added to a chat Turn (message_id) or Task run (task_run_id).
CREATE TABLE IF NOT EXISTS memory_uses (
  id INTEGER PRIMARY KEY,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  message_id INTEGER REFERENCES messages(id),
  task_run_id INTEGER REFERENCES task_runs(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  CHECK (message_id IS NOT NULL OR task_run_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS memory_uses_by_memory ON memory_uses(memory_id, id);
CREATE TRIGGER IF NOT EXISTS memory_uses_no_update BEFORE UPDATE ON memory_uses
  BEGIN SELECT RAISE(ABORT, 'memory_uses is append-only'); END;
CREATE TRIGGER IF NOT EXISTS memory_uses_no_delete BEFORE DELETE ON memory_uses
  BEGIN SELECT RAISE(ABORT, 'memory_uses is append-only'); END;

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  goal TEXT NOT NULL CHECK (length(trim(goal)) > 0),
  task_type TEXT NOT NULL CHECK (task_type IN ('one_time', 'recurring')),
  interval_seconds INTEGER,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'completed', 'cancelled')),
  conversation_id TEXT NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  next_due_at INTEGER,
  message_cursor INTEGER NOT NULL DEFAULT 0 CHECK (message_cursor >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((task_type = 'one_time' AND interval_seconds IS NULL) OR
    (task_type = 'recurring' AND interval_seconds > 0 AND interval_seconds % 3600 = 0)),
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)),
  UNIQUE (session_id)
);
CREATE INDEX IF NOT EXISTS due_tasks ON tasks(state, next_due_at, id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'failed', 'cancelled')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  failure_detail TEXT CHECK (failure_detail IS NULL OR length(failure_detail) <= 500),
  artifact_paths_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifact_paths_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((state = 'processing' AND completed_at IS NULL) OR (state != 'processing' AND completed_at IS NOT NULL)),
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_task_run ON task_runs(state)
  WHERE state = 'processing' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS task_runs_by_task ON task_runs(task_id, id) WHERE deleted_at IS NULL;

${taskProposalsTable("IF NOT EXISTS task_proposals")}
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_task_proposal_per_conversation ON task_proposals(transport, workspace_id, conversation_id)
  WHERE state = 'pending' AND deleted_at IS NULL;
`;

export class UnsafeDatabasePathError extends Error {
  constructor(databaseFile: string) {
    super(`Database must be inoai.sqlite inside the selected runtime home: ${databaseFile}`);
    this.name = "UnsafeDatabasePathError";
  }
}

// `confirming` is a claimed Create or management confirm whose side effects are running. `card_closed_at` records the
// card edit that removed its buttons after the proposal left pending or confirming.
function taskProposalsTable(target: string): string {
  return `CREATE TABLE ${target} (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  transport TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create', 'edit', 'run', 'pause', 'resume', 'cancel')),
  task_id INTEGER REFERENCES tasks(id),
  spec_json TEXT CHECK (spec_json IS NULL OR json_valid(spec_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'confirming', 'confirmed', 'cancelled', 'expired', 'failed')),
  expires_at INTEGER NOT NULL,
  card_message_id TEXT,
  card_closed_at INTEGER,
  resolved_at INTEGER,
  result_task_id INTEGER REFERENCES tasks(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((kind = 'create' AND task_id IS NULL) OR (kind != 'create' AND task_id IS NOT NULL)),
  CHECK ((kind IN ('create', 'edit') AND spec_json IS NOT NULL) OR (kind NOT IN ('create', 'edit') AND spec_json IS NULL)),
  CHECK ((state IN ('pending', 'confirming') AND resolved_at IS NULL) OR (state NOT IN ('pending', 'confirming') AND resolved_at IS NOT NULL)),
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);`;
}

/** Rebuilds a T-0001 `task_proposals` table to allow `confirming` and add `card_closed_at`. Keeps every row. */
function migrateTaskProposals(database: DatabaseSync): void {
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_proposals'").get() as { sql: string } | undefined;
  if (!table || table.sql.includes("'confirming'")) return;
  database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    database.exec(`${taskProposalsTable("task_proposals_v2")}
    INSERT INTO task_proposals_v2 (id, session_id, transport, workspace_id, conversation_id, kind, task_id, spec_json, state,
      expires_at, card_message_id, resolved_at, result_task_id, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by)
    SELECT id, session_id, transport, workspace_id, conversation_id, kind, task_id, spec_json, state,
      expires_at, card_message_id, resolved_at, result_task_id, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by
    FROM task_proposals;
    DROP TABLE task_proposals;
    ALTER TABLE task_proposals_v2 RENAME TO task_proposals;
    CREATE UNIQUE INDEX one_pending_task_proposal_per_conversation ON task_proposals(transport, workspace_id, conversation_id)
      WHERE state = 'pending' AND deleted_at IS NULL;`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
  if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("Task proposal migration broke a foreign key");
}

function migrateMessages(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (columns.some(({ name }) => name === "delivery_state")) return;
  database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    database.exec(`CREATE TABLE messages_v2 (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      transport TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      external_message_id TEXT,
      external_author_id TEXT,
      user_id INTEGER REFERENCES users(id),
      direction TEXT NOT NULL CHECK (direction IN ('user', 'agent')),
      body TEXT NOT NULL,
      reply_to_external_message_id TEXT,
      in_reply_to_message_id INTEGER REFERENCES messages(id),
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
      failure_detail TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by TEXT NOT NULL DEFAULT 'system',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_by TEXT NOT NULL DEFAULT 'system',
      started_at INTEGER,
      runtime_started_at INTEGER,
      completed_at INTEGER,
      provisional_id TEXT UNIQUE,
      delivery_state TEXT CHECK (delivery_state IN ('pending', 'uncertain', 'confirmed', 'failed')),
      deleted_at INTEGER,
      deleted_by TEXT,
      CHECK (direction != 'user' OR external_message_id IS NOT NULL),
      CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
    );
    INSERT INTO messages_v2 (id, session_id, transport, workspace_id, external_message_id, external_author_id, user_id,
      direction, body, reply_to_external_message_id, in_reply_to_message_id, state, failure_detail,
      created_at, created_by, updated_at, updated_by, started_at, completed_at, delivery_state, deleted_at, deleted_by)
    SELECT id, session_id, transport, workspace_id, external_message_id, external_author_id, user_id,
      direction, body, reply_to_external_message_id, in_reply_to_message_id, state, failure_detail,
      created_at, created_by, updated_at, updated_by, started_at, completed_at,
      CASE WHEN direction = 'agent' THEN 'confirmed' END, deleted_at, deleted_by FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_v2 RENAME TO messages;
    CREATE UNIQUE INDEX unique_external_message ON messages(transport, workspace_id, external_message_id);
    CREATE INDEX pending_user_messages ON messages(direction, state, id);
    CREATE INDEX messages_by_session ON messages(session_id, id);`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
  if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("Message migration broke a foreign key");
}

const taskScheduleColumns = [
  ["title", "TEXT"], ["output_spec", "TEXT"], ["timezone", "TEXT"], ["schedule_kind", "TEXT"],
  ["schedule_time", "TEXT"], ["schedule_days", "TEXT"], ["ends_at", "INTEGER"], ["max_runs", "INTEGER"],
] as const;

function migrateTasks(database: DatabaseSync): void {
  const missingColumns = () => {
    const existing = new Set((database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(({ name }) => name));
    return taskScheduleColumns.filter(([name]) => !existing.has(name));
  };
  if (missingColumns().length === 0) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    // Another connection may have added columns before this one took the write lock.
    for (const [name, type] of missingColumns()) database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Adds `memories.kind` to a database created before Memory kinds. Existing Memories become `topic`. */
function migrateMemories(database: DatabaseSync): void {
  const hasKind = () => (database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).some(({ name }) => name === "kind");
  if (hasKind()) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    // Another connection may have added the column before this one took the write lock.
    if (!hasKind()) database.exec("ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'topic' CHECK (kind IN ('core', 'topic'))");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function openDatabase(home: RuntimeHome): DatabaseSync {
  const directory = resolve(home.directory);
  const databaseFile = resolve(home.databaseFile);
  const expectedFile = join(directory, "inoai.sqlite");
  if (databaseFile !== expectedFile || lstatSync(directory).isSymbolicLink() || (existsSync(databaseFile) && lstatSync(databaseFile).isSymbolicLink())) {
    throw new UnsafeDatabasePathError(home.databaseFile);
  }

  const database = new DatabaseSync(databaseFile);
  try {
    database.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${databaseBusyTimeoutMs};`);
    database.exec(initialSchema);
    migrateMessages(database);
    migrateTasks(database);
    migrateMemories(database);
    migrateTaskProposals(database);
    recoverStaleWork(database);
    recoverLegacyApprovals(database);
    recoverTaskProposals(database, Math.floor(Date.now() / 1000));
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export class MaintenanceDatabaseUnavailableError extends Error {
  constructor(reason: string) {
    super(`Maintenance database unavailable: ${reason}`);
    this.name = "MaintenanceDatabaseUnavailableError";
  }
}

function validateMaintenanceDatabase(database: DatabaseSync): void {
  const objects = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as Array<{ name: string }>).map(({ name }) => name));
  const required = [...initialSchema.matchAll(/CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS (\w+)/g)].map((match) => match[1]!);
  if (required.some((name) => !objects.has(name))) {
    throw new MaintenanceDatabaseUnavailableError("schema initialization or migration is required");
  }
  const messageColumns = database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  const memoryColumns = database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!messageColumns.some(({ name }) => name === "delivery_state") || !memoryColumns.some(({ name }) => name === "kind")) {
    throw new MaintenanceDatabaseUnavailableError("schema migration is required");
  }
  const recovery = database.prepare(`SELECT
    EXISTS(SELECT 1 FROM messages WHERE direction='user' AND state='processing' AND deleted_at IS NULL) AS stale_messages,
    EXISTS(SELECT 1 FROM memory_reviews WHERE state='processing' AND deleted_at IS NULL) AS stale_reviews,
    EXISTS(SELECT 1 FROM messages WHERE id IN (SELECT request_message_id FROM approvals WHERE request_message_id IS NOT NULL)
      AND direction='agent' AND body != 'Legacy approval request redacted') AS unredacted_requests,
    EXISTS(SELECT 1 FROM approvals WHERE summary != 'Legacy approval request redacted'
      OR (state='pending' AND deleted_at IS NULL)) AS legacy_approvals,
    EXISTS(SELECT 1 FROM task_runs WHERE state='processing' AND deleted_at IS NULL) AS stale_task_runs`).get() as {
      stale_messages: number; stale_reviews: number; unredacted_requests: number; legacy_approvals: number; stale_task_runs: number;
    };
  if (Object.values(recovery).some(Boolean)) {
    throw new MaintenanceDatabaseUnavailableError("runtime startup recovery is required");
  }
}

/** Run a short maintenance operation against an initialized, live runtime home. */
export async function withMaintenanceDatabase<T>(home: RuntimeHome, operation: (database: DatabaseSync) => T | Promise<T>): Promise<T> {
  const directory = resolve(home.directory);
  const databaseFile = resolve(home.databaseFile);
  const selectedHome = resolveRuntimeHome(dirname(directory), `direct:${directory}`);
  if (directory !== selectedHome.directory || databaseFile !== selectedHome.databaseFile
    || resolve(home.lockFile) !== selectedHome.lockFile
    || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()
    || !lstatSync(home.lockFile).isFile() || lstatSync(home.lockFile).isSymbolicLink()
    || !existsSync(databaseFile) || !lstatSync(databaseFile).isFile() || lstatSync(databaseFile).isSymbolicLink()) {
    throw new UnsafeDatabasePathError(home.databaseFile);
  }
  if (await inspectRuntimeHomeLock(home.lockFile) !== "live") {
    throw new MaintenanceDatabaseUnavailableError("a live runtime lock was not confirmed");
  }

  const database = new DatabaseSync(databaseFile);
  try {
    database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${databaseBusyTimeoutMs}`);
    validateMaintenanceDatabase(database);
    return await operation(database);
  } finally {
    database.close();
  }
}

type AuditColumns = {
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
  deleted_at: number | null;
  deleted_by: string | null;
};

export type UserRecord = AuditColumns & {
  id: number;
  transport: string;
  workspace_id: string;
  external_user_id: string;
  display_name: string | null;
  role: "owner" | "family";
  state: "active" | "disabled";
};

export type SessionRecord = AuditColumns & {
  id: number;
  user_id: number;
  transport: string;
  workspace_id: string;
  parent_conversation_id: string;
  conversation_id: string;
  initiating_external_message_id: string;
  agent_provider: string;
  agent_session_id: string;
  project_path: string;
  state: "active" | "ended" | "failed";
  ended_at: number | null;
};

export type MessageRecord = AuditColumns & {
  id: number;
  session_id: number;
  transport: string;
  workspace_id: string;
  external_message_id: string | null;
  external_author_id: string | null;
  user_id: number | null;
  direction: "user" | "agent";
  body: string;
  reply_to_external_message_id: string | null;
  in_reply_to_message_id: number | null;
  state: "pending" | "processing" | "completed" | "failed";
  failure_detail: string | null;
  started_at: number | null;
  runtime_started_at: number | null;
  completed_at: number | null;
  provisional_id: string | null;
  delivery_state: "pending" | "uncertain" | "confirmed" | "failed" | null;
};

export type EventRecord = AuditColumns & {
  id: number;
  session_id: number | null;
  message_id: number | null;
  event_type: string;
  detail: string | null;
};

export type ApprovalRecord = AuditColumns & {
  id: number;
  session_id: number;
  runtime_approval_id: string;
  request_message_id: number | null;
  resolution_message_id: number | null;
  summary: string;
  expires_at: number;
  state: "pending" | "approved" | "rejected" | "expired" | "failed";
};

export const commandApprovalSummary = "Codex command approval (preview shown only in Discord)";

export function createCommandApproval(database: DatabaseSync, sessionId: number, runtimeApprovalId: string, expiresAt: number): ApprovalRecord {
  const result = database.prepare(`INSERT INTO approvals (session_id, runtime_approval_id, summary, expires_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, 'runtime:codex', 'runtime:codex')`).run(sessionId, runtimeApprovalId, commandApprovalSummary, expiresAt);
  return activeRow<ApprovalRecord>(database, "SELECT * FROM approvals WHERE id = ? AND deleted_at IS NULL", Number(result.lastInsertRowid))!;
}

export function setCommandApprovalCard(database: DatabaseSync, approvalId: number, messageId: number): boolean {
  return database.prepare(`UPDATE approvals SET request_message_id = ?, updated_at = unixepoch(), updated_by = 'transport:discord'
    WHERE id = ? AND state = 'pending' AND request_message_id IS NULL AND deleted_at IS NULL`).run(messageId, approvalId).changes === 1;
}

export function resolveCommandApproval(database: DatabaseSync, approvalId: number, state: "approved" | "rejected" | "expired" | "failed"): boolean {
  return database.prepare(`UPDATE approvals SET state = ?, updated_at = unixepoch(), updated_by = 'runtime:codex'
    WHERE id = ? AND state = 'pending' AND deleted_at IS NULL`).run(state, approvalId).changes === 1;
}

export type MemoryRecord = AuditColumns & {
  id: number;
  body: string;
  source_message_id: number | null;
  created_by_user_id: number | null;
  review_id: number | null;
  origin: "manual" | "review";
  state: "active" | "deleted";
  kind: MemoryKind;
};

export type MemoryKind = "core" | "topic";

export type MemoryProposalRecord = AuditColumns & {
  id: number;
  body: string;
  normalized_body: string;
  kind: MemoryKind;
  review_id: number;
  source_message_ids: number[];
  state: "pending" | "confirmed" | "rejected" | "expired";
  card_message_id: string | null;
  expires_at: number;
  answered_at: number | null;
  created_memory_id: number | null;
};
export type NewMemoryProposal = Pick<MemoryProposalRecord, "body" | "kind" | "review_id" | "source_message_ids" | "expires_at">;
/** `answered` is false when the proposal was not pending and unexpired; nothing changed then. */
export type MemoryProposalAnswer = { answered: boolean; proposal: MemoryProposalRecord | undefined };
/** `memory` is the created Memory, or the active Memory with the same normalized body when confirm was a no-op. */
export type MemoryProposalConfirmation = MemoryProposalAnswer & { memory?: MemoryRecord; duplicate: boolean };

export type MemoryUseRecord = {
  id: number;
  memory_id: number;
  session_id: number;
  message_id: number | null;
  task_run_id: number | null;
  created_at: number;
  created_by: string;
};
export type NewMemoryUse = Pick<MemoryUseRecord, "memory_id" | "session_id" | "message_id" | "task_run_id">;

export type MemoryReviewRecord = AuditColumns & {
  id: number;
  session_id: number;
  from_message_id: number;
  through_message_id: number;
  state: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  next_attempt_at: number;
  recap: string | null;
  failure_detail: string | null;
  started_at: number | null;
  completed_at: number | null;
};

export type TaskRecord = AuditColumns & {
  id: number;
  goal: string;
  task_type: "one_time" | "recurring";
  interval_seconds: number | null;
  state: "active" | "paused" | "completed" | "cancelled";
  conversation_id: string;
  session_id: number;
  next_due_at: number | null;
  message_cursor: number;
  title: string | null;
  output_spec: string | null;
  timezone: string | null;
  schedule_kind: "once" | "interval" | "daily" | "days" | "weekly" | null;
  schedule_time: string | null;
  schedule_days: string | null;
  ends_at: number | null;
  max_runs: number | null;
};

export type TaskRunRecord = AuditColumns & {
  id: number;
  task_id: number;
  state: "processing" | "completed" | "failed" | "cancelled";
  started_at: number;
  completed_at: number | null;
  failure_detail: string | null;
  artifact_paths: string[];
};

export type TaskProposalKind = "create" | "edit" | "run" | "pause" | "resume" | "cancel";
export type TaskProposalRecord = AuditColumns & {
  id: number;
  session_id: number;
  transport: string;
  workspace_id: string;
  conversation_id: string;
  kind: TaskProposalKind;
  task_id: number | null;
  spec_json: string | null;
  state: "pending" | "confirming" | "confirmed" | "cancelled" | "expired" | "failed";
  expires_at: number;
  card_message_id: string | null;
  card_closed_at: number | null;
  resolved_at: number | null;
  result_task_id: number | null;
};
export type NewTaskProposal = Pick<TaskProposalRecord, "session_id" | "transport" | "workspace_id" | "conversation_id"
  | "kind" | "task_id" | "spec_json" | "expires_at">;
export type TaskProposalOutcome = "confirmed" | "cancelled" | "failed";
/** A resolved proposal whose card still shows buttons. `replaced` is true when a newer proposal expired it. */
export type OpenTaskProposalCard = TaskProposalRecord & { card_message_id: string; replaced: boolean };
export type TaskEditResult = "edited" | "not_found" | "not_editable" | "running" | "no_run_left";
export type PendingTaskOwner = Pick<SessionRecord, "user_id" | "transport" | "workspace_id" | "agent_provider" | "project_path">;

export type NewTask = Pick<TaskRecord, "goal" | "task_type" | "conversation_id" | "session_id">
  & Partial<Pick<TaskRecord, "interval_seconds" | "next_due_at" | "message_cursor" | "title" | "output_spec" | "timezone"
    | "schedule_kind" | "schedule_time" | "schedule_days" | "ends_at" | "max_runs">>;

export type NewUser = Omit<UserRecord, keyof AuditColumns | "id">;
export type NewSession = Omit<SessionRecord, keyof AuditColumns | "id" | "ended_at" | "state"> & { state?: SessionRecord["state"] };
export type NewMessage = Omit<MessageRecord, keyof AuditColumns | "id" | "failure_detail" | "started_at" | "runtime_started_at" | "completed_at" | "provisional_id" | "delivery_state" | "state"> & { state?: MessageRecord["state"] };
export type NewAgentResponse = Omit<NewMessage, "session_id" | "direction" | "in_reply_to_message_id" | "state">;
export type MessageQueueMode = "per-session" | "global";
export type NewEvent = Omit<EventRecord, keyof AuditColumns | "id">;
export type NewMemory = Omit<MemoryRecord, keyof AuditColumns | "id" | "state" | "kind"> & { kind?: MemoryKind };
export type NewMemoryReview = Omit<MemoryReviewRecord, keyof AuditColumns | "id" | "attempts" | "next_attempt_at" | "recap" | "failure_detail" | "started_at" | "completed_at" | "state">;

function activeRow<T>(database: DatabaseSync, sql: string, ...values: Array<string | number | bigint | Uint8Array | null>): T | undefined {
  return database.prepare(sql).get(...values) as T | undefined;
}

export function recoverStaleWork(database: DatabaseSync, actor = "startup-recovery"): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`UPDATE messages SET state = 'failed', failure_detail = 'Runtime outcome uncertain after restart',
      completed_at = unixepoch(), updated_at = unixepoch(), updated_by = ?
      WHERE direction = 'user' AND state = 'processing' AND runtime_started_at IS NOT NULL AND deleted_at IS NULL`).run(actor);
    database.prepare(`UPDATE messages SET state = 'pending', updated_at = unixepoch(), updated_by = ?
      WHERE direction = 'user' AND state = 'processing' AND runtime_started_at IS NULL AND deleted_at IS NULL`).run(actor);
    database.prepare(`UPDATE memory_reviews SET state = 'pending', updated_at = unixepoch(), updated_by = ?
      WHERE state = 'processing' AND deleted_at IS NULL`).run(actor);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export type RecoveredTaskRun = { id: number; task_id: number; started_at: number; completed_at: number };

/** Fails Task Runs left `processing` by a restart and returns the runs it failed. */
export function recoverTaskRuns(database: DatabaseSync, actor = "startup-recovery", now = Math.floor(Date.now() / 1000)): RecoveredTaskRun[] {
  database.exec("BEGIN IMMEDIATE");
  try {
    const runs = database.prepare("SELECT id, task_id, started_at FROM task_runs WHERE state='processing' AND deleted_at IS NULL ORDER BY id").all() as Array<{ id: number; task_id: number; started_at: number }>;
    const stale = database.prepare("SELECT DISTINCT task_id FROM task_runs WHERE state='processing' AND deleted_at IS NULL").all() as Array<{ task_id: number }>;
    database.prepare(`UPDATE task_runs SET state='failed', failure_detail='Interrupted by restart', completed_at=?, updated_at=?, updated_by=?
      WHERE state='processing' AND deleted_at IS NULL`).run(now, now, actor);
    const updateTask = database.prepare(`UPDATE tasks SET next_due_at=?+interval_seconds, updated_at=?, updated_by=?
      WHERE id=? AND task_type='recurring' AND schedule_kind IS NULL AND state IN ('active','paused') AND deleted_at IS NULL`);
    for (const { task_id } of stale) {
      updateTask.run(now, now, actor, task_id);
      advanceScheduledTask(database, task_id, now, actor);
    }
    database.exec("COMMIT");
    return runs.map((run) => ({ ...run, completed_at: now }));
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Sets the next run of a scheduled task (`schedule_kind` set) after a run ends, or
 * completes the task when its stop condition is reached. Runs that ended as
 * completed or failed count toward `max_runs`. Legacy tasks are left unchanged.
 * Call inside the caller's transaction.
 */
function advanceScheduledTask(database: DatabaseSync, taskId: number, now: number, actor: string): void {
  const task = getTask(database, taskId);
  if (!task || task.schedule_kind == null || (task.state !== "active" && task.state !== "paused")) return;
  const { runs } = database.prepare(`SELECT COUNT(*) AS runs FROM task_runs
    WHERE task_id=? AND state IN ('completed','failed') AND deleted_at IS NULL`).get(taskId) as { runs: number };
  const spec = taskSpecFromRow(task);
  const next = spec ? nextRunAt(spec, now, runs) : null;
  database.prepare("UPDATE tasks SET next_due_at=?,state=?,updated_at=?,updated_by=? WHERE id=?")
    .run(next, next === null ? "completed" : task.state, now, actor, taskId);
}

type TaskRunRow = Omit<TaskRunRecord, "artifact_paths"> & { artifact_paths_json: string };
function taskRun(row: TaskRunRow): TaskRunRecord {
  const { artifact_paths_json, ...record } = row;
  return { ...record, artifact_paths: JSON.parse(artifact_paths_json) as string[] };
}

export function createTask(database: DatabaseSync, task: NewTask, actor = "system"): TaskRecord {
  if (!task.goal.trim()) throw new RangeError("Task goal is required");
  if (task.task_type === "recurring" && (!Number.isSafeInteger(task.interval_seconds) || task.interval_seconds! <= 0 || task.interval_seconds! % 3600 !== 0)) throw new RangeError("Recurring Task interval must be whole hours");
  if (task.task_type === "one_time" && (task.interval_seconds != null || (task.schedule_kind == null && task.next_due_at != null))) throw new RangeError("One-time Task cannot have a schedule");
  if (!database.prepare("SELECT 1 FROM sessions WHERE id=? AND conversation_id=? AND state='active' AND deleted_at IS NULL").get(task.session_id, task.conversation_id)) throw new Error("Task Session is not active in its Conversation");
  const nextDueAt = task.next_due_at ?? (task.task_type === "recurring" ? Math.floor(Date.now() / 1000) + task.interval_seconds! : null);
  const result = database.prepare(`INSERT INTO tasks (goal,task_type,interval_seconds,state,conversation_id,session_id,next_due_at,message_cursor,
    title,output_spec,timezone,schedule_kind,schedule_time,schedule_days,ends_at,max_runs,created_by,updated_by)
    VALUES (?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(task.goal.trim(), task.task_type, task.interval_seconds ?? null, task.conversation_id, task.session_id, nextDueAt, task.message_cursor ?? 0,
    task.title ?? null, task.output_spec ?? null, task.timezone ?? null, task.schedule_kind ?? null, task.schedule_time ?? null,
    task.schedule_days ?? null, task.ends_at ?? null, task.max_runs ?? null, actor, actor);
  return activeRow<TaskRecord>(database, "SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL", Number(result.lastInsertRowid))!;
}

export function getTask(database: DatabaseSync, id: number): TaskRecord | undefined {
  return activeRow<TaskRecord>(database, "SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL", id);
}

export function listTasks(database: DatabaseSync): TaskRecord[] {
  return database.prepare("SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY id").all() as TaskRecord[];
}

export function listTaskRuns(database: DatabaseSync, taskId: number): TaskRunRecord[] {
  return (database.prepare("SELECT * FROM task_runs WHERE task_id=? AND deleted_at IS NULL ORDER BY id").all(taskId) as TaskRunRow[]).map(taskRun);
}

export function getTaskRun(database: DatabaseSync, id: number): TaskRunRecord | undefined {
  const row = database.prepare("SELECT * FROM task_runs WHERE id=? AND deleted_at IS NULL").get(id) as TaskRunRow | undefined;
  return row ? taskRun(row) : undefined;
}

export function claimTaskRun(database: DatabaseSync, taskId: number, now: number, actor = "task-scheduler"): TaskRunRecord | undefined {
  database.exec("BEGIN IMMEDIATE");
  try {
    const task = getTask(database, taskId);
    if (!task || task.state !== "active") throw new Error("Task is not active");
    if (database.prepare("SELECT 1 FROM task_runs WHERE state='processing' AND deleted_at IS NULL").get()) {
      database.exec("COMMIT");
      return undefined;
    }
    const result = database.prepare(`INSERT INTO task_runs (task_id,state,started_at,created_at,created_by,updated_at,updated_by)
      VALUES (?,'processing',?,?,?, ?,?)`).run(taskId, now, now, actor, now, actor);
    const row = database.prepare("SELECT * FROM task_runs WHERE id=?").get(Number(result.lastInsertRowid)) as TaskRunRow;
    database.exec("COMMIT");
    return taskRun(row);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function completeTaskRun(database: DatabaseSync, runId: number, messageCursor: number, artifactPaths: string[], now: number, actor = "task-runtime"): TaskRunRecord {
  if (!Number.isSafeInteger(messageCursor) || messageCursor < 0) throw new RangeError("Invalid Task message cursor");
  if (artifactPaths.some((path) => !path.startsWith("results/") || path.startsWith("/") || path.split(/[\\/]/).includes(".."))) throw new RangeError("Task artifacts must use relative results/ paths");
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = database.prepare("SELECT task_id FROM task_runs WHERE id=? AND state='processing' AND deleted_at IS NULL").get(runId) as { task_id: number } | undefined;
    if (!current) throw new Error("Task Run is not processing");
    const changed = database.prepare(`UPDATE task_runs SET state='completed',completed_at=?,artifact_paths_json=?,updated_at=?,updated_by=?
      WHERE id=? AND state='processing' AND deleted_at IS NULL`).run(now, JSON.stringify(artifactPaths), now, actor, runId);
    if (changed.changes !== 1) throw new Error("Task Run changed before completion");
    database.prepare(`UPDATE tasks SET message_cursor=?,next_due_at=CASE WHEN task_type='recurring' THEN ?+interval_seconds ELSE NULL END,
      state=CASE WHEN task_type='one_time' AND state='active' THEN 'completed' ELSE state END,updated_at=?,updated_by=?
      WHERE id=? AND deleted_at IS NULL AND state IN ('active','paused') AND schedule_kind IS NULL`).run(messageCursor, now, now, actor, current.task_id);
    database.prepare(`UPDATE tasks SET message_cursor=? WHERE id=? AND deleted_at IS NULL AND state IN ('active','paused') AND schedule_kind IS NOT NULL`)
      .run(messageCursor, current.task_id);
    advanceScheduledTask(database, current.task_id, now, actor);
    const row = database.prepare("SELECT * FROM task_runs WHERE id=?").get(runId) as TaskRunRow;
    database.exec("COMMIT");
    return taskRun(row);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function failTaskRun(database: DatabaseSync, runId: number, detail: string, now: number, actor = "task-runtime"): boolean {
  const safeDetail = detail.replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
  database.exec("BEGIN IMMEDIATE");
  try {
    const changed = database.prepare(`UPDATE task_runs SET state='failed',failure_detail=?,completed_at=?,updated_at=?,updated_by=?
      WHERE id=? AND state='processing' AND deleted_at IS NULL`).run(safeDetail || "Task run failed", now, now, actor, runId);
    if (changed.changes === 1) {
      database.prepare(`UPDATE tasks SET next_due_at=CASE WHEN task_type='recurring' THEN ?+interval_seconds ELSE NULL END,updated_at=?,updated_by=?
        WHERE id=(SELECT task_id FROM task_runs WHERE id=?) AND state IN ('active','paused') AND schedule_kind IS NULL AND deleted_at IS NULL`).run(now, now, actor, runId);
      const { task_id } = database.prepare("SELECT task_id FROM task_runs WHERE id=?").get(runId) as { task_id: number };
      advanceScheduledTask(database, task_id, now, actor);
    }
    database.exec("COMMIT");
    return changed.changes === 1;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function pauseTask(database: DatabaseSync, taskId: number, actor = "user:owner"): boolean {
  return database.prepare("UPDATE tasks SET state='paused',updated_at=unixepoch(),updated_by=? WHERE id=? AND state='active' AND deleted_at IS NULL").run(actor, taskId).changes === 1;
}

/** Resumes a paused task. A scheduled task (`schedule_kind` set) gets its next run calculated from `now`. */
export function resumeTask(database: DatabaseSync, taskId: number, actor = "user:owner", now = Math.floor(Date.now() / 1000)): boolean {
  database.exec("BEGIN IMMEDIATE");
  try {
    const changed = database.prepare("UPDATE tasks SET state='active',updated_at=?,updated_by=? WHERE id=? AND state='paused' AND deleted_at IS NULL").run(now, actor, taskId).changes === 1;
    if (changed) advanceScheduledTask(database, taskId, now, actor);
    database.exec("COMMIT");
    return changed;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Moves a UI-created Task and its Session from a `pending:ui:` placeholder to a new thread in one transaction. */
export function bindTaskConversation(database: DatabaseSync, taskId: number, binding: {
  conversationId: string; parentConversationId: string; initiatingExternalMessageId: string;
}, now: number, actor = "task-runtime"): void {
  if (!binding.conversationId || binding.conversationId.startsWith("pending:")) throw new Error("Invalid Task conversation ID");
  database.exec("BEGIN IMMEDIATE");
  try {
    const task = getTask(database, taskId);
    if (!task || !task.conversation_id.startsWith("pending:ui:")) throw new Error("Task conversation is not pending");
    const session = database.prepare(`UPDATE sessions SET conversation_id=?,parent_conversation_id=?,initiating_external_message_id=?,
      updated_at=?,updated_by=? WHERE id=? AND conversation_id=? AND state='active' AND deleted_at IS NULL`)
      .run(binding.conversationId, binding.parentConversationId, binding.initiatingExternalMessageId, now, actor, task.session_id, task.conversation_id);
    const changed = database.prepare("UPDATE tasks SET conversation_id=?,updated_at=?,updated_by=? WHERE id=? AND conversation_id=? AND deleted_at IS NULL")
      .run(binding.conversationId, now, actor, taskId, task.conversation_id);
    if (session.changes !== 1 || changed.changes !== 1) throw new Error("Task conversation changed before binding");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function cancelTask(database: DatabaseSync, taskId: number, now: number, actor = "user:owner"): boolean {
  database.exec("BEGIN IMMEDIATE");
  try {
    const changed = database.prepare("UPDATE tasks SET state='cancelled',updated_at=?,updated_by=? WHERE id=? AND state IN ('active','paused') AND deleted_at IS NULL").run(now, actor, taskId);
    if (changed.changes === 1) database.prepare(`UPDATE task_runs SET state='cancelled',completed_at=?,updated_at=?,updated_by=?
      WHERE task_id=? AND state='processing' AND deleted_at IS NULL`).run(now, now, actor, taskId);
    database.exec("COMMIT");
    return changed.changes === 1;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export type TaskProviderSwitch = { taskId: number; runId: number; fromProvider: string; toProvider: string };

/**
 * Moves a Task's active Session from `fromProvider` to `toProvider` with a fresh `pending:task:switch:` Agent Session ID
 * and records a `task_provider_switched` event, in one transaction. Returns false when the Session is no longer active
 * with `fromProvider`, for example because another run start switched it first.
 */
export function switchTaskSessionProvider(database: DatabaseSync, sessionId: number, change: TaskProviderSwitch, now: number,
  actor = "task-runtime"): boolean {
  if (!change.toProvider || change.toProvider === change.fromProvider) throw new RangeError("Invalid agent provider switch");
  return inTransaction(database, () => {
    const session = database.prepare(`SELECT agent_session_id FROM sessions
      WHERE id=? AND agent_provider=? AND state='active' AND deleted_at IS NULL`).get(sessionId, change.fromProvider) as { agent_session_id: string } | undefined;
    if (!session) return false;
    const changed = database.prepare(`UPDATE sessions SET agent_provider=?,agent_session_id=?,updated_at=?,updated_by=?
      WHERE id=? AND agent_provider=? AND agent_session_id=? AND state='active' AND deleted_at IS NULL`)
      .run(change.toProvider, `pending:task:switch:${randomUUID()}`, now, actor, sessionId, change.fromProvider, session.agent_session_id);
    if (changed.changes !== 1) return false;
    createEvent(database, { session_id: sessionId, message_id: null, event_type: "task_provider_switched",
      detail: `task=${change.taskId}; run=${change.runId}; from=${change.fromProvider}; agent_session=${session.agent_session_id}` }, actor);
    return true;
  });
}

export function getTaskProposal(database: DatabaseSync, id: number): TaskProposalRecord | undefined {
  return activeRow<TaskProposalRecord>(database, "SELECT * FROM task_proposals WHERE id=? AND deleted_at IS NULL", id);
}

function inTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

type ProposalEventRow = Pick<TaskProposalRecord, "id" | "session_id" | "kind" | "task_id">;

// Event details hold only ids, kinds, and reason codes; never spec text.
function recordProposalEvent(database: DatabaseSync, row: ProposalEventRow, state: string, actor: string, reason?: string): void {
  createEvent(database, { session_id: row.session_id, message_id: null, event_type: `task_proposal_${state}`,
    detail: `proposal=${row.id}; kind=${row.kind}; task=${row.task_id ?? "new"}${reason ? `; reason=${reason}` : ""}` }, actor);
}

// Expires matching pending proposals and records one event each. Call inside the caller's transaction.
function expireProposalsWhere(database: DatabaseSync, where: string, values: SQLInputValue[], now: number, actor: string, reason: string): number {
  const rows = database.prepare(`UPDATE task_proposals SET state='expired',resolved_at=?,updated_at=?,updated_by=?
    WHERE ${where} AND state='pending' AND deleted_at IS NULL RETURNING id, session_id, kind, task_id`).all(now, now, actor, ...values) as ProposalEventRow[];
  for (const row of rows) recordProposalEvent(database, row, "expired", actor, reason);
  return rows.length;
}

/** Stores a pending proposal and expires any earlier pending proposal in the same conversation, in one transaction. */
export function createTaskProposal(database: DatabaseSync, proposal: NewTaskProposal, now: number, actor = "discord:owner"): TaskProposalRecord {
  return inTransaction(database, () => {
    if (!database.prepare(`SELECT 1 FROM sessions WHERE id=? AND transport=? AND workspace_id=? AND conversation_id=?
      AND state='active' AND deleted_at IS NULL`).get(proposal.session_id, proposal.transport, proposal.workspace_id, proposal.conversation_id)) {
      throw new Error("Task proposal Session is not active in its Conversation");
    }
    expireProposalsWhere(database, "transport=? AND workspace_id=? AND conversation_id=?",
      [proposal.transport, proposal.workspace_id, proposal.conversation_id], now, "system", "replaced");
    const result = database.prepare(`INSERT INTO task_proposals (session_id,transport,workspace_id,conversation_id,kind,task_id,spec_json,
      expires_at,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(proposal.session_id, proposal.transport,
      proposal.workspace_id, proposal.conversation_id, proposal.kind, proposal.task_id, proposal.spec_json, proposal.expires_at, now, actor, now, actor);
    return getTaskProposal(database, Number(result.lastInsertRowid))!;
  });
}

export function setTaskProposalCardMessage(database: DatabaseSync, id: number, cardMessageId: string, now: number, actor = "transport:discord"): boolean {
  return database.prepare(`UPDATE task_proposals SET card_message_id=?,updated_at=?,updated_by=?
    WHERE id=? AND state='pending' AND deleted_at IS NULL`).run(cardMessageId, now, actor, id).changes === 1;
}

/**
 * Resolves a pending, unexpired proposal exactly once. A later call changes nothing and
 * reports the current state. An overdue pending proposal becomes `expired` instead.
 */
export function resolveTaskProposal(database: DatabaseSync, id: number, outcome: TaskProposalOutcome, now: number,
  actor = "discord:owner", resultTaskId: number | null = null, reason?: string): { resolved: boolean; proposal: TaskProposalRecord | undefined } {
  return inTransaction(database, () => {
    const row = database.prepare(`UPDATE task_proposals SET state=?,resolved_at=?,result_task_id=?,updated_at=?,updated_by=?
      WHERE id=? AND state='pending' AND expires_at>? AND deleted_at IS NULL RETURNING id, session_id, kind, task_id`)
      .get(outcome, now, outcome === "confirmed" ? resultTaskId : null, now, actor, id, now) as ProposalEventRow | undefined;
    if (row) recordProposalEvent(database, { ...row, task_id: row.task_id ?? (outcome === "confirmed" ? resultTaskId : null) }, outcome, actor, reason);
    else expireProposalsWhere(database, "id=? AND expires_at<=?", [id, now], now, "system", "overdue");
    return { resolved: row !== undefined, proposal: getTaskProposal(database, id) };
  });
}

/**
 * Claims a pending, unexpired proposal for confirmation exactly once (`pending` to `confirming`).
 * The proposal's Session must still be active in its conversation; otherwise the proposal expires.
 */
export function claimTaskProposal(database: DatabaseSync, id: number, now: number, actor = "discord:owner"): { claimed: boolean; proposal: TaskProposalRecord | undefined } {
  return inTransaction(database, () => {
    const claimed = database.prepare(`UPDATE task_proposals SET state='confirming',updated_at=?,updated_by=?
      WHERE id=? AND state='pending' AND expires_at>? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM sessions s
        WHERE s.id=task_proposals.session_id AND s.conversation_id=task_proposals.conversation_id AND s.state='active' AND s.deleted_at IS NULL)`)
      .run(now, actor, id, now).changes === 1;
    if (!claimed) {
      expireProposalsWhere(database, "id=? AND expires_at<=?", [id, now], now, "system", "overdue");
      expireProposalsWhere(database, "id=?", [id], now, "system", "session_inactive");
    }
    return { claimed, proposal: getTaskProposal(database, id) };
  });
}

/** Ends a claimed proposal (`confirming` to `confirmed` or `failed`) exactly once. */
export function finishTaskProposal(database: DatabaseSync, id: number, outcome: "confirmed" | "failed", now: number,
  actor = "discord:owner", resultTaskId: number | null = null, reason?: string): { finished: boolean; proposal: TaskProposalRecord | undefined } {
  return inTransaction(database, () => {
    const row = database.prepare(`UPDATE task_proposals SET state=?,resolved_at=?,result_task_id=?,updated_at=?,updated_by=?
      WHERE id=? AND state='confirming' AND deleted_at IS NULL RETURNING id, session_id, kind, task_id`)
      .get(outcome, now, outcome === "confirmed" ? resultTaskId : null, now, actor, id) as ProposalEventRow | undefined;
    if (row) recordProposalEvent(database, { ...row, task_id: row.task_id ?? (outcome === "confirmed" ? resultTaskId : null) }, outcome, actor, reason);
    return { finished: row !== undefined, proposal: getTaskProposal(database, id) };
  });
}

/** Startup recovery: a proposal left in `confirming` failed with the process; overdue pending proposals expire. */
export function recoverTaskProposals(database: DatabaseSync, now: number, actor = "system"): void {
  inTransaction(database, () => {
    const rows = database.prepare(`UPDATE task_proposals SET state='failed',resolved_at=?,updated_at=?,updated_by=?
      WHERE state='confirming' AND deleted_at IS NULL RETURNING id, session_id, kind, task_id`).all(now, now, actor) as ProposalEventRow[];
    for (const row of rows) recordProposalEvent(database, row, "failed", actor, "restart");
    expireProposalsWhere(database, "expires_at<=?", [now], now, actor, "overdue");
  });
}

export function expireOverdueTaskProposals(database: DatabaseSync, now: number, actor = "system"): number {
  return inTransaction(database, () => expireProposalsWhere(database, "expires_at<=?", [now], now, actor, "overdue"));
}

export function expireSessionTaskProposals(database: DatabaseSync, sessionId: number, now: number, actor = "system"): number {
  return inTransaction(database, () => expireProposalsWhere(database, "session_id=?", [sessionId], now, actor, "reset"));
}

/** Resolved proposals whose card still has buttons, oldest first. */
export function listOpenTaskProposalCards(database: DatabaseSync): OpenTaskProposalCard[] {
  return (database.prepare(`SELECT p.*, (p.state='expired' AND EXISTS (SELECT 1 FROM task_proposals n
      WHERE n.transport=p.transport AND n.workspace_id=p.workspace_id AND n.conversation_id=p.conversation_id
      AND n.id>p.id AND n.created_at=p.resolved_at AND n.deleted_at IS NULL)) AS replaced
    FROM task_proposals p WHERE p.state NOT IN ('pending','confirming') AND p.card_message_id IS NOT NULL
      AND p.card_closed_at IS NULL AND p.deleted_at IS NULL ORDER BY p.id`).all() as Array<Omit<OpenTaskProposalCard, "replaced"> & { replaced: number }>)
    .map((row) => ({ ...row, replaced: row.replaced === 1 }));
}

/** Records that a resolved proposal's card was edited to remove its buttons. */
export function closeTaskProposalCard(database: DatabaseSync, id: number, now: number, actor = "transport:discord"): boolean {
  return database.prepare(`UPDATE task_proposals SET card_closed_at=?,updated_at=?,updated_by=?
    WHERE id=? AND card_closed_at IS NULL AND state NOT IN ('pending','confirming') AND deleted_at IS NULL`).run(now, now, actor, id).changes === 1;
}

/**
 * Replaces an active or paused Task's spec and recomputes its next run (IP-0002 edit rules).
 * A Task with a processing run is not edited.
 */
export function editTask(database: DatabaseSync, taskId: number, spec: TaskSpec, now: number, actor: string): TaskEditResult {
  return inTransaction(database, () => {
    const task = getTask(database, taskId);
    if (!task) return "not_found";
    if (task.state !== "active" && task.state !== "paused") return "not_editable";
    if (database.prepare("SELECT 1 FROM task_runs WHERE task_id=? AND state='processing' AND deleted_at IS NULL").get(taskId)) return "running";
    const { runs } = database.prepare(`SELECT COUNT(*) AS runs FROM task_runs
      WHERE task_id=? AND state IN ('completed','failed') AND deleted_at IS NULL`).get(taskId) as { runs: number };
    const next = nextRunAt(spec, now, runs);
    if (next === null) return "no_run_left";
    const columns = toTaskColumns(spec, now);
    database.prepare(`UPDATE tasks SET goal=?,task_type=?,interval_seconds=?,next_due_at=?,title=?,output_spec=?,timezone=?,
      schedule_kind=?,schedule_time=?,schedule_days=?,ends_at=?,max_runs=?,updated_at=?,updated_by=? WHERE id=?`).run(
      columns.goal, columns.task_type, columns.interval_seconds, next, columns.title, columns.output_spec, columns.timezone,
      columns.schedule_kind, columns.schedule_time, columns.schedule_days, columns.ends_at, columns.max_runs, now, actor, taskId);
    return "edited";
  });
}

/**
 * Creates a `pending:ui:` placeholder Session and its Task. The Task's first run opens its thread in the
 * task channel (`bindTaskConversation`). Call inside the caller's transaction.
 */
export function insertPendingTask(database: DatabaseSync, owner: PendingTaskOwner, columns: TaskColumns, actor: string): TaskRecord {
  const id = randomUUID();
  const conversationId = `pending:ui:${id}`;
  const session = createSession(database, {
    user_id: owner.user_id, transport: owner.transport, workspace_id: owner.workspace_id,
    parent_conversation_id: "pending:ui", conversation_id: conversationId, initiating_external_message_id: conversationId,
    agent_provider: owner.agent_provider, agent_session_id: `pending:task:${id}`, project_path: owner.project_path,
  }, actor);
  return createTask(database, { ...columns, conversation_id: conversationId, session_id: session.id }, actor);
}

export function createPendingTask(database: DatabaseSync, owner: PendingTaskOwner, columns: TaskColumns, actor: string): TaskRecord {
  return inTransaction(database, () => insertPendingTask(database, owner, columns, actor));
}

export function recoverLegacyApprovals(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    // Old approval prompts could contain arbitrary runtime text. Keep the row for audit,
    // but remove its preview before any Discord recovery or UI read can expose it.
    database.prepare(`UPDATE messages SET body = 'Legacy approval request redacted', updated_at = unixepoch(), updated_by = 'startup-recovery'
      WHERE id IN (SELECT request_message_id FROM approvals WHERE request_message_id IS NOT NULL)
        AND direction = 'agent' AND body NOT IN ('Legacy approval request redacted', 'Codex command approval card')`).run();
    database.prepare(`UPDATE approvals SET summary = 'Legacy approval request redacted', updated_at = unixepoch(),
      updated_by = CASE WHEN state = 'failed' AND updated_by = 'startup-recovery' THEN updated_by ELSE 'startup-redaction' END
      WHERE summary NOT IN ('Legacy approval request redacted', ?)`).run(commandApprovalSummary);
    const pending = database.prepare("SELECT id, session_id, summary FROM approvals WHERE state = 'pending' AND deleted_at IS NULL").all() as Array<{ id: number; session_id: number; summary: string }>;
    const fail = database.prepare(`UPDATE approvals SET state = 'failed', updated_at = unixepoch(), updated_by = 'startup-recovery'
      WHERE id = ? AND state = 'pending' AND deleted_at IS NULL`);
    for (const row of pending) {
      fail.run(row.id);
      createEvent(database, { session_id: row.session_id, message_id: null,
        event_type: row.summary === commandApprovalSummary ? "approval_failed_restart" : "legacy_approval_failed",
        detail: "saved approval cannot resume; fresh request required" }, "startup-recovery");
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function legacyApprovalNotices(database: DatabaseSync): Array<{ id: number; session_id: number; conversation_id: string; transport: "discord"; workspace_id: string; external_message_id: string | null }> {
  return database.prepare(`SELECT a.id, a.session_id, s.conversation_id, s.transport, s.workspace_id, m.external_message_id
    FROM approvals a JOIN sessions s ON s.id = a.session_id
    LEFT JOIN messages m ON m.id = a.request_message_id
    WHERE a.state = 'failed' AND a.updated_by = 'startup-recovery' AND a.resolution_message_id IS NULL
      AND a.deleted_at IS NULL ORDER BY a.id`).all() as ReturnType<typeof legacyApprovalNotices>;
}

export function claimLegacyApprovalNotice(database: DatabaseSync, approvalId: number): boolean {
  return database.prepare(`UPDATE approvals SET updated_at = unixepoch(), updated_by = 'startup-notice-claimed'
    WHERE id = ? AND state = 'failed' AND updated_by = 'startup-recovery'
      AND resolution_message_id IS NULL AND deleted_at IS NULL`).run(approvalId).changes === 1;
}

export function resolveLegacyApprovalNotice(database: DatabaseSync, approvalId: number, messageId: number): void {
  database.prepare(`UPDATE approvals SET resolution_message_id = ?, updated_at = unixepoch(), updated_by = 'startup-notice-sent'
    WHERE id = ? AND state = 'failed' AND updated_by = 'startup-notice-claimed'
      AND resolution_message_id IS NULL AND deleted_at IS NULL`).run(messageId, approvalId);
}

export function upsertUser(database: DatabaseSync, user: NewUser, actor = "system"): UserRecord | undefined {
  database.prepare(`INSERT INTO users (transport, workspace_id, external_user_id, display_name, role, state, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transport, workspace_id, external_user_id) DO UPDATE SET
      display_name = excluded.display_name, role = excluded.role, state = excluded.state,
      deleted_at = NULL, deleted_by = NULL,
      updated_at = unixepoch(), updated_by = excluded.updated_by`).run(
    user.transport, user.workspace_id, user.external_user_id, user.display_name, user.role, user.state, actor, actor,
  );
  return activeRow<UserRecord>(database, "SELECT * FROM users WHERE transport = ? AND workspace_id = ? AND external_user_id = ? AND deleted_at IS NULL", user.transport, user.workspace_id, user.external_user_id);
}

export function bootstrapOwner(database: DatabaseSync, configuration: Configuration): UserRecord {
  database.exec("BEGIN");
  try {
    const owner = upsertUser(database, {
      transport: "discord",
      workspace_id: configuration.discordGuildId,
      external_user_id: configuration.discordOwnerUserId,
      display_name: null,
      role: "owner",
      state: "active",
    })!;
    database.prepare(`UPDATE users SET state = 'disabled', updated_at = unixepoch(), updated_by = 'owner-bootstrap'
      WHERE transport = 'discord' AND workspace_id = ? AND role = 'owner' AND state = 'active'
        AND deleted_at IS NULL AND external_user_id <> ?`).run(configuration.discordGuildId, configuration.discordOwnerUserId);
    database.exec("COMMIT");
    return owner;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function createSession(database: DatabaseSync, session: NewSession, actor = "system"): SessionRecord {
  const result = database.prepare(`INSERT INTO sessions (user_id, transport, workspace_id, parent_conversation_id, conversation_id, initiating_external_message_id, agent_provider, agent_session_id, project_path, state, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    session.user_id, session.transport, session.workspace_id, session.parent_conversation_id, session.conversation_id,
    session.initiating_external_message_id, session.agent_provider, session.agent_session_id, session.project_path,
    session.state ?? "active", actor, actor,
  );
  return activeRow<SessionRecord>(database, "SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL", Number(result.lastInsertRowid))!;
}

export function getSession(database: DatabaseSync, id: number): SessionRecord | undefined {
  return activeRow<SessionRecord>(database, "SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL", id);
}

export function bindAgentSession(database: DatabaseSync, id: number, threadId: string, actor = "runtime:codex"): SessionRecord {
  if (!threadId || threadId.startsWith("pending:")) throw new Error("Invalid Agent Session ID");
  const result = database.prepare(`UPDATE sessions SET agent_session_id = ?, updated_at = unixepoch(), updated_by = ?
    WHERE id = ? AND agent_session_id LIKE 'pending:%' AND state = 'active' AND deleted_at IS NULL`).run(threadId, actor, id);
  if (result.changes !== 1) throw new Error("Agent Session is no longer pending");
  return getSession(database, id)!;
}

// Replaces a runtime-assigned placeholder with the ID the runtime reported during the first Turn.
export function rebindAgentSession(database: DatabaseSync, id: number, fromId: string, toId: string, actor: string): SessionRecord {
  if (!toId || toId.startsWith("pending:")) throw new Error("Invalid Agent Session ID");
  const result = database.prepare(`UPDATE sessions SET agent_session_id = ?, updated_at = unixepoch(), updated_by = ?
    WHERE id = ? AND agent_session_id = ? AND agent_session_id NOT LIKE 'pending:%' AND state = 'active' AND deleted_at IS NULL`).run(toId, actor, id, fromId);
  if (result.changes !== 1) throw new Error("Agent Session changed before rebinding");
  return getSession(database, id)!;
}

export function archiveMessage(database: DatabaseSync, message: NewMessage, actor = "system"): { message?: MessageRecord; inserted: boolean } {
  if (!message.external_message_id) throw new RangeError("External message ID is required");
  const result = database.prepare(`INSERT INTO messages (session_id, transport, workspace_id, external_message_id, external_author_id, user_id, direction, body, reply_to_external_message_id, in_reply_to_message_id, state, failure_detail, completed_at, delivery_state, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CASE WHEN ? = 'user' AND NOT EXISTS (SELECT 1 FROM sessions WHERE id = ? AND state = 'active' AND deleted_at IS NULL)
        THEN 'failed' ELSE ? END,
      CASE WHEN ? = 'user' AND NOT EXISTS (SELECT 1 FROM sessions WHERE id = ? AND state = 'active' AND deleted_at IS NULL)
        THEN 'Cancelled by reset before runtime start' ELSE NULL END,
      CASE WHEN ? = 'user' AND NOT EXISTS (SELECT 1 FROM sessions WHERE id = ? AND state = 'active' AND deleted_at IS NULL)
        THEN unixepoch() ELSE NULL END,
      ?, ?, ?)
    ON CONFLICT(transport, workspace_id, external_message_id) DO NOTHING`).run(
    message.session_id, message.transport, message.workspace_id, message.external_message_id, message.external_author_id,
    message.user_id, message.direction, message.body, message.reply_to_external_message_id, message.in_reply_to_message_id,
    message.direction, message.session_id, message.state ?? "pending",
    message.direction, message.session_id, message.direction, message.session_id,
    message.direction === "agent" ? "confirmed" : null, actor, actor,
  );
  return {
    message: activeRow<MessageRecord>(database, "SELECT * FROM messages WHERE transport = ? AND workspace_id = ? AND external_message_id = ? AND deleted_at IS NULL", message.transport, message.workspace_id, message.external_message_id),
    inserted: result.changes === 1,
  };
}

export function listMessages(database: DatabaseSync, sessionId: number): MessageRecord[] {
  return database.prepare("SELECT * FROM messages WHERE session_id = ? AND deleted_at IS NULL ORDER BY id").all(sessionId) as MessageRecord[];
}

export function softDeleteMessage(database: DatabaseSync, id: number, actor = "system"): void {
  database.prepare("UPDATE messages SET updated_at = unixepoch(), updated_by = ?, deleted_at = unixepoch(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL").run(actor, actor, id);
}

export function claimNextMessage(database: DatabaseSync, mode: MessageQueueMode, actor = "system"): MessageRecord | undefined {
  database.exec("BEGIN IMMEDIATE");
  try {
    const message = activeRow<MessageRecord>(database, `SELECT * FROM messages AS candidate
      WHERE candidate.direction = 'user' AND candidate.state = 'pending' AND candidate.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM sessions WHERE id = candidate.session_id AND state = 'active' AND deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM messages AS processing
          WHERE processing.session_id = candidate.session_id AND processing.direction = 'user'
            AND processing.state = 'processing' AND processing.deleted_at IS NULL)
        AND (? = 'per-session' OR NOT EXISTS (SELECT 1 FROM messages AS processing
          WHERE processing.direction = 'user' AND processing.state = 'processing' AND processing.deleted_at IS NULL))
      ORDER BY candidate.id LIMIT 1`, mode);
    if (!message) {
      database.exec("COMMIT");
      return undefined;
    }
    database.prepare(`UPDATE messages SET state = 'processing', started_at = unixepoch(), updated_at = unixepoch(), updated_by = ?
      WHERE id = ? AND state = 'pending' AND deleted_at IS NULL`).run(actor, message.id);
    const claimed = activeRow<MessageRecord>(database, "SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL", message.id);
    database.exec("COMMIT");
    return claimed;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function markRuntimeStarted(database: DatabaseSync, messageId: number, actor = "runtime:codex"): boolean {
  return database.prepare(`UPDATE messages SET runtime_started_at = unixepoch(), updated_at = unixepoch(), updated_by = ?
    WHERE id = ? AND direction = 'user' AND state = 'processing' AND runtime_started_at IS NULL AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM sessions WHERE id = messages.session_id AND state = 'active' AND deleted_at IS NULL)`).run(actor, messageId).changes === 1;
}

export function failProcessingMessage(database: DatabaseSync, messageId: number, detail: string, actor = "system"): boolean {
  return database.prepare(`UPDATE messages SET state = 'failed', failure_detail = ?, completed_at = unixepoch(),
    updated_at = unixepoch(), updated_by = ?
    WHERE id = ? AND direction = 'user' AND state = 'processing' AND deleted_at IS NULL`).run(detail, actor, messageId).changes === 1;
}

export function archiveResponseChunks(database: DatabaseSync, messageId: number, bodies: string[], actor = "runtime:codex"): MessageRecord[] | undefined {
  // An empty list completes the turn without a reply (a reply that held only a Task block).
  if (bodies.some((body) => !body)) throw new RangeError("Response chunks must be nonempty");
  database.exec("BEGIN IMMEDIATE");
  try {
    const inbound = activeRow<MessageRecord>(database, `SELECT * FROM messages WHERE id = ? AND direction = 'user'
      AND state = 'processing' AND runtime_started_at IS NOT NULL AND deleted_at IS NULL`, messageId);
    if (!inbound) {
      database.exec("COMMIT");
      return undefined;
    }
    const rows: MessageRecord[] = [];
    for (const body of bodies) {
      const result = database.prepare(`INSERT INTO messages (session_id, transport, workspace_id, external_message_id,
        direction, body, in_reply_to_message_id, state, provisional_id, delivery_state, created_by, updated_by)
        VALUES (?, ?, ?, NULL, 'agent', ?, ?, 'completed', ?, 'pending', ?, ?)`).run(
        inbound.session_id, inbound.transport, inbound.workspace_id, body, messageId, randomUUID(), actor, actor,
      );
      rows.push(activeRow<MessageRecord>(database, "SELECT * FROM messages WHERE id = ?", Number(result.lastInsertRowid))!);
    }
    database.prepare(`UPDATE messages SET state = 'completed', completed_at = unixepoch(), updated_at = unixepoch(), updated_by = ?
      WHERE id = ? AND state = 'processing'`).run(actor, messageId);
    database.exec("COMMIT");
    return rows;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function archiveFailureNotice(database: DatabaseSync, messageId: number, body: string, actor = "conversation-worker"): MessageRecord | undefined {
  database.exec("BEGIN IMMEDIATE");
  try {
    const inbound = activeRow<MessageRecord>(database, `SELECT * FROM messages WHERE id = ? AND direction = 'user'
      AND state = 'failed' AND deleted_at IS NULL`, messageId);
    if (!inbound || database.prepare(`SELECT id FROM messages WHERE in_reply_to_message_id = ?
      AND direction = 'agent' AND deleted_at IS NULL LIMIT 1`).get(messageId)) {
      database.exec("COMMIT");
      return undefined;
    }
    const result = database.prepare(`INSERT INTO messages (session_id, transport, workspace_id, external_message_id,
      direction, body, in_reply_to_message_id, state, provisional_id, delivery_state, created_by, updated_by)
      VALUES (?, ?, ?, NULL, 'agent', ?, ?, 'completed', ?, 'pending', ?, ?)`).run(
      inbound.session_id, inbound.transport, inbound.workspace_id, body, messageId, randomUUID(), actor, actor,
    );
    const notice = activeRow<MessageRecord>(database, "SELECT * FROM messages WHERE id = ?", Number(result.lastInsertRowid))!;
    database.exec("COMMIT");
    return notice;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function listPendingResponseChunks(database: DatabaseSync): MessageRecord[] {
  return database.prepare(`SELECT * FROM messages WHERE direction = 'agent' AND delivery_state = 'pending'
    AND in_reply_to_message_id IS NOT NULL AND deleted_at IS NULL ORDER BY id`).all() as MessageRecord[];
}

export function claimResponseChunk(database: DatabaseSync, id: number, actor = "transport:discord"): boolean {
  return database.prepare(`UPDATE messages SET delivery_state = 'uncertain', updated_at = unixepoch(), updated_by = ?
    WHERE id = ? AND direction = 'agent' AND delivery_state = 'pending' AND deleted_at IS NULL`).run(actor, id).changes === 1;
}

export function confirmResponseChunk(database: DatabaseSync, id: number, externalMessageId: string, actor = "transport:discord"): boolean {
  if (!externalMessageId) throw new RangeError("Discord message ID is required");
  return database.prepare(`UPDATE messages SET external_message_id = ?, delivery_state = 'confirmed',
    updated_at = unixepoch(), updated_by = ?
    WHERE id = ? AND direction = 'agent' AND delivery_state = 'uncertain' AND deleted_at IS NULL`).run(externalMessageId, actor, id).changes === 1;
}

export function failResponseChunk(database: DatabaseSync, id: number, detail: string, actor = "transport:discord"): boolean {
  return database.prepare(`UPDATE messages SET delivery_state = 'failed', failure_detail = ?,
    updated_at = unixepoch(), updated_by = ?
    WHERE id = ? AND direction = 'agent' AND delivery_state = 'uncertain' AND deleted_at IS NULL`).run(detail, actor, id).changes === 1;
}

export function failRemainingResponseChunks(database: DatabaseSync, inboundMessageId: number, actor = "transport:discord"): number {
  return Number(database.prepare(`UPDATE messages SET delivery_state = 'failed', failure_detail = 'Skipped after earlier chunk was not confirmed',
    updated_at = unixepoch(), updated_by = ? WHERE direction = 'agent' AND in_reply_to_message_id = ?
    AND delivery_state = 'pending' AND deleted_at IS NULL`).run(actor, inboundMessageId).changes);
}

export function resetSession(database: DatabaseSync, sessionId: number, actor = "user:owner", now = Math.floor(Date.now() / 1000)): boolean {
  database.exec("BEGIN IMMEDIATE");
  try {
    const changed = database.prepare(`UPDATE sessions SET state = 'ended', ended_at = unixepoch(),
      updated_at = unixepoch(), updated_by = ? WHERE id = ? AND state = 'active' AND deleted_at IS NULL`).run(actor, sessionId).changes;
    if (changed) {
      database.prepare(`UPDATE messages SET state = 'failed', failure_detail = CASE WHEN runtime_started_at IS NULL
        THEN 'Cancelled by reset before runtime start' ELSE 'Runtime outcome uncertain after reset' END,
        completed_at = unixepoch(), updated_at = unixepoch(), updated_by = ?
        WHERE session_id = ? AND direction = 'user' AND state IN ('pending', 'processing') AND deleted_at IS NULL`).run(actor, sessionId);
      database.prepare(`UPDATE messages SET delivery_state = 'failed', failure_detail = 'Delivery cancelled by reset',
        updated_at = unixepoch(), updated_by = ?
        WHERE session_id = ? AND direction = 'agent' AND delivery_state = 'pending' AND deleted_at IS NULL`).run(actor, sessionId);
      expireProposalsWhere(database, "session_id=?", [sessionId], now, "system", "reset");
    }
    database.exec("COMMIT");
    return changed === 1;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function completeMessageWithResponse(database: DatabaseSync, messageId: number, response: NewAgentResponse, actor = "system"): { message: MessageRecord; response: MessageRecord } | undefined {
  if (!response.external_message_id) throw new RangeError("Delivered response ID is required");
  database.exec("BEGIN IMMEDIATE");
  try {
    const message = activeRow<MessageRecord>(database, `SELECT * FROM messages
      WHERE id = ? AND direction = 'user' AND state = 'processing' AND deleted_at IS NULL`, messageId);
    if (!message) {
      database.exec("COMMIT");
      return undefined;
    }
    const result = database.prepare(`INSERT INTO messages (session_id, transport, workspace_id, external_message_id, external_author_id, user_id, direction, body, reply_to_external_message_id, in_reply_to_message_id, state, delivery_state, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, ?, ?, 'completed', 'confirmed', ?, ?)`).run(
      message.session_id, response.transport, response.workspace_id, response.external_message_id, response.external_author_id,
      response.user_id, response.body, response.reply_to_external_message_id, message.id, actor, actor,
    );
    database.prepare(`UPDATE messages SET state = 'completed', completed_at = unixepoch(), updated_at = unixepoch(), updated_by = ?
      WHERE id = ? AND state = 'processing' AND deleted_at IS NULL`).run(actor, message.id);
    const completed = activeRow<MessageRecord>(database, "SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL", message.id)!;
    const agentResponse = activeRow<MessageRecord>(database, "SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL", Number(result.lastInsertRowid))!;
    database.exec("COMMIT");
    return { message: completed, response: agentResponse };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function createEvent(database: DatabaseSync, event: NewEvent, actor = "system"): EventRecord {
  const result = database.prepare("INSERT INTO events (session_id, message_id, event_type, detail, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)").run(event.session_id, event.message_id, event.event_type, event.detail, actor, actor);
  return activeRow<EventRecord>(database, "SELECT * FROM events WHERE id = ? AND deleted_at IS NULL", Number(result.lastInsertRowid))!;
}

export function listEvents(database: DatabaseSync, sessionId?: number): EventRecord[] {
  return (sessionId === undefined
    ? database.prepare("SELECT * FROM events WHERE deleted_at IS NULL ORDER BY id").all()
    : database.prepare("SELECT * FROM events WHERE session_id = ? AND deleted_at IS NULL ORDER BY id").all(sessionId)) as EventRecord[];
}

export function failApproval(database: DatabaseSync, id: number): void {
  database.prepare(`UPDATE approvals SET state = 'failed', updated_at = unixepoch(), updated_by = 'runtime:codex'
    WHERE id = ? AND state = 'pending' AND deleted_at IS NULL`).run(id);
}

export function createMemory(database: DatabaseSync, memory: NewMemory, actor = "system"): MemoryRecord {
  const result = database.prepare("INSERT INTO memories (body, source_message_id, created_by_user_id, review_id, origin, kind, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(memory.body, memory.source_message_id, memory.created_by_user_id, memory.review_id, memory.origin, memory.kind ?? "topic", actor, actor);
  return activeRow<MemoryRecord>(database, "SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL", Number(result.lastInsertRowid))!;
}

export function listMemories(database: DatabaseSync): MemoryRecord[] {
  return database.prepare("SELECT * FROM memories WHERE state = 'active' AND deleted_at IS NULL ORDER BY id").all() as MemoryRecord[];
}

export function softDeleteMemory(database: DatabaseSync, id: number, actor = "system"): void {
  database.prepare("UPDATE memories SET state = 'deleted', updated_at = unixepoch(), updated_by = ?, deleted_at = unixepoch(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL").run(actor, actor, id);
}

/** Memory text compared for duplicates and rejections: lower-case, trimmed, inner whitespace collapsed. */
export function normalizeMemoryBody(body: string): string {
  return body.toLowerCase().trim().replace(/\s+/g, " ");
}

type MemoryProposalRow = Omit<MemoryProposalRecord, "source_message_ids"> & { source_message_ids_json: string };
function memoryProposal(row: MemoryProposalRow | undefined): MemoryProposalRecord | undefined {
  if (!row) return undefined;
  const { source_message_ids_json, ...record } = row;
  return { ...record, source_message_ids: JSON.parse(source_message_ids_json) as number[] };
}

/** Stores a pending Memory proposal. Runs in the caller's transaction, if any. */
export function createMemoryProposal(database: DatabaseSync, proposal: NewMemoryProposal, now: number, actor = "memory-review"): MemoryProposalRecord {
  const body = proposal.body.trim();
  const result = database.prepare(`INSERT INTO memory_proposals (body,normalized_body,kind,review_id,source_message_ids_json,expires_at,
    created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(body, normalizeMemoryBody(body), proposal.kind,
    proposal.review_id, JSON.stringify(proposal.source_message_ids), proposal.expires_at, now, actor, now, actor);
  return getMemoryProposal(database, Number(result.lastInsertRowid))!;
}

export function getMemoryProposal(database: DatabaseSync, id: number): MemoryProposalRecord | undefined {
  return memoryProposal(activeRow<MemoryProposalRow>(database, "SELECT * FROM memory_proposals WHERE id=? AND deleted_at IS NULL", id));
}

/** Pending proposals that have not reached `expires_at`, oldest first. */
export function listPendingMemoryProposals(database: DatabaseSync, now: number): MemoryProposalRecord[] {
  return (database.prepare("SELECT * FROM memory_proposals WHERE state='pending' AND expires_at>? AND deleted_at IS NULL ORDER BY id")
    .all(now) as MemoryProposalRow[]).map((row) => memoryProposal(row)!);
}

export function setMemoryProposalCardMessage(database: DatabaseSync, id: number, cardMessageId: string, now: number, actor = "transport:discord"): boolean {
  return database.prepare(`UPDATE memory_proposals SET card_message_id=?,updated_at=?,updated_by=?
    WHERE id=? AND state='pending' AND deleted_at IS NULL`).run(cardMessageId, now, actor, id).changes === 1;
}

// Moves a pending, unexpired proposal to `state`. Call inside the caller's transaction.
function answerMemoryProposal(database: DatabaseSync, id: number, state: "confirmed" | "rejected", now: number, actor: string): MemoryProposalRecord | undefined {
  return memoryProposal(database.prepare(`UPDATE memory_proposals SET state=?,answered_at=?,updated_at=?,updated_by=?
    WHERE id=? AND state='pending' AND expires_at>? AND deleted_at IS NULL RETURNING *`).get(state, now, now, actor, id, now) as MemoryProposalRow | undefined);
}

// Expires matching pending proposals. Call inside the caller's transaction.
function expireMemoryProposalsWhere(database: DatabaseSync, where: string, values: SQLInputValue[], now: number, actor: string): MemoryProposalRecord[] {
  return (database.prepare(`UPDATE memory_proposals SET state='expired',answered_at=?,updated_at=?,updated_by=?
    WHERE ${where} AND state='pending' AND deleted_at IS NULL RETURNING *`).all(now, now, actor, ...values) as MemoryProposalRow[])
    .map((row) => memoryProposal(row)!);
}

/**
 * Confirms a pending, unexpired proposal exactly once and creates its Memory with the proposed kind in the same
 * transaction. When an active Memory already has the same normalized body, the proposal is confirmed and no Memory
 * is created. A non-pending proposal changes nothing; an overdue pending proposal becomes `expired`.
 */
export function confirmMemoryProposal(database: DatabaseSync, id: number, now: number, actor = "discord:owner"): MemoryProposalConfirmation {
  return inTransaction(database, () => {
    const answered = answerMemoryProposal(database, id, "confirmed", now, actor);
    if (!answered) {
      expireMemoryProposalsWhere(database, "id=? AND expires_at<=?", [id, now], now, "system");
      return { answered: false, duplicate: false, proposal: getMemoryProposal(database, id) };
    }
    const existing = listMemories(database).find((memory) => normalizeMemoryBody(memory.body) === answered.normalized_body);
    if (existing) return { answered: true, duplicate: true, memory: existing, proposal: answered };
    const memory = createMemory(database, { body: answered.body, source_message_id: answered.source_message_ids[0] ?? null,
      created_by_user_id: null, review_id: answered.review_id, origin: "review", kind: answered.kind }, actor);
    database.prepare("UPDATE memory_proposals SET created_memory_id=? WHERE id=?").run(memory.id, id);
    return { answered: true, duplicate: false, memory, proposal: getMemoryProposal(database, id) };
  });
}

/** Rejects a pending, unexpired proposal exactly once. A non-pending proposal changes nothing; an overdue one expires. */
export function rejectMemoryProposal(database: DatabaseSync, id: number, now: number, actor = "discord:owner"): MemoryProposalAnswer {
  return inTransaction(database, () => {
    const answered = answerMemoryProposal(database, id, "rejected", now, actor);
    if (!answered) expireMemoryProposalsWhere(database, "id=? AND expires_at<=?", [id, now], now, "system");
    return { answered: answered !== undefined, proposal: answered ?? getMemoryProposal(database, id) };
  });
}

/** Expires every pending proposal whose `expires_at` has passed and returns them. */
export function expireDueMemoryProposals(database: DatabaseSync, now: number, actor = "system"): MemoryProposalRecord[] {
  return inTransaction(database, () => expireMemoryProposalsWhere(database, "expires_at<=?", [now], now, actor));
}

/** True when a proposal with the same normalized body was rejected before. */
export function wasMemoryProposalRejected(database: DatabaseSync, body: string): boolean {
  return database.prepare("SELECT 1 FROM memory_proposals WHERE normalized_body=? AND state='rejected' AND deleted_at IS NULL LIMIT 1")
    .get(normalizeMemoryBody(body)) !== undefined;
}

/** A Memory Review stores at most this many proposals; each one expires this many seconds after it is stored. */
export const maxReviewProposals = 5;
export const memoryProposalTtlSeconds = 7 * 24 * 60 * 60;
/** A proposal that passed the review's own checks (owner citations, kind, body limit, no secret-like text). */
export type ReviewProposalDraft = { body: string; kind: MemoryKind; sourceMessageIds: number[] };
export type ReviewProposalSkip = "duplicate_memory" | "duplicate_proposal" | "rejected_proposal" | "too_many_proposals";

/**
 * Stores a review's proposals inside the caller's review commit transaction, in order. A proposal is skipped when its
 * normalized text matches an active Memory, a pending unexpired proposal (including one stored earlier in this call),
 * or a rejected proposal, and once maxReviewProposals are stored.
 */
export function storeReviewProposals(database: DatabaseSync, reviewId: number, drafts: ReviewProposalDraft[], now: number, actor = "memory-review"): { ids: number[]; skipped: ReviewProposalSkip[] } {
  const memories = new Set(listMemories(database).map((memory) => normalizeMemoryBody(memory.body)));
  const pending = database.prepare("SELECT 1 FROM memory_proposals WHERE normalized_body=? AND state='pending' AND expires_at>? AND deleted_at IS NULL LIMIT 1");
  const ids: number[] = [];
  const skipped: ReviewProposalSkip[] = [];
  for (const draft of drafts) {
    const normalized = normalizeMemoryBody(draft.body);
    const skip: ReviewProposalSkip | undefined = memories.has(normalized) ? "duplicate_memory"
      : pending.get(normalized, now) ? "duplicate_proposal"
      : wasMemoryProposalRejected(database, normalized) ? "rejected_proposal"
      : ids.length >= maxReviewProposals ? "too_many_proposals" : undefined;
    if (skip) { skipped.push(skip); continue; }
    ids.push(createMemoryProposal(database, { body: draft.body, kind: draft.kind, review_id: reviewId,
      source_message_ids: draft.sourceMessageIds, expires_at: now + memoryProposalTtlSeconds }, now, actor).id);
  }
  return { ids, skipped };
}

/** Appends one `memory_uses` row per use in one transaction. Rows are never updated or deleted. */
export function recordMemoryUses(database: DatabaseSync, uses: NewMemoryUse[], now: number, actor = "system"): number {
  if (uses.length === 0) return 0;
  return inTransaction(database, () => {
    const insert = database.prepare("INSERT INTO memory_uses (memory_id,session_id,message_id,task_run_id,created_at,created_by) VALUES (?,?,?,?,?,?)");
    for (const use of uses) insert.run(use.memory_id, use.session_id, use.message_id, use.task_run_id, now, actor);
    return uses.length;
  });
}

export function listMemoryUses(database: DatabaseSync, memoryId?: number): MemoryUseRecord[] {
  return (memoryId === undefined
    ? database.prepare("SELECT * FROM memory_uses ORDER BY id").all()
    : database.prepare("SELECT * FROM memory_uses WHERE memory_id=? ORDER BY id").all(memoryId)) as MemoryUseRecord[];
}

export function createMemoryReview(database: DatabaseSync, review: NewMemoryReview, actor = "system"): MemoryReviewRecord {
  const boundary = (messageId: number) => activeRow<MessageRecord>(database,
    "SELECT * FROM messages WHERE id = ? AND session_id = ? AND deleted_at IS NULL", messageId, review.session_id);
  const cursor = activeRow<{ through_message_id: number }>(database,
    "SELECT MAX(through_message_id) AS through_message_id FROM memory_reviews WHERE session_id = ? AND state = 'completed' AND deleted_at IS NULL", review.session_id);
  if (!boundary(review.from_message_id) || !boundary(review.through_message_id) || review.from_message_id > review.through_message_id || review.from_message_id <= (cursor?.through_message_id ?? 0)) {
    throw new RangeError("Memory review boundaries must be active, ordered messages after the completed review cursor");
  }
  const result = database.prepare("INSERT INTO memory_reviews (session_id, from_message_id, through_message_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?)").run(review.session_id, review.from_message_id, review.through_message_id, actor, actor);
  return activeRow<MemoryReviewRecord>(database, "SELECT * FROM memory_reviews WHERE id = ? AND deleted_at IS NULL", Number(result.lastInsertRowid))!;
}

export function completeMemoryReview(database: DatabaseSync, id: number, recap: string, actor = "system"): MemoryReviewRecord | undefined {
  database.prepare("UPDATE memory_reviews SET state = 'completed', recap = ?, completed_at = unixepoch(), updated_at = unixepoch(), updated_by = ? WHERE id = ? AND deleted_at IS NULL").run(recap, actor, id);
  return activeRow<MemoryReviewRecord>(database, "SELECT * FROM memory_reviews WHERE id = ? AND deleted_at IS NULL", id);
}

export function messagesForMemoryReview(database: DatabaseSync, sessionId: number): MessageRecord[] {
  return database.prepare(`SELECT * FROM messages
    WHERE session_id = ? AND id > COALESCE((SELECT MAX(through_message_id) FROM memory_reviews
      WHERE session_id = ? AND state = 'completed' AND deleted_at IS NULL), 0)
      AND deleted_at IS NULL ORDER BY id`).all(sessionId, sessionId) as MessageRecord[];
}
