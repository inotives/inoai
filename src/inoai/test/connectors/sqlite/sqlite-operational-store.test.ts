import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeFailure, type AgentRuntime } from "../../../agent-runtime/ports.js";
import { MemoryReviewScheduler, type SchedulerClock } from "../../../memory/memory-review-scheduler.js";

import { bootstrapRuntimeHome } from "../../../agent-instance/runtime-home.js";
import type { Configuration } from "../../../agent-instance/config.js";
import { databaseBusyTimeoutMs, openDatabase } from "../../../connectors/persistence/sqlite/legacy-database.js";
import { createSqliteOperationalStore } from "../../../connectors/persistence/sqlite/operational-store.js";

async function fixture(t: test.TestContext) {
  const deployment = await mkdtemp(join(tmpdir(), "inoai-sqlite-adapter-"));
  const home = await bootstrapRuntimeHome(deployment);
  const database = openDatabase(home);
  const store = createSqliteOperationalStore(database);
  t.after(async () => {
    if (database.isOpen) await store.close();
    await rm(deployment, { recursive: true, force: true });
  });
  const configuration = { discordGuildId: "guild", discordOwnerUserId: "owner" } as Configuration;
  const owner = await store.bootstrapOwner(configuration, "bootstrap:test");
  const session = async (name: string) => store.createSession({
    user_id: owner.id, transport: "discord", workspace_id: "guild",
    parent_conversation_id: "parent", conversation_id: name,
    initiating_external_message_id: name, agent_provider: "codex",
    agent_session_id: name, project_path: deployment,
  }, "session:test");
  const inbound = async (sessionId: number, name: string) => (await store.archiveMessage({
    session_id: sessionId, transport: "discord", workspace_id: "guild",
    external_message_id: name, external_author_id: "owner", user_id: owner.id,
    direction: "user", body: name, reply_to_external_message_id: null,
    in_reply_to_message_id: null,
  }, "message:test")).message!;
  return { home, database, store, configuration, owner, session, inbound };
}

