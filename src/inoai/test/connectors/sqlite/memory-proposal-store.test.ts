import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapRuntimeHome } from "../../../agent-instance/runtime-home.js";
import type { Configuration } from "../../../agent-instance/config.js";
import { listMemoryUses, normalizeMemoryBody, openDatabase, type NewMemoryProposal } from "../../../connectors/persistence/sqlite/legacy-database.js";
import { createSqliteOperationalStore } from "../../../connectors/persistence/sqlite/operational-store.js";

const now = Math.floor(Date.now() / 1000);
const week = 7 * 86_400;

async function fixture(t: test.TestContext) {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-memory-proposals-"));
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
    agent_session_id: "agent-thread", project_path: deployment,
  }, "session:test");
  const { message } = await store.archiveMessage({
    session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: "m1", external_author_id: "owner",
    user_id: owner.id, direction: "user", body: "I prefer short answers", reply_to_external_message_id: null, in_reply_to_message_id: null,
  }, "test");
  const review = await store.createMemoryReview({ session_id: session.id, from_message_id: message!.id, through_message_id: message!.id }, "test");
  const proposal = (overrides: Partial<NewMemoryProposal> = {}): NewMemoryProposal => ({
    body: "Prefers short answers", kind: "core", review_id: review.id, source_message_ids: [message!.id], expires_at: now + week, ...overrides,
  });
  return { home, database, store, session, message: message!, review, proposal };
}

test("normalizeMemoryBody lower-cases, trims, and collapses inner whitespace", () => {
  assert.equal(normalizeMemoryBody("  Prefers \t SHORT\n\nanswers  "), "prefers short answers");
});

test("a database from before Memory kinds migrates idempotently with existing Memories as topic", async (t) => {
  const { home, store } = await fixture(t);
  const memory = await store.createMemory({ body: "Old fact", source_message_id: null, created_by_user_id: null, review_id: null, origin: "manual" }, "test");
  await store.close();

  const legacy = new DatabaseSync(home.databaseFile);
  legacy.exec("DROP TABLE memory_uses; DROP TABLE memory_proposals; ALTER TABLE memories DROP COLUMN kind;");
  assert.equal((legacy.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).some(({ name }) => name === "kind"), false);
  const before = legacy.prepare("SELECT * FROM memories ORDER BY id").all();
  legacy.close();

  for (let open = 0; open < 2; open += 1) {
    const reopened = openDatabase(home);
    try {
      const rows = reopened.prepare("SELECT * FROM memories ORDER BY id").all() as Array<Record<string, unknown>>;
      assert.deepEqual(rows.map(({ kind: _kind, ...row }) => row), before.map((row) => ({ ...row })));
      assert.deepEqual(rows.map((row) => [row.id, row.kind]), [[memory.id, "topic"]]);
      for (const name of ["memory_proposals", "memory_uses", "pending_memory_proposals", "memory_uses_by_memory", "memory_uses_no_update", "memory_uses_no_delete"]) {
        assert.ok(reopened.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name), `missing ${name}`);
      }
      assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
      assert.throws(() => reopened.prepare("UPDATE memories SET kind='other' WHERE id=?").run(memory.id), /CHECK constraint/);
    } finally {
      reopened.close();
    }
  }
});

test("createMemory stores the given kind and defaults to topic", async (t) => {
  const { store } = await fixture(t);
  const base = { source_message_id: null, created_by_user_id: null, review_id: null, origin: "manual" as const };
  assert.equal((await store.createMemory({ ...base, body: "default" }, "test")).kind, "topic");
  assert.equal((await store.createMemory({ ...base, body: "always", kind: "core" }, "test")).kind, "core");
  assert.deepEqual((await store.listMemories()).map((memory) => memory.kind), ["topic", "core"]);
});

