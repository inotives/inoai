import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { bootstrapRuntimeHome, type RuntimeHome } from "../../inoai/agent-instance/runtime-home.js";
import { openDatabase } from "../../inoai/connectors/persistence/sqlite/legacy-database.js";
import { loadUiData } from "../api/read-model.js";

const NOW = new Date("2026-10-20T12:30:00Z");
const now = NOW.getTime() / 1_000;
const at = (iso: string) => Date.parse(iso) / 1_000;
const DAY = 86_400;

async function withHome(run: (home: RuntimeHome, database: DatabaseSync) => Promise<void>): Promise<void> {
  const deploymentDirectory = await mkdtemp(join(tmpdir(), "inoai-ui-insights-test-"));
  const home = await bootstrapRuntimeHome(deploymentDirectory, ".robin-xai-test");
  const database = openDatabase(home);
  try {
    database.prepare("INSERT INTO users (transport, workspace_id, external_user_id) VALUES (?, ?, ?)").run("discord", "workspace-test", "owner");
    for (const name of ["chat", "one-time", "recurring"]) {
      database.prepare(`INSERT INTO sessions (user_id, transport, workspace_id, parent_conversation_id, conversation_id, initiating_external_message_id, agent_provider, agent_session_id, project_path)
        VALUES (1, 'discord', 'workspace-test', 'parent', ?, ?, 'codex', ?, ?)`).run(name, `initial-${name}`, `agent-${name}`, deploymentDirectory);
    }
    database.prepare("INSERT INTO tasks (goal, task_type, conversation_id, session_id) VALUES ('Once', 'one_time', 'one-time', 2)").run();
    database.prepare("INSERT INTO tasks (goal, task_type, interval_seconds, conversation_id, session_id) VALUES ('Every hour', 'recurring', 3600, 'recurring', 3)").run();
    await run(home, database);
  } finally {
    database.close();
    await rm(deploymentDirectory, { recursive: true, force: true });
  }
}

let externalId = 0;
function message(database: DatabaseSync, sessionId: number, direction: "user" | "agent", createdAt: number, options: { replyTo?: number; state?: string; deleted?: boolean } = {}): number {
  const result = database.prepare(`INSERT INTO messages (session_id, transport, workspace_id, external_message_id, direction, body, in_reply_to_message_id, state, created_at, deleted_at, deleted_by)
    VALUES (?, 'discord', 'workspace-test', ?, ?, 'body', ?, ?, ?, ?, ?)`).run(sessionId, direction === "user" ? `external-${externalId += 1}` : null, direction,
    options.replyTo ?? null, options.state ?? "completed", createdAt, options.deleted ? createdAt : null, options.deleted ? "test" : null);
  return Number(result.lastInsertRowid);
}

function event(database: DatabaseSync, eventType: string, detail: string | null, createdAt: number, deleted = false): void {
  database.prepare("INSERT INTO events (session_id, event_type, detail, created_at, deleted_at, deleted_by) VALUES (1, ?, ?, ?, ?, ?)")
    .run(eventType, detail, createdAt, deleted ? createdAt : null, deleted ? "test" : null);
}

function taskRun(database: DatabaseSync, taskId: number, state: "completed" | "failed", startedAt: number, deleted = false): void {
  database.prepare("INSERT INTO task_runs (task_id, state, started_at, completed_at, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?, ?)")
    .run(taskId, state, startedAt, startedAt + 60, deleted ? startedAt : null, deleted ? "test" : null);
}

