import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapRuntimeHome } from "../../../agent-instance/runtime-home.js";
import type { Configuration } from "../../../agent-instance/config.js";
import { openDatabase } from "../../../connectors/persistence/sqlite/legacy-database.js";
import { createSqliteOperationalStore } from "../../../connectors/persistence/sqlite/operational-store.js";
import { toTaskColumns, validateTaskSpec, type TaskSpec } from "../../../tasks/schedule.js";

async function fixture(t: test.TestContext) {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-task-store-"));
  const home = await bootstrapRuntimeHome(deployment);
  const database = openDatabase(home);
  const store = createSqliteOperationalStore(database);
  t.after(async () => {
    if (database.isOpen) await store.close();
    await rm(deployment, { recursive: true, force: true });
  });
  const owner = await store.bootstrapOwner({ discordGuildId: "guild", discordOwnerUserId: "owner" } as Configuration, "owner:test");
  const session = await store.createSession({
    user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel",
    conversation_id: "thread", initiating_external_message_id: "starter", agent_provider: "codex",
    agent_session_id: "agent-session", project_path: deployment,
  }, "session:test");
  return { deployment, home, database, store, session };
}

test("Task persistence migrates an existing home, completes and reopens runs, and preserves audit", async (t) => {
  const { home, database, store, session } = await fixture(t);
  const task = await store.createTask({ goal: "write report", task_type: "recurring", interval_seconds: 3600,
    conversation_id: "thread", session_id: session.id, next_due_at: 1000 }, "task:create");
  assert.equal(task.created_by, "task:create");
  const run = (await store.claimTaskRun(task.id, 1100, "task:claim"))!;
  assert.equal(run.state, "processing");
  assert.equal(await store.claimTaskRun(task.id, 1101), undefined);
  assert.equal((await store.getTask(task.id))!.state, "active");
  await store.completeTaskRun(run.id, 22, ["results/1/1/report.md"], 1200, "task:complete");
  assert.deepEqual((await store.getTaskRun(run.id))!.artifact_paths, ["results/1/1/report.md"]);
  assert.equal((await store.getTask(task.id))!.next_due_at, 4800);
  assert.equal((await store.getTask(task.id))!.message_cursor, 22);
  assert.equal((await store.getTask(task.id))!.updated_by, "task:complete");
  assert.equal((await store.getTaskRun(run.id))!.started_at, 1100);
  assert.equal((await store.getTaskRun(run.id))!.completed_at, 1200);
  assert.equal((await store.getTaskRun(run.id))!.updated_by, "task:complete");

  await store.close();
  const reopened = createSqliteOperationalStore(openDatabase(home));
  try {
    assert.equal((await reopened.getTask(task.id))!.goal, "write report");
    assert.equal((await reopened.listTaskRuns(task.id)).length, 1);
  } finally {
    await reopened.close();
  }
  assert.equal(database.isOpen, false);
});

test("Task lifecycle supports failure, pause, resume, cancellation, and restart recovery", async (t) => {
  const { store, session, database } = await fixture(t);
  const task = await store.createTask({ goal: "daily report", task_type: "recurring", interval_seconds: 86400,
    conversation_id: "thread", session_id: session.id, next_due_at: 900 }, "task:create");
  const first = (await store.claimTaskRun(task.id, 1000))!;
  assert.equal(await store.failTaskRun(first.id, "API_KEY=abc Bearer secret failed", 1010, "task:failure"), true);
  assert.equal((await store.getTaskRun(first.id))!.failure_detail, "API_KEY=[redacted] Bearer [redacted] failed");
  assert.equal((await store.getTask(task.id))!.next_due_at, 87410);
  assert.equal(await store.pauseTask(task.id, "task:pause"), true);
  await assert.rejects(store.claimTaskRun(task.id, 2000), /Task is not active/);
  assert.equal(await store.resumeTask(task.id, "task:resume"), true);

  const interrupted = (await store.claimTaskRun(task.id, 3000))!;
  await store.recoverTaskRuns("startup:test");
  assert.equal((await store.getTaskRun(interrupted.id))!.state, "failed");
  assert.equal((await store.getTaskRun(interrupted.id))!.failure_detail, "Interrupted by restart");
  assert.equal((await store.getTask(task.id))!.next_due_at, Math.floor(Date.now() / 1000) + 86400);

  const active = (await store.claimTaskRun(task.id, 4000))!;
  assert.equal(await store.cancelTask(task.id, 4010, "task:cancel"), true);
  assert.equal((await store.getTaskRun(active.id))!.state, "cancelled");
  assert.equal((await store.getTask(task.id))!.state, "cancelled");
  assert.equal((await store.getTaskRun(active.id))!.updated_by, "task:cancel");
  assert.equal((await store.getTask(task.id))!.updated_by, "task:cancel");
  assert.equal(await store.cancelTask(task.id, 4020), false);
  const deletedAt = 5000;
  database.prepare("UPDATE tasks SET deleted_at=?,deleted_by='task:delete' WHERE id=?").run(deletedAt, task.id);
  database.prepare("UPDATE task_runs SET deleted_at=?,deleted_by='task:delete' WHERE id=?").run(deletedAt, active.id);
  assert.equal(await store.getTask(task.id), undefined);
  assert.equal(await store.getTaskRun(active.id), undefined);
  assert.equal((await store.listTasks()).some((row) => row.id === task.id), false);
  assert.equal((await store.listTaskRuns(task.id)).some((row) => row.id === active.id), false);
  assert.ok(database.prepare("SELECT id FROM task_runs WHERE id=?").get(active.id));
  assert.equal(database.prepare("SELECT deleted_by FROM tasks WHERE id=?").get(task.id)!.deleted_by, "task:delete");
});