test("create, get, list pending, and set card message", async (t) => {
  const { store, review, message, proposal } = await fixture(t);
  const created = await store.createMemoryProposal!(proposal({ body: "  Prefers   Short answers " }), now, "memory-review");
  assert.deepEqual([created.body, created.normalized_body, created.kind, created.review_id, created.source_message_ids, created.state],
    ["Prefers   Short answers", "prefers short answers", "core", review.id, [message.id], "pending"]);
  assert.deepEqual([created.created_by, created.updated_by, created.created_at, created.answered_at, created.card_message_id, created.created_memory_id],
    ["memory-review", "memory-review", now, null, null, null]);
  assert.deepEqual(await store.getMemoryProposal!(created.id), created);
  const overdue = await store.createMemoryProposal!(proposal({ body: "old", expires_at: now }), now - week);
  assert.deepEqual((await store.listPendingMemoryProposals!(now)).map((row) => row.id), [created.id]);
  assert.equal(await store.setMemoryProposalCardMessage!(created.id, "card-1", now + 1), true);
  assert.equal((await store.getMemoryProposal!(created.id))!.card_message_id, "card-1");
  await store.rejectMemoryProposal!(created.id, now + 2);
  assert.equal(await store.setMemoryProposalCardMessage!(created.id, "card-2", now + 3), false);
  assert.equal((await store.getMemoryProposal!(created.id))!.card_message_id, "card-1");
  assert.equal((await store.getMemoryProposal!(overdue.id))!.state, "pending");
});

