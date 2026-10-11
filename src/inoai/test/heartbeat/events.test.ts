import assert from "node:assert/strict";
import { stat, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHeartbeatEventRecorder } from "../../heartbeat/events.js";
import { openDatabase, listEvents } from "../../connectors/persistence/sqlite/legacy-database.js";
import { bootstrapRuntimeHome } from "../../agent-instance/runtime-home.js";

test("heartbeat recorder writes sanitized events to the selected SQLite database", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-heartbeat-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = await bootstrapRuntimeHome(directory);
  const database = openDatabase(home);
  try {
    await createHeartbeatEventRecorder(home)({ event_type: "heartbeat_check", detail: JSON.stringify({ status: "healthy", query: "healthy" }) });
    assert.deepEqual(listEvents(database).map((event) => [event.event_type, event.created_by, event.detail]), [
      ["heartbeat_check", "heartbeat", JSON.stringify({ status: "healthy", query: "healthy" })],
    ]);
  } finally { database.close(); }
});

test("heartbeat recorder does not create a missing database", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-heartbeat-events-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = await bootstrapRuntimeHome(directory);
  await assert.rejects(createHeartbeatEventRecorder(home)({ event_type: "heartbeat_check", detail: "{}" }), /unavailable/);
  assert.equal(await stat(home.databaseFile).then(() => true, () => false), false);
});

test("heartbeat recorder writes while a read-only SQLite connection is open", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "inoai-heartbeat-events-concurrent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = await bootstrapRuntimeHome(directory);
  const writer = openDatabase(home);
  const reader = new DatabaseSync(home.databaseFile, { readOnly: true });
  const recorder = createHeartbeatEventRecorder(home);
  try {
    await recorder({ event_type: "heartbeat_check", detail: "{}" });
    assert.equal(listEvents(writer).length, 1);
  } finally {
    recorder.close();
    reader.close();
    writer.close();
  }
});
