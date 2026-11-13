import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireRuntimeHomeLock, bootstrapRuntimeHome } from "../../../agent-instance/runtime-home.js";
import type { Configuration } from "../../../agent-instance/config.js";
import { openDatabase, withMaintenanceDatabase, type RoleEquipRecord } from "../../../connectors/persistence/sqlite/legacy-database.js";
import { createSqliteOperationalStore } from "../../../connectors/persistence/sqlite/operational-store.js";

async function fixture(t: test.TestContext) {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-role-equips-"));
  const home = await bootstrapRuntimeHome(deployment);
  const database = openDatabase(home);
  const store = createSqliteOperationalStore(database);
  t.after(async () => {
    if (database.isOpen) await store.close();
    await rm(deployment, { recursive: true, force: true });
  });
  return { deployment, home, database, store };
}

const rows = (database: DatabaseSync) => database.prepare("SELECT * FROM role_equips ORDER BY id").all() as RoleEquipRecord[];
const roleSchema = (database: DatabaseSync) => (database.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name='role_equips' ORDER BY type, name").all() as Array<{ type: string; name: string; sql: string }>);

function assertRoleSchema(database: DatabaseSync): void {
  const objects = roleSchema(database);
  assert.deepEqual(objects.map(({ type, name }) => `${type}:${name}`), ["index:one_equipped_role", "table:role_equips"]);
  assert.match(objects[0]!.sql, /CREATE UNIQUE INDEX one_equipped_role ON role_equips\(\(unequipped_at IS NULL\)\) WHERE unequipped_at IS NULL/);
  const columns = (database.prepare("PRAGMA table_info(role_equips)").all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(columns, ["id", "role_id", "equipped_at", "equipped_by", "unequipped_at", "unequipped_by",
    "created_at", "created_by", "updated_at", "updated_by", "deleted_at", "deleted_by"]);
}

test("a fresh database has role_equips and the one-open-row index", async (t) => {
  const { database } = await fixture(t);
  assertRoleSchema(database);
});

test("an existing database from the previous schema gains role_equips and keeps its data", async (t) => {
  const { home, database, store } = await fixture(t);
  await store.createMemory({ body: "Keep me", source_message_id: null, created_by_user_id: null, review_id: null, origin: "manual" }, "test");
  await store.close();
  const legacy = new DatabaseSync(home.databaseFile);
  legacy.exec("DROP TABLE role_equips");
  assert.deepEqual(roleSchema(legacy), []);
  legacy.close();

  const upgraded = openDatabase(home);
  try {
    assertRoleSchema(upgraded);
    assert.deepEqual((upgraded.prepare("SELECT body FROM memories").all() as Array<{ body: string }>).map(({ body }) => body), ["Keep me"]);
  } finally {
    upgraded.close();
  }
  assert.equal(database.isOpen, false);
});

test("live maintenance still accepts a database that has not run the role_equips migration", async (t) => {
  const { home, store } = await fixture(t);
  await store.close();
  const legacy = new DatabaseSync(home.databaseFile);
  legacy.exec("DROP TABLE role_equips");
  legacy.close();
  const release = await acquireRuntimeHomeLock(home);
  try {
    assert.equal(await withMaintenanceDatabase(home, () => "ran"), "ran");
  } finally {
    await release();
  }
});

test("the index allows at most one open row", async (t) => {
  const { database } = await fixture(t);
  database.prepare("INSERT INTO role_equips (role_id, equipped_by) VALUES ('planner', 'test')").run();
  assert.throws(() => database.prepare("INSERT INTO role_equips (role_id, equipped_by) VALUES ('reviewer', 'test')").run(), /UNIQUE constraint failed/);
  database.prepare("INSERT INTO role_equips (role_id, equipped_by, unequipped_at, unequipped_by) VALUES ('reviewer', 'test', 1, 'test')").run();
  assert.equal(rows(database).length, 2);
});

test("equip from none, equip the same role, switch, and unequip keep exactly one open row and every row", async (t) => {
  const { database, store } = await fixture(t);
  assert.equal(await store.getEquippedRole!(), null);

  const first = await store.equipRole!("planner", "cli:owner");
  assert.equal(first.changed, true);
  assert.equal(first.previous, null);
  assert.equal(first.current.role_id, "planner");
  assert.equal(first.current.equipped_by, "cli:owner");
  assert.equal(first.current.created_by, "cli:owner");
  assert.equal(first.current.updated_by, "cli:owner");
  assert.equal(first.current.unequipped_at, null);
  assert.deepEqual(await store.getEquippedRole!(), first.current);

  const again = await store.equipRole!("planner", "discord:owner");
  assert.equal(again.changed, false);
  assert.deepEqual(again.previous, first.current);
  assert.deepEqual(again.current, first.current);
  assert.equal(rows(database).length, 1);
  assert.equal(rows(database)[0]!.updated_by, "cli:owner");

  const switched = await store.equipRole!("reviewer", "ui:owner");
  assert.equal(switched.changed, true);
  assert.equal(switched.previous?.id, first.current.id);
  assert.equal(switched.current.role_id, "reviewer");
  const [closed, open] = rows(database);
  assert.equal(closed!.role_id, "planner");
  assert.equal(typeof closed!.unequipped_at, "number");
  assert.equal(closed!.unequipped_by, "ui:owner");
  assert.equal(closed!.updated_by, "ui:owner");
  assert.equal(closed!.equipped_by, "cli:owner");
  assert.equal(open!.unequipped_at, null);
  assert.equal(open!.equipped_by, "ui:owner");
  assert.equal(rows(database).filter((row) => row.unequipped_at === null).length, 1);
  assert.equal((await store.getEquippedRole!())?.role_id, "reviewer");

  const unequipped = await store.unequipRole!("discord:owner");
  assert.equal(unequipped.changed, true);
  assert.equal(unequipped.previous?.role_id, "reviewer");
  assert.equal(await store.getEquippedRole!(), null);
  const all = rows(database);
  assert.equal(all.length, 2);
  assert.equal(all[1]!.unequipped_by, "discord:owner");
  assert.equal(all[1]!.updated_by, "discord:owner");
  assert(all.every((row) => row.deleted_at === null && row.deleted_by === null && row.unequipped_at !== null));
});

test("unequip with no role equipped writes nothing", async (t) => {
  const { database, store } = await fixture(t);
  const changes = () => (database.prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes;
  const before = changes();
  assert.deepEqual(await store.unequipRole!("cli:owner"), { changed: false, previous: null });
  assert.equal(changes(), before);
  assert.equal(rows(database).length, 0);

  await store.equipRole!("planner", "cli:owner");
  await store.unequipRole!("cli:owner");
  const closed = rows(database);
  const afterClose = changes();
  assert.deepEqual(await store.unequipRole!("ui:owner"), { changed: false, previous: null });
  assert.equal(changes(), afterClose);
  assert.deepEqual(rows(database), closed);
});

test("a failed switch rolls back and keeps the previous role equipped", async (t) => {
  const { database, store } = await fixture(t);
  await store.equipRole!("planner", "cli:owner");
  await assert.rejects(store.equipRole!("", "cli:owner"), /CHECK constraint failed/);
  assert.equal((await store.getEquippedRole!())?.role_id, "planner");
  assert.equal(rows(database).length, 1);
  assert.equal(rows(database)[0]!.unequipped_at, null);
});

test("role_applied records read back per Session, including a Session with no record", async (t) => {
  const { deployment, store } = await fixture(t);
  const owner = await store.bootstrapOwner({ discordGuildId: "guild", discordOwnerUserId: "owner" } as Configuration, "owner:test");
  const session = (conversation: string) => store.createSession({
    user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel",
    conversation_id: conversation, initiating_external_message_id: `starter-${conversation}`, agent_provider: "codex",
    agent_session_id: `agent-${conversation}`, project_path: deployment,
  }, "session:test");
  const first = await session("one");
  const second = await session("two");

  assert.equal(await store.lastAppliedRole!(first.id), undefined);

  const event = await store.recordRoleApplied!(first.id, "planner", "conversation-worker");
  assert.equal(event.event_type, "role_applied");
  assert.equal(event.detail, "role=planner");
  assert.equal(event.session_id, first.id);
  assert.equal(event.message_id, null);
  assert.equal(event.created_by, "conversation-worker");
  assert.deepEqual(await store.lastAppliedRole!(first.id), { roleId: "planner" });

  const none = await store.recordRoleApplied!(first.id, null, "conversation-worker");
  assert.equal(none.detail, "role=none");
  assert.deepEqual(await store.lastAppliedRole!(first.id), { roleId: null });

  await store.recordRoleApplied!(first.id, "reviewer", "task-runner");
  assert.deepEqual(await store.lastAppliedRole!(first.id), { roleId: "reviewer" });

  assert.equal(await store.lastAppliedRole!(second.id), undefined);
  await store.createEvent({ session_id: second.id, message_id: null, event_type: "turn_completed", detail: "role=planner" });
  assert.equal(await store.lastAppliedRole!(second.id), undefined);
});
