import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BigQuerySyncScheduler, buildBigQueryMergeQuery, exportToBigQuery, bigQueryTables, type BigQueryUpsertRequest } from "../bigquery.js";
import { archiveMessage, createEvent, createMemory, createSession, listEvents, openDatabase, softDeleteMemory, softDeleteMessage, upsertUser } from "../database.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";

test("BigQuery export is disabled without optional configuration or a client", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-bq-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    try {
      assert.deepEqual(await exportToBigQuery(database, undefined, undefined), { state: "disabled", reason: "not_configured" });
      let calls = 0;
      assert.deepEqual(await exportToBigQuery(database, undefined, { upsertRows: async () => { calls += 1; } }), { state: "disabled", reason: "not_configured" });
      assert.equal(calls, 0);
    } finally { database.close(); }
  } finally { await rm(deployment, { recursive: true, force: true }); }
});

test("BigQuery MERGE declares types for nullable parameters", () => {
  const row = Object.fromEntries(bigQueryTables.messages.fields.map((field) => [
    field.name,
    field.mode === "REQUIRED" ? (field.type === "INT64" ? 1 : field.type === "TIMESTAMP" ? "2026-01-01T00:00:00Z" : "value") : null,
  ]));
  const merge = buildBigQueryMergeQuery("project-12345", "analytics", bigQueryTables.messages, row);

  assert.match(merge.query, /^MERGE `project-12345\.analytics\.messages`/);
  assert.match(merge.query, /CAST\(@p_source_deleted_at AS STRING\)/);
  assert.equal(merge.params.p_source_deleted_at, null);
  assert.equal(merge.types.p_source_deleted_at, "TIMESTAMP");
  assert.equal(merge.types.p_user_source_id, "INT64");
});

test("two runtime homes share one sink without colliding on overlapping source IDs", async () => {
  const firstDeployment = await mkdtemp(join(tmpdir(), "inoai-bq-test-"));
  const secondDeployment = await mkdtemp(join(tmpdir(), "inoai-bq-test-"));
  try {
    const first = openDatabase(await bootstrapRuntimeHome(firstDeployment), { agentName: "planner", agentProvider: "codex" });
    const second = openDatabase(await bootstrapRuntimeHome(secondDeployment), { agentName: "reviewer", agentProvider: "claude" });
    try {
      const rows = new Map<string, BigQueryUpsertRequest["rows"][number]>();
      const upsert = async (request: BigQueryUpsertRequest) => {
        for (const row of request.rows) rows.set(`${request.table.name}:${row.agent_instance_id}:${row.source_id}`, row);
      };
      const configuration = { projectId: "project-12345", datasetId: "analytics", syncIntervalMinutes: 60 };
      assert.equal((await exportToBigQuery(first, configuration, { upsertRows: upsert })).state, "exported");
      assert.equal((await exportToBigQuery(second, configuration, { upsertRows: upsert })).state, "exported");

      const instances = [...rows.values()].filter((row) => row.agent_name === "planner" || row.agent_name === "reviewer");
      assert.equal(instances.length, 2);
      assert.notEqual(instances[0].agent_instance_id, instances[1].agent_instance_id);
      assert.deepEqual(new Set(instances.map((row) => row.source_id)), new Set([1]));
      assert.equal(rows.size, 2);
    } finally {
      first.close();
      second.close();
    }
  } finally {
    await rm(firstDeployment, { recursive: true, force: true });
    await rm(secondDeployment, { recursive: true, force: true });
  }
});

test("BigQuery export sends redacted rows with stable keys and tombstones", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-bq-test-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const database = openDatabase(home, { agentName: "planner", agentProvider: "codex" });
    try {
      const user = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
      const session = createSession(database, { user_id: user.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "parent", conversation_id: "thread", initiating_external_message_id: "start", agent_provider: "codex", agent_session_id: "agent", project_path: deployment });
      const message = archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: "message", external_author_id: "owner", user_id: user.id, direction: "user", body: "remember password: super-secret", reply_to_external_message_id: null, in_reply_to_message_id: null }).message!;
      createEvent(database, { session_id: session.id, message_id: message.id, event_type: "test", detail: "Authorization: Bearer secret-value" });
      const memory = createMemory(database, { body: "api_key = hidden", source_message_id: message.id, created_by_user_id: user.id, review_id: null, origin: "manual" });
      softDeleteMessage(database, message.id);
      softDeleteMemory(database, memory.id);

      const calls: BigQueryUpsertRequest[] = [];
      const result = await exportToBigQuery(database, { projectId: "project-12345", datasetId: "analytics", syncIntervalMinutes: 60 }, { upsertRows: async (request) => { calls.push(request); } });
      assert.equal(result.state, "exported");
      assert.equal(calls.length, 5);
      const messages = calls.find(({ table }) => table.name === "messages")!;
      assert.deepEqual(messages.table.keyFields, ["agent_instance_id", "source_id"]);
      assert.equal(messages.rows[0].source_deleted_at !== null, true);
      assert.match(String(messages.rows[0].redacted_body), /redacted/);
      assert.doesNotMatch(String(messages.rows[0].redacted_body), /super-secret/);
      const events = calls.find(({ table }) => table.name === "events")!;
      assert.doesNotMatch(String(events.rows[0].redacted_detail), /secret-value/);
      assert.equal(bigQueryTables.messages.partitionField, "source_updated_at");
      assert.deepEqual(bigQueryTables.messages.clusteringFields, ["agent_instance_id"]);
    } finally { database.close(); }
  } finally { await rm(deployment, { recursive: true, force: true }); }
});

