import assert from "node:assert/strict";
import test from "node:test";

import { PostgresOperationalStore } from "../operational-store.js";

type QueryCall = { text: string; values: unknown[] };

function fakePool(rows: unknown[] = []) {
  const calls: QueryCall[] = [];
  const query = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    return { rows, rowCount: rows.length };
  };
  const client = {
    query,
    release() {},
  };
  return {
    calls,
    query,
    async connect() { return client; },
    async end() {},
  };
}

test("operational store schema is derived from the validated Agent Instance ID", async () => {
  const pool = fakePool();
  const store = new PostgresOperationalStore(pool as never, "agent-inoai-planner");
  await store.getSession(7);
  assert.match(pool.calls[0]!.text, /FROM "agent_inoai-planner"|FROM "agent_inoai_planner"\."sessions"/);
  assert.deepEqual(pool.calls[0]!.values, [7]);
  assert.throws(() => new PostgresOperationalStore(pool as never, "agent-unsafe\"schema"), /lowercase agent|Invalid/);
});

test("queue claims use a transaction and row locking for single-claim semantics", async () => {
  const pool = fakePool();
  const store = new PostgresOperationalStore(pool as never, "agent-test");
  await store.claimNextMessage("per-session", "worker:test");
  assert.equal(pool.calls[0]!.text, "BEGIN");
  assert.match(pool.calls[1]!.text, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(pool.calls[1]!.values, ["per-session"]);
  assert.equal(pool.calls.at(-1)!.text, "COMMIT");
});

test("database failures are sanitized before reaching callers", async () => {
  const pool = {
    async query() { throw new Error("postgresql://user:secret@example.test/app"); },
    async end() {},
  };
  const store = new PostgresOperationalStore(pool as never, "agent-test");
  await assert.rejects(() => store.getSession(1), { message: "PostgreSQL operation failed" });
});

test("review snapshot uses one repeatable-read client transaction", async () => {
  const poolCalls: string[] = [];
  const clientCalls: string[] = [];
  const client = {
    async query(text: string) {
      clientCalls.push(text);
      if (text.startsWith("SELECT MAX")) return { rows: [{ through_message_id: null }], rowCount: 1 };
      if (text.includes("FROM \"agent_test\".\"memory_reviews\"")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    async query(text: string) { poolCalls.push(text); return { rows: [], rowCount: 0 }; },
    async connect() { return client; },
    async end() {},
  };
  const store = new PostgresOperationalStore(pool as never, "agent-test");
  const snapshot = await store.readMemoryReview(4);
  assert.equal(snapshot.cursor, 0);
  assert.equal(poolCalls.length, 0);
  assert.match(clientCalls[0]!, /^BEGIN ISOLATION LEVEL REPEATABLE READ$/);
  assert.equal(clientCalls.at(-1), "COMMIT");
  assert.ok(clientCalls.slice(1, -1).length >= 5);
});

test("same-session review commits serialize and the second caller returns stale_range", async () => {
  let cursor = 0;
  let nextReviewId = 1;
  let lockOwner: number | undefined;
  let releaseLock: (() => void) | undefined;
  let clientNumber = 0;
  const makeClient = (id: number) => ({
    async query(text: string, values: unknown[] = []) {
      if (text === "BEGIN") return { rows: [], rowCount: 0 };
      if (text.includes("pg_advisory_xact_lock")) {
        if (lockOwner !== undefined) await new Promise<void>((resolve) => { releaseLock = resolve; });
        lockOwner = id;
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SELECT MAX")) return { rows: [{ through_message_id: cursor }], rowCount: 1 };
      if (text.startsWith("INSERT INTO") && text.includes("memory_reviews")) return { rows: [{ id: nextReviewId++ }], rowCount: 1 };
      if (text === "COMMIT") {
        cursor = 11;
        const release = releaseLock;
        releaseLock = undefined;
        lockOwner = undefined;
        release?.();
        return { rows: [], rowCount: 0 };
      }
      if (text === "ROLLBACK") { lockOwner = undefined; releaseLock?.(); releaseLock = undefined; return { rows: [], rowCount: 0 }; }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  });
  const pool = {
    async query() { return { rows: [], rowCount: 0 }; },
    async connect() { return makeClient(++clientNumber); },
    async end() {},
  };
  const store = new PostgresOperationalStore(pool as never, "agent-test");
  const input = { sessionId: 4, cursor: 0, fromMessageId: 11, throughMessageId: 11, recap: "tabs", actions: [], ignored: [], counts: { added: 0, updated: 0, deleted: 0 } };
  const results = await Promise.all([store.commitMemoryReview(input), store.commitMemoryReview(input)]);
  assert.deepEqual(results.map((result) => result.state).sort(), ["completed", "stale_range"]);
});
