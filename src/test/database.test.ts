import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  archiveMessage,
  archiveResponseChunks,
  bootstrapOwner,
  claimNextMessage,
  claimResponseChunk,
  completeMemoryReview,
  completeMessageWithResponse,
  confirmResponseChunk,
  createEvent,
  createMemory,
  createMemoryReview,
  createSession,
  databaseBusyTimeoutMs,
  failResponseChunk,
  listPendingResponseChunks,
  listMemories,
  listMessages,
  messagesForMemoryReview,
  openDatabase,
  markRuntimeStarted,
  resetSession,
  softDeleteMemory,
  softDeleteMessage,
  UnsafeDatabasePathError,
  upsertUser,
} from "../database.js";
import { validateConfiguration } from "../config.js";
import { bootstrapRuntimeHome } from "../runtime-home.js";

test("opens the selected runtime database with WAL and a bounded busy timeout", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    try {
      const journal = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      const timeout = database.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      assert.equal(journal.journal_mode, "wal");
      assert.equal(timeout.timeout, databaseBusyTimeoutMs);
    } finally {
      database.close();
    }
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("recovery requeues only pre-runtime work and fails post-start work once", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const database = openDatabase(home);
    const user = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
    const session = createSession(database, { user_id: user.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "parent", conversation_id: "thread", initiating_external_message_id: "start", agent_provider: "codex", agent_session_id: "agent-session", project_path: deployment });
    const inbound = (id: string) => archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: id, external_author_id: "owner", user_id: user.id, direction: "user", body: id, reply_to_external_message_id: null, in_reply_to_message_id: null }).message!;
    const first = inbound("one");
    const second = inbound("two");
    assert.equal(claimNextMessage(database, "global")?.id, first.id);
    assert.equal(markRuntimeStarted(database, first.id), true);
    assert.equal(markRuntimeStarted(database, first.id), false);
    database.close();

    const restarted = openDatabase(home);
    const failed = restarted.prepare("SELECT * FROM messages WHERE id = ?").get(first.id) as typeof first;
    assert.equal(failed.state, "failed");
    assert.match(failed.failure_detail!, /uncertain/);
    assert.equal(claimNextMessage(restarted, "global")?.id, second.id);
    restarted.close();
    const again = openDatabase(home);
    assert.equal((again.prepare("SELECT state FROM messages WHERE id = ?").get(first.id) as { state: string }).state, "failed");
    assert.equal((again.prepare("SELECT agent_session_id FROM sessions WHERE id = ?").get(session.id) as { agent_session_id: string }).agent_session_id, "agent-session");
    again.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("response chunks are archived before send and uncertain chunks are never reclaimed", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const database = openDatabase(home);
    const user = upsertUser(database, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
    const session = createSession(database, { user_id: user.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "parent", conversation_id: "thread", initiating_external_message_id: "start", agent_provider: "codex", agent_session_id: "agent-session", project_path: deployment });
    const inbound = (id: string) => archiveMessage(database, { session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: id, external_author_id: "owner", user_id: user.id, direction: "user", body: id, reply_to_external_message_id: null, in_reply_to_message_id: null }).message!;
    const first = inbound("one");
    assert.equal(claimNextMessage(database, "global")?.id, first.id);
    assert.equal(archiveResponseChunks(database, first.id, ["too early"]), undefined);
    assert.equal(markRuntimeStarted(database, first.id), true);
    const [confirmed, failed, uncertain, pending] = archiveResponseChunks(database, first.id, ["first", "second", "third", "fourth"])!;
    assert.ok(confirmed && failed && uncertain && pending);
    assert.deepEqual([confirmed, failed, uncertain, pending].map((row) => row.external_message_id), [null, null, null, null]);
    assert.equal(new Set([confirmed, failed, uncertain, pending].map((row) => row.provisional_id)).size, 4);
    assert.equal(claimResponseChunk(database, confirmed.id), true);
    assert.equal(confirmResponseChunk(database, confirmed.id, "discord-response"), true);
    assert.equal(claimResponseChunk(database, failed.id), true);
    assert.equal(failResponseChunk(database, failed.id, "Known transport failure"), true);
    assert.equal(claimResponseChunk(database, uncertain.id), true);
    assert.equal(claimResponseChunk(database, uncertain.id), false);
    assert.deepEqual(listPendingResponseChunks(database).map((row) => row.id), [pending.id]);
    database.close();

    const reopened = openDatabase(home);
    assert.deepEqual(listMessages(reopened, session.id).filter((row) => row.direction === "agent").map((row) => [row.body, row.delivery_state, row.external_message_id]), [
      ["first", "confirmed", "discord-response"], ["second", "failed", null], ["third", "uncertain", null], ["fourth", "pending", null],
    ]);
    assert.deepEqual(listPendingResponseChunks(reopened).map((row) => row.id), [pending.id]);
    const second = archiveMessage(reopened, { session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: "two", external_author_id: "owner", user_id: user.id, direction: "user", body: "two", reply_to_external_message_id: null, in_reply_to_message_id: null }).message!;
    assert.equal(claimNextMessage(reopened, "global")?.id, second.id);
    assert.equal(markRuntimeStarted(reopened, second.id), true);
    const queued = archiveMessage(reopened, { session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: "three", external_author_id: "owner", user_id: user.id, direction: "user", body: "three", reply_to_external_message_id: null, in_reply_to_message_id: null }).message!;
    assert.equal(resetSession(reopened, session.id), true);
    assert.equal(resetSession(reopened, session.id), false);
    assert.equal((reopened.prepare("SELECT state, failure_detail FROM messages WHERE id = ?").get(second.id) as { state: string; failure_detail: string }).state, "failed");
    assert.equal((reopened.prepare("SELECT state FROM messages WHERE id = ?").get(queued.id) as { state: string }).state, "failed");
    assert.equal((reopened.prepare("SELECT state FROM sessions WHERE id = ?").get(session.id) as { state: string }).state, "ended");
    assert.deepEqual(listPendingResponseChunks(reopened), []);
    assert.equal((reopened.prepare("SELECT delivery_state FROM messages WHERE id = ?").get(pending.id) as { delivery_state: string }).delivery_state, "failed");
    const late = archiveMessage(reopened, { session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: "late", external_author_id: "owner", user_id: user.id, direction: "user", body: "late", reply_to_external_message_id: null, in_reply_to_message_id: null });
    assert.equal(late.inserted, true);
    assert.equal(late.message?.state, "failed");
    assert.match(late.message!.failure_detail!, /reset/);
    assert.equal(archiveMessage(reopened, { session_id: session.id, transport: "discord", workspace_id: "guild", external_message_id: "late", external_author_id: "owner", user_id: user.id, direction: "user", body: "late", reply_to_external_message_id: null, in_reply_to_message_id: null }).inserted, false);
    assert.equal(claimNextMessage(reopened, "global"), undefined);
    reopened.prepare("UPDATE messages SET state = 'pending' WHERE id = ?").run(late.message!.id);
    assert.equal(claimNextMessage(reopened, "global"), undefined);
    assert.equal(listMessages(reopened, session.id).length, 8);
    reopened.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("migrates a legacy archive without losing message or approval references", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const current = openDatabase(home);
    const user = upsertUser(current, { transport: "discord", workspace_id: "guild", external_user_id: "owner", display_name: null, role: "owner", state: "active" })!;
    const session = createSession(current, { user_id: user.id, transport: "discord", workspace_id: "guild", parent_conversation_id: "parent", conversation_id: "thread", initiating_external_message_id: "start", agent_provider: "codex", agent_session_id: "agent-session", project_path: deployment });
    current.close();

    const legacy = new DatabaseSync(home.databaseFile);
    legacy.exec(`PRAGMA foreign_keys = OFF;
      DROP TABLE messages;
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id), transport TEXT NOT NULL,
        workspace_id TEXT NOT NULL, external_message_id TEXT NOT NULL, external_author_id TEXT,
        user_id INTEGER REFERENCES users(id), direction TEXT NOT NULL CHECK (direction IN ('user', 'agent')),
        body TEXT NOT NULL, reply_to_external_message_id TEXT, in_reply_to_message_id INTEGER REFERENCES messages(id),
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
        failure_detail TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), created_by TEXT NOT NULL DEFAULT 'system',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_by TEXT NOT NULL DEFAULT 'system',
        started_at INTEGER, completed_at INTEGER, deleted_at INTEGER, deleted_by TEXT,
        CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
      );
      INSERT INTO messages (id, session_id, transport, workspace_id, external_message_id, direction, body, state)
        VALUES (1, ${session.id}, 'discord', 'guild', 'inbound', 'user', 'original request', 'completed');
      INSERT INTO messages (id, session_id, transport, workspace_id, external_message_id, direction, body, state, in_reply_to_message_id)
        VALUES (2, ${session.id}, 'discord', 'guild', 'answer', 'agent', 'original answer', 'completed', 1);
      INSERT INTO approvals (session_id, runtime_approval_id, request_message_id, summary, expires_at, state)
        VALUES (${session.id}, 'approval', 2, 'old preview', 1, 'failed');`);
    legacy.close();

    const migrated = openDatabase(home);
    const rows = listMessages(migrated, session.id);
    assert.deepEqual(rows.map((row) => [row.id, row.external_message_id, row.in_reply_to_message_id, row.delivery_state]), [
      [1, "inbound", null, null], [2, "answer", 1, "confirmed"],
    ]);
    assert.equal((migrated.prepare("SELECT request_message_id FROM approvals WHERE runtime_approval_id = 'approval'").get() as { request_message_id: number }).request_message_id, 2);
    assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    migrated.close();
    openDatabase(home).close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("creates the documented v1 schema safely on each open", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const database = openDatabase(home);
    try {
      const objects = database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as Array<{ name: string }>;
      const names = new Set(objects.map(({ name }) => name));
      for (const name of [
        "users", "sessions", "messages", "events", "memories", "memory_reviews", "approvals",
        "one_active_session_per_conversation", "unique_initiating_message", "unique_agent_session",
        "unique_external_message", "pending_user_messages", "messages_by_session", "events_by_session",
        "pending_approvals_by_session", "due_memory_reviews", "active_memories",
      ]) assert.ok(names.has(name), `missing ${name}`);
    } finally {
      database.close();
    }
    openDatabase(home).close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("rejects database paths outside the selected runtime home", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    assert.throws(() => openDatabase({ ...home, databaseFile: join(deployment, "outside.sqlite") }), UnsafeDatabasePathError);
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("bootstraps one active configured owner across restarts", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const configuration = validateConfiguration({
       DISCORD_BOT_TOKEN: "token", DISCORD_GUILD_ID: "guild", DISCORD_OWNER_USER_ID: "owner", DISCORD_STATUS_CHANNEL_ID: "channel",
      CHAT_PROVIDER: "discord", AGENT_PROVIDER: "codex", MEMORY_REVIEW_TIME: "06:00", MEMORY_REVIEW_MAX_CHARS: "20000",
    });
    const database = openDatabase(home);
    const first = bootstrapOwner(database, configuration);
    database.close();
    const reopened = openDatabase(home);
    const second = bootstrapOwner(reopened, configuration);
    const owners = reopened.prepare("SELECT id, external_user_id FROM users WHERE transport = 'discord' AND workspace_id = 'guild' AND role = 'owner' AND state = 'active' AND deleted_at IS NULL").all() as Array<{ id: number; external_user_id: string }>;
    assert.equal(first.id, second.id);
    assert.equal(owners.length, 1);
    assert.equal(owners[0]?.id, first.id);
    assert.equal(owners[0]?.external_user_id, "owner");
    reopened.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("bootstrap reactivates a soft-deleted configured owner", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    const configuration = validateConfiguration({
       DISCORD_BOT_TOKEN: "token", DISCORD_GUILD_ID: "guild", DISCORD_OWNER_USER_ID: "owner", DISCORD_STATUS_CHANNEL_ID: "channel",
      CHAT_PROVIDER: "discord", AGENT_PROVIDER: "codex", MEMORY_REVIEW_TIME: "06:00", MEMORY_REVIEW_MAX_CHARS: "20000",
    });
    const first = bootstrapOwner(database, configuration);
    database.prepare("UPDATE users SET deleted_at = unixepoch(), deleted_by = 'test' WHERE id = ?").run(first.id);
    const restored = bootstrapOwner(database, configuration);
    const owners = database.prepare("SELECT id FROM users WHERE transport = 'discord' AND workspace_id = 'guild' AND role = 'owner' AND state = 'active' AND deleted_at IS NULL").all() as Array<{ id: number }>;
    assert.equal(restored.id, first.id);
    assert.equal(owners.length, 1);
    assert.equal(owners[0]?.id, first.id);
    database.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("bootstrap disables a replaced configured owner", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    const first = validateConfiguration({
       DISCORD_BOT_TOKEN: "token", DISCORD_GUILD_ID: "guild", DISCORD_OWNER_USER_ID: "first", DISCORD_STATUS_CHANNEL_ID: "channel",
      CHAT_PROVIDER: "discord", AGENT_PROVIDER: "codex", MEMORY_REVIEW_TIME: "06:00", MEMORY_REVIEW_MAX_CHARS: "20000",
    });
    const second = validateConfiguration({
       DISCORD_BOT_TOKEN: "token", DISCORD_GUILD_ID: "guild", DISCORD_OWNER_USER_ID: "second", DISCORD_STATUS_CHANNEL_ID: "channel",
      CHAT_PROVIDER: "discord", AGENT_PROVIDER: "codex", MEMORY_REVIEW_TIME: "06:00", MEMORY_REVIEW_MAX_CHARS: "20000",
    });
    bootstrapOwner(database, first);
    const active = bootstrapOwner(database, second);
    const owners = (database.prepare("SELECT external_user_id, state FROM users WHERE transport = 'discord' AND workspace_id = 'guild' AND role = 'owner' AND deleted_at IS NULL ORDER BY external_user_id").all() as Array<{ external_user_id: string; state: string }>).map(({ external_user_id, state }) => ({ external_user_id, state }));
    assert.equal(active.external_user_id, "second");
    assert.deepEqual(owners, [
      { external_user_id: "first", state: "disabled" },
      { external_user_id: "second", state: "active" },
    ]);
    database.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("archives records durably, filters soft deletes, and deduplicates messages", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const database = openDatabase(home);
    const user = upsertUser(database, {
      transport: "discord", workspace_id: "workspace", external_user_id: "owner", display_name: "Owner", role: "owner", state: "active",
    }, "user:owner")!;
    const session = createSession(database, {
      user_id: user.id, transport: "discord", workspace_id: "workspace", parent_conversation_id: "parent", conversation_id: "conversation",
      initiating_external_message_id: "start", agent_provider: "codex", agent_session_id: "session", project_path: deployment,
    }, "transport:discord");
    const first = archiveMessage(database, {
      session_id: session.id, transport: "discord", workspace_id: "workspace", external_message_id: "one", external_author_id: "owner",
      user_id: user.id, direction: "user", body: "first", reply_to_external_message_id: null, in_reply_to_message_id: null,
    }, "user:owner");
    const duplicate = archiveMessage(database, {
      session_id: session.id, transport: "discord", workspace_id: "workspace", external_message_id: "one", external_author_id: "owner",
      user_id: user.id, direction: "user", body: "first again", reply_to_external_message_id: null, in_reply_to_message_id: null,
    }, "user:owner");
    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(listMessages(database, session.id).length, 1);
    const event = createEvent(database, { session_id: session.id, message_id: first.message!.id, event_type: "received", detail: null }, "transport:discord");
    const memory = createMemory(database, { body: "durable", source_message_id: first.message!.id, created_by_user_id: user.id, review_id: null, origin: "manual" }, "user:owner");
    for (const record of [session, first.message!, event, memory]) {
      assert.ok(record.created_at);
      assert.ok(record.created_by);
      assert.ok(record.updated_at);
      assert.ok(record.updated_by);
      assert.equal(record.deleted_at, null);
      assert.equal(record.deleted_by, null);
    }
    softDeleteMemory(database, memory.id, "user:owner");
    softDeleteMessage(database, first.message!.id, "user:owner");
    assert.deepEqual(listMessages(database, session.id), []);
    assert.deepEqual(listMemories(database), []);
    database.close();
    const reopened = openDatabase(home);
    assert.equal((reopened.prepare("SELECT count(*) AS count FROM messages").get() as { count: number }).count, 1);
    assert.equal((reopened.prepare("SELECT count(*) AS count FROM memories").get() as { count: number }).count, 1);
    reopened.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("selects only messages newer than the latest completed memory review", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    const user = upsertUser(database, {
      transport: "discord", workspace_id: "workspace", external_user_id: "owner", display_name: null, role: "owner", state: "active",
    })!;
    const session = createSession(database, {
      user_id: user.id, transport: "discord", workspace_id: "workspace", parent_conversation_id: "parent", conversation_id: "conversation",
      initiating_external_message_id: "start", agent_provider: "codex", agent_session_id: "session", project_path: deployment,
    });
    const message = (externalMessageId: string) => archiveMessage(database, {
      session_id: session.id, transport: "discord", workspace_id: "workspace", external_message_id: externalMessageId, external_author_id: "owner",
      user_id: user.id, direction: "user", body: externalMessageId, reply_to_external_message_id: null, in_reply_to_message_id: null,
    }).message!;
    const first = message("one");
    const second = message("two");
    const review = createMemoryReview(database, { session_id: session.id, from_message_id: first.id, through_message_id: second.id });
    assert.ok(review.created_at);
    assert.equal(review.deleted_at, null);
    assert.equal(messagesForMemoryReview(database, session.id).length, 2);
    completeMemoryReview(database, review.id, "recap");
    const third = message("three");
    assert.deepEqual(messagesForMemoryReview(database, session.id).map(({ id }) => id), [third.id]);
    database.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("keeps the memory review cursor monotonic when an older pending review completes later", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    const user = upsertUser(database, {
      transport: "discord", workspace_id: "workspace", external_user_id: "owner", display_name: null, role: "owner", state: "active",
    })!;
    const session = createSession(database, {
      user_id: user.id, transport: "discord", workspace_id: "workspace", parent_conversation_id: "parent", conversation_id: "conversation",
      initiating_external_message_id: "start", agent_provider: "codex", agent_session_id: "session", project_path: deployment,
    });
    const message = (externalMessageId: string) => archiveMessage(database, {
      session_id: session.id, transport: "discord", workspace_id: "workspace", external_message_id: externalMessageId, external_author_id: "owner",
      user_id: user.id, direction: "user", body: externalMessageId, reply_to_external_message_id: null, in_reply_to_message_id: null,
    }).message!;
    const first = message("one");
    const second = message("two");
    const third = message("three");
    const older = createMemoryReview(database, { session_id: session.id, from_message_id: first.id, through_message_id: second.id });
    const newer = createMemoryReview(database, { session_id: session.id, from_message_id: first.id, through_message_id: third.id });
    completeMemoryReview(database, newer.id, "newer recap");
    completeMemoryReview(database, older.id, "older recap");
    assert.deepEqual(messagesForMemoryReview(database, session.id), []);
    assert.throws(() => createMemoryReview(database, {
      session_id: session.id, from_message_id: third.id, through_message_id: third.id,
    }), RangeError);
    database.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("rejects memory review boundaries from another session", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    const user = upsertUser(database, {
      transport: "discord", workspace_id: "workspace", external_user_id: "owner", display_name: null, role: "owner", state: "active",
    })!;
    const session = (conversation: string) => createSession(database, {
      user_id: user.id, transport: "discord", workspace_id: "workspace", parent_conversation_id: conversation, conversation_id: conversation,
      initiating_external_message_id: `${conversation}-start`, agent_provider: "codex", agent_session_id: conversation, project_path: deployment,
    });
    const firstSession = session("first");
    const secondSession = session("second");
    const message = (target: typeof firstSession, externalMessageId: string) => archiveMessage(database, {
      session_id: target.id, transport: "discord", workspace_id: "workspace", external_message_id: externalMessageId, external_author_id: "owner",
      user_id: user.id, direction: "user", body: externalMessageId, reply_to_external_message_id: null, in_reply_to_message_id: null,
    }).message!;
    const first = message(firstSession, "first-one");
    const pending = message(firstSession, "first-two");
    const otherSession = message(secondSession, "second-one");
    assert.throws(() => createMemoryReview(database, {
      session_id: firstSession.id, from_message_id: first.id, through_message_id: otherSession.id,
    }), RangeError);
    assert.deepEqual(messagesForMemoryReview(database, firstSession.id).map(({ id }) => id), [first.id, pending.id]);
    database.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("claims oldest pending messages once per session and finalizes responses atomically", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    const user = upsertUser(database, {
      transport: "discord", workspace_id: "workspace", external_user_id: "owner", display_name: null, role: "owner", state: "active",
    })!;
    const session = (conversation: string) => createSession(database, {
      user_id: user.id, transport: "discord", workspace_id: "workspace", parent_conversation_id: conversation, conversation_id: conversation,
      initiating_external_message_id: `${conversation}-start`, agent_provider: "codex", agent_session_id: conversation, project_path: deployment,
    });
    const firstSession = session("first");
    const secondSession = session("second");
    const message = (target: typeof firstSession, externalMessageId: string) => archiveMessage(database, {
      session_id: target.id, transport: "discord", workspace_id: "workspace", external_message_id: externalMessageId, external_author_id: "owner",
      user_id: user.id, direction: "user", body: externalMessageId, reply_to_external_message_id: null, in_reply_to_message_id: null,
    }).message!;
    const first = message(firstSession, "first-one");
    const second = message(firstSession, "first-two");
    const independent = message(secondSession, "second-one");

    assert.equal(claimNextMessage(database, "per-session")?.id, first.id);
    assert.equal(claimNextMessage(database, "per-session")?.id, independent.id);
    assert.equal(claimNextMessage(database, "per-session"), undefined);
    const completed = completeMessageWithResponse(database, first.id, {
      transport: "discord", workspace_id: "workspace", external_message_id: "first-response", external_author_id: null,
      user_id: null, body: "response", reply_to_external_message_id: null,
    });
    assert.equal(completed?.message.state, "completed");
    assert.equal(completed?.response.in_reply_to_message_id, first.id);
    assert.equal(completed?.response.state, "completed");
    assert.equal(claimNextMessage(database, "per-session")?.id, second.id);
    database.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("falls back to a single global FIFO queue", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const database = openDatabase(await bootstrapRuntimeHome(deployment));
    const user = upsertUser(database, {
      transport: "discord", workspace_id: "workspace", external_user_id: "owner", display_name: null, role: "owner", state: "active",
    })!;
    const session = (conversation: string) => createSession(database, {
      user_id: user.id, transport: "discord", workspace_id: "workspace", parent_conversation_id: conversation, conversation_id: conversation,
      initiating_external_message_id: `${conversation}-start`, agent_provider: "codex", agent_session_id: conversation, project_path: deployment,
    });
    const firstSession = session("first");
    const secondSession = session("second");
    const message = (target: typeof firstSession, externalMessageId: string) => archiveMessage(database, {
      session_id: target.id, transport: "discord", workspace_id: "workspace", external_message_id: externalMessageId, external_author_id: "owner",
      user_id: user.id, direction: "user", body: externalMessageId, reply_to_external_message_id: null, in_reply_to_message_id: null,
    }).message!;
    const first = message(firstSession, "first-one");
    const second = message(secondSession, "second-one");

    assert.equal(claimNextMessage(database, "global")?.id, first.id);
    assert.equal(claimNextMessage(database, "global"), undefined);
    completeMessageWithResponse(database, first.id, {
      transport: "discord", workspace_id: "workspace", external_message_id: "first-response", external_author_id: null,
      user_id: null, body: "response", reply_to_external_message_id: null,
    });
    assert.equal(claimNextMessage(database, "global")?.id, second.id);
    database.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("recovers stale processing work on restart without changing its history", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-test-"));
  try {
    const home = await bootstrapRuntimeHome(deployment);
    const database = openDatabase(home);
    const user = upsertUser(database, {
      transport: "discord", workspace_id: "workspace", external_user_id: "owner", display_name: null, role: "owner", state: "active",
    })!;
    const session = createSession(database, {
      user_id: user.id, transport: "discord", workspace_id: "workspace", parent_conversation_id: "parent", conversation_id: "conversation",
      initiating_external_message_id: "start", agent_provider: "codex", agent_session_id: "session", project_path: deployment,
    });
    const message = archiveMessage(database, {
      session_id: session.id, transport: "discord", workspace_id: "workspace", external_message_id: "message", external_author_id: "owner",
      user_id: user.id, direction: "user", body: "message", reply_to_external_message_id: null, in_reply_to_message_id: null,
    }, "user:owner").message!;
    const review = createMemoryReview(database, {
      session_id: session.id, from_message_id: message.id, through_message_id: message.id,
    });
    database.prepare("UPDATE messages SET state = 'processing', started_at = unixepoch(), updated_by = 'worker' WHERE id = ?").run(message.id);
    database.prepare("UPDATE memory_reviews SET state = 'processing', started_at = unixepoch(), updated_by = 'worker' WHERE id = ?").run(review.id);
    database.close();

    const restarted = openDatabase(home);
    const recoveredMessage = restarted.prepare("SELECT * FROM messages WHERE id = ?").get(message.id) as typeof message;
    const recoveredReview = restarted.prepare("SELECT * FROM memory_reviews WHERE id = ?").get(review.id) as typeof review;
    assert.equal(recoveredMessage.state, "pending");
    assert.equal(recoveredMessage.created_by, "user:owner");
    assert.ok(recoveredMessage.started_at);
    assert.equal(recoveredReview.state, "pending");
    assert.equal(recoveredReview.created_by, "system");
    assert.ok(recoveredReview.started_at);
    assert.equal((restarted.prepare("SELECT count(*) AS count FROM messages WHERE state = 'completed'").get() as { count: number }).count, 0);
    restarted.close();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});
