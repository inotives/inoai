import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapRuntimeHome } from "../../../agent-instance/runtime-home.js";
import type { Configuration } from "../../../agent-instance/config.js";
import { claimTaskProposal, databaseBusyTimeoutMs, openDatabase, resolveTaskProposal, type NewTaskProposal } from "../../../connectors/persistence/sqlite/legacy-database.js";
import { createSqliteOperationalStore } from "../../../connectors/persistence/sqlite/operational-store.js";

const now = Math.floor(Date.now() / 1000);
const spec = JSON.stringify({ title: "Daily report", instruction: "Summarize news" });

async function fixture(t: test.TestContext) {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-task-proposals-"));
  const home = await bootstrapRuntimeHome(deployment);
  const database = openDatabase(home);
  const store = createSqliteOperationalStore(database);
  t.after(async () => {
    if (database.isOpen) await store.close();
    await rm(deployment, { recursive: true, force: true });
  });
  const owner = await store.bootstrapOwner({ discordGuildId: "guild", discordOwnerUserId: "owner" } as Configuration, "owner:test");
  const newSession = (conversation: string) => store.createSession({
    user_id: owner.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "channel",
    conversation_id: conversation, initiating_external_message_id: `starter-${conversation}`, agent_provider: "codex",
    agent_session_id: `agent-${conversation}`, project_path: deployment,
  }, "session:test");
  const session = await newSession("thread");
  const proposal = (overrides: Partial<NewTaskProposal> = {}): NewTaskProposal => ({
    session_id: session.id, transport: "discord", workspace_id: "guild", conversation_id: "thread",
    kind: "create", task_id: null, spec_json: spec, expires_at: now + 86_400, ...overrides,
  });
  return { home, database, store, session, newSession, proposal };
}

test("an existing home gains task_proposals idempotently without changing other tables", async (t) => {
  const { home, database, store, session } = await fixture(t);
  await store.createTask({ goal: "keep me", task_type: "one_time", conversation_id: "thread", session_id: session.id }, "task:create");
  await store.close();

  const legacy = new DatabaseSync(home.databaseFile);
  legacy.exec("DROP INDEX one_pending_task_proposal_per_conversation; DROP TABLE task_proposals;");
  const snapshot = (db: DatabaseSync) => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'task_proposals' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
    return JSON.stringify({
      schema: db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '%task_proposal%' ORDER BY name").all(),
      rows: tables.map((name) => db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()),
    });
  };
  const before = snapshot(legacy);
  legacy.close();

  for (let open = 0; open < 2; open += 1) {
    const reopened = openDatabase(home);
    try {
      assert.equal(snapshot(reopened), before);
      const names = (reopened.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%task_proposal%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
      assert.deepEqual(names, ["one_pending_task_proposal_per_conversation", "task_proposals"]);
      assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      reopened.close();
    }
  }
  assert.equal(database.isOpen, false);
});

test("creating a proposal expires the earlier pending proposal in the same conversation only", async (t) => {
  const { store, newSession, proposal } = await fixture(t);
  const other = await newSession("other-thread");
  const first = await store.createTaskProposal(proposal(), now, "discord:owner");
  assert.deepEqual([first.state, first.created_by, first.updated_by, first.resolved_at], ["pending", "discord:owner", "discord:owner", null]);
  const elsewhere = await store.createTaskProposal(proposal({ session_id: other.id, conversation_id: "other-thread" }), now);
  const second = await store.createTaskProposal(proposal({ spec_json: JSON.stringify({ title: "Revised" }) }), now + 5);

  const replaced = (await store.getTaskProposal(first.id))!;
  assert.deepEqual([replaced.state, replaced.resolved_at, replaced.updated_by, replaced.created_by], ["expired", now + 5, "system", "discord:owner"]);
  assert.equal((await store.getTaskProposal(second.id))!.state, "pending");
  assert.equal((await store.getTaskProposal(elsewhere.id))!.state, "pending");
  assert.equal((await store.resolveTaskProposal(first.id, "confirmed", now + 6)).resolved, false);
});

