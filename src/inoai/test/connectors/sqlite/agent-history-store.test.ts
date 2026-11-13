import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireRuntimeHomeLock, bootstrapRuntimeHome } from "../../../agent-instance/runtime-home.js";
import type { Configuration } from "../../../agent-instance/config.js";
import type { AgentHistoryEntry, AgentHistoryRole } from "../../../agent-runtime/ports.js";
import { listHistory, MaintenanceDatabaseUnavailableError, openDatabase, withMaintenanceDatabase } from "../../../connectors/persistence/sqlite/legacy-database.js";
import { createSqliteOperationalStore } from "../../../connectors/persistence/sqlite/operational-store.js";

const historyObjects = ["agent_history_sessions", "agent_history", "agent_history_sessions_no_update", "agent_history_sessions_no_delete",
  "agent_history_no_update", "agent_history_no_delete"];

async function fixture(t: test.TestContext) {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-agent-history-"));
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
    conversation_id: "thread", initiating_external_message_id: "starter", agent_provider: "anthropic-api",
    agent_session_id: "agent-1", project_path: deployment,
  }, "session:test");
  return { home, database, store, session };
}

const entry = (role: AgentHistoryRole, text: string, model: string | null = null): AgentHistoryEntry =>
  ({ role, model, contentJson: JSON.stringify([{ type: "text", text }]) });

test("appending two Turns lists their rows in ordinal order, per Agent Session", async (t) => {
  const { store, session } = await fixture(t);
  assert.deepEqual(await store.listHistory(session.id, "agent-1"), []);
  await store.appendHistory(session.id, "agent-1", [], "test");
  await store.appendHistory(session.id, "agent-1", [entry("user", "one"), entry("assistant", "reply one", "claude-opus-5-5")], "anthropic-api");
  await store.appendHistory(session.id, "agent-2", [entry("user", "other session")], "anthropic-api");
  await store.appendHistory(session.id, "agent-1", [entry("system", "new instructions"), entry("user", "two"), entry("assistant", "reply two", "claude-opus-5-5")], "anthropic-api");

  assert.deepEqual(await store.listHistory(session.id, "agent-1"), [
    { ordinal: 0, ...entry("user", "one") },
    { ordinal: 1, ...entry("assistant", "reply one", "claude-opus-5-5") },
    { ordinal: 2, ...entry("system", "new instructions") },
    { ordinal: 3, ...entry("user", "two") },
    { ordinal: 4, ...entry("assistant", "reply two", "claude-opus-5-5") },
  ]);
  assert.deepEqual(await store.listHistory(session.id, "agent-2"), [{ ordinal: 0, ...entry("user", "other session") }]);
});

test("the Session record round-trips and the first stored record wins", async (t) => {
  const { database, store, session } = await fixture(t);
  const frozen = { systemJson: JSON.stringify("You are inoai."), toolsJson: JSON.stringify([{ type: "web_search_20260209", name: "web_search" }]), model: "claude-opus-5-5" };
  assert.deepEqual(await store.readOrCreateHistorySession(session.id, "agent-1", frozen, "anthropic-api"), frozen);
  assert.deepEqual(await store.readOrCreateHistorySession(session.id, "agent-1", { systemJson: "\"changed\"", toolsJson: "[]", model: "other" }), frozen);
  const rows = database.prepare("SELECT session_id, agent_session_id, created_by FROM agent_history_sessions").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ session_id: session.id, agent_session_id: "agent-1", created_by: "anthropic-api" }]);
});

test("appending is atomic: a failing row leaves no rows", async (t) => {
  const { database, store, session } = await fixture(t);
  await store.appendHistory(session.id, "agent-1", [entry("user", "kept")]);
  await assert.rejects(store.appendHistory(session.id, "agent-1", [entry("user", "lost"), entry("tool" as AgentHistoryRole, "bad")]), /CHECK constraint/);
  await assert.rejects(store.appendHistory(session.id + 100, "agent-1", [entry("user", "no session")]), /FOREIGN KEY/);
  assert.deepEqual((await store.listHistory(session.id, "agent-1")).map((row) => row.ordinal), [0]);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM agent_history").get() as { count: number }).count, 1);
  assert.equal(database.isTransaction, false);
});

test("agent history rows can never be updated or deleted", async (t) => {
  const { database, store, session } = await fixture(t);
  await store.readOrCreateHistorySession(session.id, "agent-1", { systemJson: "\"s\"", toolsJson: "[]", model: "m" });
  await store.appendHistory(session.id, "agent-1", [entry("user", "one")]);
  for (const table of ["agent_history_sessions", "agent_history"]) {
    assert.throws(() => database.prepare(`UPDATE ${table} SET created_by='x'`).run(), /append-only/);
    assert.throws(() => database.prepare(`DELETE FROM ${table}`).run(), /append-only/);
  }
  assert.equal((await store.listHistory(session.id, "agent-1")).length, 1);
});

test("an existing database gains the history tables and a live maintenance connection validates", async (t) => {
  const { home, store, session } = await fixture(t);
  await store.close();
  const legacy = new DatabaseSync(home.databaseFile);
  legacy.exec("DROP TABLE agent_history; DROP TABLE agent_history_sessions;");
  legacy.close();

  const release = await acquireRuntimeHomeLock(home);
  try {
    // A live home that has not migrated yet is refused without changing it.
    await assert.rejects(withMaintenanceDatabase(home, () => assert.fail("must not run")), MaintenanceDatabaseUnavailableError);
    const check = new DatabaseSync(home.databaseFile);
    assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_history'").get(), undefined);
    check.close();

    const reopened = openDatabase(home);
    try {
      for (const name of historyObjects) assert.ok(reopened.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name), `missing ${name}`);
      const migrated = createSqliteOperationalStore(reopened);
      await migrated.appendHistory(session.id, "agent-1", [entry("user", "after migration")]);
    } finally {
      reopened.close();
    }
    const listed = await withMaintenanceDatabase(home, (database) => listHistory(database, session.id, "agent-1"));
    assert.deepEqual(listed.map((row) => row.ordinal), [0]);
  } finally {
    await release();
  }
});