test("insights aggregate a seeded home per window with UTC buckets", async () => {
  await withHome(async (home, database) => {
    const u1 = message(database, 1, "user", at("2026-10-20T12:20:00Z"));
    message(database, 1, "agent", at("2026-10-20T12:20:30Z"), { replyTo: u1 });
    message(database, 1, "agent", at("2026-10-20T12:21:30Z"), { replyTo: u1 });
    message(database, 1, "user", at("2026-10-20T12:25:00Z"));
    message(database, 1, "user", at("2026-10-20T12:21:00Z"), { deleted: true });
    const u2 = message(database, 1, "user", at("2026-10-20T10:00:00Z"));
    message(database, 1, "agent", at("2026-10-20T10:02:00Z"), { replyTo: u2 });
    const once = message(database, 2, "user", at("2026-10-20T11:00:00Z"));
    message(database, 2, "agent", at("2026-10-20T11:01:00Z"), { replyTo: once });
    message(database, 3, "agent", now - 2 * DAY);
    const u3 = message(database, 1, "user", now - 3 * DAY);
    message(database, 1, "agent", now - 3 * DAY + 600, { replyTo: u3 });
    const u4 = message(database, 1, "user", now - 20 * DAY);
    message(database, 1, "agent", now - 20 * DAY + 1_000, { replyTo: u4 });
    message(database, 1, "user", now - 40 * DAY);

    event(database, "runtime_usage", "input=100; output=20; cached=50; reasoning=5; cost_usd=0.01; provider=claude", at("2026-10-20T12:05:00Z"));
    event(database, "runtime_usage", "input=10; output=2; cached=0", at("2026-10-20T11:10:00Z"));
    event(database, "runtime_usage", "input=abc; output=1; provider=codex", at("2026-10-20T12:06:00Z"));
    event(database, "runtime_usage", "garbage", at("2026-10-20T12:07:00Z"));
    event(database, "runtime_usage", null, at("2026-10-20T12:07:30Z"));
    event(database, "runtime_usage", "input=999", at("2026-10-20T12:08:00Z"), true);
    event(database, "runtime_usage", "input=1000; output=100; cost_usd=0.5; provider=opencode", now - 3 * DAY);
    event(database, "skill_selected", "skill=alpha; version=1.0.0", at("2026-10-20T12:01:00Z"));
    event(database, "skill_selected", "skill=alpha; version=1.0.0", at("2026-10-20T12:02:00Z"));
    event(database, "skill_selected", "skill=beta; version=2.0.0", at("2026-10-20T11:30:00Z"));
    event(database, "skill_selected", "skill=beta; version=2.0.0", now - 3 * DAY);
    event(database, "skill_selected", "skill=beta; version=2.0.0", now - 3 * DAY);
    event(database, "skill_selected", "version=1", at("2026-10-20T12:03:00Z"));
    event(database, "runtime_failure", "attempt=1; reason=timed_out; replay_safe=false", at("2026-10-20T12:03:00Z"));
    event(database, "runtime_failure", "attempt=2; reason=timed_out; replay_safe=false", at("2026-10-20T12:03:10Z"));
    event(database, "turn_failed", "reason=empty_answer", at("2026-10-20T12:04:00Z"));
    event(database, "turn_failed", "Runtime outcome uncertain", at("2026-10-20T12:04:10Z"));
    event(database, "response_delivery_failed", "known_pre_send_failure", at("2026-10-20T12:04:20Z"));
    event(database, "turn_failed", "reason=provider_mismatch; attempts=0", now - 5 * DAY);

    taskRun(database, 1, "completed", at("2026-10-20T11:00:00Z"));
    taskRun(database, 2, "failed", now - 2 * DAY);
    taskRun(database, 2, "completed", now - 40 * DAY);
    taskRun(database, 1, "failed", at("2026-10-20T12:00:00Z"), true);

    const { insights } = await loadUiData(home, NOW);
    const day = insights["24h"];
    assert.equal(day.bucket, "hour");
    assert.equal(day.volume.length, 24);
    assert.equal(day.volume[0]?.start, "2026-10-19T13:00:00.000Z");
    assert.equal(day.volume[23]?.start, "2026-10-20T12:00:00.000Z");
    assert.deepEqual(day.volume.slice(21), [
      { start: "2026-10-20T10:00:00.000Z", owner: 1, agent: 1 },
      { start: "2026-10-20T11:00:00.000Z", owner: 1, agent: 1 },
      { start: "2026-10-20T12:00:00.000Z", owner: 2, agent: 2 },
    ]);
    assert.ok(day.volume.slice(0, 21).every((item) => item.owner === 0 && item.agent === 0));
    assert.deepEqual(day.conversationTypes, { chat: 6, oneTime: 2, recurring: 0 });
    assert.deepEqual(day.replyTime, { count: 3, medianSeconds: 60, p90Seconds: 120 });
    assert.deepEqual(day.failures, [
      { cause: "runtime_failure:timed_out", count: 2 },
      { cause: "delivery_failed", count: 1 },
      { cause: "turn_failed:empty_answer", count: 1 },
      { cause: "turn_failed:uncertain", count: 1 },
    ]);
    assert.deepEqual(day.taskRuns, { completed: 1, failed: 0 });
    assert.equal(day.tokens.series.length, 24);
    assert.deepEqual(day.tokens.series[23], { start: "2026-10-20T12:00:00.000Z", input: 100, output: 20, cached: 50, reasoning: 5 });
    assert.deepEqual(day.tokens.series[22], { start: "2026-10-20T11:00:00.000Z", input: 10, output: 2, cached: 0, reasoning: 0 });
    assert.deepEqual(day.tokens.totals, { input: 110, output: 22, cached: 50, reasoning: 5, costUsd: 0.01, turns: 2 });
    assert.deepEqual(day.skills, [{ skill: "alpha", count: 2 }, { skill: "beta", count: 1 }]);

    const week = insights["7d"];
    assert.equal(week.bucket, "day");
    assert.deepEqual(week.volume.map((item) => item.start), ["14", "15", "16", "17", "18", "19", "20"].map((date) => `2026-10-${date}T00:00:00.000Z`));
    assert.deepEqual(week.volume.map((item) => [item.owner, item.agent]), [[0, 0], [0, 0], [0, 0], [1, 1], [0, 1], [0, 0], [4, 4]]);
    assert.deepEqual(week.conversationTypes, { chat: 8, oneTime: 2, recurring: 1 });
    assert.deepEqual(week.replyTime, { count: 4, medianSeconds: 90, p90Seconds: 600 });
    assert.deepEqual(week.failures.find((item) => item.cause === "turn_failed:provider_mismatch"), { cause: "turn_failed:provider_mismatch", count: 1 });
    assert.deepEqual(week.taskRuns, { completed: 1, failed: 1 });
    assert.deepEqual(week.tokens.totals, { input: 1110, output: 122, cached: 50, reasoning: 5, costUsd: 0.51, turns: 3 });
    assert.equal(week.tokens.series[3]?.input, 1000);
    assert.deepEqual(week.skills, [{ skill: "beta", count: 3 }, { skill: "alpha", count: 2 }]);

    const month = insights["30d"];
    assert.equal(month.volume.length, 30);
    assert.equal(month.volume[0]?.start, "2026-09-21T00:00:00.000Z");
    assert.deepEqual(month.conversationTypes, { chat: 10, oneTime: 2, recurring: 1 });
    assert.deepEqual(month.replyTime, { count: 5, medianSeconds: 120, p90Seconds: 1_000 });
    assert.deepEqual(month.taskRuns, { completed: 1, failed: 1 });
    assert.equal(month.volume.reduce((sum, item) => sum + item.owner + item.agent, 0), 13);
  });
});