test("proposals reject a mismatched Session and inconsistent kind fields", async (t) => {
  const { store, database, session, proposal } = await fixture(t);
  await assert.rejects(store.createTaskProposal(proposal({ conversation_id: "elsewhere" }), now), /not active in its Conversation/);
  const task = await store.createTask({ goal: "existing", task_type: "one_time", conversation_id: "thread", session_id: session.id });
  await assert.rejects(store.createTaskProposal(proposal({ task_id: task.id }), now), /CHECK constraint/);
  await assert.rejects(store.createTaskProposal(proposal({ kind: "pause", spec_json: null }), now), /CHECK constraint/);
  await assert.rejects(store.createTaskProposal(proposal({ kind: "pause", task_id: task.id }), now), /CHECK constraint/);
  await assert.rejects(store.createTaskProposal(proposal({ spec_json: "{not json" }), now), /CHECK constraint/);
  const pause = await store.createTaskProposal(proposal({ kind: "pause", task_id: task.id, spec_json: null }), now);
  assert.equal(pause.kind, "pause");
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM task_proposals").get() as { count: number }).count, 1);
});

test("resolve is exactly once across repeats, concurrent calls, and connections", async (t) => {
  const { home, store, session, proposal } = await fixture(t);
  const task = await store.createTask({ goal: "made", task_type: "one_time", conversation_id: "thread", session_id: session.id });
  const created = await store.createTaskProposal(proposal(), now);
  assert.equal(await store.setTaskProposalCardMessage(created.id, "card-1", now + 1), true);

  const results = await Promise.all([
    store.resolveTaskProposal(created.id, "confirmed", now + 2, "discord:owner", task.id),
    store.resolveTaskProposal(created.id, "cancelled", now + 2),
  ]);
  assert.deepEqual(results.map(({ resolved }) => resolved), [true, false]);
  assert.deepEqual(results.map(({ proposal: row }) => row!.state), ["confirmed", "confirmed"]);
  const confirmed = (await store.getTaskProposal(created.id))!;
  assert.deepEqual([confirmed.state, confirmed.result_task_id, confirmed.resolved_at, confirmed.card_message_id, confirmed.updated_by],
    ["confirmed", task.id, now + 2, "card-1", "discord:owner"]);

  const repeated = await store.resolveTaskProposal(created.id, "failed", now + 3);
  assert.equal(repeated.resolved, false);
  assert.deepEqual(repeated.proposal, confirmed);
  assert.equal(await store.setTaskProposalCardMessage(created.id, "card-2", now + 3), false);

  const second = await store.createTaskProposal(proposal({ kind: "run", task_id: task.id, spec_json: null }), now + 4);
  const other = new DatabaseSync(home.databaseFile);
  try {
    other.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${databaseBusyTimeoutMs}`);
    const outcomes = [
      resolveTaskProposal(other, second.id, "cancelled", now + 5),
      (await store.resolveTaskProposal(second.id, "confirmed", now + 5, "discord:owner", task.id)),
      resolveTaskProposal(other, second.id, "failed", now + 5),
    ];
    assert.deepEqual(outcomes.map(({ resolved }) => resolved), [true, false, false]);
    assert.deepEqual(outcomes.map(({ proposal: row }) => row!.state), ["cancelled", "cancelled", "cancelled"]);
    assert.equal(outcomes[0]!.proposal!.result_task_id, null);
  } finally {
    other.close();
  }

  assert.deepEqual(await store.resolveTaskProposal(9999, "confirmed", now), { resolved: false, proposal: undefined });
});

test("an expired proposal cannot be confirmed and reports its expired state", async (t) => {
  const { store, proposal } = await fixture(t);
  const created = await store.createTaskProposal(proposal({ expires_at: now + 10 }), now);
  const late = await store.resolveTaskProposal(created.id, "confirmed", now + 10, "discord:owner", null);
  assert.equal(late.resolved, false);
  assert.deepEqual([late.proposal!.state, late.proposal!.resolved_at, late.proposal!.updated_by], ["expired", now + 10, "system"]);
  assert.equal((await store.resolveTaskProposal(created.id, "cancelled", now + 11)).proposal!.state, "expired");
});

test("overdue and per-session expiry change only pending proposals", async (t) => {
  const { store, newSession, proposal } = await fixture(t);
  const other = await newSession("other-thread");
  const overdue = await store.createTaskProposal(proposal({ expires_at: now + 10 }), now);
  const current = await store.createTaskProposal(proposal({ session_id: other.id, conversation_id: "other-thread", expires_at: now + 100 }), now);

  assert.equal(await store.expireOverdueTaskProposals(now + 10), 1);
  assert.deepEqual([(await store.getTaskProposal(overdue.id))!.state, (await store.getTaskProposal(overdue.id))!.updated_by], ["expired", "system"]);
  assert.equal((await store.getTaskProposal(current.id))!.state, "pending");
  assert.equal(await store.expireOverdueTaskProposals(now + 10), 0);

  const kept = await store.createTaskProposal(proposal({ expires_at: now + 100 }), now + 20);
  assert.equal(await store.resolveTaskProposal(kept.id, "cancelled", now + 21).then(({ resolved }) => resolved), true);
  const reset = await store.createTaskProposal(proposal({ expires_at: now + 100 }), now + 22);
  assert.equal(await store.expireSessionTaskProposals(other.id, now + 30), 1);
  assert.deepEqual([(await store.getTaskProposal(current.id))!.state, (await store.getTaskProposal(current.id))!.resolved_at], ["expired", now + 30]);
  assert.equal((await store.getTaskProposal(reset.id))!.state, "pending");
  assert.equal((await store.getTaskProposal(kept.id))!.state, "cancelled");
  assert.equal(await store.expireSessionTaskProposals(other.id, now + 31), 0);
});

test("startup expires overdue pending proposals and keeps current ones pending", async (t) => {
  const { home, store, newSession, proposal } = await fixture(t);
  const other = await newSession("other-thread");
  const overdue = await store.createTaskProposal(proposal({ expires_at: now - 60 }), now - 120);
  const current = await store.createTaskProposal(proposal({ session_id: other.id, conversation_id: "other-thread", expires_at: now + 3600 }), now);
  await store.close();

  const reopened = createSqliteOperationalStore(openDatabase(home));
  try {
    const expired = (await reopened.getTaskProposal(overdue.id))!;
    assert.deepEqual([expired.state, expired.updated_by, expired.created_by], ["expired", "system", "discord:owner"]);
    assert.ok(expired.resolved_at! >= now);
    assert.equal((await reopened.getTaskProposal(current.id))!.state, "pending");
  } finally {
    await reopened.close();
  }
});

// The T-0001 table, before `confirming` and `card_closed_at`.
const t0001TaskProposals = `CREATE TABLE task_proposals (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  transport TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create', 'edit', 'run', 'pause', 'resume', 'cancel')),
  task_id INTEGER REFERENCES tasks(id),
  spec_json TEXT CHECK (spec_json IS NULL OR json_valid(spec_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'confirmed', 'cancelled', 'expired', 'failed')),
  expires_at INTEGER NOT NULL,
  card_message_id TEXT,
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
  CHECK ((state = 'pending' AND resolved_at IS NULL) OR (state != 'pending' AND resolved_at IS NOT NULL)),
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_task_proposal_per_conversation ON task_proposals(transport, workspace_id, conversation_id)
  WHERE state = 'pending' AND deleted_at IS NULL;`;

test("an existing T-0001 home gains the confirming state without data loss", async (t) => {
  const { home, store, session, newSession } = await fixture(t);
  const task = await store.createTask({ goal: "made", task_type: "one_time", conversation_id: "thread", session_id: session.id });
  const other = await newSession("other-thread");
  await store.close();
  const legacy = new DatabaseSync(home.databaseFile);
  legacy.exec(`DROP INDEX one_pending_task_proposal_per_conversation; DROP TABLE task_proposals; ${t0001TaskProposals}`);
  legacy.prepare(`INSERT INTO task_proposals (session_id,transport,workspace_id,conversation_id,kind,task_id,spec_json,state,expires_at,
    card_message_id,resolved_at,result_task_id,created_at,created_by,updated_at,updated_by) VALUES
    (?,'discord','guild','thread','create',NULL,?,'confirmed',?,'card-1',?,?,?,'discord:owner',?,'discord:owner'),
    (?,'discord','guild','other-thread','pause',?,NULL,'pending',?,'card-2',NULL,NULL,?,'discord:owner',?,'discord:owner')`)
    .run(session.id, spec, now + 86_400, now + 5, task.id, now, now + 5, other.id, task.id, now + 86_400, now, now);
  const rows = legacy.prepare("SELECT * FROM task_proposals ORDER BY id").all();
  legacy.close();

  for (let open = 0; open < 2; open += 1) {
    const reopened = openDatabase(home);
    try {
      const migrated = reopened.prepare("SELECT * FROM task_proposals ORDER BY id").all() as Array<Record<string, unknown>>;
      assert.deepEqual(migrated.map(({ card_closed_at: _closed, ...row }) => row), rows.map((row) => ({ ...row })));
      assert.deepEqual(migrated.map((row) => row.card_closed_at), [null, null]);
      const table = reopened.prepare("SELECT sql FROM sqlite_master WHERE name='task_proposals'").get() as { sql: string };
      assert.match(table.sql, /'confirming'/);
      assert.ok(reopened.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='one_pending_task_proposal_per_conversation'").get());
      assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      reopened.close();
    }
  }
  const migratedStore = createSqliteOperationalStore(openDatabase(home));
  try {
    const claimed = await migratedStore.claimTaskProposal(2, now + 10);
    assert.deepEqual([claimed.claimed, claimed.proposal!.state, claimed.proposal!.resolved_at], [true, "confirming", null]);
    await assert.rejects(migratedStore.createTaskProposal({ session_id: other.id, transport: "discord", workspace_id: "guild",
      conversation_id: "other-thread", kind: "run", task_id: task.id, spec_json: "{}", expires_at: now + 100 }, now + 11), /CHECK constraint/);
  } finally {
    await migratedStore.close();
  }
});

test("claim moves pending to confirming once, and finish ends it once with events", async (t) => {
  const { home, store, session, proposal } = await fixture(t);
  const task = await store.createTask({ goal: "made", task_type: "one_time", conversation_id: "thread", session_id: session.id });
  const created = await store.createTaskProposal(proposal(), now);
  const results = await Promise.all([store.claimTaskProposal(created.id, now + 1), store.claimTaskProposal(created.id, now + 1)]);
  assert.deepEqual(results.map(({ claimed }) => claimed), [true, false]);
  const other = new DatabaseSync(home.databaseFile);
  try {
    other.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${databaseBusyTimeoutMs}`);
    assert.equal(claimTaskProposal(other, created.id, now + 1).claimed, false);
  } finally {
    other.close();
  }
  const claimed = (await store.getTaskProposal(created.id))!;
  assert.deepEqual([claimed.state, claimed.resolved_at, claimed.updated_by], ["confirming", null, "discord:owner"]);
  assert.equal((await store.resolveTaskProposal(created.id, "cancelled", now + 2)).resolved, false);
  assert.equal((await store.expireOverdueTaskProposals(now + 100_000)), 0);
  assert.equal((await store.getTaskProposal(created.id))!.state, "confirming");

  const finished = await store.finishTaskProposal(created.id, "confirmed", now + 3, "discord:owner", task.id);
  assert.deepEqual([finished.finished, finished.proposal!.state, finished.proposal!.result_task_id, finished.proposal!.resolved_at],
    [true, "confirmed", task.id, now + 3]);
  assert.equal((await store.finishTaskProposal(created.id, "failed", now + 4)).finished, false);

  const failing = await store.createTaskProposal(proposal(), now + 5);
  await store.claimTaskProposal(failing.id, now + 6);
  await store.finishTaskProposal(failing.id, "failed", now + 7, "discord:owner", task.id, "thread_failed");
  assert.equal((await store.getTaskProposal(failing.id))!.result_task_id, null);
  const events = (await store.listEvents(session.id)).filter((event) => event.event_type.startsWith("task_proposal_"));
  assert.deepEqual(events.map((event) => [event.event_type, event.detail]), [
    ["task_proposal_confirmed", `proposal=${created.id}; kind=create; task=${task.id}`],
    ["task_proposal_failed", `proposal=${failing.id}; kind=create; task=new; reason=thread_failed`],
  ]);
});