test("BigQuery export reports client failures without throwing", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-bq-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    try {
      const result = await exportToBigQuery(database, { projectId: "project-12345", datasetId: "analytics", syncIntervalMinutes: 60 }, { upsertRows: async () => { throw new Error("offline"); } });
      assert.equal(result.state, "failed");
      assert.equal((result.error as Error).message, "offline");
    } finally { database.close(); }
  } finally { await rm(deployment, { recursive: true, force: true }); }
});

test("BigQuery export advances per-table watermarks and re-sends only the overlap", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-bq-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    try {
      const calls: BigQueryUpsertRequest[] = [];
      const client = { upsertRows: async (request: BigQueryUpsertRequest) => { calls.push(request); } };
      const first = await exportToBigQuery(database, { projectId: "project-12345", datasetId: "analytics", syncIntervalMinutes: 60 }, client, 2_000_000_000);
      assert.equal(first.state, "exported");
      const callCount = calls.length;
      const second = await exportToBigQuery(database, { projectId: "project-12345", datasetId: "analytics", syncIntervalMinutes: 60 }, client, 2_000_000_001);
      assert.deepEqual(second, { state: "exported", tables: 6, rows: 1 });
      assert.equal(calls.length, callCount + 1);
      const state = database.prepare("SELECT COUNT(*) AS count FROM bigquery_sync_state").get() as { count: number };
      assert.equal(state.count, 6);
    } finally { database.close(); }
  } finally { await rm(deployment, { recursive: true, force: true }); }
});

test("BigQuery retry is idempotent across a reopened runtime home", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-bq-test-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const configuration = { projectId: "project-12345", datasetId: "analytics", syncIntervalMinutes: 60 };
    const firstDatabase = openDatabase(home, { agentName: "planner", agentProvider: "codex" });
    try {
      const failed = await exportToBigQuery(firstDatabase, configuration, { upsertRows: async () => { throw new Error("offline"); } }, 2_000_000_000);
      assert.equal(failed.state, "failed");
    } finally { firstDatabase.close(); }

    const database = openDatabase(home);
    try {
      const keys = new Set<string>();
      let upsertCount = 0;
      const result = await exportToBigQuery(database, configuration, { upsertRows: async (request) => {
        upsertCount += request.rows.length;
        for (const row of request.rows) keys.add(`${request.table.name}:${row.agent_instance_id}:${row.source_id}`);
      } }, 2_000_000_121);
      assert.equal(result.state, "exported");
      assert.equal(upsertCount, 1);
      assert.equal(keys.size, 1);
      const repeated = await exportToBigQuery(database, configuration, { upsertRows: async (request) => {
        upsertCount += request.rows.length;
        for (const row of request.rows) keys.add(`${request.table.name}:${row.agent_instance_id}:${row.source_id}`);
      } }, 2_000_000_122);
      assert.equal(repeated.state, "exported");
      assert.equal(upsertCount, 2);
      assert.equal(keys.size, 1);
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM bigquery_sync_state WHERE consecutive_failures = 0 AND next_attempt_at = 0").get() as { count: number }).count, 6);
    } finally { database.close(); }
  } finally { await rm(deployment, { recursive: true, force: true }); }
});

test("BigQuery failure records a bounded retry and does not block local events", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-bq-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    try {
      const configuration = { projectId: "project-12345", datasetId: "analytics", syncIntervalMinutes: 60 };
      const failed = await exportToBigQuery(database, configuration, { upsertRows: async () => { throw new Error("offline"); } }, 2_000_000_000);
      assert.equal(failed.state, "failed");
      const state = database.prepare("SELECT consecutive_failures, next_attempt_at, last_error FROM bigquery_sync_state WHERE table_name = 'agent_instances'").get() as { consecutive_failures: number; next_attempt_at: number; last_error: string };
      assert.equal(state.consecutive_failures, 1);
      assert.equal(state.next_attempt_at, 2_000_000_120);
      assert.equal(state.last_error, "unavailable");
      const deferred = await exportToBigQuery(database, configuration, { upsertRows: async () => undefined }, 2_000_000_001);
      assert.deepEqual(deferred, { state: "deferred", until: 2_000_000_120 });
      assert.ok(listEvents(database).some((event) => event.event_type === "bigquery_sync_failed"));
      assert.equal(listEvents(database).at(-1)?.event_type, "bigquery_sync_deferred");
    } finally { database.close(); }
  } finally { await rm(deployment, { recursive: true, force: true }); }
});

test("BigQuery scheduler uses the configured interval and stops cleanly", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-bq-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    try {
      const timers = new Set<() => void>();
      const scheduler = new BigQuerySyncScheduler(database, { projectId: "project-12345", datasetId: "analytics", syncIntervalMinutes: 7 }, { upsertRows: async () => undefined }, {
        clock: { now: () => new Date(2_000_000_000_000), setInterval: (callback, ms) => { assert.equal(ms, 420_000); timers.add(callback); return callback; }, clearInterval: (handle) => { timers.delete(handle as () => void); } },
      });
      scheduler.start();
      await scheduler.poke();
      assert.equal(timers.size, 1);
      scheduler.stop();
      assert.equal(timers.size, 0);
    } finally { database.close(); }
  } finally { await rm(deployment, { recursive: true, force: true }); }
});