test("insights for a home without activity are zero-filled with empty usage and skills", async () => {
  await withHome(async (home) => {
    const { insights } = await loadUiData(home, NOW);
    for (const [window, length] of [["24h", 24], ["7d", 7], ["30d", 30]] as const) {
      const data = insights[window];
      assert.equal(data.volume.length, length);
      assert.equal(data.tokens.series.length, length);
      assert.ok(data.tokens.series.every((item) => item.input + item.output + item.cached + item.reasoning === 0));
      assert.deepEqual(data.tokens.totals, { input: 0, output: 0, cached: 0, reasoning: 0, costUsd: null, turns: 0 });
      assert.deepEqual(data.skills, []);
      assert.deepEqual(data.failures, []);
      assert.deepEqual(data.replyTime, { count: 0, medianSeconds: null, p90Seconds: null });
      assert.deepEqual(data.conversationTypes, { chat: 0, oneTime: 0, recurring: 0 });
      assert.deepEqual(data.taskRuns, { completed: 0, failed: 0 });
    }
  });
});

test("metrics and insights count more than the 500-message sample", async () => {
  await withHome(async (home, database) => {
    database.exec("BEGIN");
    for (let index = 0; index < 590; index += 1) message(database, 1, "user", now - 1_800 + index);
    for (let index = 0; index < 10; index += 1) message(database, 1, "agent", now - 600 + index, { state: "failed" });
    for (let index = 0; index < 5; index += 1) message(database, 1, "user", now - 10 * DAY + index);
    database.exec("COMMIT");
    const data = await loadUiData(home, NOW);
    assert.equal(data.messages.length, 500);
    assert.equal(data.metrics.messages24h, 600);
    assert.equal(data.metrics.messages30d, 605);
    assert.equal(data.metrics.failedReplies24h, 10);
    assert.equal(data.metrics.failedReplies30d, 10);
    assert.equal(data.insights["24h"].conversationTypes.chat, 600);
    assert.equal(data.insights["24h"].volume.reduce((sum, item) => sum + item.owner + item.agent, 0), 600);
    assert.equal(data.insights["30d"].conversationTypes.chat, 605);
  });
});