test("claim expires an overdue proposal or one whose Session is no longer active", async (t) => {
  const { database, store, newSession, proposal } = await fixture(t);
  const overdue = await store.createTaskProposal(proposal({ expires_at: now + 10 }), now);
  const late = await store.claimTaskProposal(overdue.id, now + 10);
  assert.deepEqual([late.claimed, late.proposal!.state, late.proposal!.updated_by], [false, "expired", "system"]);

  const other = await newSession("other-thread");
  const orphan = await store.createTaskProposal(proposal({ session_id: other.id, conversation_id: "other-thread" }), now);
  database.prepare("UPDATE sessions SET state='ended', ended_at=? WHERE id=?").run(now, other.id);
  const inactive = await store.claimTaskProposal(orphan.id, now + 1);
  assert.deepEqual([inactive.claimed, inactive.proposal!.state, inactive.proposal!.resolved_at], [false, "expired", now + 1]);
  const events = (await store.listEvents()).filter((event) => event.event_type === "task_proposal_expired").map((event) => event.detail);
  assert.deepEqual(events, [`proposal=${overdue.id}; kind=create; task=new; reason=overdue`,
    `proposal=${orphan.id}; kind=create; task=new; reason=session_inactive`]);
});

test("reset expires the Session's pending proposals in its transaction", async (t) => {
  const { store, session, newSession, proposal } = await fixture(t);
  const other = await newSession("other-thread");
  const pending = await store.createTaskProposal(proposal(), now);
  const elsewhere = await store.createTaskProposal(proposal({ session_id: other.id, conversation_id: "other-thread" }), now);
  assert.equal(await store.resetSession(session.id, "user:owner"), true);
  const expired = (await store.getTaskProposal(pending.id))!;
  assert.deepEqual([expired.state, expired.updated_by], ["expired", "system"]);
  assert.equal((await store.getTaskProposal(elsewhere.id))!.state, "pending");
  assert.deepEqual((await store.listEvents(session.id)).filter((event) => event.event_type === "task_proposal_expired").map((event) => event.detail),
    [`proposal=${pending.id}; kind=create; task=new; reason=reset`]);
  assert.equal((await store.claimTaskProposal(pending.id, now + 1)).claimed, false);
});