test("one-time Tasks complete after one run and reject invalid recurrence and artifact transitions", async (t) => {
  const { store, session } = await fixture(t);
  await assert.rejects(store.createTask({ goal: "bad interval", task_type: "recurring", interval_seconds: 90,
    conversation_id: "thread", session_id: session.id }));
  const oneTime = await store.createTask({ goal: "once", task_type: "one_time", conversation_id: "thread", session_id: session.id });
  assert.equal((await store.getTask(oneTime.id))!.state, "active");
  assert.equal(oneTime.next_due_at, null);
  const run = (await store.claimTaskRun(oneTime.id, 100))!;
  await assert.rejects(store.completeTaskRun(run.id, 0, ["../secret.txt"], 200));
  await store.completeTaskRun(run.id, 4, [], 201);
  assert.equal((await store.getTask(oneTime.id))!.state, "completed");
  await assert.rejects(store.claimTaskRun(oneTime.id, 300), /Task is not active/);
});

test("opening an older SQLite home adds Task tables without changing existing rows", async (t) => {
  const { home, database, session } = await fixture(t);
  database.prepare("INSERT INTO events (session_id,event_type,detail,created_by,updated_by) VALUES (?, 'before_migration', 'kept', 'test', 'test')").run(session.id);
  database.exec("DROP INDEX task_runs_by_task; DROP INDEX one_active_task_run; DROP INDEX due_tasks; DROP TABLE task_runs; DROP TABLE tasks;");
  database.close();
  const migrated = openDatabase(home);
  try {
    assert.equal((migrated.prepare("SELECT detail FROM events WHERE event_type='before_migration'").get() as { detail: string }).detail, "kept");
    assert.ok(migrated.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='task_runs'").get());
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM tasks").get()!.count, 0);
  } finally {
    migrated.close();
  }
});

const scheduleColumns = ["title", "output_spec", "timezone", "schedule_kind", "schedule_time", "schedule_days", "ends_at", "max_runs"];

test("opening a home without Task schedule columns adds them idempotently and keeps legacy Tasks unchanged", async (t) => {
  const { home, database, session } = await fixture(t);
  for (const column of scheduleColumns) database.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
  database.prepare(`INSERT INTO tasks (goal,task_type,interval_seconds,conversation_id,session_id,next_due_at,message_cursor,created_by,updated_by)
    VALUES ('legacy report','recurring',7200,'thread',?,5000,3,'legacy','legacy')`).run(session.id);
  const before = { ...(database.prepare("SELECT * FROM tasks").get() as Record<string, unknown>) };
  database.close();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const migrated = openDatabase(home);
    try {
      const columns = (migrated.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string; type: string; notnull: number }>);
      for (const name of scheduleColumns) {
        const column = columns.find((candidate) => candidate.name === name);
        assert.ok(column, name);
        assert.equal(column.notnull, 0);
        assert.equal(column.type, name === "ends_at" || name === "max_runs" ? "INTEGER" : "TEXT");
      }
      const after = migrated.prepare("SELECT * FROM tasks").get() as Record<string, unknown>;
      assert.deepEqual(Object.fromEntries(Object.keys(before).map((key) => [key, after[key]])), before);
      for (const name of scheduleColumns) assert.equal(after[name], null);
    } finally {
      migrated.close();
    }
  }
});

test("createTask persists schedule columns from toTaskColumns within the existing CHECK constraints", async (t) => {
  const { store, database, home, session: ownerSession } = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  const schedules = [
    { kind: "once" }, { kind: "once", at: now + 3600 }, { kind: "interval", hours: 4 }, { kind: "daily", time: "09:00" },
    { kind: "days", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, { kind: "weekly", time: "18:30", day: "sun" },
  ];
  for (const [index, schedule] of schedules.entries()) {
    const result = validateTaskSpec({ title: `Task ${index}`, instruction: "Summarize failing CI", expectedOutput: "A short list",
      schedule, timezone: "Asia/Singapore", maxRuns: schedule.kind === "once" ? undefined : 5 }, now);
    assert.equal(result.ok, true, JSON.stringify(result));
    const columns = toTaskColumns((result as { spec: TaskSpec }).spec, now);
    const session = await store.createSession({
      user_id: ownerSession.user_id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel",
      conversation_id: `pending:ui:${index}`, initiating_external_message_id: `starter-${index}`, agent_provider: "codex",
      agent_session_id: `agent-session-${index}`, project_path: home.directory,
    }, "session:test");
    const task = await store.createTask({ ...columns, conversation_id: session.conversation_id, session_id: session.id }, "ui:owner");
    for (const [key, value] of Object.entries(columns)) assert.equal(task[key as keyof typeof task], value, `${schedule.kind}.${key}`);
    assert.equal(task.created_by, "ui:owner");
  }
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count, schedules.length);
});

test("createTask keeps rejecting a due time on legacy one-time Tasks", async (t) => {
  const { store, session } = await fixture(t);
  await assert.rejects(store.createTask({ goal: "once", task_type: "one_time", next_due_at: 100,
    conversation_id: "thread", session_id: session.id }), /One-time Task cannot have a schedule/);
  await assert.rejects(store.createTask({ goal: "once", task_type: "one_time", interval_seconds: 3600, schedule_kind: "once",
    conversation_id: "thread", session_id: session.id }), /One-time Task cannot have a schedule/);
});