test("production adapter keeps SQLite settings, owner identity, audit, and connection ownership", async (t) => {
  const { database, store, configuration, owner } = await fixture(t);
  assert.equal(database.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
  assert.equal(database.prepare("PRAGMA busy_timeout").get()!.timeout, databaseBusyTimeoutMs);
  assert.equal((await store.bootstrapOwner(configuration)).id, owner.id);
  assert.equal(owner.created_by, "bootstrap:test");
  const other = await store.bootstrapOwner({ ...configuration, discordOwnerUserId: "replacement" }, "owner:replace");
  assert.notEqual(other.id, owner.id);
  assert.equal(await store.findUser("discord", "guild", "owner"), undefined);
  assert.equal((await store.findUser("discord", "guild", "replacement"))!.id, other.id);
  assert.equal(database.prepare("SELECT updated_by FROM users WHERE id=?").get(owner.id)!.updated_by, "owner:replace");
  await store.close();
  assert.equal(database.isOpen, false);
});

test("queue claims preserve FIFO, session isolation, and safe recovery without duplicate notices", async (t) => {
  const { store, session, inbound } = await fixture(t);
  const first = await session("first");
  const second = await session("second");
  const a = await inbound(first.id, "a");
  const b = await inbound(first.id, "b");
  const c = await inbound(second.id, "c");
  assert.equal((await store.claimNextMessage("per-session"))!.id, a.id);
  assert.equal(await store.claimNextMessage("global"), undefined);
  assert.equal((await store.claimNextMessage("per-session"))!.id, c.id);
  assert.equal(await store.claimNextMessage("per-session"), undefined);
  assert.equal(await store.markRuntimeStarted(a.id), true);
  await store.recoverStaleWork();
  await store.recoverStaleWork();
  const rows = await store.listMessages(first.id);
  assert.equal(rows.find((row) => row.id === a.id)!.state, "failed");
  assert.match(rows.find((row) => row.id === a.id)!.failure_detail!, /uncertain/);
  assert.equal(rows.filter((row) => row.direction === "agent").length, 1);
  assert.equal((await store.listMessages(second.id))[0]!.state, "pending");
  assert.equal((await store.claimNextMessage("global"))!.id, b.id);
});

test("response delivery keeps confirmed, failed, and uncertain chunks across reopen", async (t) => {
  const { home, database, store, session, inbound } = await fixture(t);
  const s = await session("delivery");
  const message = await inbound(s.id, "request");
  await store.claimNextMessage("global");
  assert.equal(await store.archiveResponseChunks(message.id, ["early"]), undefined);
  await store.markRuntimeStarted(message.id);
  const chunks = (await store.archiveResponseChunks(message.id, ["confirmed", "failed", "uncertain", "remaining"]))!;
  for (const chunk of chunks.slice(0, 3)) assert.equal(await store.claimResponseChunk(chunk.id), true);
  assert.equal(await store.confirmResponseChunk(chunks[0]!.id, "sent"), true);
  assert.equal(await store.confirmResponseChunk(chunks[0]!.id, "duplicate"), false);
  assert.equal(await store.failResponseChunk(chunks[1]!.id, "send failed"), true);
  assert.equal(await store.failRemainingResponseChunks(message.id), 1);
  await store.close();
  const reopened = createSqliteOperationalStore(openDatabase(home));
  try {
    assert.deepEqual((await reopened.listMessages(s.id)).filter((row) => row.direction === "agent").map((row) => row.delivery_state),
      ["confirmed", "failed", "uncertain", "failed"]);
    assert.deepEqual(await reopened.listPendingResponseChunks(), []);
    assert.equal(await reopened.claimResponseChunk(chunks[2]!.id), false);
  } finally {
    await reopened.close();
  }
  assert.equal(database.isOpen, false);
});

test("Memory Review commit is atomic, advances its cursor once, and preserves soft-delete audit", async (t) => {
  const { store, database, session, inbound } = await fixture(t);
  const s = await session("review");
  const message = await inbound(s.id, "remember tabs");
  await store.claimNextMessage("global");
  await store.markRuntimeStarted(message.id);
  const response = (await store.archiveResponseChunks(message.id, ["noted"]))![0]!;
  const manual = await store.createMemory({ body: "manual", source_message_id: null, created_by_user_id: null, review_id: null, origin: "manual" }, "memory:test");
  await store.softDeleteMemory(manual.id, "memory:delete");
  assert.deepEqual(await store.listMemories(), []);
  assert.equal(database.prepare("SELECT deleted_by FROM memories WHERE id=?").get(manual.id)!.deleted_by, "memory:delete");
  const review = await store.createMemoryReview({ session_id: s.id, from_message_id: message.id, through_message_id: response.id });
  assert.equal((await store.claimDueMemoryReview(Math.floor(Date.now() / 1000)))!.id, review.id);
  assert.equal(await store.updateMemoryReview(review.id, {}), false);
  assert.equal(await store.updateMemoryReview(review.id, { attempts: 1 }, "review:attempt"), true);
  const snapshot = await store.readMemoryReview(s.id, review.id);
  assert.equal(snapshot.cursor, 0);
  assert.equal(snapshot.review!.updated_by, "review:attempt");
  const input = {
    sessionId: s.id, cursor: snapshot.cursor, reviewId: review.id,
    fromMessageId: message.id, throughMessageId: response.id, recap: "Use tabs.",
    actions: [{ op: "add" as const, body: "Use tabs.", sourceMessageId: message.id }],
    ignored: ["invalid"], counts: { added: 1, updated: 0, deleted: 0 }, actor: "review:test",
  };
  // A failed Memory insert must roll back the recap and cursor as well.
  await assert.rejects(store.commitMemoryReview({ ...input, actions: [{ ...input.actions[0]!, sourceMessageId: 999999 }] }));
  assert.equal((await store.readMemoryReview(s.id, review.id)).cursor, 0);
  assert.deepEqual(await store.listMemories(), []);
  const results = await Promise.all([store.commitMemoryReview(input), store.commitMemoryReview(input)]);
  assert.deepEqual(results.map((result) => result.state), ["completed", "stale_range"]);
  assert.equal((await store.readMemoryReview(s.id)).cursor, response.id);
  assert.deepEqual(await store.messagesForMemoryReview(s.id), []);
  assert.equal((await store.listMemories())[0]!.created_by, "review:test");
  assert.match((await store.listEvents(s.id)).find((row) => row.event_type === "memory_review_completed")!.detail!, /added=1.*ignored=1; reasons=invalid:1/);
  assert.equal(await store.updateMemoryReview(review.id, { state: "pending" }), false);
});

test("pending reviews accept scheduling updates and retired reviews stay protected", async (t) => {
  const { store, session, inbound } = await fixture(t);
  const s = await session("schedule");
  const message = await inbound(s.id, "request");
  const review = await store.createMemoryReview({ session_id: s.id, from_message_id: message.id, through_message_id: message.id });
  const due = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(await store.updateMemoryReview(review.id, { state: "pending", nextAttemptAt: due }, "schedule:test"), true);
  assert.equal(await store.claimDueMemoryReview(due - 1), undefined);
  const claimed = (await store.claimDueMemoryReview(due))!;
  assert.equal(claimed.id, review.id);
  assert.equal(claimed.next_attempt_at, due);
  assert.equal(await store.retireMemoryReview(review.id), true);
  assert.equal(await store.updateMemoryReview(review.id, { state: "pending", nextAttemptAt: 0 }), false);
  assert.equal(await store.claimDueMemoryReview(due), undefined);
});

test("scheduler re-arms the same failed review the day after retry exhaustion", async (t) => {
  const { store, session, inbound } = await fixture(t);
  const s = await session("retry");
  const message = await inbound(s.id, "Remember that I prefer tabs.");
  await store.claimNextMessage("global");
  await store.markRuntimeStarted(message.id);
  await store.archiveResponseChunks(message.id, ["Noted."]);
  let now = new Date(2026, 9, 11, 6);
  let fail = true;
  let calls = 0;
  const clock: SchedulerClock = {
    now: () => now, setInterval: () => undefined, clearInterval: () => {},
  };
  const runtime: AgentRuntime = {
    displayName: "Claude", loginHint: "claude /login",
    async createSession() { return "review"; }, async resumeSession() {},
    async *runTurn() {}, async cancel() {}, async close() {},
    health: () => ({ state: "ready" }),
    async review(prompt) {
      calls++;
      if (fail) throw new RuntimeFailure("usage", true);
      return prompt.includes("combine the window notes")
        ? '{"recap":"Prefers tabs.","actions":[]}' : '{"notes":"Prefers tabs."}';
    },
  };
  const scheduler = new MemoryReviewScheduler(store, runtime, { reviewTime: "06:00", maxChars: 20_000, clock });
  t.after(() => scheduler.stop());
  scheduler.start();
  await scheduler.idle();
  for (const hours of [1, 2, 4]) {
    now = new Date(now.getTime() + hours * 3600_000);
    scheduler.poke();
    await scheduler.idle();
  }
  const [failed] = await store.listOpenMemoryReviews(s.id);
  assert.ok(failed);
  assert.equal(failed.state, "failed");
  assert.equal(failed.attempts, 4);
  assert.equal(failed.failure_detail, "usage");
  assert.equal(calls, 4);
  fail = false;
  now = new Date(2026, 9, 12, 6);
  scheduler.poke();
  await scheduler.idle();
  const snapshot = await store.readMemoryReview(s.id, failed.id);
  assert.equal(snapshot.review!.state, "completed");
  assert.equal(snapshot.review!.attempts, 0);
  assert.equal(snapshot.review!.failure_detail, null);
  assert.deepEqual(await store.listOpenMemoryReviews(s.id), []);
  assert.ok(calls > 4);
  assert.equal((await store.listEvents(s.id)).filter((event) => event.event_type === "memory_review_completed").length, 1);
});