test("startup fails leftover confirming proposals and lists resolved cards until they are closed", async (t) => {
  const { home, store, proposal } = await fixture(t);
  const stuck = await store.createTaskProposal(proposal(), now);
  await store.setTaskProposalCardMessage(stuck.id, "card-1", now);
  await store.claimTaskProposal(stuck.id, now + 1);
  const replacing = await store.createTaskProposal(proposal(), now + 2);
  await store.setTaskProposalCardMessage(replacing.id, "card-2", now + 2);
  const newest = await store.createTaskProposal(proposal(), now + 3);
  await store.close();

  const reopened = createSqliteOperationalStore(openDatabase(home));
  try {
    const failed = (await reopened.getTaskProposal(stuck.id))!;
    assert.deepEqual([failed.state, failed.updated_by], ["failed", "system"]);
    assert.ok(failed.resolved_at! >= now);
    assert.equal((await reopened.getTaskProposal(newest.id))!.state, "pending");
    const cards = await reopened.listOpenTaskProposalCards();
    assert.deepEqual(cards.map((card) => [card.id, card.state, card.card_message_id, card.replaced]),
      [[stuck.id, "failed", "card-1", false], [replacing.id, "expired", "card-2", true]]);
    assert.equal(await reopened.closeTaskProposalCard(stuck.id, now + 4), true);
    assert.equal(await reopened.closeTaskProposalCard(stuck.id, now + 5), false);
    assert.equal(await reopened.closeTaskProposalCard(newest.id, now + 5), false);
    assert.deepEqual((await reopened.listOpenTaskProposalCards()).map((card) => card.id), [replacing.id]);
    assert.ok((await reopened.listEvents()).some((event) => event.event_type === "task_proposal_failed"
      && event.detail === `proposal=${stuck.id}; kind=create; task=new; reason=restart`));
  } finally {
    await reopened.close();
  }
});
