import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { Configuration } from "../../../agent-instance/config.js";
import { inspectRuntimeHomeLock, resolveRuntimeHome, type RuntimeHome } from "../../../agent-instance/runtime-home.js";
import { nextRunAt, taskSpecFromRow } from "../../../tasks/schedule.js";

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
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER,
  deleted_by TEXT,
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS active_memories ON memories(state, id);

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
`;

export class UnsafeDatabasePathError extends Error {
  constructor(databaseFile: string) {
    super(`Database must be inoai.sqlite inside the selected runtime home: ${databaseFile}`);
    this.name = "UnsafeDatabasePathError";
  }
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
  const existing = new Set((database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(({ name }) => name));
  const missing = taskScheduleColumns.filter(([name]) => !existing.has(name));
  if (missing.length === 0) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [name, type] of missing) database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
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
    recoverStaleWork(database);
    recoverTaskRuns(database);
    recoverLegacyApprovals(database);
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
  if (!messageColumns.some(({ name }) => name === "delivery_state")) {
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
  const selectedHome = resolveRuntimeHome(dirname(directory), basename(directory));
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

export type MemoryRecord = AuditColumns & {
  id: number;
  body: string;
  source_message_id: number | null;
  created_by_user_id: number | null;
  review_id: number | null;
  origin: "manual" | "review";
  state: "active" | "deleted";
};

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

export type NewTask = Pick<TaskRecord, "goal" | "task_type" | "conversation_id" | "session_id">
  & Partial<Pick<TaskRecord, "interval_seconds" | "next_due_at" | "message_cursor" | "title" | "output_spec" | "timezone"
    | "schedule_kind" | "schedule_time" | "schedule_days" | "ends_at" | "max_runs">>;

export type NewUser = Omit<UserRecord, keyof AuditColumns | "id">;
export type NewSession = Omit<SessionRecord, keyof AuditColumns | "id" | "ended_at" | "state"> & { state?: SessionRecord["state"] };
export type NewMessage = Omit<MessageRecord, keyof AuditColumns | "id" | "failure_detail" | "started_at" | "runtime_started_at" | "completed_at" | "provisional_id" | "delivery_state" | "state"> & { state?: MessageRecord["state"] };
export type NewAgentResponse = Omit<NewMessage, "session_id" | "direction" | "in_reply_to_message_id" | "state">;
export type MessageQueueMode = "per-session" | "global";
export type NewEvent = Omit<EventRecord, keyof AuditColumns | "id">;
export type NewMemory = Omit<MemoryRecord, keyof AuditColumns | "id" | "state">;
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

export function recoverTaskRuns(database: DatabaseSync, actor = "startup-recovery", now = Math.floor(Date.now() / 1000)): void {
  database.exec("BEGIN IMMEDIATE");
  try {
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
    const changed = database.prepare("UPDATE tasks SET state='active',updated_at=unixepoch(),updated_by=? WHERE id=? AND state='paused' AND deleted_at IS NULL").run(actor, taskId).changes === 1;
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

export function recoverLegacyApprovals(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    // Old approval prompts could contain arbitrary runtime text. Keep the row for audit,
    // but remove its preview before any Discord recovery or UI read can expose it.
    database.prepare(`UPDATE messages SET body = 'Legacy approval request redacted', updated_at = unixepoch(), updated_by = 'startup-recovery'
      WHERE id IN (SELECT request_message_id FROM approvals WHERE request_message_id IS NOT NULL)
        AND direction = 'agent' AND body != 'Legacy approval request redacted'`).run();
    database.prepare(`UPDATE approvals SET summary = 'Legacy approval request redacted', updated_at = unixepoch(),
      updated_by = CASE WHEN state = 'failed' AND updated_by = 'startup-recovery' THEN updated_by ELSE 'startup-redaction' END
      WHERE summary != 'Legacy approval request redacted'`).run();
    const pending = database.prepare("SELECT id, session_id FROM approvals WHERE state = 'pending' AND deleted_at IS NULL").all() as Array<{ id: number; session_id: number }>;
    const fail = database.prepare(`UPDATE approvals SET state = 'failed', updated_at = unixepoch(), updated_by = 'startup-recovery'
      WHERE id = ? AND state = 'pending' AND deleted_at IS NULL`);
    for (const row of pending) {
      fail.run(row.id);
      createEvent(database, { session_id: row.session_id, message_id: null,
        event_type: "legacy_approval_failed", detail: "saved approval cannot resume; fresh request required" }, "startup-recovery");
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
  if (!bodies.length || bodies.some((body) => !body)) throw new RangeError("Response chunks must be nonempty");
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

export function resetSession(database: DatabaseSync, sessionId: number, actor = "user:owner"): boolean {
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
  const result = database.prepare("INSERT INTO memories (body, source_message_id, created_by_user_id, review_id, origin, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)").run(memory.body, memory.source_message_id, memory.created_by_user_id, memory.review_id, memory.origin, actor, actor);
  return activeRow<MemoryRecord>(database, "SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL", Number(result.lastInsertRowid))!;
}

export function listMemories(database: DatabaseSync): MemoryRecord[] {
  return database.prepare("SELECT * FROM memories WHERE state = 'active' AND deleted_at IS NULL ORDER BY id").all() as MemoryRecord[];
}

export function softDeleteMemory(database: DatabaseSync, id: number, actor = "system"): void {
  database.prepare("UPDATE memories SET state = 'deleted', updated_at = unixepoch(), updated_by = ?, deleted_at = unixepoch(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL").run(actor, actor, id);
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
