// Task-only writes from the local UI. Each write opens a short-lived SQLite
// connection with the 5-second busy timeout (ADR 0025) and closes it in `finally`.
import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RuntimeHome } from "../../inoai/agent-instance/runtime-home.js";
import {
  databaseBusyTimeoutMs, editTask, getTask, insertPendingTask, pauseTask, resumeTask,
} from "../../inoai/connectors/persistence/sqlite/legacy-database.js";
import { toTaskColumns, validateTaskSpec, type TaskSpec } from "../../inoai/tasks/schedule.js";
import { readTasks, type UiTask } from "./read-model.js";

export const uiActor = "ui:owner";
export const noSessionMessage = "Talk to the agent in Discord once before creating tasks from the UI.";

export type TaskAction = "run" | "pause" | "resume" | "cancel";

export class TaskWriteError extends Error {
  constructor(readonly status: number, message: string, readonly fields?: Record<string, string>, readonly retryable = false) {
    super(message);
    this.name = "TaskWriteError";
  }
}

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as Error & { code?: string; errcode?: number; errno?: number };
  return sqliteError.code === "SQLITE_BUSY" || sqliteError.code === "SQLITE_LOCKED"
    || [5, 6].includes(sqliteError.errcode ?? sqliteError.errno ?? -1)
    || /database is (?:locked|busy)/i.test(error.message);
}

function validSpec(input: unknown, now: number): TaskSpec {
  const result = validateTaskSpec(input, now);
  if (!result.ok) throw new TaskWriteError(400, "Invalid task.", result.errors);
  return result.spec;
}

// Opens the selected home's existing database. A missing file is never created.
function withTaskDatabase<T>(home: RuntimeHome, operation: (database: DatabaseSync) => T): T {
  const directory = resolve(home.directory);
  const databaseFile = resolve(home.databaseFile);
  let safe = false;
  try {
    safe = databaseFile === join(directory, "inoai.sqlite") && !lstatSync(directory).isSymbolicLink()
      && lstatSync(databaseFile).isFile();
  } catch {
    throw new TaskWriteError(409, "Start the agent once before managing tasks from the UI.");
  }
  if (!safe) throw new TaskWriteError(500, "Runtime data unavailable.");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databaseFile);
    database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${databaseBusyTimeoutMs}`);
    const columns = new Set((database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("schedule_kind")) throw new TaskWriteError(409, "Start the agent once to update the database before managing tasks from the UI.");
    return operation(database);
  } catch (error) {
    if (error instanceof TaskWriteError) throw error;
    if (isSqliteBusyError(error)) throw new TaskWriteError(503, "The database is busy. Try again.", undefined, true);
    throw error;
  } finally {
    database?.close();
  }
}

// Runs `operation` in one write transaction. Rolls back on any error.
function transaction<T>(database: DatabaseSync, operation: () => T): T {
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

function hasProcessingRun(database: DatabaseSync, taskId: number): boolean {
  return database.prepare("SELECT 1 FROM task_runs WHERE task_id=? AND state='processing' AND deleted_at IS NULL").get(taskId) !== undefined;
}

function existingTask(database: DatabaseSync, taskId: number) {
  const task = getTask(database, taskId);
  if (!task) throw new TaskWriteError(404, "Task not found.");
  return task;
}

function uiTask(database: DatabaseSync, taskId: number): UiTask {
  return readTasks(database, taskId)[0]!;
}

/** Creates a placeholder Session and a Task in one transaction. */
export function createUiTask(home: RuntimeHome, input: unknown, now = Math.floor(Date.now() / 1000)): UiTask {
  const columns = toTaskColumns(validSpec(input, now), now);
  return withTaskDatabase(home, (database) => {
    const taskId = transaction(database, () => {
      const owner = database.prepare(`SELECT s.user_id, s.transport, s.workspace_id, s.agent_provider, s.project_path FROM sessions s
        JOIN users u ON u.id = s.user_id AND u.role = 'owner' AND u.state = 'active' AND u.deleted_at IS NULL
        WHERE s.deleted_at IS NULL ORDER BY s.id DESC LIMIT 1`).get() as
        { user_id: number; transport: string; workspace_id: string; agent_provider: string; project_path: string } | undefined;
      if (!owner) throw new TaskWriteError(409, noSessionMessage);
      return insertPendingTask(database, owner, columns, uiActor).id;
    });
    return uiTask(database, taskId);
  });
}

/** Replaces the task's spec and recomputes its next run. Only active or paused tasks without a running run. */
export function editUiTask(home: RuntimeHome, taskId: number, input: unknown, now = Math.floor(Date.now() / 1000)): UiTask {
  const spec = validSpec(input, now);
  return withTaskDatabase(home, (database) => {
    const result = editTask(database, taskId, spec, now, uiActor);
    if (result === "not_found") throw new TaskWriteError(404, "Task not found.");
    if (result === "not_editable") throw new TaskWriteError(409, "Only active or paused tasks can be edited.");
    if (result === "running") throw new TaskWriteError(409, "A run is in progress. Try again after it finishes.");
    if (result === "no_run_left") throw new TaskWriteError(400, "Invalid task.", { schedule: "The schedule has no run left after the runs so far." });
    return uiTask(database, taskId);
  });
}

/** Applies run now, pause, resume, or cancel to one task. */
export function applyUiTaskAction(home: RuntimeHome, taskId: number, action: TaskAction, now = Math.floor(Date.now() / 1000)): UiTask {
  return withTaskDatabase(home, (database) => {
    if (action === "resume") {
      existingTask(database, taskId);
      if (!resumeTask(database, taskId, uiActor, now)) throw new TaskWriteError(409, "Only paused tasks can be resumed.");
      return uiTask(database, taskId);
    }
    transaction(database, () => {
      const task = existingTask(database, taskId);
      if (action === "pause") {
        if (!pauseTask(database, taskId, uiActor)) throw new TaskWriteError(409, "Only active tasks can be paused.");
      } else if (action === "run") {
        if (task.state !== "active") throw new TaskWriteError(409, "Only active tasks can run now.");
        if (hasProcessingRun(database, taskId)) throw new TaskWriteError(409, "A run is in progress. Try again after it finishes.");
        database.prepare("UPDATE tasks SET next_due_at=?,updated_at=?,updated_by=? WHERE id=?").run(now, now, uiActor, taskId);
      } else {
        // An in-progress run is left to finish; the scheduler only starts runs for active tasks.
        const changed = database.prepare(`UPDATE tasks SET state='cancelled',updated_at=?,updated_by=?
          WHERE id=? AND state IN ('active','paused') AND deleted_at IS NULL`).run(now, uiActor, taskId).changes;
        if (changed !== 1) throw new TaskWriteError(409, "Only active or paused tasks can be cancelled.");
      }
    });
    return uiTask(database, taskId);
  });
}