test("confirm creates the Memory with the proposed kind in the same transaction and answers once", async (t) => {
  const { database, store, review, message, proposal } = await fixture(t);
  const created = await store.createMemoryProposal!(proposal(), now);
  const confirmed = await store.confirmMemoryProposal!(created.id, now + 10, "discord:owner");
  assert.equal(confirmed.answered, true);
  assert.equal(confirmed.duplicate, false);
  assert.deepEqual([confirmed.memory!.body, confirmed.memory!.kind, confirmed.memory!.origin, confirmed.memory!.review_id, confirmed.memory!.source_message_id, confirmed.memory!.created_by],
    ["Prefers short answers", "core", "review", review.id, message.id, "discord:owner"]);
  assert.deepEqual([confirmed.proposal!.state, confirmed.proposal!.answered_at, confirmed.proposal!.created_memory_id, confirmed.proposal!.updated_by],
    ["confirmed", now + 10, confirmed.memory!.id, "discord:owner"]);
  assert.deepEqual((await store.listMemories()).map((memory) => memory.id), [confirmed.memory!.id]);

  for (const again of [await store.confirmMemoryProposal!(created.id, now + 20), await store.rejectMemoryProposal!(created.id, now + 20)]) {
    assert.equal(again.answered, false);
    assert.deepEqual([again.proposal!.state, again.proposal!.answered_at], ["confirmed", now + 10]);
  }
  assert.equal((await store.listMemories()).length, 1);

  // A failing Memory insert rolls back the proposal answer.
  const other = await store.createMemoryProposal!(proposal({ body: "Uses Helix" }), now);
  database.exec("CREATE TEMP TRIGGER fail_memory BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  await assert.rejects(store.confirmMemoryProposal!(other.id, now + 30), /boom/);
  database.exec("DROP TRIGGER fail_memory");
  assert.equal((await store.getMemoryProposal!(other.id))!.state, "pending");
});

test("confirm is a no-op when an active Memory has the same normalized body", async (t) => {
  const { store, proposal } = await fixture(t);
  const existing = await store.createMemory({ body: "prefers  SHORT answers", source_message_id: null, created_by_user_id: null, review_id: null, origin: "manual" }, "test");
  const created = await store.createMemoryProposal!(proposal(), now);
  const confirmed = await store.confirmMemoryProposal!(created.id, now + 1);
  assert.deepEqual([confirmed.answered, confirmed.duplicate, confirmed.memory!.id], [true, true, existing.id]);
  assert.deepEqual([confirmed.proposal!.state, confirmed.proposal!.created_memory_id], ["confirmed", null]);
  assert.deepEqual((await store.listMemories()).map((memory) => memory.id), [existing.id]);
});

test("reject records the rejection and the rejected-text lookup matches normalized text", async (t) => {
  const { store, proposal } = await fixture(t);
  const created = await store.createMemoryProposal!(proposal(), now);
  assert.equal(await store.wasMemoryProposalRejected!("prefers short answers"), false);
  const rejected = await store.rejectMemoryProposal!(created.id, now + 5, "discord:owner");
  assert.deepEqual([rejected.answered, rejected.proposal!.state, rejected.proposal!.answered_at, rejected.proposal!.updated_by],
    [true, "rejected", now + 5, "discord:owner"]);
  assert.equal(await store.wasMemoryProposalRejected!("  PREFERS short\nanswers "), true);
  assert.equal(await store.wasMemoryProposalRejected!("prefers long answers"), false);
  const again = await store.confirmMemoryProposal!(created.id, now + 6);
  assert.deepEqual([again.answered, again.proposal!.state], [false, "rejected"]);
  assert.deepEqual(await store.listMemories(), []);
});

test("due proposals expire, and an overdue proposal cannot be confirmed or rejected", async (t) => {
  const { store, proposal } = await fixture(t);
  const due = await store.createMemoryProposal!(proposal({ body: "due", expires_at: now + 10 }), now);
  const later = await store.createMemoryProposal!(proposal({ body: "later", expires_at: now + week }), now);
  const overdue = await store.createMemoryProposal!(proposal({ body: "overdue", expires_at: now + 10 }), now);

  const confirmed = await store.confirmMemoryProposal!(overdue.id, now + 10);
  assert.deepEqual([confirmed.answered, confirmed.proposal!.state, confirmed.proposal!.answered_at, confirmed.proposal!.updated_by],
    [false, "expired", now + 10, "system"]);
  assert.deepEqual(await store.listMemories(), []);

  const expired = await store.expireDueMemoryProposals!(now + 10);
  assert.deepEqual(expired.map((row) => [row.id, row.state, row.answered_at]), [[due.id, "expired", now + 10]]);
  assert.deepEqual(await store.expireDueMemoryProposals!(now + 11), []);
  assert.equal((await store.rejectMemoryProposal!(due.id, now + 12)).answered, false);
  assert.equal(await store.wasMemoryProposalRejected!("due"), false);
  assert.equal((await store.getMemoryProposal!(later.id))!.state, "pending");
});

test("memory_uses records a batch and its rows can never be updated or deleted", async (t) => {
  const { database, store, session, message } = await fixture(t);
  const a = await store.createMemory({ body: "a", source_message_id: null, created_by_user_id: null, review_id: null, origin: "manual", kind: "core" }, "test");
  const b = await store.createMemory({ body: "b", source_message_id: null, created_by_user_id: null, review_id: null, origin: "manual" }, "test");
  assert.equal(await store.recordMemoryUses!([], now), 0);
  assert.equal(await store.recordMemoryUses!([
    { memory_id: a.id, session_id: session.id, message_id: message.id, task_run_id: null },
    { memory_id: b.id, session_id: session.id, message_id: message.id, task_run_id: null },
  ], now, "conversation-worker"), 2);
  const rows = listMemoryUses(database);
  assert.deepEqual(rows.map((row) => [row.memory_id, row.session_id, row.message_id, row.task_run_id, row.created_at, row.created_by]),
    [[a.id, session.id, message.id, null, now, "conversation-worker"], [b.id, session.id, message.id, null, now, "conversation-worker"]]);
  assert.deepEqual(listMemoryUses(database, b.id).map((row) => row.id), [rows[1]!.id]);

  // A bad row rolls back the whole batch.
  await assert.rejects(store.recordMemoryUses!([
    { memory_id: a.id, session_id: session.id, message_id: message.id, task_run_id: null },
    { memory_id: a.id, session_id: session.id, message_id: null, task_run_id: null },
  ], now));
  assert.equal(listMemoryUses(database).length, 2);

  assert.throws(() => database.prepare("UPDATE memory_uses SET created_by='x'").run(), /append-only/);
  assert.throws(() => database.prepare("DELETE FROM memory_uses").run(), /append-only/);
  // Soft-deleting a Memory leaves its usage history intact.
  await store.softDeleteMemory(a.id, "test");
  assert.deepEqual(listMemoryUses(database), rows);
});
